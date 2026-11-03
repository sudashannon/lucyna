package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	recoverySchema     = 1
	recoveryMaxArchive = 32 << 20
	recoveryMaxStore   = 8 << 20
	recoveryMaxEntries = 512
)

var (
	recoveryChatName   = regexp.MustCompile(`^chat-([0-9a-f]{64})$`)
	recoveryChatTarget = regexp.MustCompile(`^chat/[0-9a-f]{64}\.json$`)
)

type recoveryStore struct {
	Name           string
	Target         string
	Read           func() ([]byte, error)
	List           func() (map[string][]byte, error)
	Validate       func([]byte) error
	Export         func([]byte) ([]byte, error)
	PrepareRestore func(current, incoming []byte) ([]byte, error)
}

type recoveryManifest struct {
	Schema int      `json:"schema"`
	Stores []string `json:"stores"`
}

type recoveryArchive struct {
	manifest recoveryManifest
	data     map[string][]byte
}

type recoveryAPI struct {
	stores  []recoveryStore
	dataDir string
}

func validRecoveryTarget(target string) bool {
	switch target {
	case "config.json", "workspaces.yaml", "claims.json", "review.json":
		return true
	case "chat": // closed descriptor template; archives contain hashed chat IDs.
		return true
	default:
		return recoveryChatTarget.MatchString(target)
	}
}

func newRecoveryAPI(dataDir string, stores []recoveryStore) (*recoveryAPI, error) {
	seen, targets := map[string]bool{}, map[string]bool{}
	for _, store := range stores {
		chatTemplate := store.Name == "chat" && store.Target == "chat" && store.List != nil
		if store.Name == "" || strings.ContainsAny(store.Name, `/\\`) || store.Name == "mcp-token" || !validRecoveryTarget(store.Target) || store.Validate == nil || seen[store.Name] || targets[store.Target] {
			return nil, fmt.Errorf("invalid recovery store %q", store.Name)
		}
		if chatTemplate {
			if store.Read != nil || store.Export != nil || store.PrepareRestore != nil {
				return nil, errors.New("chat recovery template only supports List and Validate")
			}
		} else if store.Read == nil || store.List != nil {
			return nil, fmt.Errorf("invalid recovery callbacks for %q", store.Name)
		}
		if store.Target == "config.json" && (store.Export == nil || store.PrepareRestore == nil) {
			return nil, errors.New("config recovery requires secret redaction and merge callbacks")
		}
		seen[store.Name], targets[store.Target] = true, true
	}
	if dataDir == "" {
		return nil, errors.New("recovery data directory is required")
	}
	return &recoveryAPI{stores: stores, dataDir: dataDir}, nil
}

