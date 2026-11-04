package wiki

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"stele/internal/source"
)

// Opt-in only: profile the read-only index against a real documentation tree.
func TestBodySearchIndexProfile(t *testing.T) {
	root := os.Getenv("LUCYNA_SEARCH_PROFILE_ROOT")
	if root == "" {
		t.Skip("no profile corpus")
	}
	components := map[string]Component{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && isSearchMarkdown(path) {
			components[path] = Component{ID: path, Path: path, Workspace: "profile", Type: TypeKnowledge}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	b := newBodySearchIndex()
	start := time.Now()
	b.schedule(components, []WorkspaceConfig{{Alias: "profile", Path: root, Type: source.KindDocs}}, nil)
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		if _, ok := b.candidates("密钥"); ok {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	build := time.Since(start)
	start = time.Now()
	matches, ready := b.candidates("密钥")
	if !ready {
		t.Fatal("index build timed out")
	}
	fmt.Printf("corpus=%d build_ms=%d query_ms=%d matches=%d\n", len(components), build.Milliseconds(), time.Since(start).Milliseconds(), len(matches))
}

func waitBodyIndex(t *testing.T, b *bodySearchIndex) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, ready := b.candidates("test"); ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("body index did not become ready")
}

func TestBodySearchIndexChangesAndUnicode(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "document.md")
	if err := os.WriteFile(file, []byte("密钥位置 Secret location"), 0600); err != nil {
		t.Fatal(err)
	}
	ws := []WorkspaceConfig{{Alias: "library", Path: root, Type: source.KindDocs}}
	components := map[string]Component{file: {ID: file, Path: file, Workspace: "library", Type: TypeKnowledge}}
	b := newBodySearchIndex()
	b.schedule(components, ws, nil)
	waitBodyIndex(t, b)
	for _, q := range []string{"密钥", "钥", "secret", "SECRET", "location"} {
		matches, _ := b.candidates(q)
		if len(matches) != 1 || matches[0] != file {
			t.Fatalf("query %q: %v", q, matches)
		}
	}
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("密钥位置 PUBLIC location"), 0600); err != nil {
		t.Fatal(err)
	}
	// Preserve timestamp and size to reproduce editors which restore metadata.
	if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	b.schedule(components, ws, []string{file})
	waitBodyIndex(t, b)
	if matches, _ := b.candidates("secret"); len(matches) != 0 {
		t.Fatalf("stale results: %v", matches)
	}
	if matches, _ := b.candidates("public"); len(matches) != 1 {
		t.Fatalf("missing edit: %v", matches)
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	b.schedule(map[string]Component{}, ws, []string{file})
	waitBodyIndex(t, b)
	if matches, _ := b.candidates("public"); len(matches) != 0 {
		t.Fatalf("deleted file still indexed: %v", matches)
	}
}

func TestBodySearchIndexExcludesOutsideWorkspace(t *testing.T) {
	root, other := t.TempDir(), t.TempDir()
	file := filepath.Join(other, "outside.md")
	if err := os.WriteFile(file, []byte("outside-needle"), 0600); err != nil {
		t.Fatal(err)
	}
	b := newBodySearchIndex()
	b.schedule(map[string]Component{file: {ID: file, Path: file, Workspace: "library", Type: TypeKnowledge}}, []WorkspaceConfig{{Alias: "library", Path: root, Type: source.KindDocs}}, nil)
	waitBodyIndex(t, b)
	if matches, _ := b.candidates("outside-needle"); len(matches) != 0 {
		t.Fatalf("indexed outside workspace: %v", matches)
	}
}

func TestBodySearchIndexMarkdownExtension(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "document.MARKDOWN")
	if err := os.WriteFile(file, []byte("扩展名正文内容"), 0600); err != nil {
		t.Fatal(err)
	}
	b := newBodySearchIndex()
	b.schedule(map[string]Component{file: {ID: file, Path: file, Workspace: "library", Type: TypeKnowledge}}, []WorkspaceConfig{{Alias: "library", Path: root, Type: source.KindDocs}}, nil)
	waitBodyIndex(t, b)
	if matches, _ := b.candidates("正文"); len(matches) != 1 {
		t.Fatalf("markdown document missing: %v", matches)
	}
}

func TestIndexedSearchReturnsLiveEvidence(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "knowledge.md")
	if err := os.WriteFile(file, []byte("# Sample\n\n这里保存密钥的操作步骤。\n"), 0600); err != nil {
		t.Fatal(err)
	}
	component := Component{ID: file, Path: file, Workspace: "library", Type: TypeKnowledge, Title: "Sample"}
	components := map[string]Component{file: component}
	ws := []WorkspaceConfig{{Alias: "library", Path: root, Type: source.KindDocs}}
	a := &API{graph: BuildGraph([]Component{component}, nil), ws: ws, bodyIndex: newBodySearchIndex()}
	a.bodyIndex.schedule(components, ws, nil)
	waitBodyIndex(t, a.bodyIndex)
	ranked, evidence := a.rankDocumentSearch("密钥", nil, nil, components, nil, nil)
	if len(ranked) != 1 || ranked[0].id != file || ranked[0].lexicalRank != semanticBodyMatch {
		t.Fatalf("unexpected ranked result: %+v", ranked)
	}
	a.selectedEvidence("密钥", ranked, components, evidence)
	ref, ok := evidence[file]
	if !ok || len(ref.Reasons) == 0 || ref.Reasons[0] != "literal-body" || ref.LineStart == 0 || ref.Version == "" {
		t.Fatalf("missing live evidence: %+v", ref)
	}
}
