package review

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"stele/internal/appdir"
	"stele/internal/source"
)

const schemaVersion = 1

var ErrInvalid = errors.New("review: invalid request")
var ErrForbidden = errors.New("review: forbidden")
var ErrTooLarge = errors.New("review: request too large")
var ErrNotFound = errors.New("review: not found")
var ErrConflict = errors.New("review: revision conflict")

func StorePath() string { return appdir.Path("review.json") }

type CandidateStatus string

const (
	CandidatePending  CandidateStatus = "pending"
	CandidateRejected CandidateStatus = "rejected"
	CandidateAdopted  CandidateStatus = "adopted"
)

type Candidate struct {
	ID          string                     `json:"id"`
	Workspace   string                     `json:"workspace"`
	ComponentID string                     `json:"componentId"`
	Title       string                     `json:"title,omitempty"`
	Text        string                     `json:"text"`
	References  []source.EvidenceReference `json:"references"`
	Status      CandidateStatus            `json:"status"`
	CreatedAt   string                     `json:"createdAt"`
	UpdatedAt   string                     `json:"updatedAt"`
}

type Decision struct {
	ID            string `json:"id"`
	Action        string `json:"action"`
	InputRevision string `json:"inputRevision"`
	At            string `json:"at"`
	Reason        string `json:"reason,omitempty"`
}

type envelope struct {
	SchemaVersion int         `json:"schemaVersion"`
	Candidates    []Candidate `json:"candidates"`
	Decisions     []Decision  `json:"decisions"`
}

type Store struct {
	mu         sync.RWMutex
	path       string
	candidates map[string]Candidate
	decisions  map[string]Decision
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path, candidates: map[string]Candidate{}, decisions: map[string]Decision{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := ValidateSnapshot(data); err != nil {
		return nil, fmt.Errorf("review: parse %s: %w", path, err)
	}
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	for _, candidate := range env.Candidates {
		s.candidates[candidate.ID] = cloneCandidate(candidate)
	}
	for _, decision := range env.Decisions {
		s.decisions[decision.ID] = decision
	}
	return s, nil
}

// ValidateSnapshot is also used by recovery preflight before any file is installed.
func ValidateSnapshot(data []byte) error {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return err
	}
	if env.SchemaVersion != schemaVersion {
		return fmt.Errorf("review: unsupported schema version %d", env.SchemaVersion)
	}
	seen := map[string]bool{}
	for _, c := range env.Candidates {
		if c.ID == "" || c.Workspace == "" || c.ComponentID == "" || c.Text == "" || seen[c.ID] {
			return errors.New("review: invalid or duplicate candidate")
		}
		if c.Status != CandidatePending && c.Status != CandidateRejected && c.Status != CandidateAdopted {
			return errors.New("review: invalid candidate status")
		}
		seen[c.ID] = true
	}
	return nil
}

