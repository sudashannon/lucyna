package wiki

import (
	"os"
	"path/filepath"
	"strings"

	"stele/internal/source"
)

// authorizedWorkspaceDocumentPath validates live filesystem ownership without
// depending on the asynchronous index having discovered a newly created source.
func authorizedWorkspaceDocumentPath(workspace source.Workspace, path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", os.ErrPermission
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	var roots []string
	if workspace.Type == source.KindSuperpowers {
		roots = source.SuperpowersRoots(workspace.Path)
	} else {
		roots = append(source.ScanRoots(workspace), source.ProjectRoot(workspace), source.MirrorRoot(workspace))
	}
	for _, root := range roots {
		root, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(root, canonical)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		info, err := os.Stat(canonical)
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() {
			return "", os.ErrPermission
		}
		return canonical, nil
	}
	return "", os.ErrPermission
}
