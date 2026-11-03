package chat

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"stele/chat/provider"
	"stele/internal/appdir"
	"stele/internal/source"
)

type Session struct {
	SchemaVersion int                          `json:"schema_version"`
	Workspace     string                       `json:"workspace"`
	Change        string                       `json:"change"`
	Messages      []provider.Message           `json:"messages"`
	References    [][]source.EvidenceReference `json:"references,omitempty"`
	Usage         UsageStats                   `json:"usage"`
	CreatedAt     time.Time                    `json:"created_at"`
	UpdatedAt     time.Time                    `json:"updated_at"`
}

type UsageStats struct {
	TotalInput  int `json:"total_input"`
	TotalOutput int `json:"total_output"`
}

type SessionStore struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
	turns map[string]*sync.Mutex
}

var store = &SessionStore{locks: make(map[string]*sync.Mutex), turns: make(map[string]*sync.Mutex)}

func sessionKey(workspace, change string) string { return workspace + "\x00" + change }

func (s *SessionStore) conversationLock(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locks[key] == nil {
		s.locks[key] = &sync.Mutex{}
	}
	return s.locks[key]
}

func (s *SessionStore) BeginTurn(key string) bool {
	s.mu.Lock()
	if s.turns[key] == nil {
		s.turns[key] = &sync.Mutex{}
	}
	lock := s.turns[key]
	s.mu.Unlock()
	return lock.TryLock()
}

func (s *SessionStore) EndTurn(key string) {
	s.mu.Lock()
	lock := s.turns[key]
	s.mu.Unlock()
	if lock != nil {
		lock.Unlock()
	}
}

func sessionPath(key string) string {
	return filepath.Join(appdir.Path("chat"), fmt.Sprintf("%x.json", sha256.Sum256([]byte(key))))
}

func ValidateSessionSnapshot(data []byte) error {
	var sess Session
	if err := json.Unmarshal(data, &sess); err != nil {
		return fmt.Errorf("invalid chat session: %w", err)
	}
	if sess.SchemaVersion != 1 || sess.Workspace == "" || sess.Change == "" || sess.Messages == nil {
		return errors.New("invalid chat session schema or identity")
	}
	for _, message := range sess.Messages {
		for _, block := range message.Content {
			if block.Type == "image" && block.Source != nil && block.Source.Data != "" {
				return errors.New("chat session contains an unpersistable image payload")
			}
		}
	}
	return nil
}

func (s *SessionStore) Load(workspace, change string) (*Session, error) {
	key := sessionKey(workspace, change)
	lock := s.conversationLock(key)
	lock.Lock()
	defer lock.Unlock()
	data, err := os.ReadFile(sessionPath(key))
	if errors.Is(err, os.ErrNotExist) {
		return &Session{SchemaVersion: 1, Workspace: workspace, Change: change, Messages: []provider.Message{}, CreatedAt: time.Now()}, nil
	}
	if err != nil {
		return nil, err
	}
	if err := ValidateSessionSnapshot(data); err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal(data, &sess); err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *SessionStore) Save(sess *Session) error {
	key := sessionKey(sess.Workspace, sess.Change)
	lock := s.conversationLock(key)
	lock.Lock()
	defer lock.Unlock()
	path := sessionPath(key)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	sess.SchemaVersion = 1
	data, err := json.Marshal(sess)
	f, err := os.CreateTemp(filepath.Dir(path), ".chat-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}

func (s *SessionStore) Delete(workspace, change string) error {
	key := sessionKey(workspace, change)
	lock := s.conversationLock(key)
	lock.Lock()
	defer lock.Unlock()
	err := os.Remove(sessionPath(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
