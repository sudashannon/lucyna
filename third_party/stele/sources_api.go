package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"stele/internal/managed"
	"stele/internal/source"
	"stele/internal/sources"
)

const (
	captureRequestLimit = 10 << 20
	captureTextLimit    = 1 << 20
	captureBodyLimit    = 4 << 20
)

var sourceIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type SourceAPI struct {
	workspaces  func() []WorkspaceConfig
	authorize   func(*http.Request, string) bool
	privateRoot func() string
	onChanged   func(string)
	client      *http.Client
}

type capturedSource struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Origin    string    `json:"origin"`
	Version   string    `json:"version"`
	Excerpt   string    `json:"excerpt"`
	Workspace string    `json:"workspace"`
	Type      string    `json:"type"`
	CreatedAt time.Time `json:"createdAt"`
	Authority string    `json:"authority"`
	Path      string    `json:"path"`
	Blob      string    `json:"-"`
}

type sourceCaptureResponse struct {
	ID         string            `json:"id"`
	Title      string            `json:"title"`
	Origin     string            `json:"origin"`
	Version    string            `json:"version"`
	Excerpt    string            `json:"excerpt"`
	Candidates []sourceCandidate `json:"candidates"`
}
type sourceCandidate struct {
	Title       string                     `json:"title"`
	ComponentID string                     `json:"componentId"`
	Text        string                     `json:"text"`
	References  []source.EvidenceReference `json:"references"`
}

// NewSourceAPI uses live workspace configuration, a loopback write guard, private binary storage, and an optional index invalidation callback.
func NewSourceAPI(workspaces func() []WorkspaceConfig, authorize func(*http.Request, string) bool, privateRoot func() string, onChanged func(string)) *SourceAPI {
	a := &SourceAPI{workspaces: workspaces, authorize: authorize, privateRoot: privateRoot, onChanged: onChanged}
	a.client = &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return validatePublicURL(req.Context(), req.URL)
	}}
	return a
}
func (a *SourceAPI) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/sources/capture", a.handleCapture)
	mux.HandleFunc("/api/sources", a.handleSources)
	mux.HandleFunc("/api/sources/", a.handleSource)
}

