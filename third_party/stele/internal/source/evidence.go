package source

// EvidenceReference identifies a bounded snapshot used for navigation or an answer.
// Reasons describe retrieval signals, not confidence that the content is true.
type EvidenceReference struct {
	ID        string   `json:"id"`
	Workspace string   `json:"workspace"`
	Title     string   `json:"title"`
	Type      string   `json:"type"`
	Path      string   `json:"path,omitempty"`
	Resource  string   `json:"resource,omitempty"`
	Version   string   `json:"version"`
	Excerpt   string   `json:"excerpt"`
	LineStart int      `json:"lineStart,omitempty"`
	LineEnd   int      `json:"lineEnd,omitempty"`
	Reasons   []string `json:"reasons"`
	Freshness string   `json:"freshness"`
	Truncated bool     `json:"truncated,omitempty"`
}