func (s *Store) List(workspace string) []Candidate {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Candidate, 0, len(s.candidates))
	for _, c := range s.candidates {
		if workspace == "" || c.Workspace == workspace {
			out = append(out, cloneCandidate(c))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

func (s *Store) Get(id string) (Candidate, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.candidates[id]
	return cloneCandidate(c), ok
}

// Create deduplicates the same selected text and references in a workspace/component.
func (s *Store) Create(c Candidate) (Candidate, bool, error) {
	if c.Workspace == "" || c.ComponentID == "" || c.Text == "" {
		return Candidate{}, false, fmt.Errorf("%w: workspace, componentId and text are required", ErrInvalid)
	}
	identity, err := json.Marshal(struct {
		Workspace string                     `json:"workspace"`
		Component string                     `json:"component"`
		Text      string                     `json:"text"`
		Refs      []source.EvidenceReference `json:"references"`
	}{c.Workspace, c.ComponentID, c.Text, c.References})
	if err != nil {
		return Candidate{}, false, err
	}
	sum := sha256.Sum256(identity)
	c.ID = "candidate." + hex.EncodeToString(sum[:16])
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.candidates[c.ID]; ok {
		return cloneCandidate(existing), false, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	c.Status, c.CreatedAt, c.UpdatedAt = CandidatePending, now, now
	proposed := cloneCandidates(s.candidates)
	proposed[c.ID] = cloneCandidate(c)
	if err := s.persist(proposed, s.decisions); err != nil {
		return Candidate{}, false, err
	}
	s.candidates = proposed
	return cloneCandidate(c), true, nil
}

// SetStatus compare-and-swaps rejection; adoption must use Adopt's writer gate.
func (s *Store) SetStatus(id, revision string, status CandidateStatus, reason string) (Candidate, error) {
	if status != CandidateRejected {
		return Candidate{}, fmt.Errorf("%w: use Adopt to accept candidates", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.candidates[id]
	if !ok {
		return Candidate{}, ErrNotFound
	}
	if c.Status == status {
		return cloneCandidate(c), nil
	}
	if c.Status != CandidatePending || Revision(c) != revision {
		return Candidate{}, ErrConflict
	}
	proposed := cloneCandidates(s.candidates)
	c.Status = status
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	proposed[id] = c
	decisions := cloneDecisions(s.decisions)
	decisions[id] = Decision{ID: id, Action: string(status), InputRevision: revision, At: c.UpdatedAt, Reason: reason}
	if err := s.persist(proposed, decisions); err != nil {
		return Candidate{}, err
	}
	s.candidates, s.decisions = proposed, decisions
	return cloneCandidate(c), nil
}

func Revision(c Candidate) string {
	b, _ := json.Marshal(c)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (s *Store) persist(candidates map[string]Candidate, decisions map[string]Decision) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	env := envelope{SchemaVersion: schemaVersion}
	for _, c := range candidates {
		env.Candidates = append(env.Candidates, c)
	}
	for _, d := range decisions {
		env.Decisions = append(env.Decisions, d)
	}

	sort.Slice(env.Candidates, func(i, j int) bool { return env.Candidates[i].ID < env.Candidates[j].ID })
	sort.Slice(env.Decisions, func(i, j int) bool { return env.Decisions[i].ID < env.Decisions[j].ID })
	data, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".review-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.path)
}

func cloneCandidate(c Candidate) Candidate {
	c.References = append([]source.EvidenceReference(nil), c.References...)
	for i := range c.References {
		c.References[i].Reasons = append([]string(nil), c.References[i].Reasons...)
	}
	return c
}

func cloneCandidates(in map[string]Candidate) map[string]Candidate {
	out := make(map[string]Candidate, len(in))
	for id, c := range in {
		out[id] = cloneCandidate(c)
	}
	return out
}

func cloneDecisions(in map[string]Decision) map[string]Decision {
	out := make(map[string]Decision, len(in))
	for id, d := range in {
		out[id] = d
	}
	return out
}
func (s *Store) Update(id, revision, title, text string) (Candidate, error) {
	if text == "" {
		return Candidate{}, fmt.Errorf("%w: candidate text is required", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.candidates[id]
	if !ok {
		return Candidate{}, ErrNotFound
	}
	if c.Status != CandidatePending || Revision(c) != revision {
		return Candidate{}, ErrConflict
	}
	c.Title, c.Text = title, text
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	proposed := cloneCandidates(s.candidates)
	proposed[id] = c
	if err := s.persist(proposed, s.decisions); err != nil {
		return Candidate{}, err
	}
	s.candidates = proposed
	return cloneCandidate(c), nil
}

// Adopt serializes candidate acceptance with edits/rejections. The callback must
// perform idempotent create-only publication keyed by candidate ID.
func (s *Store) Adopt(id, revision string, create func(Candidate) error) (Candidate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.candidates[id]
	if !ok {
		return Candidate{}, ErrNotFound
	}
	if c.Status == CandidateAdopted {
		return cloneCandidate(c), nil
	}
	if c.Status != CandidatePending || Revision(c) != revision {
		return Candidate{}, ErrConflict
	}
	if create == nil {
		return Candidate{}, errors.New("review: adoption writer unavailable")
	}
	if err := create(cloneCandidate(c)); err != nil {
		return Candidate{}, err
	}
	proposed := cloneCandidates(s.candidates)
	c.Status = CandidateAdopted
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	proposed[id] = c
	decisions := cloneDecisions(s.decisions)
	decisions[id] = Decision{ID: id, Action: string(CandidateAdopted), InputRevision: revision, At: c.UpdatedAt}
	if err := s.persist(proposed, decisions); err != nil {
		return Candidate{}, err
	}
	s.candidates, s.decisions = proposed, decisions
	return cloneCandidate(c), nil
}

func (s *Store) Dismiss(issueID, inputRevision, reason string) error {
	if issueID == "" || inputRevision == "" {
		return fmt.Errorf("%w: issue id and input revision are required", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	decisions := cloneDecisions(s.decisions)
	decisions[issueID] = Decision{ID: issueID, Action: "dismiss", InputRevision: inputRevision, At: time.Now().UTC().Format(time.RFC3339Nano), Reason: reason}
	if err := s.persist(s.candidates, decisions); err != nil {
		return err
	}
	s.decisions = decisions
	return nil
}

func (s *Store) IsDismissed(issueID, inputRevision string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.decisions[issueID]
	return ok && d.Action == "dismiss" && d.InputRevision == inputRevision
}
func (s *Store) DecisionFor(issueID string) (Decision, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.decisions[issueID]
	return d, ok
}
