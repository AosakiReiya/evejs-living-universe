// Package manifest defines the versioned release metadata for the X-Eve patch.
//
// Schema v2 describes every file the patch touches with both the expected
// baseline state (before the patch) and the expected installed state (after
// the patch and the Docker overlay layer).
package manifest

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

const (
	// SchemaVersion is the current manifest schema. v3 adds a per-file module
	// assignment; v2 manifests without module data remain loadable.
	SchemaVersion = 3
	// SchemaVersionV2 is accepted for compatibility with pre-module manifests.
	SchemaVersionV2 = 2
)

var sha256Re = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// FileState is a hash/size pair describing one state of a touched file.
type FileState struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// File describes one touched file.
type File struct {
	Path      string    `json:"path"`
	Operation string    `json:"operation"` // overlay | delete
	Kind      string    `json:"kind"`      // added | modified
	Source    string    `json:"source"`    // patch | docker-overlay
	Baseline  FileState `json:"baseline"`
	Installed FileState `json:"installed"`
	Module    string    `json:"module,omitempty"` // owning subsystem (v3)
}

// Release identifies the plugin and the supported EveJS baseline.
type Release struct {
	Version     string `json:"version"`
	EveJS       string `json:"evejs"`
	ArchiveName string `json:"archiveName"`
	ArchiveSHA  string `json:"archiveSha256"`
	Note        string `json:"note,omitempty"`
}

// Manifest is the top-level v2 document.
type Manifest struct {
	SchemaVersion int     `json:"schemaVersion"`
	Release       Release `json:"release"`
	Files         []File  `json:"files"`
}

// Load reads and validates a manifest from disk.
func Load(path string) (*Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest %s: %w", path, err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("manifest %s is not valid JSON: %w", path, err)
	}
	if err := m.Validate(); err != nil {
		return nil, fmt.Errorf("manifest %s: %w", path, err)
	}
	return &m, nil
}

// Save writes the manifest atomically with a trailing newline.
func (m *Manifest) Save(path string) error {
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Validate checks schema, path safety, and per-file consistency.
func (m *Manifest) Validate() error {
	if m.SchemaVersion != SchemaVersion && m.SchemaVersion != SchemaVersionV2 {
		return fmt.Errorf("unsupported schemaVersion %d", m.SchemaVersion)
	}
	if strings.TrimSpace(m.Release.Version) == "" {
		return fmt.Errorf("release.version is empty")
	}
	if strings.TrimSpace(m.Release.EveJS) == "" {
		return fmt.Errorf("release.evejs is empty")
	}
	if !sha256Re.MatchString(m.Release.ArchiveSHA) {
		return fmt.Errorf("release.archiveSha256 is not a valid SHA-256")
	}
	if len(m.Files) == 0 {
		return fmt.Errorf("files array is empty")
	}
	seen := map[string]bool{}
	for i := range m.Files {
		f := &m.Files[i]
		if err := validateFile(f); err != nil {
			return err
		}
		if m.SchemaVersion >= SchemaVersion && strings.TrimSpace(f.Module) == "" {
			return fmt.Errorf("file %s is not assigned to a module", f.Path)
		}
		if seen[f.Path] {
			return fmt.Errorf("duplicate file path: %s", f.Path)
		}
		seen[f.Path] = true
	}
	return nil
}

func validateFile(f *File) error {
	if err := safepath.ValidateRel(f.Path); err != nil {
		return err
	}
	if f.Operation != "overlay" && f.Operation != "delete" {
		return fmt.Errorf("unsupported operation %q for %s", f.Operation, f.Path)
	}
	if f.Operation == "delete" {
		return nil
	}
	if f.Kind != "added" && f.Kind != "modified" {
		return fmt.Errorf("unsupported kind %q for %s", f.Kind, f.Path)
	}
	if f.Source != "patch" && f.Source != "docker-overlay" {
		return fmt.Errorf("unsupported source %q for %s", f.Source, f.Path)
	}
	if f.Kind == "modified" {
		if !sha256Re.MatchString(f.Baseline.SHA256) {
			return fmt.Errorf("modified file %s has an invalid baseline sha256", f.Path)
		}
	} else if f.Baseline.SHA256 != "" || f.Baseline.Size != 0 {
		return fmt.Errorf("added file %s must have an empty baseline state", f.Path)
	}
	if !sha256Re.MatchString(f.Installed.SHA256) {
		return fmt.Errorf("file %s has an invalid installed sha256", f.Path)
	}
	if f.Installed.Size < 0 || f.Baseline.Size < 0 {
		return fmt.Errorf("file %s has a negative size", f.Path)
	}
	return nil
}

// ByPath sorts files by path.
func (m *Manifest) ByPath() []File {
	out := make([]File, len(m.Files))
	copy(out, m.Files)
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// ApplyModules stamps each file with its owning module. Every manifest file
// must be present in the moduleFor map.
func (m *Manifest) ApplyModules(moduleFor map[string]string) error {
	for i := range m.Files {
		module, ok := moduleFor[m.Files[i].Path]
		if !ok {
			return fmt.Errorf("manifest file has no module assignment: %s", m.Files[i].Path)
		}
		m.Files[i].Module = module
	}
	m.SchemaVersion = SchemaVersion
	return m.Validate()
}

// ModulesFor returns the set of modules referenced by the manifest files.
func (m *Manifest) ModulesFor() map[string]bool {
	out := make(map[string]bool, 8)
	for _, f := range m.Files {
		if f.Module != "" {
			out[f.Module] = true
		}
	}
	return out
}

// Map returns a path-indexed map of the files.
func (m *Manifest) Map() map[string]File {
	out := make(map[string]File, len(m.Files))
	for _, f := range m.Files {
		out[f.Path] = f
	}
	return out
}
