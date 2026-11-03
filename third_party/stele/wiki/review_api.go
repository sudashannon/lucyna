package wiki

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"stele/internal/claims"
	"stele/internal/review"
	"stele/internal/source"
)

const reviewBodyLimit = 1 << 20

type ReviewFinding struct {
	ID        string           `json:"id"`
	Workspace string           `json:"workspace"`
	Issue     LintIssue        `json:"issue"`
	Dismissed bool             `json:"dismissed"`
	Decision  *review.Decision `json:"decision,omitempty"`
}

type ReviewAPI struct {
	api              *API
	store            *review.Store
	browserWrite     func(*http.Request) bool
	resolveWorkspace func(string) (source.Workspace, error)
	verifyReferences func([]source.EvidenceReference) error
	createKnowledge  func(review.Candidate) (source.EvidenceReference, error)
	createTodo       func(issueID, workspace, revision, title, componentID string) (string, error)
}

func NewReviewAPI(a *API, store *review.Store, browserWrite func(*http.Request) bool,
	resolveWorkspace func(string) (source.Workspace, error),
	verifyReferences func([]source.EvidenceReference) error,
	createKnowledge func(review.Candidate) (source.EvidenceReference, error),
	createTodo func(issueID, workspace, revision, title, componentID string) (string, error),
) *ReviewAPI {
	return &ReviewAPI{api: a, store: store, browserWrite: browserWrite, resolveWorkspace: resolveWorkspace,
		verifyReferences: verifyReferences, createKnowledge: createKnowledge, createTodo: createTodo}
}

