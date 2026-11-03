package wiki

import (
	"net/http"
	"strings"

	"stele/internal/sessions"
)

// passageQueryMaxBytes bounds a passage search. The search is a linear scan
// over a session's natural language (a few MB at the extreme), so the bound
// protects against pathological queries without limiting real ones.
const passageQueryMaxBytes = 512

// passageSearchLimit caps hits per request. A UI renders a page, not a corpus;
// the client pages by narrowing its query.
const passageSearchLimit = 30

// contextWindowSpan is how many neighboring passages a context request returns
// on each side of the hit. Large enough to carry the exchange around a
// decision, small enough that the response stays a page.
const contextWindowSpan = 3

// normalizePassageQuery validates a search query.
func normalizePassageQuery(raw string) (string, bool) {
	query := strings.TrimSpace(raw)
	if query == "" || len(query) > passageQueryMaxBytes {
		return "", false
	}
	return query, true
}

// sessionPassageJSON is the wire form of one passage hit. ByteOffset lets the
// UI highlight the match; Origin names the subagent transcript a hit came
// from, so a merged session's results stay attributable.
type sessionPassageJSON struct {
	Seq        int    `json:"seq"`
	Role       string `json:"role"`
	Timestamp  string `json:"ts,omitempty"`
	Text       string `json:"text"`
	ByteOffset int    `json:"byteOffset"`
	Origin     string `json:"origin,omitempty"`
}

// HandleSessionSearch runs a literal search inside ONE session. It answers
// "where in this long session was X said" - the in-session find bar - and
// never touches other sessions.
func (a *API) HandleSessionSearch(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	query, ok := normalizePassageQuery(r.URL.Query().Get("q"))
	if id == "" || !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id and q are required (q at most 512 bytes)"})
		return
	}
	index, _ := a.sessionsSnapshot()
	if index == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session layer is not enabled"})
		return
	}
	digest, found := index.Digest(id)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	hits := sessions.SearchPassages(digest, query, sessions.SearchOptions{Limit: passageSearchLimit})
	out := make([]sessionPassageJSON, 0, len(hits))
	for _, hit := range hits {
		out = append(out, sessionPassageJSON{
			Seq:        hit.Seq,
			Role:       hit.Role,
			Timestamp:  hit.TS,
			Text:       hit.Text,
			ByteOffset: hit.ByteOffset,
			Origin:     hit.Origin,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"query": query, "hits": out, "total": len(digest.Passages)})
}

// HandleSessionPassages returns one session's passages around a seq: the
// context window a UI shows when a reader expands a hit.
func (a *API) HandleSessionPassages(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	seq, span, ok := parseSeqSpan(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "seq must be an integer; span at most 20"})
		return
	}
	index, _ := a.sessionsSnapshot()
	if index == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session layer is not enabled"})
		return
	}
	digest, found := index.Digest(id)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}
	window := sessions.ContextWindow(digest, seq, span)
	out := make([]sessionPassageJSON, 0, len(window))
	for _, passage := range window {
		out = append(out, sessionPassageJSON{
			Seq:       passage.Seq,
			Role:      passage.Role,
			Timestamp: passage.TS,
			Text:      passage.Text,
			Origin:    passage.Origin,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"seq": seq, "passages": out})
}

// HandleSessionsSearch runs a literal search across every indexed session and
// groups the hits by session, best session first. This is the entry point for
// "which conversation dealt with X" over the whole history.
func (a *API) HandleSessionsSearch(w http.ResponseWriter, r *http.Request) {
	query, ok := normalizePassageQuery(r.URL.Query().Get("q"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "q is required and must be at most 512 bytes"})
		return
	}
	limit := 5
	if raw := r.URL.Query().Get("limit"); raw != "" {
		// parsePositiveInt accepts negatives, so the > 0 check is what keeps
		// results[:limit] from panicking on ?limit=-1.
		if parsed, err := parsePositiveInt(raw); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}
	index, workspaces := a.sessionsSnapshot()
	if index == nil {
		writeJSON(w, http.StatusOK, map[string]any{"query": query, "sessions": []any{}})
		return
	}
	results := sessions.SearchAcrossSessions(index.Digests(), query, sessions.SearchOptions{})
	if len(results) > limit {
		results = results[:limit]
	}
	type sessionHitsJSON struct {
		ID        string               `json:"id"`
		Title     string               `json:"title"`
		Workspace string               `json:"workspace,omitempty"`
		UpdatedAt string               `json:"updatedAt"`
		HitCount  int                  `json:"hitCount"`
		Hits      []sessionPassageJSON `json:"hits"`
	}
	out := make([]sessionHitsJSON, 0, len(results))
	a.mu.RLock()
	defer a.mu.RUnlock()
	for _, result := range results {
		entry := sessionHitsJSON{
			ID:        result.Digest.Path,
			Title:     result.Digest.Title,
			UpdatedAt: result.Digest.UpdatedAt.Format("2006-01-02 15:04"),
			HitCount:  len(result.Hits),
			Hits:      []sessionPassageJSON{},
		}
		if component, ok := SessionComponent(result.Digest, workspaces); ok {
			entry.Workspace = component.Workspace
		}
		for _, hit := range result.Hits {
			entry.Hits = append(entry.Hits, sessionPassageJSON{
				Seq:        hit.Seq,
				Role:       hit.Role,
				Timestamp:  hit.TS,
				Text:       hit.Text,
				ByteOffset: hit.ByteOffset,
				Origin:     hit.Origin,
			})
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"query": query, "sessions": out})
}

// parseSeqSpan reads the seq and span query parameters for the context
// endpoint. A missing seq is an error; a missing span takes the default.
func parseSeqSpan(r *http.Request) (int, int, bool) {
	// parsePositiveInt accepts negatives and zero; seq must be a real index.
	seq, err := parsePositiveInt(r.URL.Query().Get("seq"))
	if err != nil || seq < 0 {
		return 0, 0, false
	}
	span := contextWindowSpan
	if raw := r.URL.Query().Get("span"); raw != "" {
		if parsed, err := parsePositiveInt(raw); err == nil && parsed > 0 && parsed <= 20 {
			span = parsed
		}
	}
	return seq, span, true
}