func (a *SourceAPI) handleCapture(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, captureRequestLimit)
	if err := r.ParseMultipartForm(captureRequestLimit); err != nil {
		writeJSONError(w, "invalid capture form or request too large", http.StatusBadRequest)
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	alias := strings.TrimSpace(r.FormValue("workspace"))
	ws, ok := a.workspace(alias)
	if !ok {
		writeJSONError(w, "unknown workspace", http.StatusNotFound)
		return
	}
	if a.authorize == nil || !a.authorize(r, alias) {
		writeJSONError(w, "write access denied", http.StatusForbidden)
		return
	}
	var origin, title, format string
	var raw []byte
	var blob []byte
	file, header, err := r.FormFile("file")
	if err == nil {
		defer file.Close()
		if header.Size > captureRequestLimit {
			writeJSONError(w, "file too large", http.StatusRequestEntityTooLarge)
			return
		}
		name := filepath.Base(header.Filename)
		ext := strings.ToLower(filepath.Ext(name))
		if ext == "" {
			writeJSONError(w, "file extension required", http.StatusBadRequest)
			return
		}
		raw, err = io.ReadAll(io.LimitReader(file, captureRequestLimit+1))
		if err != nil || len(raw) > captureRequestLimit {
			writeJSONError(w, "file too large", http.StatusRequestEntityTooLarge)
			return
		}
		blob = raw
		title = strings.TrimSpace(r.FormValue("title"))
		if title == "" {
			title = strings.TrimSuffix(name, ext)
		}
		origin = "upload:" + name
		format = ext
	} else if r.FormValue("url") != "" {
		u, parseErr := url.Parse(strings.TrimSpace(r.FormValue("url")))
		if parseErr != nil || validatePublicURL(r.Context(), u) != nil {
			writeJSONError(w, "URL is invalid or points to a non-public address", http.StatusBadRequest)
			return
		}
		body, ct, finalURL, fetchErr := a.fetch(r.Context(), u)
		if fetchErr != nil {
			writeJSONError(w, fetchErr.Error(), http.StatusBadGateway)
			return
		}
		title = strings.TrimSpace(r.FormValue("title"))
		if title == "" && ct == "text/html" {
			title = htmlTitle(body)
		}
		if ct == "text/html" {
			body = htmlToText(body)
		}
		if title == "" {
			title = finalURL
		}
		raw = body
		origin = finalURL
		format = extensionForContentType(ct)
		if format == ".pdf" {
			blob = body
		}
	} else {
		raw = []byte(r.FormValue("text"))
		if len(raw) > captureTextLimit {
			writeJSONError(w, "text exceeds 1 MiB", http.StatusRequestEntityTooLarge)
			return
		}
		if len(raw) == 0 {
			writeJSONError(w, "provide file, url, or text", http.StatusBadRequest)
			return
		}
		title = strings.TrimSpace(r.FormValue("title"))
		if title == "" {
			title = "Captured text"
		}
		origin = "manual"
		format = ".md"
	}
	if len(raw) == 0 {
		writeJSONError(w, "source is empty", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	doc, err := sources.Parse(ctx, "source"+format, raw)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusUnsupportedMediaType)
		return
	}
	if len(doc.Text) == 0 {
		writeJSONError(w, "source contains no extractable text", http.StatusUnprocessableEntity)
		return
	}
	if len(doc.Text) > captureTextLimit {
		writeJSONError(w, "extracted source exceeds 1 MiB", http.StatusRequestEntityTooLarge)
		return
	}
	if title == "" {
		title = "Captured source"
	}
	title = truncateUTF8(title, 240)
	id, err := newSourceID()
	if err != nil {
		writeJSONError(w, "could not allocate source id", http.StatusInternalServerError)
		return
	}
	rel := filepath.ToSlash(filepath.Join(sourceKnowledgeDir(), "sources", id+".md"))
	root, err := filepath.EvalSymlinks(sourceRoot(ws))
	if err != nil {
		writeJSONError(w, "workspace source root is unavailable", http.StatusInternalServerError)
		return
	}
	dest, err := safeSourcePath(root, rel)
	if err != nil {
		writeJSONError(w, "source path is unsafe", http.StatusInternalServerError)
		return
	}
	if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		writeJSONError(w, "could not create source storage", 500)
		return
	}
	content := fmt.Sprintf("---\ntitle: %s\nsource_id: %s\norigin: %s\ncaptured_at: %s\nsource_type: %s\nauthority: unverified\n---\n\n%s\n", yamlScalar(title), id, yamlScalar(origin), time.Now().UTC().Format(time.RFC3339), yamlScalar(doc.Format), doc.Text)
	hash := sha256.Sum256([]byte(content))
	version := "doc-v1:" + hex.EncodeToString(hash[:])
	if err = writeNewFile(dest, []byte(content)); err != nil {
		writeJSONError(w, "could not persist source", http.StatusInternalServerError)
		return
	}
	meta := capturedSource{ID: id, Title: title, Origin: origin, Version: version, Excerpt: excerpt(doc.Text, 1200), Workspace: alias, Type: doc.Format, CreatedAt: time.Now().UTC(), Authority: "unverified", Path: rel}
	if len(blob) > 0 && (doc.Format == "pdf" || doc.Format == "docx" || doc.Format == "pptx" || doc.Format == "xlsx") {
		if a.privateRoot == nil {
			_ = os.Remove(dest)
			writeJSONError(w, "private source storage unavailable", http.StatusInternalServerError)
			return
		}
		blobPath, rootErr := safePrivateBlobPath(a.privateRoot(), alias, id+"."+doc.Format)
		if rootErr != nil {
			_ = os.Remove(dest)
			writeJSONError(w, "private source storage unavailable", http.StatusInternalServerError)
			return
		}
		if err = os.MkdirAll(filepath.Dir(blobPath), 0700); err != nil {
			_ = os.Remove(dest)
			writeJSONError(w, "could not create private source storage", 500)
			return
		}
		if err = writeNewFile(blobPath, blob); err != nil {
			_ = os.Remove(dest)
			writeJSONError(w, "could not persist original source", 500)
			return
		}
		meta.Blob = filepath.Base(blobPath)
	}
	if err = writeSourceMetadata(dest+".json", meta); err != nil {
		_ = os.Remove(dest)
		if meta.Blob != "" {
			if blobPath, pathErr := safePrivateBlobPath(a.privateRoot(), alias, meta.Blob); pathErr == nil {
				_ = os.Remove(blobPath)
			}
		}
		writeJSONError(w, "could not persist source metadata", 500)
		return
	}
	if a.onChanged != nil {
		a.onChanged(alias)
	}
	resource := "doc://" + alias + "/" + rel
	ref := source.EvidenceReference{ID: dest, Workspace: alias, Title: title, Type: "source", Path: dest, Resource: resource, Version: version, Excerpt: excerpt(doc.Text, 1200), LineStart: 10, LineEnd: 9 + lineCount(doc.Text), Reasons: []string{"captured source"}, Freshness: "current"}
	writeSourceJSON(w, sourceCaptureResponse{ID: id, Title: title, Origin: origin, Version: version, Excerpt: meta.Excerpt, Candidates: []sourceCandidate{{Title: title, ComponentID: dest, Text: doc.Text, References: []source.EvidenceReference{ref}}}})
}

