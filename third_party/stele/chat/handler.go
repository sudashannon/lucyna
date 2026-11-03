package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"stele/chat/provider"
	"stele/internal/source"
)

const defaultSystemPrompt = "你是 Stele 工程文档分析助手。请基于提供的文档内容回答问题。\n若答案不在文档中，请诚实告知。如果用户要求画架构图、流程图，请使用 mermaid 语法。\n用中文回答。"

// WikiGraphAccessor provides read access to the wiki knowledge graph
// for context injection into chat prompts.
type WikiGraphAccessor interface {
	Neighborhood(changeID string) (direct []NeighborInfo, secondHop []string)
	CommunityOverview(changeID string) (string, error)
}

// NeighborInfo describes one direct (1-hop) graph neighbor of a change.
type NeighborInfo struct {
	ID    string
	Title string
	Kind  string // edge kind
}

type ContextError struct {
	Status  int
	Message string
}

func (e *ContextError) Error() string { return e.Message }

type WorkspaceModelResolver interface {
	ModelForWorkspace(workspace string) (providerName string, err error)
}

type WorkspacePurposeResolver interface {
	PurposeForWorkspace(workspace string) (purpose string, err error)
}

func HandleMessage(baseDir, openspecDir string, wikiGraph WikiGraphAccessor, resolver ContextResolver, models WorkspaceModelResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
		var req struct {
			Workspace    string   `json:"workspace"`
			Change       string   `json:"change"`
			Message      string   `json:"message"`
			ContextFiles []string `json:"context_files"`
			Images       []string `json:"images"`
			IncludeGraph bool     `json:"includeGraph"`
			ComponentID  string   `json:"componentId"`
			EvidenceOnly bool     `json:"evidenceOnly"`
		}
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeJSON(w, http.StatusRequestEntityTooLarge, "request body exceeds 10 MiB")
				return
			}
			writeJSON(w, http.StatusBadRequest, "invalid request")
			return
		}
		if err := dec.Decode(&struct{}{}); err != io.EOF {
			writeJSON(w, http.StatusBadRequest, "invalid request")
			return
		}
		if req.Workspace == "" || req.Change == "" || strings.TrimSpace(req.Message) == "" {
			writeJSON(w, http.StatusBadRequest, "workspace, change and message required")
			return
		}
		if len(req.ContextFiles) > 8 {
			writeJSON(w, http.StatusRequestEntityTooLarge, "at most 8 context files")
			return
		}
		for _, image := range req.Images {
			if !strings.HasPrefix(image, "data:image/") || !strings.Contains(image, ";base64,") {
				writeJSON(w, http.StatusBadRequest, "invalid image")
				return
			}
		}
		var items []ContextItem
		if resolver == nil {
			writeJSON(w, http.StatusServiceUnavailable, "context resolver unavailable")
			return
		}
		items, err := resolver.ResolveContext(req.Workspace, req.ComponentID, req.ContextFiles, req.EvidenceOnly)
		if err != nil {
			var ce *ContextError
			if errors.As(err, &ce) && ce.Status >= 400 && ce.Status < 600 {
				writeJSON(w, ce.Status, ce.Message)
			} else {
				writeJSON(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		total := 0
		for _, item := range items {
			n := len(item.Content)
			if !utf8.ValidString(item.Content) {
				writeJSON(w, http.StatusUnsupportedMediaType, "context source is not UTF-8 text")
				return
			}
			if n > 256<<10 || total+n > 1<<20 {
				writeJSON(w, http.StatusRequestEntityTooLarge, "context source limit exceeded")
				return
			}
			total += n
		}
		if len(items) > 8 {
			writeJSON(w, http.StatusRequestEntityTooLarge, "at most 8 context files")
			return
		}
		cfg, err := LoadConfig()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		workspaceProvider := ""
		if models != nil {
			var resolveErr error
			workspaceProvider, resolveErr = models.ModelForWorkspace(req.Workspace)
			if resolveErr != nil {
				writeJSON(w, http.StatusBadRequest, resolveErr.Error())
				return
			}
		}
		providerName, pcfg, err := cfg.ProviderForTask("chat", workspaceProvider)
		if err != nil || pcfg.APIKey == "" {
			writeJSON(w, http.StatusBadRequest, "请先在设置中配置 API Key")
			return
		}
		p := provider.Get(providerName)
		if p == nil {
			writeJSON(w, http.StatusInternalServerError, "provider not found")
			return
		}
		sessionID := req.ComponentID
		if sessionID == "" {
			sessionID = req.Change
		}
		conversationKey := sessionKey(req.Workspace, sessionID)
		if !store.BeginTurn(conversationKey) {
			writeJSON(w, http.StatusConflict, "conversation is busy")
			return
		}
		defer store.EndTurn(conversationKey)
		sess, err := store.Load(req.Workspace, sessionID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, "chat session unavailable: "+err.Error())
			return
		}

		systemPrompt := defaultSystemPrompt
		var refs []source.EvidenceReference
		used, omitted := 0, 0
		budget := cfg.ContextChars
		if budget <= 0 {
			budget = 24000
		}
		for _, item := range items {
			if used >= budget {
				omitted++
				continue
			}
			content := item.Content
			remaining := budget - used
			if utf8.RuneCountInString(content) > remaining {
				content = truncateUTF8(content, remaining)
				item.Reference.Excerpt = content
				item.Reference.Truncated = true
			} else {
				item.Reference.Excerpt = content
			}
			used += utf8.RuneCountInString(content)
			refs = append(refs, item.Reference)
			systemPrompt += fmt.Sprintf("\n\n<reference title=\"%s\" path=\"%s\">\n%s\n</reference>", html.EscapeString(item.Reference.Title), html.EscapeString(item.Reference.Path), html.EscapeString(content))
		}
		if !req.EvidenceOnly {
			if purposeResolver, ok := resolver.(WorkspacePurposeResolver); ok {
				purpose, purposeErr := purposeResolver.PurposeForWorkspace(req.Workspace)
				if purposeErr != nil {
					writeJSON(w, http.StatusInternalServerError, purposeErr.Error())
					return
				}
				remaining := budget - used
				if remaining > 0 && purpose != "" {
					purpose = truncateUTF8(purpose, remaining)
					used += utf8.RuneCountInString(purpose)
					systemPrompt += "\n\n<workspace_direction_not_evidence>\n" + html.EscapeString(purpose) + "\n</workspace_direction_not_evidence>"
				}
			}
		}
		if req.IncludeGraph && !req.EvidenceOnly {
			graphContext, graphErr := buildGraphContextForComponent(openspecDir, req.Change, req.ComponentID, true, wikiGraph)
			if graphErr != nil {
				writeJSON(w, http.StatusInternalServerError, "graph context unavailable: "+graphErr.Error())
				return
			}
			if graphContext != "" && used < budget {
				graphContext = truncateUTF8(graphContext, budget-used)
				used += utf8.RuneCountInString(graphContext)
				systemPrompt += "\n\n<untrusted_graph>\n" + html.EscapeString(graphContext) + "\n</untrusted_graph>"
			}
		}
		content := []provider.ContentBlock{{Type: "text", Text: req.Message}}
		for _, img := range req.Images {
			parts := strings.SplitN(img, ";base64,", 2)
			content = append(content, provider.ContentBlock{Type: "image", Source: &provider.ImageSource{Type: "base64", MediaType: strings.TrimPrefix(parts[0], "data:"), Data: parts[1]}})
		}
		userMsg := provider.Message{Role: "user", Content: content}
		messages := boundedHistory(sess.Messages, budget-used)
		messages = append(messages, userMsg)
		if req.EvidenceOnly {
			messages = []provider.Message{userMsg}
		}
		opts := provider.ChatOptions{Temperature: pcfg.Temperature, MaxTokens: pcfg.MaxTokens, Thinking: pcfg.Thinking}
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		eventCh, err := p.ChatStream(ctx, pcfg.APIKey, pcfg.APIBase, pcfg.Model, systemPrompt, messages, opts)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, "streaming not supported")
			return
		}
		send := func(v interface{}) { data, _ := json.Marshal(v); fmt.Fprintf(w, "data: %s\n\n", data); flusher.Flush() }
		send(map[string]interface{}{"type": "metadata", "references": refs, "context_chars": used, "context_budget": budget, "omitted_references": omitted, "answer_reserve_tokens": opts.MaxTokens})
		var thinkingBuf, textBuf strings.Builder
		completed := false
		for event := range eventCh {
			send(event)
			switch event.Type {
			case "thinking":
				thinkingBuf.WriteString(event.Content)
			case "delta":
				textBuf.WriteString(event.Content)
			case "done":
				completed = true
			case "error":
				return
			}
			if r.Context().Err() != nil {
				return
			}
		}
		if !completed {
			return
		}
		persistedUser := userMsg
		if len(req.Images) > 0 {
			persistedUser.Content = append([]provider.ContentBlock(nil), userMsg.Content[:1]...)
			persistedUser.Content[0].Text += "\n（图片仅用于本轮，未保存到会话历史）"
		}
		newMessages := append([]provider.Message(nil), sess.Messages...)
		newMessages = append(newMessages, persistedUser, provider.Message{Role: "assistant", Content: append([]provider.ContentBlock{{Type: "thinking", Thinking: thinkingBuf.String()}}, provider.ContentBlock{Type: "text", Text: textBuf.String()})})
		sess.Messages = newMessages
		sess.References = append(sess.References, []source.EvidenceReference{}, refs)
		sess.UpdatedAt = time.Now()
		if err := store.Save(sess); err != nil {
			send(provider.StreamEvent{Type: "error", Error: "session persistence failed"})
			return
		}
	}
}

