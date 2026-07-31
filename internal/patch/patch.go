// Package patch locates the release data shipped alongside the binary and
// resolves overlay content from the patches tree.
package patch

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

// DataRoot identifies the patches directory inside a release package.
type DataRoot struct {
	Root string // absolute patches/ directory
}

// ResolveDataRoot locates the patches data directory. The lookup order is:
//
//  1. --data-root flag
//  2. patches/ next to the running executable (release layout)
//  3. patches/ in the current working directory (development layout)
func ResolveDataRoot(explicit string) (*DataRoot, error) {
	candidates := []string{explicit}
	if explicit == "" {
		if exe, err := os.Executable(); err == nil {
			candidates = append(candidates, filepath.Join(filepath.Dir(exe), "patches"))
		}
		candidates = append(candidates, filepath.Join(".", "patches"))
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if info, err := os.Stat(abs); err == nil && info.IsDir() {
			return &DataRoot{Root: filepath.Clean(abs)}, nil
		}
	}
	return nil, fmt.Errorf("cannot locate the patches data directory; pass --data-root")
}

// ManifestPath returns the path to the release manifest.
func (d *DataRoot) ManifestPath() string {
	return filepath.Join(d.Root, "manifest.json")
}

// OverlayFile resolves a relative patch-overlay path safely.
func (d *DataRoot) OverlayFile(rel string) (string, error) {
	return safepath.ResolveChild(filepath.Join(d.Root, "files"), rel)
}

// DockerOverlayFile resolves a relative docker-overlay path safely.
func (d *DataRoot) DockerOverlayFile(rel string) (string, error) {
	return safepath.ResolveChild(filepath.Join(d.Root, "docker-overlay"), rel)
}

// ContentFor returns the on-disk content path that provides the installed
// bytes for a manifest file entry.
func (d *DataRoot) ContentFor(f manifest.File) (string, error) {
	switch f.Source {
	case "docker-overlay":
		return d.DockerOverlayFile(f.Path)
	case "patch":
		return d.OverlayFile(f.Path)
	default:
		return "", fmt.Errorf("unsupported source %q for %s", f.Source, f.Path)
	}
}
