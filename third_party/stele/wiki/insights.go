package wiki

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"stele/internal/claims"
)

type EngineeringInsight struct {
	ID              string   `json:"id"`
	Kind            string   `json:"kind"`
	Title           string   `json:"title"`
	Reason          string   `json:"reason"`
	Workspace       string   `json:"workspace"`
	ComponentIDs    []string `json:"componentIds"`
	Provenance      string   `json:"provenance"`
	ClaimID         string   `json:"claimId,omitempty"`
	ReviewFindingID string   `json:"reviewFindingId,omitempty"`
	ReviewRevision  string   `json:"reviewRevision,omitempty"`
}

type insightsResponse struct {
	Insights []EngineeringInsight `json:"insights"`
}

// Insights derives deterministic, evidence-grounded navigation prompts from the graph.
func (a *API) Insights() ([]EngineeringInsight, error) {
	a.mu.RLock()
	components, _ := cloneSearchSnapshot(a.graph.Components(), nil)
	var edges []Edge
	for _, outgoing := range a.graph.forward {
		edges = append(edges, outgoing...)
	}
	communities := make(map[string]int, len(a.graph.communities))
	for id, community := range a.graph.communities {
		communities[id] = community
	}
	lifecycleGraph := BuildGraph(nil, edges)
	for _, component := range components {
		lifecycleGraph.AddComponent(component)
	}
	a.mu.RUnlock()
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].From != edges[j].From {
			return edges[i].From < edges[j].From
		}
		if edges[i].To != edges[j].To {
			return edges[i].To < edges[j].To
		}
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		return edges[i].Kind < edges[j].Kind
	})

	out := make([]EngineeringInsight, 0)
	seen := make(map[string]bool)
	add := func(kind, title, reason, workspace, provenance string, ids ...string) int {
		sort.Strings(ids)
		sum := sha256.Sum256([]byte(kind + "\x00" + provenance + "\x00" + reason + "\x00" + strings.Join(ids, "\x00")))
		id := hex.EncodeToString(sum[:8])
		if seen[id] {
			return -1
		}
		seen[id] = true
		out = append(out, EngineeringInsight{ID: id, Kind: kind, Title: title, Reason: reason, Workspace: workspace, ComponentIDs: ids, Provenance: provenance})
		return len(out) - 1
	}

	lifecycleIssues := lifecycleGraph.lintLifecycleGaps()
	sort.Slice(lifecycleIssues, func(i, j int) bool { return lifecycleIssues[i].ComponentID < lifecycleIssues[j].ComponentID })
	for _, issue := range lifecycleIssues {
		if len(out) >= 500 {
			break
		}
		if issue.Rule != "design-no-plan" {
			continue
		}
		component, ok := components[issue.ComponentID]
		if !ok {
			continue
		}
		index := add("missing-plan", component.Title, issue.Detail, component.Workspace, "authored", component.ID)
		if index >= 0 {
			issue.Workspace = component.Workspace
			identified := []LintIssue{issue}
			lifecycleGraph.addLintIdentity(identified)
			issue = identified[0]
			out[index].ReviewFindingID = issue.ID
			out[index].ReviewRevision = issue.InputRevision
		}
	}

	store := a.ClaimsStoreSnapshot()
	if store != nil {
		resolver := a.claimsResolver()
		for _, claim := range store.List(claims.Filter{Status: string(claims.StatusStale)}) {
			component, ok := components[claim.DocID]
			if !ok || claim.DocID == "" || !importantInsightDocument(component.Type) {
				continue
			}
			if len(out) >= 500 {
				break
			}
			outcome := resolver.CheckClaim(claim)
			revision := claimReviewRevision(claim, outcome.Versions)
			target := "claim:" + claim.Workspace + "/" + claim.ID
			findingID := stableRevision([]string{claim.Workspace, "stale-claim", target, claim.DocID})
			index := add("stale-evidence", component.Title, claim.ID+" ("+claim.StaleReason+"): "+claim.Text, claim.Workspace, "authored", component.ID)
			if index >= 0 {
				out[index].ClaimID = claim.ID
				out[index].ReviewFindingID = findingID
				out[index].ReviewRevision = revision
			}
		}
	}

	for _, edge := range edges {
		if len(out) >= 500 {
			break
		}
		from, fok := components[edge.From]
		to, tok := components[edge.To]
		if !fok || !tok || from.Type == TypeSession || to.Type == TypeSession {
			continue
		}
		if edge.Source == "vector" || edge.Source == "tag" {
			add("semantic-neighbor", from.Title+" ↔ "+to.Title, "Graph candidate via "+edge.Source+"; not an authored dependency.", from.Workspace, edge.Source, edge.From, edge.To)
			continue
		}
		fromCommunity, fromAssigned := communities[edge.From]
		toCommunity, toAssigned := communities[edge.To]
		if edge.Source != "slug-match" && fromAssigned && toAssigned && fromCommunity != toCommunity {
			add("community-bridge", from.Title+" ↔ "+to.Title, "Explicit cross-community relation: "+edge.Kind, from.Workspace, "authored", edge.From, edge.To)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ID != out[j].ID {
			return out[i].ID < out[j].ID
		}
		return out[i].Kind < out[j].Kind
	})
	if len(out) > 500 {
		out = out[:500]
	}
	return out, nil
}

func importantInsightDocument(kind ComponentType) bool {
	switch kind {
	case TypeChange, TypeDesign, TypePlan, TypeSpec, TypeProposal, TypeReport, TypeKnowledge:
		return true
	default:
		return false
	}
}

func (a *API) HandleInsights(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	insights, err := a.Insights()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(insightsResponse{Insights: insights})
}