func truncateUTF8(text string, chars int) string {
	if chars <= 0 {
		return ""
	}
	count := 0
	for index := range text {
		if count == chars {
			return text[:index]
		}
		count++
	}
	return text
}

func boundedHistory(history []provider.Message, budget int) []provider.Message {
	if budget <= 0 {
		return nil
	}
	recent := make([]provider.Message, 0, len(history))
	used := 0
	for i := len(history) - 1; i >= 0 && used < budget; i-- {
		message := history[i]
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		blocks := make([]provider.ContentBlock, 0, len(message.Content))
		for j := len(message.Content) - 1; j >= 0 && used < budget; j-- {
			block := message.Content[j]
			if block.Type != "text" {
				continue
			}
			n := utf8.RuneCountInString(block.Text)
			if n > budget-used {
				block.Text = truncateUTF8(block.Text, budget-used)
				n = budget - used
			}
			if n > 0 {
				used += n
				blocks = append(blocks, provider.ContentBlock{Type: "text", Text: block.Text})
			}
		}
		if len(blocks) == 0 {
			continue
		}
		for left, right := 0, len(blocks)-1; left < right; left, right = left+1, right-1 {
			blocks[left], blocks[right] = blocks[right], blocks[left]
		}
		message.Content = blocks
		recent = append(recent, message)
	}
	for left, right := 0, len(recent)-1; left < right; left, right = left+1, right-1 {
		recent[left], recent[right] = recent[right], recent[left]
	}
	return recent
}

