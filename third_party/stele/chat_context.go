package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"stele/chat"
	"stele/internal/source"
	"stele/wiki"
)

type workspaceChatResolver struct {
	registry *WorkspaceRegistry
	baseDir  string
	wiki     *wiki.API
}

func (r workspaceChatResolver) workspace(alias string) (WorkspaceConfig, error) {
	workspaces := r.registry.List()
	for _, workspace := range workspaces {
		if workspace.Alias == alias {
			return workspace, nil
		}
	}
	if alias == "__default" && len(workspaces) == 0 {
		kind, err := source.ResolveKind(r.baseDir, "")
		if err != nil {
			return WorkspaceConfig{}, &chat.ContextError{Status: http.StatusBadRequest, Message: "default workspace is unavailable"}
		}
		return WorkspaceConfig{Alias: alias, Path: r.baseDir, Type: kind}, nil
	}
	return WorkspaceConfig{}, &chat.ContextError{Status: http.StatusForbidden, Message: "registered workspace is required"}
}

func (r workspaceChatResolver) ResolveContext(alias, componentID string, files []string, evidenceOnly bool) ([]chat.ContextItem, error) {
	workspace, err := r.workspace(alias)
	if err != nil {
		return nil, err
	}
	if len(files) > 8 {
		return nil, &chat.ContextError{Status: http.StatusBadRequest, Message: "at most eight context files are allowed"}
	}
	if componentID != "" {
		if component, ok := r.wiki.ComponentByID(componentID); ok {
			if component.Type == wiki.TypeSession {
				return nil, &chat.ContextError{Status: http.StatusForbidden, Message: "raw sessions are not document context"}
			}
			if component.Workspace != alias {
				if alias != "__default" || component.Workspace != "" {
					return nil, &chat.ContextError{Status: http.StatusForbidden, Message: "component does not belong to the selected document workspace"}
				}
				if _, err := authorizedContextPath(workspace, component.Path); err != nil {
					return nil, err
				}
			}
		} else {
			if _, err := authorizedContextPath(workspace, componentID); err != nil {
				return nil, err
			}
		}
	}
	items := make([]chat.ContextItem, 0, len(files))
	seen := make(map[string]bool, len(files))
	total := 0
	for _, path := range files {
		canonical, err := authorizedContextPath(workspace, path)
		if err != nil {
			return nil, err
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		file, err := os.Open(canonical)
		if err != nil {
			return nil, &chat.ContextError{Status: http.StatusNotFound, Message: "context source is unavailable"}
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			file.Close()
			return nil, &chat.ContextError{Status: http.StatusUnsupportedMediaType, Message: "context source must be a regular text file"}
		}
		if info.Size() > 256<<10 {
			file.Close()
			return nil, &chat.ContextError{Status: http.StatusRequestEntityTooLarge, Message: "context source exceeds 256 KiB"}
		}
		data, readErr := io.ReadAll(io.LimitReader(file, (256<<10)+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil {
			return nil, &chat.ContextError{Status: http.StatusInternalServerError, Message: "context source could not be read"}
		}
		total += len(data)
		if len(data) > 256<<10 || total > 1<<20 {
			return nil, &chat.ContextError{Status: http.StatusRequestEntityTooLarge, Message: "context source budget exceeded"}
		}
		if !utf8.Valid(data) || strings.ContainsRune(string(data), '\x00') {
			return nil, &chat.ContextError{Status: http.StatusUnsupportedMediaType, Message: "context source must be UTF-8 text"}
		}
		root, err := filepath.EvalSymlinks(source.MirrorRoot(workspace))
		if err != nil {
			return nil, &chat.ContextError{Status: http.StatusNotFound, Message: "workspace root is unavailable"}
		}
		rel, err := filepath.Rel(root, canonical)
		if err != nil || !pathWithinRoot(canonical, root) {
			return nil, &chat.ContextError{Status: http.StatusForbidden, Message: "context source escaped its workspace"}
		}
		content := string(data)
		title := filepath.Base(canonical)
		if component, ok := r.wiki.ComponentByID(path); ok {
			title = component.Title
		}
		lines := strings.Count(content, "\n") + 1
		items = append(items, chat.ContextItem{Content: content, Reference: source.EvidenceReference{
			ID: canonical, Workspace: alias, Title: title, Type: "document", Path: canonical,
			Resource: "doc://" + alias + "/" + filepath.ToSlash(rel), Version: fmt.Sprintf("doc-v1:%x", sha256.Sum256(data)),
			Excerpt: content, LineStart: 1, LineEnd: lines, Reasons: []string{"user-selected"}, Freshness: "current",
		}})
	}
	return items, nil
}

func authorizedContextPath(workspace WorkspaceConfig, path string) (string, error) {
	if !filepath.IsAbs(path) {
		path = filepath.Join(source.ProjectRoot(workspace), path)
	}
	absolute, err := filepath.Abs(path)
	if err != nil || !artifactPathAllowed(workspace, absolute) {
		return "", &chat.ContextError{Status: http.StatusForbidden, Message: "context path is outside allowed artifact roots"}
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", &chat.ContextError{Status: http.StatusNotFound, Message: "context source not found"}
	}
	if !resolvedArtifactWithinWorkspace(workspace, canonical) {
		return "", &chat.ContextError{Status: http.StatusForbidden, Message: "context path is outside allowed artifact roots"}
	}
	return canonical, nil
}

func (r workspaceChatResolver) ModelForWorkspace(alias string) (string, error) {
	workspace, err := r.workspace(alias)
	if err != nil {
		return "", err
	}
	return workspace.ModelProvider, nil
}

func (r workspaceChatResolver) PurposeForWorkspace(alias string) (string, error) {
	workspace, err := r.workspace(alias)
	if err != nil {
		return "", err
	}
	if workspace.Purpose == nil {
		return "", nil
	}
	purpose := workspace.Purpose
	return "Goal: " + purpose.Goal + "\nScope: " + purpose.Scope + "\nKey questions:\n" + strings.Join(purpose.KeyQuestions, "\n"), nil
}
