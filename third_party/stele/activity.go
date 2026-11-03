package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"stele/wiki"
)

type activityOperation struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Workspace   string `json:"workspace"`
	Status      string `json:"status"`
	StartedAt   string `json:"startedAt"`
	UpdatedAt   string `json:"updatedAt"`
	Message     string `json:"message,omitempty"`
	Cancellable bool   `json:"cancellable"`
}

type operationActivity struct {
	mu     sync.Mutex
	items  []activityOperation
	cancel map[string]context.CancelFunc
	hub    *wiki.SSEHub
}

func newOperationActivity(hub *wiki.SSEHub) *operationActivity {
	return &operationActivity{items: []activityOperation{}, cancel: map[string]context.CancelFunc{}, hub: hub}
}

func (a *operationActivity) publish(item activityOperation) {
	data, err := json.Marshal(item)
	if err == nil {
		a.hub.BroadcastNamed("operation-updated", string(data))
	}
}

func (a *operationActivity) begin(kind, workspace string, cancel context.CancelFunc) (activityOperation, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return activityOperation{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	item := activityOperation{ID: hex.EncodeToString(bytes[:]), Kind: kind, Workspace: workspace, Status: "running", StartedAt: now, UpdatedAt: now, Cancellable: true}
	a.mu.Lock()
	if len(a.items) >= 100 {
		removed := false
		for i, old := range a.items {
			if old.Status != "running" {
				a.items = append(a.items[:i], a.items[i+1:]...)
				removed = true
				break
			}
		}
		if !removed {
			a.mu.Unlock()
			return activityOperation{}, fmt.Errorf("operation capacity reached")
		}
	}
	a.items = append(a.items, item)
	a.cancel[item.ID] = cancel
	a.mu.Unlock()
	a.publish(item)
	return item, nil
}

func (a *operationActivity) finish(id, status, message string) {
	a.mu.Lock()
	var item activityOperation
	for i := range a.items {
		if a.items[i].ID == id {
			a.items[i].Status = status
			a.items[i].Message = message
			a.items[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			a.items[i].Cancellable = false
			item = a.items[i]
			break
		}
	}
	delete(a.cancel, id)
	a.mu.Unlock()
	if item.ID != "" {
		a.publish(item)
	}
}

type activityResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *activityResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *activityResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func (a *operationActivity) track(kind string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		workspace := request.URL.Query().Get("workspace")
		if workspace == "" {
			workspace = request.Header.Get("X-Stele-Workspace")
		}
		ctx, cancel := context.WithCancel(request.Context())
		defer cancel()
		item, err := a.begin(kind, workspace, cancel)
		if err != nil {
			writeJSONError(w, "operation capacity unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("X-Stele-Operation", item.ID)
		status, message := "failed", "operation interrupted"
		defer func() { a.finish(item.ID, status, message) }()
		wrapped := &activityResponseWriter{ResponseWriter: w}
		handler(wrapped, request.WithContext(ctx))
		status, message = "completed", ""
		if ctx.Err() != nil {
			status = "cancelled"
		} else if wrapped.status >= 400 {
			status, message = "failed", fmt.Sprintf("HTTP %d", wrapped.status)
		}
	}
}

func (a *operationActivity) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		a.mu.Lock()
		items := append([]activityOperation{}, a.items...)
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	case http.MethodPost:
		if !writeGuard(request) {
			writeJSONError(w, "write access denied", http.StatusForbidden)
			return
		}
		id := request.URL.Query().Get("cancel")
		a.mu.Lock()
		cancel, ok := a.cancel[id]
		a.mu.Unlock()
		if !ok {
			writeJSONError(w, "running operation not found", http.StatusNotFound)
			return
		}
		cancel()
		w.WriteHeader(http.StatusAccepted)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
