package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"stele/chat"
	"stele/internal/source"
)

func cloneWorkspaceConfig(cfg WorkspaceConfig) WorkspaceConfig {
	if cfg.Purpose != nil {
		purpose := *cfg.Purpose
		purpose.KeyQuestions = append([]string(nil), purpose.KeyQuestions...)
		cfg.Purpose = &purpose
	}
	return cfg
}

func validateWorkspacePreferences(purpose *source.WorkspacePurpose, modelProvider string) error {
	if len(modelProvider) > 128 || strings.ContainsAny(modelProvider, "\x00\r\n") {
		return fmt.Errorf("invalid workspace model provider")
	}
	if purpose == nil {
		return nil
	}
	if !utf8.ValidString(purpose.Goal) || !utf8.ValidString(purpose.Scope) || len(purpose.Goal) > 4096 || len(purpose.Scope) > 4096 || len(purpose.KeyQuestions) > 16 {
		return fmt.Errorf("workspace purpose exceeds its text limits")
	}
	for _, question := range purpose.KeyQuestions {
		if !utf8.ValidString(question) || len(question) > 1024 {
			return fmt.Errorf("workspace question exceeds its text limit")
		}
	}
	return nil
}

func (r *WorkspaceRegistry) UpdatePreferences(alias string, purpose *source.WorkspacePurpose, modelProvider string) (WorkspaceConfig, error) {
	if err := validateWorkspacePreferences(purpose, modelProvider); err != nil {
		return WorkspaceConfig{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	updated := append([]WorkspaceConfig(nil), r.workspaces...)
	for i, workspace := range updated {
		if workspace.Alias != alias {
			continue
		}
		workspace.Purpose = purpose
		workspace.ModelProvider = modelProvider
		updated[i] = cloneWorkspaceConfig(workspace)
		if err := persistWorkspaces(r.configPath, updated, r.syncCfg); err != nil {
			return WorkspaceConfig{}, err
		}
		r.workspaces = updated
		return cloneWorkspaceConfig(updated[i]), nil
	}
	return WorkspaceConfig{}, fmt.Errorf("%w: %q", ErrWorkspaceNotFound, alias)
}

func handleWorkspacePreferences(w http.ResponseWriter, r *http.Request, reg *WorkspaceRegistry) {
	if !writeGuard(r) {
		writeJSONError(w, "write access denied", http.StatusForbidden)
		return
	}
	alias := r.URL.Query().Get("alias")
	if alias == "" {
		writeJSONError(w, "workspace alias is required", http.StatusBadRequest)
		return
	}
	var in struct {
		Purpose       *source.WorkspacePurpose `json:"purpose"`
		ModelProvider string                   `json:"modelProvider"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		writeJSONError(w, "invalid workspace preferences", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeJSONError(w, "trailing workspace preferences", http.StatusBadRequest)
		return
	}
	if in.ModelProvider != "" {
		cfg, err := chat.LoadConfig()
		if err != nil {
			writeJSONError(w, "provider configuration unavailable", http.StatusInternalServerError)
			return
		}
		if _, ok := cfg.Providers[in.ModelProvider]; !ok {
			writeJSONError(w, "unknown workspace model provider", http.StatusBadRequest)
			return
		}
	}
	if err := validateWorkspacePreferences(in.Purpose, in.ModelProvider); err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}
	workspace, err := reg.UpdatePreferences(alias, in.Purpose, in.ModelProvider)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, ErrWorkspaceNotFound) {
			status = http.StatusNotFound
		}
		writeJSONError(w, err.Error(), status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(workspace)
}
