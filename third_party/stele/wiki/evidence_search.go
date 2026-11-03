package wiki

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"stele/internal/source"
)

const maxEvidenceBytes = 2 << 20
const maxEvidenceExcerpt = 1200

var errEvidenceTooLarge = errors.New("document exceeds evidence limit")

// ReadEvidence returns a bounded excerpt from one registered document snapshot.
func (a *API) ReadEvidence(componentID, workspace, query string) (source.EvidenceReference, error) {
	component, ok := a.ComponentByID(componentID)
	if !ok || component.Type == TypeSession || component.Workspace != workspace {
		return source.EvidenceReference{}, os.ErrNotExist
	}
	var config source.Workspace
	found := false
	for _, ws := range a.workspacesSnapshot() {
		if ws.Alias == workspace {
			config, found = ws, true
			break
		}
	}
	if !found {
		return source.EvidenceReference{}, os.ErrNotExist
	}
	path, err := authorizedWorkspaceDocumentPath(config, component.Path)
	if err != nil {
		return source.EvidenceReference{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return source.EvidenceReference{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return source.EvidenceReference{}, err
	}
	if !info.Mode().IsRegular() {
		return source.EvidenceReference{}, errors.New("document is not a regular file")
	}
	if info.Size() > maxEvidenceBytes {
		return source.EvidenceReference{}, errEvidenceTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(f, maxEvidenceBytes+1))
	if err != nil {
		return source.EvidenceReference{}, err
	}
	if len(data) > maxEvidenceBytes {
		return source.EvidenceReference{}, errEvidenceTooLarge
	}
	version := sha256.Sum256(data)
	lines := bytes.Split(data, []byte("\n"))
	needle := []byte(strings.ToLower(strings.TrimSpace(query)))
	start, matched := 1, false
	if len(needle) > 0 {
		for i, line := range lines {
			if bytes.Contains(bytes.ToLower(line), needle) {
				start, matched = i+1, true
				break
			}
		}
	}
	from, to := start-2, start+1
	if from < 0 {
		from = 0
	}
	if to >= len(lines) {
		to = len(lines) - 1
	}
	var excerpt strings.Builder
	for i := from; i <= to; i++ {
		if i > from {
			excerpt.WriteByte('\n')
		}
		excerpt.Write(lines[i])
	}
	text := excerpt.String()
	runes := []rune(text)
	truncated := len(runes) > maxEvidenceExcerpt
	if truncated {
		text = string(runes[:maxEvidenceExcerpt])
	}
	reasons := []string{"semantic-preview"}
	if matched {
		reasons = []string{"literal-body"}
	}
	lineEnd := from + 1 + strings.Count(text, "\n")
	return source.EvidenceReference{ID: component.ID, Workspace: component.Workspace, Title: component.Title, Type: string(component.Type), Path: component.Path, Version: "doc-v1:" + hex.EncodeToString(version[:]), Excerpt: text, LineStart: from + 1, LineEnd: lineEnd, Reasons: reasons, Freshness: "current", Truncated: truncated}, nil
}

type evidenceRequest struct {
	ID        string `json:"id"`
	Workspace string `json:"workspace"`
	Query     string `json:"query"`
}

// HandleEvidencePOST serves bounded, workspace-scoped evidence snapshots.
func (a *API) HandleEvidencePOST(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var req evidenceRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.ID == "" || req.Workspace == "" {
		http.Error(w, "id and workspace are required", http.StatusBadRequest)
		return
	}
	ev, err := a.ReadEvidence(req.ID, req.Workspace, req.Query)
	if err != nil {
		switch {
		case errors.Is(err, os.ErrNotExist):
			http.Error(w, err.Error(), http.StatusNotFound)
		case errors.Is(err, os.ErrPermission):
			http.Error(w, err.Error(), http.StatusForbidden)
		case errors.Is(err, errEvidenceTooLarge):
			http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		default:
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ev)
}
