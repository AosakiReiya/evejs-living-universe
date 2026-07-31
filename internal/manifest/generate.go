package manifest

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/hashutil"
	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

// GenerateOptions controls manifest generation from overlay content trees and
// a clean EveJS baseline tree.
type GenerateOptions struct {
	// Version is the plugin release version (from VERSION).
	Version string
	// EveJS is the supported EveJS baseline version.
	EveJS string
	// ArchiveName is the canonical upstream archive name.
	ArchiveName string
	// ArchiveSHA is the upstream archive SHA-256.
	ArchiveSHA string
	// Note is an optional compatibility note.
	Note string
	// OverlayRoot is the patches/files content tree.
	OverlayRoot string
	// DockerOverlayRoot is the patches/docker-overlay content tree.
	DockerOverlayRoot string
	// BaselineRoot is a clean EveJS baseline tree used for baseline hashes.
	BaselineRoot string
}

// Generate builds a v2 manifest from the overlay content trees and a clean
// baseline. Docker overlay content wins for paths that overlap the main
// overlay.
func Generate(opts GenerateOptions) (*Manifest, error) {
	if opts.Version == "" {
		return nil, fmt.Errorf("version is required")
	}
	if opts.EveJS == "" {
		return nil, fmt.Errorf("evejs version is required")
	}
	if !sha256Re.MatchString(opts.ArchiveSHA) {
		return nil, fmt.Errorf("archiveSha256 is required")
	}

	type candidate struct {
		path    string
		source  string
		content string
	}
	byPath := map[string]candidate{}

	addTree := func(root, source string) error {
		if root == "" {
			return nil
		}
		return filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("symlinks are not allowed in overlay content: %s", p)
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if err := safepath.ValidateRel(rel); err != nil {
				return err
			}
			// Docker overlay wins for overlapping paths.
			if existing, ok := byPath[rel]; ok && source == "docker-overlay" && existing.source != "docker-overlay" {
				byPath[rel] = candidate{path: rel, source: source, content: p}
				return nil
			}
			if _, ok := byPath[rel]; !ok {
				byPath[rel] = candidate{path: rel, source: source, content: p}
			}
			return nil
		})
	}

	if err := addTree(opts.OverlayRoot, "patch"); err != nil {
		return nil, fmt.Errorf("scan overlay tree: %w", err)
	}
	if err := addTree(opts.DockerOverlayRoot, "docker-overlay"); err != nil {
		return nil, fmt.Errorf("scan docker overlay tree: %w", err)
	}
	if len(byPath) == 0 {
		return nil, fmt.Errorf("no overlay content found")
	}

	paths := make([]string, 0, len(byPath))
	for p := range byPath {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	files := make([]File, 0, len(paths))
	for _, p := range paths {
		c := byPath[p]
		installedSHA, installedSize, err := hashutil.File(c.content)
		if err != nil {
			return nil, fmt.Errorf("hash overlay content %s: %w", p, err)
		}
		f := File{
			Path:      p,
			Operation: "overlay",
			Kind:      "modified",
			Source:    c.source,
			Installed: FileState{SHA256: installedSHA, Size: installedSize},
		}
		baselinePath := filepath.Join(opts.BaselineRoot, filepath.FromSlash(p))
		info, err := os.Stat(baselinePath)
		switch {
		case err == nil && info.Mode().IsRegular():
			sha, size, err := hashutil.File(baselinePath)
			if err != nil {
				return nil, fmt.Errorf("hash baseline %s: %w", p, err)
			}
			f.Baseline = FileState{SHA256: sha, Size: size}
		case err == nil:
			return nil, fmt.Errorf("baseline path is not a regular file: %s", p)
		case os.IsNotExist(err):
			f.Kind = "added"
		default:
			return nil, fmt.Errorf("cannot stat baseline %s: %w", p, err)
		}
		files = append(files, f)
	}

	m := &Manifest{
		// v2 during generation; ApplyModules stamps modules and bumps to v3.
		SchemaVersion: SchemaVersionV2,
		Release: Release{
			Version:     opts.Version,
			EveJS:       opts.EveJS,
			ArchiveName: opts.ArchiveName,
			ArchiveSHA:  opts.ArchiveSHA,
			Note:        opts.Note,
		},
		Files: files,
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return m, nil
}

// FormatFiles returns a one-line summary per file, sorted by path.
func (m *Manifest) FormatFiles() string {
	var b strings.Builder
	for _, f := range m.ByPath() {
		fmt.Fprintf(&b, "%s\t%s\t%s\t%d\n", f.Kind, f.Source, f.Path, f.Installed.Size)
	}
	return b.String()
}
