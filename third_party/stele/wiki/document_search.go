package wiki

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"stele/internal/source"
)

const maxSearchSnapshotBytes = 32 << 20

func isSearchMarkdown(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".md" || ext == ".markdown"
}

func cloneSearchSnapshot(components map[string]Component, embeddings map[string][]float32) (map[string]Component, map[string][]float32) {
	componentCopy := make(map[string]Component, len(components))
	for id, component := range components {
		if component.Frontmatter != nil {
			frontmatter := make(map[string]any, len(component.Frontmatter))
			for key, value := range component.Frontmatter {
				frontmatter[key] = value
			}
			component.Frontmatter = frontmatter
		}
		componentCopy[id] = component
	}
	embeddingCopy := make(map[string][]float32, len(embeddings))
	for id, vector := range embeddings {
		embeddingCopy[id] = append([]float32(nil), vector...)
	}
	return componentCopy, embeddingCopy
}

// rankDocumentSearch supplements the shared lexical/vector ranker with bounded
// literal body candidates, reading each authorized document as one snapshot.
func (a *API) rankDocumentSearch(query string, requiredTags []string, queryVec []float32, components map[string]Component, embeddings map[string][]float32, taxonomy *Taxonomy) ([]semanticScoredResult, map[string]source.EvidenceReference) {
	ranked := rankSemanticSearch(query, requiredTags, queryVec, components, embeddings, taxonomy)
	evidence := make(map[string]source.EvidenceReference)
	if strings.TrimSpace(query) == "" {
		return ranked, evidence
	}
	ids := make([]string, 0, len(components))
	for id := range components {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var bytesBudget int64
	byID := make(map[string]int, len(ranked))
	for i, result := range ranked {
		byID[result.id] = i
	}
	if a.bodyIndex != nil {
		if matches, ready := a.bodyIndex.waitCandidates(query, 10*time.Second); ready {
			for _, id := range matches {
				if _, ok := components[id]; !ok {
					continue
				}
				if index, ok := byID[id]; ok {
					if ranked[index].lexicalRank == semanticNoLexicalMatch {
						ranked[index].lexicalRank = semanticBodyMatch
						ranked[index].score = 0.35
					}
					continue
				}
				component := components[id]
				ranked = append(ranked, semanticScoredResult{id: id, score: 0.35, lexicalRank: semanticBodyMatch, typeOrder: semanticTypeOrder(component.Type)})
			}
			return sortDocumentResults(ranked), evidence
		}
	}
	for _, id := range ids {
		component := components[id]
		if component.Type == TypeSession || !isSearchMarkdown(component.Path) {
			continue
		}
		info, err := os.Stat(component.Path)
		if err != nil || !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > maxEvidenceBytes || bytesBudget+info.Size() > maxSearchSnapshotBytes {
			continue
		}
		bytesBudget += info.Size()
		reference, err := a.ReadEvidence(id, component.Workspace, query)
		if err != nil || len(reference.Reasons) == 0 || reference.Reasons[0] != "literal-body" {
			continue
		}
		evidence[id] = reference
		if index, ok := byID[id]; ok {
			if ranked[index].lexicalRank == semanticNoLexicalMatch {
				ranked[index].lexicalRank = semanticBodyMatch
				ranked[index].score = 0.35
			}
			continue
		}
		ranked = append(ranked, semanticScoredResult{id: id, score: 0.35, lexicalRank: semanticBodyMatch, typeOrder: semanticTypeOrder(component.Type)})
	}
	return sortDocumentResults(ranked), evidence
}

func sortDocumentResults(ranked []semanticScoredResult) []semanticScoredResult {
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].lexicalRank != ranked[j].lexicalRank {
			return ranked[i].lexicalRank < ranked[j].lexicalRank
		}
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		if ranked[i].typeOrder != ranked[j].typeOrder {
			return ranked[i].typeOrder < ranked[j].typeOrder
		}
		return ranked[i].id < ranked[j].id
	})
	return ranked
}
func (a *API) selectedEvidence(query string, results []semanticScoredResult, components map[string]Component, evidence map[string]source.EvidenceReference) {
	type evidenceJob struct {
		id        string
		component Component
	}
	jobs := make(chan evidenceJob)
	var workers sync.WaitGroup
	var evidenceMu sync.Mutex
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				reference, err := a.ReadEvidence(job.id, job.component.Workspace, query)
				if err == nil {
					evidenceMu.Lock()
					evidence[job.id] = reference
					evidenceMu.Unlock()
				}
			}
		}()
	}
	for _, result := range results {
		evidenceMu.Lock()
		_, exists := evidence[result.id]
		evidenceMu.Unlock()
		if exists {
			continue
		}
		component, ok := components[result.id]
		if !ok {
			continue
		}
		jobs <- evidenceJob{result.id, component}
	}
	close(jobs)
	workers.Wait()
}
