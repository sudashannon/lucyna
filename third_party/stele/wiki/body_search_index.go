package wiki

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"stele/internal/source"
)

// bodySearchIndex is a rebuildable, in-memory full-text index. A compact
// two-byte Bloom filter per document rejects most nonmatches before the exact
// substring check. The source files remain authoritative for returned evidence.
type bodySearchIndex struct {
	mu             sync.RWMutex
	entries        map[string]bodySearchEntry
	ready, running bool
	readySignal    chan struct{}
	generation     uint64
	components     map[string]Component
	workspaces     []WorkspaceConfig
}

type bodySearchEntry struct {
	path, workspace, root, text string
	kind                        source.Kind
	size, modified              int64
	filter                      [1024]uint64
}

func newBodySearchIndex() *bodySearchIndex { return &bodySearchIndex{} }

func (a *API) scheduleBodyIndex() {
	a.scheduleChangedBodyIndex(nil)
}

func (a *API) scheduleChangedBodyIndex(changed []string) {
	if a.bodyIndex == nil {
		return
	}
	workspaces := a.workspacesSnapshot()
	a.mu.RLock()
	components := make(map[string]Component, len(a.graph.Components()))
	for id, c := range a.graph.Components() {
		components[id] = c
	}
	a.mu.RUnlock()
	a.bodyIndex.schedule(components, workspaces, changed)
}

func (b *bodySearchIndex) schedule(components map[string]Component, workspaces []WorkspaceConfig, changed []string) {
	b.mu.Lock()
	if len(changed) > 0 {
		// Never reuse a cached body for a watcher-reported edit, including edits
		// that preserve the source file's size and timestamp.
		invalid := make(map[string]struct{}, len(changed))
		for _, path := range changed {
			invalid[filepath.Clean(path)] = struct{}{}
		}
		kept := make(map[string]bodySearchEntry, len(b.entries))
		for id, entry := range b.entries {
			if _, dirty := invalid[filepath.Clean(entry.path)]; !dirty {
				kept[id] = entry
			}
		}
		b.entries = kept
	}
	b.generation++
	b.components, b.workspaces = components, workspaces
	b.ready = false
	if b.running {
		b.mu.Unlock()
		return
	}
	b.running = true
	b.readySignal = make(chan struct{})
	b.mu.Unlock()
	go b.build()
}

func (b *bodySearchIndex) build() {
	for {
		b.mu.RLock()
		generation, components, workspaces, previous := b.generation, b.components, b.workspaces, b.entries
		b.mu.RUnlock()
		roots := make(map[string]source.Workspace, len(workspaces))
		for _, ws := range workspaces {
			roots[ws.Alias] = ws
		}
		next := make(map[string]bodySearchEntry, len(components))
		type workItem struct {
			id        string
			component Component
		}
		jobs := make(chan workItem)
		var workers sync.WaitGroup
		var nextMu sync.Mutex
		for i := 0; i < 8; i++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for job := range jobs {
					id, component := job.id, job.component
					if component.Type == TypeSession || !isSearchMarkdown(component.Path) {
						continue
					}
					ws, ok := roots[component.Workspace]
					if !ok {
						continue
					}
					info, err := os.Stat(component.Path)
					if err != nil || !info.Mode().IsRegular() || info.Size() > maxEvidenceBytes {
						continue
					}
					if cached, ok := previous[id]; ok && cached.path == component.Path && cached.workspace == component.Workspace && cached.root == ws.Path && cached.kind == ws.Type && cached.size == info.Size() && cached.modified == info.ModTime().UnixNano() {
						nextMu.Lock()
						next[id] = cached
						nextMu.Unlock()
						continue
					}
					path, err := authorizedWorkspaceDocumentPath(ws, component.Path)
					if err != nil {
						continue
					}
					data, err := os.ReadFile(path)
					if err != nil || len(data) > maxEvidenceBytes {
						continue
					}
					entry := bodySearchEntry{path: component.Path, workspace: component.Workspace, root: ws.Path, kind: ws.Type, text: strings.ToLower(string(data)), size: info.Size(), modified: info.ModTime().UnixNano()}
					for i := 0; i+1 < len(entry.text); i++ {
						n := uint16(entry.text[i])<<8 | uint16(entry.text[i+1])
						entry.filter[n/64] |= uint64(1) << (n % 64)
					}
					nextMu.Lock()
					next[id] = entry
					nextMu.Unlock()
				}
			}()
		}
		for id, component := range components {
			jobs <- workItem{id, component}
		}
		close(jobs)
		workers.Wait()
		b.mu.Lock()
		if b.generation == generation {
			b.entries = next
			b.ready = true
			b.running = false
			close(b.readySignal)
			b.mu.Unlock()
			return
		}
		// A newer change may invalidate cached data; never publish this older pass.
		b.mu.Unlock()
	}
}

// Give an in-progress initial build a short opportunity to finish instead of
// immediately starting an expensive, duplicate full scan for every search.
func (b *bodySearchIndex) waitCandidates(query string, timeout time.Duration) ([]string, bool) {
	if matches, ready := b.candidates(query); ready {
		return matches, true
	}
	b.mu.RLock()
	signal := b.readySignal
	b.mu.RUnlock()
	if signal == nil {
		return nil, false
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-signal:
		return b.candidates(query)
	case <-timer.C:
		return nil, false
	}
}

func (b *bodySearchIndex) candidates(query string) ([]string, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if !b.ready {
		return nil, false
	}
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return nil, true
	}
	result := make([]string, 0)
	for id, entry := range b.entries {
		possible := true
		for i := 0; i+1 < len(needle); i++ {
			n := uint16(needle[i])<<8 | uint16(needle[i+1])
			if entry.filter[n/64]&(uint64(1)<<(n%64)) == 0 {
				possible = false
				break
			}
		}
		if possible && strings.Contains(entry.text, needle) {
			result = append(result, id)
		}
	}
	return result, true
}