func (api *recoveryAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/api/recovery/export" {
		api.export(w)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path != "/api/recovery/preview" && r.URL.Path != "/api/recovery/restore" {
		http.NotFound(w, r)
		return
	}
	data, err := readRecoveryUpload(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	archive, err := parseRecoveryArchive(data, api.stores)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	conflicts, err := api.conflicts(archive)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if r.URL.Path == "/api/recovery/preview" {
		recoveryWriteJSON(w, http.StatusOK, map[string]any{
			"stores": archive.manifest.Stores, "conflicts": conflicts,
			"warnings": []string{"恢复内容将在下次启动时应用；当前运行状态不变。"},
		})
		return
	}
	policy := r.FormValue("conflictPolicy")
	if policy != "skip" && policy != "replace" {
		http.Error(w, "conflictPolicy must be skip or replace", http.StatusBadRequest)
		return
	}
	if err := api.stage(archive, conflicts, policy); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	recoveryWriteJSON(w, http.StatusAccepted, map[string]any{"staged": true, "restartRequired": true})
}

func (api *recoveryAPI) conflicts(archive *recoveryArchive) ([]string, error) {
	var conflicts []string
	for _, name := range archive.manifest.Stores {
		store, err := resolveRecoveryStore(name, api.stores)
		if err != nil {
			return nil, err
		}
		target, err := recoveryFilePath(api.dataDir, store.Target)
		if err != nil {
			return nil, err
		}
		if _, err := os.Lstat(target); err == nil {
			conflicts = append(conflicts, name)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return conflicts, nil
}

func (api *recoveryAPI) export(w http.ResponseWriter) {
	var buffer bytes.Buffer
	zipWriter := zip.NewWriter(&buffer)
	manifest := recoveryManifest{Schema: recoverySchema}
	stores := append([]recoveryStore(nil), api.stores...)
	sort.Slice(stores, func(i, j int) bool { return stores[i].Name < stores[j].Name })
	for _, store := range stores {
		if store.Name == "chat" {
			if err := api.exportChat(zipWriter, &manifest, store); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			continue
		}
		if _, err := recoveryFilePath(api.dataDir, store.Target); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		data, err := store.Read()
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			http.Error(w, "read "+store.Name+": "+err.Error(), http.StatusInternalServerError)
			return
		}
		if store.Export != nil {
			data, err = store.Export(data)
			if err != nil {
				http.Error(w, "redact "+store.Name+": "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
		if err := validateRecoveryData(store, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := writeRecoveryEntry(zipWriter, &manifest, store.Name, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	api.finishExport(w, zipWriter, &buffer, manifest)
}

func (api *recoveryAPI) exportChat(zipWriter *zip.Writer, manifest *recoveryManifest, template recoveryStore) error {
	files, err := template.List()
	if err != nil {
		return fmt.Errorf("list chat snapshots: %w", err)
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		store, err := resolveRecoveryStore(name, api.stores)
		if err != nil || store.Name == "chat" {
			return fmt.Errorf("invalid chat snapshot identity %q", name)
		}
		if _, err := recoveryFilePath(api.dataDir, store.Target); err != nil {
			return err
		}
		data := files[name]
		if err := validateRecoveryData(store, data); err != nil {
			return err
		}
		if err := writeRecoveryEntry(zipWriter, manifest, name, data); err != nil {
			return err
		}
	}
	return nil
}

func (api *recoveryAPI) finishExport(w http.ResponseWriter, zipWriter *zip.Writer, buffer *bytes.Buffer, manifest recoveryManifest) {
	data, _ := json.Marshal(manifest)
	entry, err := zipWriter.Create("manifest.json")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := entry.Write(data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := zipWriter.Close(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if buffer.Len() > recoveryMaxArchive {
		http.Error(w, "recovery archive exceeds size limit", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="stele-recovery.zip"`)
	_, _ = w.Write(buffer.Bytes())
}

func validateRecoveryData(store recoveryStore, data []byte) error {
	if len(data) > recoveryMaxStore {
		return fmt.Errorf("store exceeds recovery limit: %s", store.Name)
	}
	if err := store.Validate(data); err != nil {
		return fmt.Errorf("invalid %s snapshot: %w", store.Name, err)
	}
	if match := recoveryChatName.FindStringSubmatch(store.Name); match != nil {
		var identity struct {
			Workspace string `json:"workspace"`
			Change    string `json:"change"`
		}
		if err := json.Unmarshal(data, &identity); err != nil || identity.Workspace == "" || identity.Change == "" {
			return fmt.Errorf("chat snapshot %q has no valid identity", store.Name)
		}
		hash := sha256.Sum256([]byte(identity.Workspace + "\x00" + identity.Change))
		if hex.EncodeToString(hash[:]) != match[1] {
			return fmt.Errorf("chat snapshot identity does not match %q", store.Name)
		}
	}
	return nil
}

func writeRecoveryEntry(zipWriter *zip.Writer, manifest *recoveryManifest, name string, data []byte) error {
	entry, err := zipWriter.Create("stores/" + name + ".json")
	if err != nil {
		return err
	}
	if _, err := entry.Write(data); err != nil {
		return err
	}
	manifest.Stores = append(manifest.Stores, name)
	return nil
}

func readRecoveryUpload(r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, recoveryMaxArchive+1<<20)
	if err := r.ParseMultipartForm(recoveryMaxArchive); err != nil {
		return nil, fmt.Errorf("invalid recovery upload: %w", err)
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, _, err := r.FormFile("archive")
	if err != nil {
		return nil, errors.New("archive file is required")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, recoveryMaxArchive+1))
	if err != nil {
		return nil, err
	}
	if len(data) > recoveryMaxArchive {
		return nil, errors.New("recovery archive exceeds size limit")
	}
	return data, nil
}

func parseRecoveryArchive(data []byte, stores []recoveryStore) (*recoveryArchive, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid recovery ZIP: %w", err)
	}
	if len(reader.File) == 0 || len(reader.File) > recoveryMaxEntries {
		return nil, errors.New("invalid recovery entry count")
	}
	out := &recoveryArchive{data: map[string][]byte{}}
	manifestSeen := false
	var expanded uint64
	for _, file := range reader.File {
		name := file.Name
		if path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || file.FileInfo().IsDir() {
			return nil, fmt.Errorf("unsafe recovery entry %q", name)
		}
		expanded += file.UncompressedSize64
		if expanded > recoveryMaxArchive || file.UncompressedSize64 > recoveryMaxStore {
			return nil, errors.New("recovery archive expanded size exceeds limit")
		}
		if name == "manifest.json" {
			if manifestSeen {
				return nil, errors.New("duplicate recovery manifest")
			}
			manifestSeen = true
			body, err := readZipEntry(file, 64<<10)
			if err != nil {
				return nil, err
			}
			if err := json.Unmarshal(body, &out.manifest); err != nil {
				return nil, fmt.Errorf("invalid recovery manifest: %w", err)
			}
			continue
		}
		if !strings.HasPrefix(name, "stores/") || !strings.HasSuffix(name, ".json") {
			return nil, fmt.Errorf("unexpected recovery entry %q", name)
		}
		logicalName := strings.TrimSuffix(strings.TrimPrefix(name, "stores/"), ".json")
		store, err := resolveRecoveryStore(logicalName, stores)
		if err != nil || name != "stores/"+logicalName+".json" {
			return nil, fmt.Errorf("unknown recovery store %q", logicalName)
		}
		if _, duplicate := out.data[logicalName]; duplicate {
			return nil, fmt.Errorf("duplicate recovery store %q", logicalName)
		}
		body, err := readZipEntry(file, recoveryMaxStore)
		if err != nil {
			return nil, err
		}
		if err := validateRecoveryData(store, body); err != nil {
			return nil, err
		}
		out.data[logicalName] = body
	}
	if !manifestSeen || out.manifest.Schema != recoverySchema || len(out.manifest.Stores) != len(out.data) {
		return nil, errors.New("invalid recovery manifest schema or store list")
	}
	seen := map[string]bool{}
	for _, name := range out.manifest.Stores {
		if _, err := resolveRecoveryStore(name, stores); err != nil || seen[name] || out.data[name] == nil {
			return nil, fmt.Errorf("invalid manifest store %q", name)
		}
		seen[name] = true
	}
	return out, nil
}

func resolveRecoveryStore(name string, stores []recoveryStore) (recoveryStore, error) {
	for _, store := range stores {
		if store.Name == name && store.Target != "chat" {
			return store, nil
		}
	}
	match := recoveryChatName.FindStringSubmatch(name)
	if match == nil {
		return recoveryStore{}, fmt.Errorf("unknown store %q", name)
	}
	for _, template := range stores {
		if template.Name == "chat" && template.Target == "chat" && template.List != nil && template.Validate != nil {
			template.Name = name
			template.Target = filepath.Join("chat", match[1]+".json")
			template.Read = nil
			template.List = nil
			template.Export = nil
			template.PrepareRestore = nil
			return template, nil
		}
	}
	return recoveryStore{}, fmt.Errorf("chat snapshots are not enabled")
}

func readZipEntry(file *zip.File, limit int64) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("recovery entry exceeds size limit")
	}
	return data, nil
}

func (api *recoveryAPI) stage(archive *recoveryArchive, conflicts []string, policy string) error {
	conflicting := map[string]bool{}
	for _, name := range conflicts {
		conflicting[name] = policy == "skip"
	}
	manifest := recoveryManifest{Schema: recoverySchema}
	var buffer bytes.Buffer
	zipWriter := zip.NewWriter(&buffer)
	for _, name := range archive.manifest.Stores {
		if conflicting[name] {
			continue
		}
		entry, err := zipWriter.Create("stores/" + name + ".json")
		if err != nil {
			return err
		}
		if _, err := entry.Write(archive.data[name]); err != nil {
			return err
		}
		manifest.Stores = append(manifest.Stores, name)
	}
	data, _ := json.Marshal(manifest)
	entry, err := zipWriter.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err := entry.Write(data); err != nil {
		return err
	}
	if err := zipWriter.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(api.dataDir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(api.dataDir, ".recovery-*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(buffer.Bytes()); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, filepath.Join(api.dataDir, "pending-recovery.zip"))
}

// ApplyPendingRestore runs before stores are opened and rolls back every installed file on failure.
func ApplyPendingRestore(dataDir string, stores []recoveryStore) error {
	pending, err := recoveryFilePath(dataDir, "pending-recovery.zip")
	if err != nil {
		return err
	}
	info, err := os.Lstat(pending)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("pending recovery file is not regular")
	}
	data, err := os.ReadFile(pending)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	archive, err := parseRecoveryArchive(data, stores)
	if err != nil {
		return fmt.Errorf("pending recovery archive: %w", err)
	}
	type previousFile struct {
		path   string
		data   []byte
		exists bool
	}
	var changed []previousFile
	rollback := func(cause error) error {
		for i := len(changed) - 1; i >= 0; i-- {
			old := changed[i]
			var err error
			if old.exists {
				err = atomicRecoveryWrite(old.path, old.data)
			} else {
				err = os.Remove(old.path)
				if errors.Is(err, os.ErrNotExist) {
					err = nil
				}
			}
			if err != nil {
				cause = errors.Join(cause, err)
			}
		}
		return cause
	}
	for _, name := range archive.manifest.Stores {
		store, err := resolveRecoveryStore(name, stores)
		if err != nil {
			return rollback(err)
		}
		target, err := recoveryFilePath(dataDir, store.Target)
		if err != nil {
			return rollback(err)
		}
		old, err := os.ReadFile(target)
		exists := err == nil
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return rollback(err)
		}
		changed = append(changed, previousFile{path: target, data: old, exists: exists})
		incoming := archive.data[name]
		if store.PrepareRestore != nil {
			incoming, err = store.PrepareRestore(old, incoming)
			if err != nil {
				return rollback(fmt.Errorf("prepare %s: %w", name, err))
			}
		}
		if err := store.Validate(incoming); err != nil {
			return rollback(fmt.Errorf("validate prepared %s: %w", name, err))
		}
		if err := atomicRecoveryWrite(target, incoming); err != nil {
			return rollback(err)
		}
	}
	if err := os.Remove(pending); err != nil {
		return rollback(err)
	}
	return nil
}

func recoveryFilePath(dataDir, relative string) (string, error) {
	if !filepath.IsLocal(relative) || strings.Contains(relative, "\\") || filepath.Clean(relative) != relative {
		return "", fmt.Errorf("unsafe recovery target %q", relative)
	}
	root, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() {
		return "", errors.New("recovery data root is not a directory")
	}
	target := filepath.Join(root, relative)
	rel, err := filepath.Rel(root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("recovery target escapes data directory")
	}
	current := root
	parts := strings.Split(relative, string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return "", fmt.Errorf("unsafe recovery target parent %q", current)
		}
	}
	info, err := os.Lstat(target)
	if err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return "", fmt.Errorf("recovery target is not a regular file: %q", target)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return target, nil
}

func atomicRecoveryWrite(target string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".restore-*.tmp")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(name, target)
}

func recoveryWriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
