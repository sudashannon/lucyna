package main

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"

	"stele/internal/todo"
	"stele/wiki"
)

func newReviewTodoCreator(store *todo.Store, api *wiki.API) func(string, string, string, string, string) (string, error) {
	var mutation sync.Mutex
	return func(issueID, workspace, revision, title, componentID string) (string, error) {
		mutation.Lock()
		defer mutation.Unlock()
		key := fmt.Sprintf("%x", sha256.Sum256([]byte(workspace+"\x00"+issueID+"\x00"+revision)))
		marker := "Review key: " + key
		items, _, _ := store.List(todo.Filter{Workspace: workspace})
		for _, item := range items {
			for _, line := range strings.Split(item.Notes, "\n") {
				if line == marker {
					return item.ID, nil
				}
			}
		}
		if strings.TrimSpace(title) == "" {
			title = "复核工程知识"
		}
		refs := []todo.WikiRef{}
		if componentID != "" {
			component, ok := api.ComponentByID(componentID)
			if ok && component.Workspace == workspace {
				refs = append(refs, todo.WikiRef{ComponentID: componentID, Workspace: workspace, TitleSnapshot: component.Title})
			}
		}
		item, err := store.Create(todo.CreateInput{
			Workspace: workspace, Title: title, Status: todo.StatusOpen, WikiRefs: refs,
			Notes:    "Knowledge review: " + issueID + "\nInput revision: " + revision + "\n" + marker,
			Metadata: todo.Metadata{Source: todo.SourceUI},
		})
		return item.ID, err
	}
}