type SessionAuthorizer interface {
	AuthorizeChatSession(workspace, componentID string) error
}

func HandleSession(authorizer SessionAuthorizer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workspace := r.URL.Query().Get("workspace")
		change := r.URL.Query().Get("componentId")
		if change == "" {
			change = r.URL.Query().Get("change")
		}
		if workspace == "" || change == "" {
			writeJSON(w, http.StatusBadRequest, "workspace and change required")
			return
		}
		if authorizer == nil {
			writeJSON(w, http.StatusServiceUnavailable, "session authorizer unavailable")
			return
		}
		if err := authorizer.AuthorizeChatSession(workspace, change); err != nil {
			var ce *ContextError
			if errors.As(err, &ce) && ce.Status >= 400 && ce.Status < 600 {
				writeJSON(w, ce.Status, ce.Message)
			} else {
				writeJSON(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		switch r.Method {
		case http.MethodGet:
			sess, err := store.Load(workspace, change)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, "chat session unavailable: "+err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(sess)
		case http.MethodDelete:
			if err := store.Delete(workspace, change); err != nil {
				writeJSON(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, "ok")
		default:
			writeJSON(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	}
}

func HandleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		cfg, err := LoadConfig()
		if err != nil {
			writeJSON(w, 500, err.Error())
			return
		}
		masked := maskConfig(cfg)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(masked)
	case "PUT":
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, "config body exceeds 1 MiB")
			return
		}
		var cfg Config
		if err := decodeConfigStrict(body, &cfg); err != nil {
			writeJSON(w, http.StatusBadRequest, "invalid config: "+err.Error())
			return
		}
		if cfg.SchemaVersion > 1 {
			writeJSON(w, http.StatusBadRequest, "unsupported config schema version")
			return
		}
		var present map[string]json.RawMessage
		if err := json.Unmarshal(body, &present); err != nil || present == nil {
			writeJSON(w, http.StatusBadRequest, "invalid config")
			return
		}
		existing, err := LoadConfig()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		cfg, err = mergeConfigUpdate(existing, cfg, present)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if cfg.ActiveProvider == "" {
			cfg.ActiveProvider = "minimax"
		}
		if err := SaveConfig(&cfg); err != nil {
			writeJSON(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, "ok")
	default:
		writeJSON(w, 405, "method not allowed")
	}
}

func HandleProviders(w http.ResponseWriter, r *http.Request) {
	cfg, _ := LoadConfig()
	active := ""
	if cfg != nil {
		active = cfg.ActiveProvider
	}
	resp := map[string]interface{}{
		"active":    active,
		"providers": provider.List(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// buildGraphContext preserves the legacy OpenSpec lookup for existing chat entrypoints.
func buildGraphContext(openspecDir, change string, includeGraph bool, wikiGraph WikiGraphAccessor) (string, error) {
	return buildGraphContextForComponent(openspecDir, change, "", includeGraph, wikiGraph)
}

func buildGraphContextForComponent(openspecDir, change, componentID string, includeGraph bool, wikiGraph WikiGraphAccessor) (string, error) {
	if !includeGraph || wikiGraph == nil {
		return "", nil
	}
	changeID := componentID
	if changeID == "" {
		changeDir := findChangeDir(openspecDir, change)
		if changeDir == "" {
			return "", nil
		}
		changeID = filepath.Join(changeDir, ".comet.yaml")
	}
	var b strings.Builder
	direct, secondHop := wikiGraph.Neighborhood(changeID)
	if len(direct) > 0 || len(secondHop) > 0 {
		b.WriteString("\n\n---\n\n## 图谱上下文\n\n")
		b.WriteString("当前 change 的直接关联：\n")
		for _, n := range direct {
			fmt.Fprintf(&b, "- [%s] %s\n", n.Kind, n.Title)
		}
		if len(secondHop) > 0 {
			b.WriteString("\n间接关联(2-hop)：\n")
			for _, title := range secondHop {
				fmt.Fprintf(&b, "- %s\n", title)
			}
		}
	}
	overview, err := wikiGraph.CommunityOverview(changeID)
	if err != nil {
		return "", err
	}
	if overview != "" {
		b.WriteString("\n\n## 所属主题综述\n\n")
		b.WriteString(overview)
	}
	return b.String(), nil
}

func findChangeDir(openspecDir, name string) string {
	dir := filepath.Join(openspecDir, "changes", name)
	if _, err := os.Stat(filepath.Join(dir, ".comet.yaml")); err == nil {
		return dir
	}
	archiveDir := filepath.Join(openspecDir, "changes", "archive")
	entries, _ := os.ReadDir(archiveDir)
	for _, e := range entries {
		if e.IsDir() && (e.Name() == name || (len(e.Name()) > 11 && e.Name()[11:] == name)) {
			return filepath.Join(archiveDir, e.Name())
		}
	}
	return ""
}

func maskConfig(cfg *Config) *Config {
	clone := *cfg
	clone.Providers = make(map[string]ProviderConfig)
	for k, v := range cfg.Providers {
		if v.APIKey != "" {
			v.APIKey = "****"
		}
		clone.Providers[k] = v
	}
	return &clone
}

func isMasked(key string) bool {
	return strings.Contains(key, "****")
}

func writeJSON(w http.ResponseWriter, code int, msg interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{"message": msg})
}