func stableRevision(value any) string {
	data, _ := json.Marshal(value)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func claimReviewRevision(claim claims.Claim, observed map[string]string) string {
	type identity struct {
		ID        string
		Workspace string
		DocID     string
		Kind      claims.Kind
		Truth     claims.Truth
		Intent    claims.Intent
		Text      string
		Evidence  []claims.Evidence
		Observed  map[string]string
	}
	evidence := make([]claims.Evidence, len(claim.Evidence))
	copy(evidence, claim.Evidence)
	for i := range evidence {
		evidence[i].VerifiedAt = ""
	}
	return stableRevision(identity{claim.ID, claim.Workspace, claim.DocID, claim.Kind, claim.Truth, claim.Intent, claim.Text, evidence, observed})
}

func (r *ReviewAPI) findings() ([]ReviewFinding, error) {
	r.api.mu.RLock()
	issues := r.api.graph.Lint()
	for i := range issues {
		if issues[i].Workspace == "" && issues[i].Rule != "stale-claim" {
			if c, ok := r.api.graph.components[issues[i].ComponentID]; ok {
				issues[i].Workspace = c.Workspace
			}
		}
		if issues[i].ID == "" {
			issues[i].ID = stableRevision([]string{issues[i].Workspace, issues[i].Rule, issues[i].Target, issues[i].ComponentID})
		}
	}
	r.api.mu.RUnlock()
	if issues == nil {
		issues = []LintIssue{}
	}
	var err error
	issues, err = r.api.claimLintIssues(issues)
	if err != nil {
		return nil, err
	}
	out := make([]ReviewFinding, 0, len(issues))
	for _, issue := range issues {
		finding := ReviewFinding{ID: issue.ID, Workspace: issue.Workspace, Issue: issue}
		if r.store != nil {
			finding.Dismissed = r.store.IsDismissed(issue.ID, issue.InputRevision)
			if decision, ok := r.store.DecisionFor(issue.ID); ok {
				finding.Decision = &decision
			}
		}
		out = append(out, finding)
	}
	return out, nil
}
func (r *ReviewAPI) Findings() ([]ReviewFinding, error) {
	return r.findings()
}

func (r *ReviewAPI) HandleReviews(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	findings, err := r.findings()
	if err != nil {
		http.Error(w, "failed to refresh review findings: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(findings)
}

type ReviewActionRequest struct {
	Action    string `json:"action"`
	Revision  string `json:"revision"`
	Workspace string `json:"workspace"`
	Reason    string `json:"reason,omitempty"`
	Title     string `json:"title,omitempty"`
}

func (r *ReviewAPI) HandleReviewAction(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.browserWrite == nil || !r.browserWrite(req) {
		http.Error(w, "write access denied", http.StatusForbidden)
		return
	}
	id := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/wiki/reviews/"), "/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "review id required", http.StatusBadRequest)
		return
	}
	var action ReviewActionRequest
	if err := decodeBounded(req.Body, &action); err != nil {
		writeReviewError(w, err)
		return
	}
	if err := r.decide(id, action); err != nil {
		writeReviewError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (r *ReviewAPI) decide(id string, action ReviewActionRequest) error {
	findings, err := r.findings()
	if err != nil {
		return err
	}
	var current *ReviewFinding
	for i := range findings {
		if findings[i].ID == id {
			current = &findings[i]
			break
		}
	}
	if current == nil {
		return review.ErrNotFound
	}
	if action.Workspace == "" || action.Workspace != current.Workspace || action.Revision == "" || action.Revision != current.Issue.InputRevision {
		return review.ErrConflict
	}
	switch action.Action {
	case "dismiss":
		if r.store == nil {
			return errors.New("review decisions are unavailable")
		}
		return r.store.Dismiss(id, action.Revision, action.Reason)
	case "todo":
		if r.createTodo == nil {
			return errors.New("todo creation is unavailable")
		}
		_, err := r.createTodo(id, current.Workspace, action.Revision, action.Title, current.Issue.ComponentID)
		return err
	case "reverify", "retract":
		if current.Issue.Rule != "stale-claim" {
			return fmt.Errorf("%w: claim action only applies to stale claims", review.ErrInvalid)
		}
		parts := strings.SplitN(strings.TrimPrefix(current.Issue.Target, "claim:"), "/", 2)
		if len(parts) != 2 || parts[0] != action.Workspace {
			return fmt.Errorf("%w: claim workspace mismatch", review.ErrInvalid)
		}
		store := r.api.ClaimsStoreSnapshot()
		if store == nil {
			return errors.New("claims store is unavailable")
		}
		claim, ok := store.ByKey(parts[0], parts[1])
		if !ok {
			return review.ErrNotFound
		}
		if action.Action == "retract" {
			_, err := store.Retract(parts[0], []string{parts[1]})
			if err == nil && r.api.SSE != nil {
				r.api.SSE.BroadcastNamed("claims-updated", `{"retracted":1}`)
			}
			return err
		}
		outcome := r.api.claimsResolver().CheckClaim(claim)
		observedRevision := claimReviewRevision(claim, outcome.Versions)
		if observedRevision != action.Revision || (outcome.Stale && outcome.Reason != claims.StaleReasonVersionChanged) {
			return review.ErrConflict
		}
		if err := store.MarkVerifiedIfUnchanged(claim, outcome.Versions); err != nil {
			if errors.Is(err, claims.ErrRevisionConflict) {
				return review.ErrConflict
			}
			return err
		}
		r.api.refreshClaimVectors([]string{claim.ID})
		if r.api.SSE != nil {
			r.api.SSE.BroadcastNamed("claims-updated", `{"verified":1}`)
		}
		return nil
	default:
		return fmt.Errorf("%w: action must be reverify, retract, dismiss, or todo", review.ErrInvalid)
	}
}

type CandidateView struct {
	review.Candidate
	Revision string `json:"revision"`
}

func NewCandidateView(candidate review.Candidate) CandidateView {
	return CandidateView{Candidate: candidate, Revision: review.Revision(candidate)}
}

type CandidateRequest struct {
	Workspace   string                     `json:"workspace"`
	ComponentID string                     `json:"componentId"`
	Title       string                     `json:"title,omitempty"`
	Text        string                     `json:"text"`
	References  []source.EvidenceReference `json:"references"`
}

func (r *ReviewAPI) HandleCandidates(w http.ResponseWriter, req *http.Request) {
	switch req.Method {
	case http.MethodGet:
		if r.store == nil {
			http.Error(w, "candidate review unavailable", http.StatusServiceUnavailable)
			return
		}
		workspace := req.URL.Query().Get("workspace")
		if workspace != "" && r.resolveWorkspace != nil {
			if _, err := r.resolveWorkspace(workspace); err != nil {
				http.Error(w, "unknown workspace", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		candidates := r.store.List(workspace)
		views := make([]CandidateView, 0, len(candidates))
		for _, candidate := range candidates {
			views = append(views, NewCandidateView(candidate))
		}
		_ = json.NewEncoder(w).Encode(views)
	case http.MethodPost:
		if r.browserWrite == nil || !r.browserWrite(req) {
			http.Error(w, "write access denied", http.StatusForbidden)
			return
		}
		var input CandidateRequest
		if err := decodeBounded(req.Body, &input); err != nil {
			writeReviewError(w, err)
			return
		}
		candidate, created, err := r.createCandidate(input)
		if err != nil {
			writeReviewError(w, err)
			return
		}
		status := http.StatusCreated
		if !created {
			status = http.StatusOK
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(struct {
			ID        string        `json:"id"`
			Candidate CandidateView `json:"candidate"`
		}{candidate.ID, NewCandidateView(candidate)})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (r *ReviewAPI) createCandidate(input CandidateRequest) (review.Candidate, bool, error) {
	if r.store == nil || r.resolveWorkspace == nil {
		return review.Candidate{}, false, errors.New("candidate review is unavailable")
	}
	workspace, err := r.resolveWorkspace(input.Workspace)
	if err != nil {
		return review.Candidate{}, false, fmt.Errorf("%w: unknown workspace: %v", review.ErrForbidden, err)
	}
	if input.ComponentID == "" || input.Text == "" {
		return review.Candidate{}, false, fmt.Errorf("%w: componentId and text are required", review.ErrInvalid)
	}
	component, ok := r.api.ComponentByID(input.ComponentID)
	if ok {
		if component.Type == TypeSession || component.Workspace != input.Workspace {
			return review.Candidate{}, false, review.ErrForbidden
		}
	} else {
		path, err := authorizedWorkspaceDocumentPath(workspace, input.ComponentID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return review.Candidate{}, false, review.ErrNotFound
			}
			return review.Candidate{}, false, review.ErrForbidden
		}
		input.ComponentID = path
	}
	for _, ref := range input.References {
		if ref.Workspace == "" || ref.ID == "" || ref.Version == "" {
			return review.Candidate{}, false, fmt.Errorf("%w: references must include identity and version", review.ErrInvalid)
		}
	}
	return r.store.Create(review.Candidate{Workspace: input.Workspace, ComponentID: input.ComponentID, Title: input.Title, Text: input.Text, References: input.References})
}

type CandidateActionRequest struct {
	Action   string `json:"action"`
	Revision string `json:"revision"`
	Reason   string `json:"reason,omitempty"`
	Title    string `json:"title,omitempty"`
	Text     string `json:"text,omitempty"`
}

func (r *ReviewAPI) HandleCandidateAction(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.browserWrite == nil || !r.browserWrite(req) {
		http.Error(w, "write access denied", http.StatusForbidden)
		return
	}
	id := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/wiki/candidates/"), "/")
	if id == "" || strings.Contains(id, "/") {
		http.Error(w, "candidate id required", http.StatusBadRequest)
		return
	}
	var action CandidateActionRequest
	if err := decodeBounded(req.Body, &action); err != nil {
		writeReviewError(w, err)
		return
	}
	if r.store == nil {
		http.Error(w, "candidate review unavailable", http.StatusServiceUnavailable)
		return
	}
	_, ok := r.store.Get(id)
	if !ok {
		http.Error(w, review.ErrNotFound.Error(), http.StatusNotFound)
		return
	}
	var updated review.Candidate
	var err error
	switch action.Action {
	case "edit":
		updated, err = r.store.Update(id, action.Revision, action.Title, action.Text)
	case "reject":
		updated, err = r.store.SetStatus(id, action.Revision, review.CandidateRejected, action.Reason)
	case "adopt":
		if r.resolveWorkspace == nil || r.verifyReferences == nil || r.createKnowledge == nil {
			err = errors.New("candidate adoption is unavailable")
			break
		}
		updated, err = r.store.Adopt(id, action.Revision, func(candidate review.Candidate) error {
			if _, err := r.resolveWorkspace(candidate.Workspace); err != nil {
				return err
			}
			if err := r.verifyReferences(candidate.References); err != nil {
				return err
			}
			_, err := r.createKnowledge(candidate)
			return err
		})
	default:
		err = errors.New("action must be edit, reject, or adopt")
	}
	if err != nil {
		writeReviewError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(NewCandidateView(updated))
}

func decodeBounded(body io.Reader, dst any) error {
	data, err := io.ReadAll(io.LimitReader(body, reviewBodyLimit+1))
	if err != nil {
		return err
	}
	if len(data) > reviewBodyLimit {
		return review.ErrTooLarge
	}
	if err := json.Unmarshal(data, dst); err != nil {
		return fmt.Errorf("%w: %v", review.ErrInvalid, err)
	}
	return nil
}

func writeReviewError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, review.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, review.ErrConflict):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, review.ErrForbidden):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, review.ErrTooLarge):
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
	case errors.Is(err, review.ErrInvalid):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// MCPReview uses the same decision path as browser review, with the existing loopback+Bearer gate.
func (r *ReviewAPI) MCPReview(req *http.Request, id string, action ReviewActionRequest) error {
	r.api.mu.RLock()
	token := r.api.todoToken
	r.api.mu.RUnlock()
	if !r.api.mcpAuth(req, token) {
		return errors.New("write access denied: loopback + Bearer token required")
	}
	return r.decide(id, action)
}

func (r *ReviewAPI) MCPCandidateWrite(req *http.Request, id string, action CandidateActionRequest, input *CandidateRequest) (CandidateView, bool, error) {
	r.api.mu.RLock()
	token := r.api.todoToken
	r.api.mu.RUnlock()
	if !r.api.mcpAuth(req, token) {
		return CandidateView{}, false, errors.New("write access denied: loopback + Bearer token required")
	}
	if input != nil {
		c, created, err := r.createCandidate(*input)
		return NewCandidateView(c), created, err
	}
	if id == "" {
		return CandidateView{}, false, errors.New("candidate id required")
	}
	if action.Action == "edit" {
		c, err := r.store.Update(id, action.Revision, action.Title, action.Text)
		return NewCandidateView(c), false, err
	}
	if action.Action == "reject" {
		c, err := r.store.SetStatus(id, action.Revision, review.CandidateRejected, action.Reason)
		return NewCandidateView(c), false, err
	}
	if action.Action == "adopt" {
		if r.resolveWorkspace == nil || r.verifyReferences == nil || r.createKnowledge == nil {
			return CandidateView{}, false, errors.New("candidate adoption is unavailable")
		}
		c, err := r.store.Adopt(id, action.Revision, func(candidate review.Candidate) error {
			if _, err := r.resolveWorkspace(candidate.Workspace); err != nil {
				return err
			}
			if err := r.verifyReferences(candidate.References); err != nil {
				return err
			}
			_, err := r.createKnowledge(candidate)
			return err
		})
		return NewCandidateView(c), false, err
	}
	return CandidateView{}, false, errors.New("action must be edit, reject, or adopt")
}
