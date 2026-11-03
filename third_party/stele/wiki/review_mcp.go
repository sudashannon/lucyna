package wiki

import (
	"encoding/json"
	"fmt"
	"net/http"

	"stele/internal/source"
)

func (a *API) SetReviewAPI(reviewAPI *ReviewAPI) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reviewAPI = reviewAPI
}

var reviewMCPTools = []mcpTool{
	{Name: "wiki_review_list", Description: "列出工程知识复核项及输入版本；查看不会确认过期结论。", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"workspace": map[string]any{"type": "string"}}}},
	{Name: "wiki_review_action", Description: "按输入版本确认、撤回、忽略知识问题或显式创建待办；需要 loopback + Bearer。", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string"}, "workspace": map[string]any{"type": "string"}, "revision": map[string]any{"type": "string"}, "action": map[string]any{"type": "string", "enum": []string{"reverify", "retract", "dismiss", "todo"}}, "reason": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}}, "required": []string{"id", "workspace", "revision", "action"}}},
	{Name: "wiki_candidate_list", Description: "列出待审知识候选、引用快照与修改版本。", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"workspace": map[string]any{"type": "string"}}}},
	{Name: "wiki_candidate_create", Description: "保存带来源证据的知识候选，不直接改写权威文档；需要 loopback + Bearer。", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"workspace": map[string]any{"type": "string"}, "componentId": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}, "text": map[string]any{"type": "string"}, "references": map[string]any{"type": "array", "items": map[string]any{"type": "object"}}}, "required": []string{"workspace", "componentId", "text", "references"}}},
	{Name: "wiki_candidate_action", Description: "按版本编辑、拒绝或采用知识候选；采用只新建知识文档，不覆盖已有设计/spec；需要 loopback + Bearer。", InputSchema: map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string"}, "action": map[string]any{"type": "string", "enum": []string{"edit", "reject", "adopt"}}, "revision": map[string]any{"type": "string"}, "title": map[string]any{"type": "string"}, "text": map[string]any{"type": "string"}, "reason": map[string]any{"type": "string"}}, "required": []string{"id", "action", "revision"}}},
}

func init() {
	mcpTools = append(mcpTools, reviewMCPTools...)
}

func reviewMCPResult(value any, err error) mcpToolResult {
	if err != nil {
		return mcpToolResult{Content: []mcpContent{{Type: "text", Text: err.Error()}}, IsError: true}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return mcpToolResult{Content: []mcpContent{{Type: "text", Text: "review response encoding failed"}}, IsError: true}
	}
	return mcpToolResult{Content: []mcpContent{{Type: "text", Text: string(data)}}}
}

func (a *API) mcpReviewOperation(request *http.Request, name string, args map[string]any) mcpToolResult {
	a.mu.RLock()
	service := a.reviewAPI
	a.mu.RUnlock()
	if service == nil {
		return reviewMCPResult(nil, fmt.Errorf("knowledge review is unavailable"))
	}
	workspace, _ := args["workspace"].(string)
	switch name {
	case "wiki_review_list":
		findings, err := service.Findings()
		if err != nil {
			return reviewMCPResult(nil, err)
		}
		filtered := make([]ReviewFinding, 0, len(findings))
		for _, finding := range findings {
			if workspace == "" || finding.Workspace == workspace {
				filtered = append(filtered, finding)
			}
		}
		return reviewMCPResult(filtered, nil)
	case "wiki_candidate_list":
		candidates := service.store.List(workspace)
		views := make([]CandidateView, len(candidates))
		for i, candidate := range candidates {
			views[i] = NewCandidateView(candidate)
		}
		return reviewMCPResult(views, nil)
	}
	data, err := json.Marshal(args)
	if err != nil {
		return reviewMCPResult(nil, err)
	}
	var input struct {
		ID          string                     `json:"id"`
		Workspace   string                     `json:"workspace"`
		ComponentID string                     `json:"componentId"`
		Action      string                     `json:"action"`
		Revision    string                     `json:"revision"`
		Title       string                     `json:"title"`
		Text        string                     `json:"text"`
		Reason      string                     `json:"reason"`
		References  []source.EvidenceReference `json:"references"`
	}
	if err := json.Unmarshal(data, &input); err != nil {
		return reviewMCPResult(nil, err)
	}
	if name == "wiki_review_action" {
		err := service.MCPReview(request, input.ID, ReviewActionRequest{Action: input.Action, Revision: input.Revision, Workspace: input.Workspace, Reason: input.Reason, Title: input.Title})
		return reviewMCPResult(map[string]any{"applied": err == nil}, err)
	}
	if name == "wiki_candidate_create" {
		candidate, created, err := service.MCPCandidateWrite(request, "", CandidateActionRequest{}, &CandidateRequest{Workspace: input.Workspace, ComponentID: input.ComponentID, Title: input.Title, Text: input.Text, References: input.References})
		return reviewMCPResult(map[string]any{"created": created, "candidate": candidate}, err)
	}
	candidate, _, err := service.MCPCandidateWrite(request, input.ID, CandidateActionRequest{Action: input.Action, Revision: input.Revision, Reason: input.Reason, Title: input.Title, Text: input.Text}, nil)
	return reviewMCPResult(candidate, err)
}
