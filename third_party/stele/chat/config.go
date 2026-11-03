package chat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"stele/internal/appdir"
)

type ProviderConfig struct {
	APIKey      string  `json:"api_key"`
	APIBase     string  `json:"api_base"`
	Model       string  `json:"model"`
	Temperature float64 `json:"temperature"`
	MaxTokens   int     `json:"max_tokens"`
	Thinking    string  `json:"thinking"`
}

type Config struct {
	SchemaVersion  int                       `json:"schema_version,omitempty"`
	ActiveProvider string                    `json:"active_provider"`
	Providers      map[string]ProviderConfig `json:"providers"`
	ContextChars   int                       `json:"context_chars,omitempty"`
	TaskProviders  map[string]string         `json:"task_providers,omitempty"`
	TaskModels     map[string]string         `json:"task_models,omitempty"`
}

func (cfg *Config) ProviderForTask(task, workspaceProvider string) (string, ProviderConfig, error) {
	if cfg == nil {
		return "", ProviderConfig{}, fmt.Errorf("chat config is required")
	}
	if !validChatTask(task) {
		return "", ProviderConfig{}, fmt.Errorf("unsupported chat task %q", task)
	}
	name := workspaceProvider
	if name == "" {
		name = cfg.TaskProviders[task]
	}
	if name == "" {
		name = cfg.ActiveProvider
	}
	selected, ok := cfg.Providers[name]
	if !ok || name == "" {
		return "", ProviderConfig{}, fmt.Errorf("provider %q is not configured for task %q", name, task)
	}
	if workspaceProvider == "" && cfg.TaskModels[task] != "" {
		selected.Model = cfg.TaskModels[task]
	}
	return name, selected, nil
}

func validChatTask(task string) bool {
	switch task {
	case "chat", "summary", "overview", "report":
		return true
	default:
		return false
	}
}

// legacyConfigDir is where the LLM provider config lived before the project was
// renamed and its state consolidated into one data directory.
const legacyConfigDir = ".comet-ui"

// configPath returns the config file inside the data directory, moving the
// pre-rename file there once. The file holds API keys, so silently losing track
// of it would drop the user's whole provider setup.
func configPath() (string, error) {
	path := appdir.Path("config.json")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path, nil
	}
	legacy := filepath.Join(home, legacyConfigDir, "config.json")
	if _, err := os.Stat(legacy); err != nil {
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		log.Printf("chat: cannot prepare %s (%v); reading the legacy config at %s", filepath.Dir(path), err, legacy)
		return legacy, nil
	}
	if err := os.Rename(legacy, path); err != nil {
		log.Printf("chat: could not migrate %s to %s (%v); continuing with the legacy file", legacy, path, err)
		return legacy, nil
	}
	log.Printf("chat: migrated provider config %s -> %s", legacy, path)
	return path, nil
}

var LoadConfig = func() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultConfig(), nil
	}
	if err != nil {
		return nil, err
	}
	if err := ValidateConfigSnapshot(data); err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Providers == nil {
		cfg.Providers = map[string]ProviderConfig{}
	}
	return &cfg, nil
}

func ValidateConfigSnapshot(data []byte) error {
	var cfg Config
	if err := decodeConfigStrict(data, &cfg); err != nil {
		return fmt.Errorf("invalid chat config: %w", err)
	}
	if cfg.SchemaVersion > 1 {
		return fmt.Errorf("unsupported chat config schema version %d", cfg.SchemaVersion)
	}
	if cfg.Providers == nil {
		return fmt.Errorf("invalid chat config: providers missing")
	}
	if cfg.ContextChars < 0 || cfg.ContextChars > 200000 {
		return fmt.Errorf("invalid chat config: context_chars out of range")
	}
	for task := range cfg.TaskProviders {
		if !validChatTask(task) {
			return fmt.Errorf("invalid chat config: unsupported task %q", task)
		}
	}
	for task, model := range cfg.TaskModels {
		if !validChatTask(task) || utf8.RuneCountInString(model) > 256 || strings.ContainsRune(model, 0) {
			return fmt.Errorf("invalid chat config: invalid model override for task %q", task)
		}
	}
	for name, provider := range cfg.Providers {
		if strings.Contains(provider.APIKey, "\n") {
			return fmt.Errorf("invalid provider credentials for %q", name)
		}
	}
	if cfg.ActiveProvider != "" {
		if _, ok := cfg.Providers[cfg.ActiveProvider]; !ok {
			return fmt.Errorf("invalid chat config: active provider missing")
		}
	}
	return nil
}

func decodeConfigStrict(data []byte, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("unexpected trailing JSON data")
	}
	return nil
}

func mergeConfigUpdate(existing *Config, incoming Config, present map[string]json.RawMessage) (Config, error) {
	if existing == nil {
		existing = defaultConfig()
	}
	merged := incoming
	if _, ok := present["active_provider"]; !ok {
		merged.ActiveProvider = existing.ActiveProvider
	}
	if raw, ok := present["providers"]; ok && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return Config{}, fmt.Errorf("providers must be an object")
	}
	if merged.Providers == nil {
		merged.Providers = make(map[string]ProviderConfig)
	}
	for name, old := range existing.Providers {
		current, ok := merged.Providers[name]
		if !ok {
			merged.Providers[name] = old
			continue
		}
		if current.APIKey == "" || isMasked(current.APIKey) {
			current.APIKey = old.APIKey
		}
		merged.Providers[name] = current
	}
	if _, ok := present["context_chars"]; !ok {
		merged.ContextChars = existing.ContextChars
	}
	for _, field := range []string{"task_providers", "task_models"} {
		raw, ok := present[field]
		if ok && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return Config{}, fmt.Errorf("%s must be an object", field)
		}
		if !ok {
			if field == "task_providers" {
				merged.TaskProviders = existing.TaskProviders
			} else {
				merged.TaskModels = existing.TaskModels
			}
		}
	}
	return merged, nil
}

func ExportConfigSnapshot(raw []byte) ([]byte, error) {
	var cfg Config
	if err := ValidateConfigSnapshot(raw); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	for name, provider := range cfg.Providers {
		provider.APIKey = ""
		cfg.Providers[name] = provider
	}
	cfg.SchemaVersion = 1
	return json.Marshal(cfg)
}

func MergeConfigSnapshot(existing, incoming []byte) ([]byte, error) {
	var current, restored Config
	if len(existing) > 0 {
		if err := ValidateConfigSnapshot(existing); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(existing, &current); err != nil {
			return nil, err
		}
	}
	if err := ValidateConfigSnapshot(incoming); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(incoming, &restored); err != nil {
		return nil, err
	}
	for name, provider := range restored.Providers {
		provider.APIKey = current.Providers[name].APIKey
		restored.Providers[name] = provider
	}
	restored.SchemaVersion = 1
	return json.Marshal(restored)
}

func SaveConfig(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if cfg == nil {
		return fmt.Errorf("chat config is required")
	}
	cfg.SchemaVersion = 1
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := ValidateConfigSnapshot(data); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".config-*.tmp")
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

func defaultConfig() *Config {
	return &Config{
		ActiveProvider: "minimax",
		Providers: map[string]ProviderConfig{
			"minimax": {
				APIBase:     "https://api.minimaxi.com",
				Model:       "MiniMax-M3",
				Temperature: 1.0,
				MaxTokens:   4096,
				Thinking:    "auto",
			},
		},
	}
}
