package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"stele/chat"
	"stele/internal/claims"
	"stele/internal/review"
	"stele/internal/source"

	"gopkg.in/yaml.v3"
)

var recoveryChatFilename = regexp.MustCompile(`^[0-9a-f]{64}\.json$`)

func validateWorkspaceSnapshot(data []byte) error {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	var snapshot workspacesFile
	if err := decoder.Decode(&snapshot); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("workspace snapshot must contain one document")
	}
	seen := make(map[string]bool, len(snapshot.Workspaces))
	for _, workspace := range snapshot.Workspaces {
		if workspace.Alias == "" || seen[workspace.Alias] || !filepath.IsAbs(workspace.Path) {
			return fmt.Errorf("invalid workspace identity in recovery snapshot")
		}
		seen[workspace.Alias] = true
		if _, err := parseRecoveryWorkspace(workspace); err != nil {
			return err
		}
	}
	return nil
}

func parseRecoveryWorkspace(workspace WorkspaceConfig) (WorkspaceConfig, error) {
	// A recovery package may come from another host: validate its schema and
	// explicit preferences, not whether that host's repository paths exist here.
	if err := validateWorkspacePreferences(workspace.Purpose, workspace.ModelProvider); err != nil {
		return WorkspaceConfig{}, err
	}
	if _, err := source.ParseKind(workspace.Type); err != nil {
		return WorkspaceConfig{}, err
	}
	return workspace, nil
}

func recoveryStores(dataDir string) ([]recoveryStore, error) {
	readTarget := func(target string) func() ([]byte, error) {
		return func() ([]byte, error) {
			path := filepath.Join(dataDir, filepath.FromSlash(target))
			info, err := os.Lstat(path)
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() || info.Size() > recoveryMaxStore {
				return nil, fmt.Errorf("recovery target is not a bounded regular file")
			}
			file, err := os.Open(path)
			if err != nil {
				return nil, err
			}
			defer file.Close()
			data, err := io.ReadAll(io.LimitReader(file, recoveryMaxStore+1))
			if err != nil || len(data) > recoveryMaxStore {
				return nil, fmt.Errorf("recovery target exceeds its read budget")
			}
			return data, nil
		}
	}
	stores := []recoveryStore{
		{Name: "config", Target: "config.json", Read: readTarget("config.json"), Validate: chat.ValidateConfigSnapshot, Export: chat.ExportConfigSnapshot, PrepareRestore: chat.MergeConfigSnapshot},
		{Name: "workspaces", Target: "workspaces.yaml", Read: readTarget("workspaces.yaml"), Validate: validateWorkspaceSnapshot},
		{Name: "claims", Target: "claims.json", Read: readTarget("claims.json"), Validate: claims.ValidateSnapshot},
		{Name: "review", Target: "review.json", Read: readTarget("review.json"), Validate: review.ValidateSnapshot},
	}
	stores = append(stores, recoveryStore{Name: "chat", Target: "chat", Validate: chat.ValidateSessionSnapshot, List: func() (map[string][]byte, error) {
		files := map[string][]byte{}
		entries, err := os.ReadDir(filepath.Join(dataDir, "chat"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		for _, entry := range entries {
			if !entry.Type().IsRegular() || !recoveryChatFilename.MatchString(entry.Name()) {
				continue
			}
			data, err := readTarget("chat/" + entry.Name())()
			if err != nil {
				return nil, err
			}
			files["chat-"+strings.TrimSuffix(entry.Name(), ".json")] = data
		}
		return files, nil
	}})
	return stores, nil
}
