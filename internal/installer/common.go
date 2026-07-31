// Package installer implements install, uninstall, repair, and status
// operations against an EveJS target tree using the v2 manifest and the
// overlay content tree.
package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/AosakiReiya/evejs-living-universe/internal/hashutil"
)

// dataRefRe matches runtime references to gameStore data JSON files used by
// the patched server code.
var dataRefRe = regexp.MustCompile(`(?:\.\./)+gameStore/data/[A-Za-z0-9._-]+/data\.json`)

const (
	StateSchemaVersion = 2
	InstallRootName    = "_local/x-eve-patch"
)

// FileEntry records the final on-disk state of one touched file.
type FileEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
}

// State is the local install record written into the target tree.
type State struct {
	SchemaVersion  int         `json:"schemaVersion"`
	PluginVersion  string      `json:"pluginVersion"`
	EveJSVersion   string      `json:"evejsVersion"`
	InstalledAtUTC string      `json:"installedAtUtc"`
	ManifestSHA256 string      `json:"manifestSha256"`
	BackupRoot     string      `json:"backupRoot"`
	Files          []FileEntry `json:"files"`
}

// InstallRoot returns the private state directory inside the target tree.
func InstallRoot(targetRoot string) string {
	return filepath.Join(targetRoot, filepath.FromSlash(InstallRootName))
}

// StatePath returns the path of the local install record.
func StatePath(targetRoot string) string {
	return filepath.Join(InstallRoot(targetRoot), "install.json")
}

// LockPath returns the operation-lock path.
func LockPath(targetRoot string) string {
	return filepath.Join(InstallRoot(targetRoot), "install.lock")
}

// AcquireLock creates an exclusive operation lock.
func AcquireLock(targetRoot string) (release func(), err error) {
	root := InstallRoot(targetRoot)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("cannot create install state directory: %w", err)
	}
	lockPath := LockPath(targetRoot)
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("another X-Eve patch operation appears to be running: %s", lockPath)
	}
	fmt.Fprintf(f, "pid=%d started=%s\n", os.Getpid(), time.Now().UTC().Format(time.RFC3339))
	f.Close()
	return func() {
		_ = os.Remove(lockPath)
	}, nil
}

// WriteJSONAtomically writes a JSON document via a temporary file.
func WriteJSONAtomically(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp := fmt.Sprintf("%s.tmp.%d", path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LoadState reads the local install record. A missing state returns nil.
func LoadState(targetRoot string) (*State, error) {
	path := StatePath(targetRoot)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cannot read install state: %w", err)
	}
	var state State
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, fmt.Errorf("install state is not valid JSON: %w", err)
	}
	if state.SchemaVersion != StateSchemaVersion {
		return nil, fmt.Errorf("install state has unsupported schemaVersion %d (this tree may have been patched by the v0.2.3 PowerShell installer)", state.SchemaVersion)
	}
	return &state, nil
}

// AssertEveJSSentinel checks the expected EveJS layout markers.
func AssertEveJSSentinel(targetRoot string) error {
	packagePath := filepath.Join(targetRoot, "server", "package.json")
	serverEntry := filepath.Join(targetRoot, "server", "index.js")
	marketPath := filepath.Join(targetRoot, "externalservices", "market-server")
	for _, p := range []string{packagePath, serverEntry, marketPath} {
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("the selected directory does not have the expected EveJS layout; missing %s", p)
		}
	}
	raw, err := os.ReadFile(packagePath)
	if err != nil {
		return fmt.Errorf("cannot read EveJS package sentinel: %w", err)
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return fmt.Errorf("the EveJS package sentinel is not valid JSON: %s", packagePath)
	}
	if pkg.Name != "eve.js" {
		return fmt.Errorf("the package sentinel does not identify EveJS (expected package name 'eve.js'): %s", packagePath)
	}
	return nil
}

// VerifyFileMatches hashes a file and compares size and SHA-256.
func VerifyFileMatches(path, expectedSHA string, expectedSize int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a regular file: %s", path)
	}
	if expectedSize >= 0 && info.Size() != expectedSize {
		return fmt.Errorf("size mismatch (expected %d, found %d)", expectedSize, info.Size())
	}
	if expectedSHA == "" {
		return nil
	}
	actual, _, err := hashutil.File(path)
	if err != nil {
		return err
	}
	if actual != expectedSHA {
		return fmt.Errorf("SHA-256 mismatch")
	}
	return nil
}

// RemoveEmptyParents deletes empty parent directories up to (but not
// including) the root.
func RemoveEmptyParents(root, filePath string) {
	dir := filepath.Dir(filePath)
	rootClean := filepath.Clean(root)
	for dir != rootClean && strings.HasPrefix(dir, rootClean+string(filepath.Separator)) {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) > 0 {
			break
		}
		if err := os.Remove(dir); err != nil {
			break
		}
		dir = filepath.Dir(dir)
	}
}

// SortedPaths returns a sorted copy of the manifest file paths.
func SortedPaths(paths []string) []string {
	out := make([]string, len(paths))
	copy(out, paths)
	sort.Strings(out)
	return out
}