func (a *SourceAPI) handleSources(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", 405)
		return
	}
	alias := r.URL.Query().Get("workspace")
	if _, ok := a.workspace(alias); !ok {
		writeJSONError(w, "unknown workspace", 404)
		return
	}
	items, err := a.list(alias)
	if err != nil {
		writeJSONError(w, "could not list sources", 500)
		return
	}
	writeSourceJSON(w, map[string]any{"sources": items})
}
func (a *SourceAPI) handleSource(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sources/")
	if !sourceIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	alias := r.URL.Query().Get("workspace")
	ws, ok := a.workspace(alias)
	if !ok {
		writeJSONError(w, "unknown workspace", 404)
		return
	}
	file, err := a.sourceFile(ws, id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		meta, err := readSourceMetadata(file + ".json")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		b, err := os.ReadFile(file)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"source": meta, "text": markdownBody(b)})
	case http.MethodDelete:
		if a.authorize == nil || !a.authorize(r, alias) {
			writeJSONError(w, "write access denied", 403)
			return
		}
		meta, _ := readSourceMetadata(file + ".json")
		if err = os.Remove(file); err != nil && !os.IsNotExist(err) {
			writeJSONError(w, "could not delete source", 500)
			return
		}
		_ = os.Remove(file + ".json")
		if meta.Blob != "" && a.privateRoot != nil {
			if blobPath, pathErr := safePrivateBlobPath(a.privateRoot(), alias, meta.Blob); pathErr == nil {
				_ = os.Remove(blobPath)
			}
		}
		if a.onChanged != nil {
			a.onChanged(alias)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSONError(w, "method not allowed", 405)
	}
}

func (a *SourceAPI) workspace(alias string) (WorkspaceConfig, bool) {
	if alias == "" || a.workspaces == nil {
		return WorkspaceConfig{}, false
	}
	for _, ws := range a.workspaces() {
		if ws.Alias == alias {
			return ws, true
		}
	}
	return WorkspaceConfig{}, false
}
func sourceRoot(ws WorkspaceConfig) string { return source.ProjectRoot(source.Workspace(ws)) }
func privateWorkspaceKey(alias string) string {
	sum := sha256.Sum256([]byte(alias))
	return hex.EncodeToString(sum[:])
}
func safeSourcePath(root, rel string) (string, error) {
	if filepath.IsAbs(rel) || strings.Contains(rel, "\\") {
		return "", errors.New("invalid path")
	}
	rootAbs, e := filepath.Abs(root)
	if e != nil {
		return "", e
	}
	full := filepath.Join(rootAbs, filepath.FromSlash(rel))
	if full == rootAbs || !strings.HasPrefix(full, rootAbs+string(filepath.Separator)) {
		return "", errors.New("path escape")
	}
	for dir := filepath.Dir(full); dir != rootAbs && strings.HasPrefix(dir, rootAbs+string(filepath.Separator)); dir = filepath.Dir(dir) {
		if fi, e := os.Lstat(dir); e == nil && fi.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("symlink path")
		}
	}
	if fi, e := os.Lstat(full); e == nil && fi.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("symlink target")
	}
	return full, nil
}
func safePrivateBlobPath(root, alias, name string) (string, error) {
	if filepath.Base(name) != name || name == "" {
		return "", errors.New("invalid blob name")
	}
	dir, e := privateSourceDir(root, alias)
	if e != nil {
		return "", e
	}
	full := filepath.Join(dir, name)
	rootAbs, e := filepath.Abs(root)
	if e != nil {
		return "", e
	}
	for p := filepath.Dir(full); p != rootAbs && strings.HasPrefix(p, rootAbs+string(filepath.Separator)); p = filepath.Dir(p) {
		if fi, e := os.Lstat(p); e == nil && fi.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("private source symlink")
		}
	}
	if fi, e := os.Lstat(full); e == nil && fi.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("private source blob symlink")
	}
	return full, nil
}
func privateSourceDir(root, alias string) (string, error) {
	if !filepath.IsAbs(root) {
		return "", errors.New("private root must be absolute")
	}
	return filepath.Join(filepath.Clean(root), "sources", privateWorkspaceKey(alias)), nil
}
func sourceKnowledgeDir() string { if managed.Unified() { return "知识" }; return "knowledge" }
func (a *SourceAPI) sourceFile(ws WorkspaceConfig, id string) (string, error) {
	rel := filepath.ToSlash(filepath.Join(sourceKnowledgeDir(), "sources", id+".md"))
	p, e := safeSourcePath(sourceRoot(ws), rel)
	if e != nil {
		return "", e
	}
	info, e := os.Lstat(p)
	if e != nil || !info.Mode().IsRegular() || info.Size() > captureTextLimit+(64<<10) {
		return "", os.ErrNotExist
	}
	metaPath, e := safeSourcePath(sourceRoot(ws), rel+".json")
	if e != nil {
		return "", e
	}
	meta, e := readSourceMetadata(metaPath)
	if e != nil || meta.ID != id || meta.Workspace != ws.Alias {
		return "", os.ErrNotExist
	}
	if meta.Blob != "" {
		switch meta.Type {
		case "pdf", "docx", "pptx", "xlsx":
			if meta.Blob != id+"."+meta.Type {
				return "", os.ErrNotExist
			}
		default:
			return "", os.ErrNotExist
		}
	}
	return p, nil
}
func (a *SourceAPI) list(alias string) ([]capturedSource, error) {
	ws, ok := a.workspace(alias)
	if !ok {
		return nil, os.ErrNotExist
	}
	root := sourceRoot(ws)
	dir, e := safeSourcePath(root, filepath.ToSlash(filepath.Join(sourceKnowledgeDir(), "sources")))
	if e != nil {
		return nil, e
	}
	entries, e := os.ReadDir(dir)
	if os.IsNotExist(e) {
		return []capturedSource{}, nil
	}
	if e != nil {
		return nil, e
	}
	out := make([]capturedSource, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md.json") {
			continue
		}
		metaPath, e := safeSourcePath(root, filepath.ToSlash(filepath.Join(sourceKnowledgeDir(), "sources", entry.Name())))
		if e != nil {
			continue
		}
		meta, e := readSourceMetadata(metaPath)
		if e == nil && meta.Workspace == alias && sourceIDPattern.MatchString(meta.ID) {
			out = append(out, meta)
		}
	}
	return out, nil
}

func writeSourceJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
func writeNewFile(path string, b []byte) error {
	if managed.Enabled() && strings.HasSuffix(strings.ToLower(path), ".md") {
		return managed.Create(path, b)
	}
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if closeErr := f.Close(); e == nil {
		e = closeErr
	}
	if e != nil {
		_ = os.Remove(path)
	}
	return e
}
func writeSourceMetadata(path string, m capturedSource) error {
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	return writeNewFile(path, b)
}
func readSourceMetadata(path string) (capturedSource, error) {
	var m capturedSource
	info, e := os.Lstat(path)
	if e != nil {
		return m, e
	}
	if !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return m, errors.New("invalid source metadata file")
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return m, e
	}
	e = json.Unmarshal(b, &m)
	return m, e
}
func newSourceID() (string, error) {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return hex.EncodeToString(b), nil
}
func yamlScalar(s string) string { b, _ := json.Marshal(s); return string(b) }
func excerpt(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return truncateUTF8(s, n) + "…"
}
func truncateUTF8(s string, n int) string {
	if n >= len(s) {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
func markdownBody(b []byte) string {
	s := string(b)
	if i := strings.Index(s, "\n---\n"); i >= 0 {
		if j := strings.Index(s[i+5:], "\n\n"); j >= 0 {
			return strings.TrimSpace(s[i+5+j+2:])
		}
	}
	return s
}
func lineCount(s string) int {
	if s == "" {
		return 0
	}
	return strings.Count(s, "\n") + 1
}

var blockedIPNetworks = []*net.IPNet{mustCIDR("0.0.0.0/8"), mustCIDR("10.0.0.0/8"), mustCIDR("100.64.0.0/10"), mustCIDR("127.0.0.0/8"), mustCIDR("169.254.0.0/16"), mustCIDR("172.16.0.0/12"), mustCIDR("192.0.0.0/24"), mustCIDR("192.0.2.0/24"), mustCIDR("192.88.99.0/24"), mustCIDR("192.168.0.0/16"), mustCIDR("198.18.0.0/15"), mustCIDR("198.51.100.0/24"), mustCIDR("203.0.113.0/24"), mustCIDR("224.0.0.0/4"), mustCIDR("240.0.0.0/4"), mustCIDR("::/128"), mustCIDR("::1/128"), mustCIDR("::/96"), mustCIDR("64:ff9b::/96"), mustCIDR("64:ff9b:1::/48"), mustCIDR("100::/64"), mustCIDR("2001::/23"), mustCIDR("2001:20::/28"), mustCIDR("2001:db8::/32"), mustCIDR("2002::/16"), mustCIDR("fc00::/7"), mustCIDR("fe80::/10"), mustCIDR("ff00::/8")}

func mustCIDR(s string) *net.IPNet { _, n, _ := net.ParseCIDR(s); return n }
func publicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range blockedIPNetworks {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}
func validatePublicURL(ctx context.Context, u *url.URL) error {
	if u == nil || u.User != nil || u.Fragment != "" {
		return errors.New("invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("only HTTP(S) URLs are allowed")
	}
	port := u.Port()
	if port != "" && port != "80" && port != "443" {
		return errors.New("URL port is not allowed")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return errors.New("non-public URL host")
	}
	if ip := net.ParseIP(host); ip != nil {
		if !publicIP(ip) {
			return errors.New("non-public URL address")
		}
		return nil
	}
	ips, e := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if e != nil || len(ips) == 0 {
		return errors.New("URL host could not be resolved")
	}
	for _, ip := range ips {
		if !publicIP(ip) {
			return errors.New("URL host resolves to a non-public address")
		}
	}
	return nil
}
func (a *SourceAPI) fetch(ctx context.Context, u *url.URL) ([]byte, string, string, error) {
	if err := validatePublicURL(ctx, u); err != nil {
		return nil, "", "", err
	}
	transport := &http.Transport{Proxy: nil, DisableCompression: false}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		host = strings.TrimSuffix(strings.ToLower(host), ".")
		if ip := net.ParseIP(host); ip != nil {
			if !publicIP(ip) {
				return nil, errors.New("non-public URL address")
			}
			return (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, network, net.JoinHostPort(host, port))
		}
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("URL host could not be resolved")
		}
		for _, ip := range ips {
			if !publicIP(ip) {
				return nil, errors.New("URL host resolves to a non-public address")
			}
		}
		var last error
		for _, ip := range ips {
			conn, e := (&net.Dialer{Timeout: 8 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if e == nil {
				return conn, nil
			}
			last = e
		}
		return nil, last
	}
	defer transport.CloseIdleConnections()
	client := *a.client
	client.Transport = transport
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", "", err
	}
	req.Header.Set("User-Agent", "Stele-source-capture/1.0")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", "", fmt.Errorf("URL fetch failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", "", fmt.Errorf("URL returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > captureBodyLimit {
		return nil, "", "", errors.New("URL response exceeds 4 MiB")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, captureBodyLimit+1))
	if err != nil {
		return nil, "", "", err
	}
	if len(body) > captureBodyLimit {
		return nil, "", "", errors.New("URL response exceeds 4 MiB")
	}
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if ct != "text/plain" && ct != "text/markdown" && ct != "text/html" && ct != "application/pdf" {
		return nil, "", "", fmt.Errorf("URL content type %q is not allowed", ct)
	}
	if ct == "text/html" {
		body = htmlToText(body)
	}
	if !utf8.Valid(body) && ct != "application/pdf" {
		return nil, "", "", errors.New("URL content is not UTF-8")
	}
	return body, ct, resp.Request.URL.String(), nil
}
func extensionForContentType(ct string) string {
	switch ct {
	case "application/pdf":
		return ".pdf"
	case "text/markdown":
		return ".md"
	default:
		return ".txt"
	}
}
func htmlTitle(b []byte) string {
	s := strings.ToLower(string(b))
	i := strings.Index(s, "<title")
	if i < 0 {
		return ""
	}
	j := strings.Index(s[i:], ">")
	if j < 0 {
		return ""
	}
	i += j + 1
	j = strings.Index(s[i:], "</title>")
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(string(b[i : i+j]))
}
func htmlToText(b []byte) []byte {
	s := string(b)
	var out, tagText strings.Builder
	tag, skip := false, false
	for _, r := range s {
		switch {
		case r == '<':
			tag, _ = true, false
			tagText.Reset()
		case r == '>':
			tag = false
			fields := strings.Fields(strings.ToLower(tagText.String()))
			if len(fields) == 0 {
				continue
			}
			name := strings.TrimPrefix(fields[0], "/")
			if name == "script" || name == "style" {
				skip = !strings.HasPrefix(fields[0], "/")
			}
			if !skip && (name == "p" || name == "br" || name == "div" || name == "li" || strings.HasPrefix(name, "h")) {
				out.WriteByte('\n')
			}
		case tag:
			tagText.WriteRune(r)
		case !skip:
			out.WriteRune(r)
		}
	}
	return []byte(strings.TrimSpace(out.String()))
}
