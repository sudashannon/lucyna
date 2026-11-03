package chat

import (
	"errors"

	"stele/internal/source"
)

// ContextItem is an authorized, immutable source snapshot assembled by the live registry.
type ContextItem struct {
	Reference source.EvidenceReference
	Content   string
}

// ContextResolver resolves and authorizes every requested source before model access.
type ContextResolver interface {
	ResolveContext(workspace, componentID string, files []string, evidenceOnly bool) ([]ContextItem, error)
}

var ErrContextNotFound = errors.New("context source not found")
var ErrContextUnsupported = errors.New("context source is not UTF-8 text")
var ErrContextTooLarge = errors.New("context source exceeds size limit")
var ErrContextForbidden = errors.New("context source is not authorized")
