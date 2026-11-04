package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"stele/chat"
	"stele/internal/managed"
	"stele/internal/review"
	"stele/internal/source"

	"gopkg.in/yaml.v3"
)

type knowledgeAdopter struct {
	resolver  workspaceChatResolver
	onChanged func(string)
}

func (a knowledgeAdopter) verifyReferences(refs []source.EvidenceReference) error {
	for _, ref := range refs {
		if ref.Path == "" || ref.Workspace == "" || ref.Version == "" {
			return fmt.Errorf("document evidence identity is incomplete")
		}
		workspace, err := a.resolver.workspace(ref.Workspace)
		if err != nil {
			return err
		}
		path, err := authorizedContextPath(workspace, ref.Path)
		if err != nil {
			var contextError *chat.ContextError
			if errors.As(err, &contextError) {
				if contextError.Status == http.StatusNotFound {
					return review.ErrConflict
				}
				if contextError.Status == http.StatusForbidden {
					return review.ErrForbidden
				}
			}
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return review.ErrConflict
			}
			return err
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
			file.Close()
			return fmt.Errorf("evidence must be a bounded regular document")
		}
		data, readErr := io.ReadAll(io.LimitReader(file, (1<<20)+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || len(data) > 1<<20 {
			return fmt.Errorf("evidence cannot be read within its budget")
		}
		if ref.Version != fmt.Sprintf("doc-v1:%x", sha256.Sum256(data)) {
			return review.ErrConflict
		}
	}
	return nil
}

func (a knowledgeAdopter) create(candidate review.Candidate) (source.EvidenceReference, error) {
	workspace, err := a.resolver.workspace(candidate.Workspace)
	if err != nil {
		return source.EvidenceReference{}, err
	}
	if candidate.ID == "" || filepath.Base(candidate.ID) != candidate.ID || strings.ContainsAny(candidate.ID, "/\\\x00") || len(candidate.Text) > 1<<20 {
		return source.EvidenceReference{}, fmt.Errorf("invalid knowledge candidate")
	}
	if err := a.verifyReferences(candidate.References); err != nil {
		return source.EvidenceReference{}, err
	}
	root, err := filepath.EvalSymlinks(source.ProjectRoot(workspace))
	if err != nil {
		return source.EvidenceReference{}, err
	}
	category := "knowledge"
	if managed.Unified() { category = "知识" }
	directory := filepath.Join(root, category)
	if err := os.MkdirAll(directory, 0755); err != nil {
		return source.EvidenceReference{}, err
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil || !pathWithinRoot(canonical, root) {
		return source.EvidenceReference{}, fmt.Errorf("knowledge directory escaped its workspace")
	}
	path := filepath.Join(canonical, candidate.ID+".md")
	refs := make([]string, 0, len(candidate.References))
	for _, ref := range candidate.References {
		refs = append(refs, ref.Resource)
	}
	metadata, err := yaml.Marshal(struct {
		Title       string   `yaml:"title"`
		Type        string   `yaml:"type"`
		CandidateID string   `yaml:"candidate_id"`
		Created     string   `yaml:"created"`
		Sources     []string `yaml:"sources"`
	}{candidate.Title, "knowledge", candidate.ID, candidate.CreatedAt, refs})
	if err != nil {
		return source.EvidenceReference{}, err
	}
	data := append([]byte("---\n"), metadata...)
	data = append(data, []byte("---\n\n"+candidate.Text+"\n")...)
	if current, err := os.ReadFile(path); err == nil {
		if !bytes.Equal(current, data) {
			return source.EvidenceReference{}, review.ErrConflict
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return source.EvidenceReference{}, err
	} else {
		if err := createKnowledgeAtomically(path, data); err != nil {
			return source.EvidenceReference{}, err
		}
	}
	if a.onChanged != nil {
		a.onChanged(candidate.Workspace)
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return source.EvidenceReference{}, err
	}
	return source.EvidenceReference{
		ID: path, Workspace: candidate.Workspace, Title: candidate.Title, Type: "knowledge", Path: path,
		Resource: "doc://" + candidate.Workspace + "/" + filepath.ToSlash(rel), Version: fmt.Sprintf("doc-v1:%x", sha256.Sum256(data)),
		Excerpt: candidate.Text, Reasons: []string{"human-adopted"}, Freshness: "current",
	}, nil
}

func createKnowledgeAtomically(path string, content []byte) error {
	if managed.Enabled() {
		return managed.Create(path, content)
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".stele-knowledge-*")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err = file.Chmod(0644); err == nil {
		_, err = file.Write(content)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	// A hard link publishes the completed bytes without ever replacing an existing file.
	if err := os.Link(temp, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return review.ErrConflict
		}
		return err
	}
	if directory, err := os.Open(filepath.Dir(path)); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
