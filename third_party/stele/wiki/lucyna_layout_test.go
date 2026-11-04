package wiki

import (
 "path/filepath"
 "testing"
)

func TestLucynaDocumentCategoryOverridesFilename(t *testing.T) {
 t.Setenv("LUCYNA_ENGINE_CALLBACK", "http://127.0.0.1:1")
 cases := map[string]ComponentType{"知识":TypeKnowledge,"规范":TypeSpec,"计划":TypePlan,"提案":TypeProposal,"任务":TypeTasks,"报告":TypeReport,"设计":TypeDesign,"图表":TypeDiagram,"资料":TypeArtifact}
 for folder,want := range cases { if got:=classifyPath(filepath.Join("library",folder,"design.md")); got!=want {t.Errorf("%s: got %s, want %s",folder,got,want)} }
}
