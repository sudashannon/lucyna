package main

import (
	"net/http"
	"path/filepath"
	"strings"

	"stele/chat"
	"stele/wiki"
)

func (r workspaceChatResolver) AuthorizeChatSession(alias, identity string) error {
	workspace, err := r.workspace(alias)
	if err != nil {
		return err
	}
	if identity == "" || len(identity) > 4096 || strings.ContainsRune(identity, '\x00') {
		return &chat.ContextError{Status: http.StatusBadRequest, Message: "invalid conversation identity"}
	}
	if component, ok := r.wiki.ComponentByID(identity); ok {
		if component.Type == wiki.TypeSession {
			return &chat.ContextError{Status: http.StatusForbidden, Message: "raw session identity is not a document conversation"}
		}
		if component.Workspace != alias {
			if alias != "__default" || component.Workspace != "" {
				return &chat.ContextError{Status: http.StatusForbidden, Message: "conversation belongs to a different document workspace"}
			}
			if _, err := authorizedContextPath(workspace, component.Path); err != nil {
				return err
			}
		}
		return nil
	}
	if filepath.IsAbs(identity) || strings.ContainsAny(identity, "/\\") {
		absolute := identity
		if !filepath.IsAbs(absolute) {
			absolute = filepath.Join(workspace.Path, identity)
		}
		if !artifactPathAllowed(workspace, absolute) {
			return &chat.ContextError{Status: http.StatusForbidden, Message: "conversation path is outside its workspace"}
		}
		// The document may have been deleted since the conversation was saved.
		// Authorize its existing parent so history remains readable without following an escaping symlink.
		parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
		if err != nil || !resolvedArtifactWithinWorkspace(workspace, parent) {
			return &chat.ContextError{Status: http.StatusForbidden, Message: "conversation parent is outside its workspace"}
		}
	}
	return nil
}
