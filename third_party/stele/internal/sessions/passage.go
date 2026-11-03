package sessions

import "unicode/utf8"

// Passage is one retrievable slice of a session's natural language: a user
// message, an assistant text answer, or a session title. It is derived data
// like the Digest itself - never tool output, never thinking, never transcript
// bytes beyond what a speaker actually wrote - and small enough that keeping
// every passage of every session in the digest cache stays affordable
// (measured: a 109 MB transcript yields ~1 MB of text).
//
// Seq counts retained passages within one transcript file, starting at 0. It
// is the locator a client can follow to reconstruct ordering; context windows
// read neighboring passages by seq, exactly like Funes' turn numbering.
type Passage struct {
	Seq    int    `json:"seq"`
	Role   string `json:"role"` // "user" | "assistant" | "session"
	TS     string `json:"ts"`   // RFC3339Nano event timestamp, may be empty
	Text   string `json:"text"`
	Origin string `json:"origin,omitempty"` // part-file base name for a subagent passage
}

// PassageLimit bounds a single passage. A user pasting a large file into the
// chat can produce one enormous text block; keeping it whole would bloat the
// cache for text almost nobody can search usefully.
const PassageLimit = 8000

// passageSink receives passages as the parser walks a transcript. Implementors
// must be safe to call from one parser goroutine only.
type passageSink interface {
	add(p Passage)
}

// passageSlice is the production sink: it collects into a slice owned by the
// parsing digest.
type passageSlice struct{ items *[]Passage }

func (s passageSlice) add(p Passage) { *s.items = append(*s.items, p) }

// truncatePassage caps a passage's text at PassageLimit runes, keeping the
// head: in practice errors and decisions appear at the start of a message.
func truncatePassage(text string) string {
	// RuneCountInString avoids the []rune allocation on the common path -
	// passages are almost always under the cap.
	if utf8.RuneCountInString(text) <= PassageLimit {
		return text
	}
	runes := []rune(text)
	return string(runes[:PassageLimit])
}
