package wiki

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"stele/chat"
	"stele/chat/provider"
)

const summaryPromptVersion = "summary-v1"

func summaryCachePath(cacheDir, componentID, providerName string, pc chat.ProviderConfig) string {
	input := fmt.Sprintf("%s\x00%s\x00%s\x00%s\x00%g\x00%d\x00%s", componentID, providerName, pc.APIBase, pc.Model, pc.Temperature, 300, summaryPromptVersion)
	h := sha256.Sum256([]byte(input))
	return filepath.Join(cacheDir, hex.EncodeToString(h[:])[:16]+".md")
}
func (a *API) summaryProvider(c Component) (string, chat.ProviderConfig, error) {
	cfg, err := chat.LoadConfig()
	if err != nil {
		return "", chat.ProviderConfig{}, err
	}
	_, workspaceProvider, err := a.WorkspacePreferences(c.Workspace)
	if err != nil {
		return "", chat.ProviderConfig{}, err
	}
	return cfg.ProviderForTask("summary", workspaceProvider)
}

// CachedSummary returns a previously generated summary when one exists and is
// still newer than the source file, without ever calling the LLM. The viewer
// needs this: it wants to show an existing summary the moment a document
// opens, and it cannot use Summarize for that because a cache miss there
// silently bills a generation for every document you merely look at.
func CachedSummary(c Component, cacheDir, providerName string, pc chat.ProviderConfig) (string, bool, error) {
	cachePath := summaryCachePath(cacheDir, c.ID, providerName, pc)
	cacheInfo, err := os.Stat(cachePath)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	srcInfo, err := os.Stat(c.Path)
	if err != nil {
		return "", false, err
	}
	if !cacheInfo.ModTime().After(srcInfo.ModTime()) {
		return "", false, nil
	}
	data, err := os.ReadFile(cachePath)
	if err != nil {
		return "", false, err
	}
	return string(data), true, nil
}

// Summarize returns a cached summary when available; otherwise it uses the
// task-selected provider (workspace override, task config, then active) and
// persists the result.
func Summarize(ctx context.Context, c Component, cacheDir, providerName string, pc chat.ProviderConfig) (string, error) {
	if cached, ok, err := CachedSummary(c, cacheDir, providerName, pc); err != nil {
		return "", err
	} else if ok {
		return cached, nil
	}
	summary, err := generateSummary(ctx, c, providerName, pc)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(summaryCachePath(cacheDir, c.ID, providerName, pc), []byte(summary), 0644); err != nil {
		return "", err
	}
	return summary, nil
}

func generateSummary(ctx context.Context, c Component, providerName string, pc chat.ProviderConfig) (string, error) {
	p := provider.Get(providerName)
	if p == nil {
		return "", fmt.Errorf("provider %q not registered", providerName)
	}

	content, err := os.ReadFile(c.Path)
	if err != nil {
		return "", err
	}

	events, err := p.ChatStream(ctx, pc.APIKey, pc.APIBase, pc.Model,
		"用一段简洁的中文摘要概括这份工程文档的核心内容，不超过150字。",
		[]provider.Message{{
			Role:    "user",
			Content: []provider.ContentBlock{{Type: "text", Text: string(content)}},
		}},
		provider.ChatOptions{Temperature: pc.Temperature, MaxTokens: 300},
	)
	if err != nil {
		return "", err
	}

	var out string
	for ev := range events {
		if ev.Error != "" {
			return "", fmt.Errorf("provider error: %s", ev.Error)
		}
		out += ev.Content
	}
	return out, nil
}
