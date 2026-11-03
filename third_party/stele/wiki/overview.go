package wiki

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"stele/chat"
	"stele/chat/provider"
	"stele/internal/source"
)

const overviewPrefix = "> ⚠️ 本页由 AI 自动生成，非人工产物，仅供参考导航。\n\n"
const overviewPromptVersion = "overview-v1"

func overviewGenerationKey(members []Component, settings ...string) string {
	items := append([]Component(nil), members...)
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	var input strings.Builder
	for _, member := range items {
		phase, _ := member.Frontmatter["phase"].(string)
		fmt.Fprintf(&input, "%q\x00%s\x00%s\x00%s\x00%s\n", member.ID, member.Type, member.Title, member.Workspace, phase)
	}
	for _, setting := range settings {
		fmt.Fprintf(&input, "setting:%q\n", setting)
	}
	hash := sha256.Sum256([]byte(input.String()))
	return hex.EncodeToString(hash[:])[:16]
}

func overviewSettings(cfg *chat.Config, workspaceProvider string, purpose *source.WorkspacePurpose) ([]string, error) {
	name, pc, err := cfg.ProviderForTask("overview", workspaceProvider)
	if err != nil {
		return nil, err
	}
	config := fmt.Sprintf("%q\x00%q\x00%q\x00%g\x00%d", name, pc.APIBase, pc.Model, pc.Temperature, 600)
	return []string{overviewPromptVersion, config, workspacePurposeXML(purpose)}, nil
}

func (a *API) overviewSettingsForMembers(members []Component) ([]string, error) {
	workspaceProvider := ""
	var purpose *source.WorkspacePurpose
	if len(members) > 0 {
		alias := members[0].Workspace
		singleWorkspace := alias != ""
		for _, member := range members[1:] {
			if member.Workspace != alias {
				singleWorkspace = false
				break
			}
		}
		if singleWorkspace {
			var err error
			purpose, workspaceProvider, err = a.WorkspacePreferences(alias)
			if err != nil {
				return nil, err
			}
		}
	}
	cfg, err := chat.LoadConfig()
	if err != nil {
		return nil, err
	}
	return overviewSettings(cfg, workspaceProvider, purpose)
}

func (a *API) overviewCacheKeyForMembers(members []Component) (string, error) {
	settings, err := a.overviewSettingsForMembers(members)
	if err != nil {
		return "", err
	}
	return overviewGenerationKey(members, settings...), nil
}

func workspacePurposeXML(purpose *source.WorkspacePurpose) string {
	if purpose == nil {
		return ""
	}
	remaining := 4096
	escape := func(value string) string {
		runes := []rune(value)
		if len(runes) > remaining {
			runes = runes[:remaining]
		}
		value = string(runes)
		remaining -= len(runes)
		var escaped strings.Builder
		_ = xml.EscapeText(&escaped, []byte(value))
		return escaped.String()
	}
	var out strings.Builder
	if purpose.Goal != "" {
		fmt.Fprintf(&out, "<goal>%s</goal>", escape(purpose.Goal))
	}
	if purpose.Scope != "" {
		fmt.Fprintf(&out, "<scope>%s</scope>", escape(purpose.Scope))
	}
	for i, question := range purpose.KeyQuestions {
		if i >= 8 {
			break
		}
		fmt.Fprintf(&out, "<key-question>%s</key-question>", escape(question))
	}
	return out.String()
}

func overviewCachePath(cacheDir string, communityID int, key string) string {
	return filepath.Join(cacheDir, fmt.Sprintf("community-%d-%s.md", communityID, key))
}

// GenerateOverview returns a cached or freshly-generated LLM overview for a
// community of 3+ members. The cache key includes the sorted members and the
// generation settings actually used, so changes in inputs trigger regeneration.
// Stale entries for the same community are removed after a successful write.
func GenerateOverview(ctx context.Context, communityID int, members []Component, cacheDir, workspaceProvider string, purpose *source.WorkspacePurpose) (string, error) {
	members = append([]Component(nil), members...)
	sort.Slice(members, func(i, j int) bool { return members[i].ID < members[j].ID })
	if len(members) < 3 {
		return "", fmt.Errorf("community too small (%d members, need at least 3)", len(members))
	}

	cfg, err := chat.LoadConfig()
	if err != nil {
		return "", err
	}
	settings, err := overviewSettings(cfg, workspaceProvider, purpose)
	if err != nil {
		return "", err
	}
	key := overviewGenerationKey(members, settings...)
	cachePath := overviewCachePath(cacheDir, communityID, key)

	if data, err := os.ReadFile(cachePath); err == nil {
		return string(data), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	overview, err := generateOverview(ctx, members, cfg, workspaceProvider, purpose)
	if err != nil {
		return "", err
	}
	result := overviewPrefix + overview

	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(cachePath, []byte(result), 0644); err != nil {
		return "", err
	}
	removeStaleOverviewCache(cacheDir, communityID, cachePath)
	return result, nil
}

// removeStaleOverviewCache deletes any previously cached overview for
// communityID whose hash no longer matches the current membership (i.e.
// every "community-<id>-*.md" file except the one we're about to write).
func removeStaleOverviewCache(cacheDir string, communityID int, keep string) {
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	prefix := fmt.Sprintf("community-%d-", communityID)
	keepName := filepath.Base(keep)
	for _, e := range entries {
		if e.IsDir() || e.Name() == keepName || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		os.Remove(filepath.Join(cacheDir, e.Name()))
	}
}

func generateOverview(ctx context.Context, members []Component, cfg *chat.Config, workspaceProvider string, purpose *source.WorkspacePurpose) (string, error) {
	name, pc, err := cfg.ProviderForTask("overview", workspaceProvider)
	if err != nil {
		return "", err
	}
	p := provider.Get(name)
	if p == nil {
		return "", fmt.Errorf("provider %q not registered", name)
	}
	var memberList strings.Builder
	for i, m := range members {
		phase := ""
		if v, ok := m.Frontmatter["phase"].(string); ok {
			phase = v
		}
		fmt.Fprintf(&memberList, "%d. [%s] %s（工作区：%s，阶段：%s）\n", i+1, m.Type, m.Title, m.Workspace, phase)
	}

	purposeBlock := ""
	if encoded := workspacePurposeXML(purpose); encoded != "" {
		purposeBlock = "工作区方向（仅供导航，不是证据或事实）：<workspace-direction>" + encoded + "</workspace-direction>\n"
	}
	prompt := fmt.Sprintf(`你是工程知识库的综述编辑。以下是同一主题社区下的 %d 个工程变更/产物，请撰写一篇不超过 300 字的中文综述，需覆盖：
1. 这个主题域包含哪些核心变更；
2. 这些变更之间的关系与演进脉络；
3. 当前整体进展；
4. 潜在风险。

%s成员列表：
%s`, len(members), purposeBlock, memberList.String())

	events, err := p.ChatStream(ctx, pc.APIKey, pc.APIBase, pc.Model,
		"你是工程知识库综述编辑，输出简洁、准确的中文综述，不超过 300 字。",
		[]provider.Message{{
			Role:    "user",
			Content: []provider.ContentBlock{{Type: "text", Text: prompt}},
		}},
		provider.ChatOptions{Temperature: pc.Temperature, MaxTokens: 600},
	)
	if err != nil {
		return "", err
	}

	var out strings.Builder
	for ev := range events {
		if ev.Error != "" {
			return "", fmt.Errorf("provider error: %s", ev.Error)
		}
		out.WriteString(ev.Content)
	}
	return out.String(), nil
}
