package sessions

import (
	"sort"
	"strings"
	"unicode/utf8"
)

// SearchOptions bounds a passage search. Case-insensitive by default because
// session text mixes prose with camelCase identifiers, and a reader searching
// "force_link_up" does not distinguish Force_Link_Up.
type SearchOptions struct {
	// MatchCase keeps the search case-sensitive; off by default.
	MatchCase bool
	// Limit caps returned hits; 0 means no cap.
	Limit int
	// Origin filters to one part transcript by its base name (a subagent's
	// dispatch name). Empty matches everything.
	Origin string
}

// PassageHit is one match: the passage plus its position in the text, so a UI
// can show the matched substring without re-scanning.
type PassageHit struct {
	Passage
	// ByteOffset locates the first match within the (possibly truncated)
	// passage text. It is a byte offset into the stored string, which is what
	// Go slicing needs to render the context window.
	ByteOffset int
}

// SearchPassages finds the literal needle in a digest's passages. The needle
// is matched literally - no regex - because the common queries are error
// strings, file paths, and symbols, and regex escaping is a tax on every
// caller. Hits come back in reading order (seq), which is the natural order
// for "where in this session did this happen".
func SearchPassages(digest Digest, needle string, opts SearchOptions) []PassageHit {
	needle = strings.TrimSpace(needle)
	if needle == "" {
		return nil
	}
	needleLower := needle
	if !opts.MatchCase {
		needleLower = strings.ToLower(needle)
	}
	var hits []PassageHit
	for _, passage := range digest.Passages {
		if opts.Origin != "" && passage.Origin != opts.Origin {
			continue
		}
		text := passage.Text
		if !opts.MatchCase {
			text = strings.ToLower(text)
		}
		at := strings.Index(text, needleLower)
		if at < 0 {
			continue
		}
		// The case-insensitive index points into the lowercased copy, whose
		// byte length can differ from the original (e.g. `İ`). Map it back so
		// ByteOffset always slices the original text on a rune boundary.
		offset := at
		if !opts.MatchCase {
			offset = byteOffsetInOriginal(passage.Text, at)
		}
		hits = append(hits, PassageHit{Passage: passage, ByteOffset: offset})
		if opts.Limit > 0 && len(hits) >= opts.Limit {
			break
		}
	}
	return hits
}

// byteOffsetInOriginal maps an offset in the case-folded copy of text back to
// the corresponding offset in text itself: both strings decompose into the
// same rune sequence, so advancing rune counts in lockstep recovers the byte
// position in the original.
func byteOffsetInOriginal(text string, foldedAt int) int {
	folded := strings.ToLower(text)
	if foldedAt >= len(folded) {
		return len(text)
	}
	runeIndex := utf8.RuneCountInString(folded[:foldedAt])
	count := 0
	for at := range text {
		if count == runeIndex {
			return at
		}
		count++
	}
	return len(text)
}

// ContextWindow returns the passages around seq: span before it and span after
// it, clamped to the digest's range. The hit passage itself is always first in
// the result so a client can anchor on it.
func ContextWindow(digest Digest, seq int, span int) []Passage {
	if span < 0 {
		span = 0
	}
	lo := seq - span
	if lo < 0 {
		lo = 0
	}
	hi := seq + span
	if hi > len(digest.Passages)-1 {
		hi = len(digest.Passages) - 1
	}
	if lo > hi {
		return nil
	}
	out := make([]Passage, 0, hi-lo+1)
	for i := lo; i <= hi; i++ {
		out = append(out, digest.Passages[i])
	}
	return out
}

// SessionSearchResult is one session's contribution to a cross-session search,
// grouped so a UI can show "3 hits in this session" instead of a flat list.
type SessionSearchResult struct {
	Digest Digest
	Hits   []PassageHit
}

// SearchAcrossSessions runs a literal search over every merged digest and
// returns the sessions that matched, best first: more hits rank higher, then
// more recently active sessions. Sessions whose only matches are subagent
// passages still rank as their own session - the reader wants the session,
// not the transcript bookkeeping.
func SearchAcrossSessions(digests []Digest, needle string, opts SearchOptions) []SessionSearchResult {
	var results []SessionSearchResult
	for _, digest := range digests {
		hits := SearchPassages(digest, needle, opts)
		if len(hits) == 0 {
			continue
		}
		results = append(results, SessionSearchResult{Digest: digest, Hits: hits})
	}
	sort.Slice(results, func(i, j int) bool {
		left, right := results[i], results[j]
		if len(left.Hits) != len(right.Hits) {
			return len(left.Hits) > len(right.Hits)
		}
		if !left.Digest.UpdatedAt.Equal(right.Digest.UpdatedAt) {
			return left.Digest.UpdatedAt.After(right.Digest.UpdatedAt)
		}
		return left.Digest.Path < right.Digest.Path
	})
	return results
}
