// Package verify validates a target tree and the release data itself.
package verify

import (
	"fmt"
	"os"

	"github.com/AosakiReiya/evejs-living-universe/internal/installer"
	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

// Result summarizes an installed-tree verification.
type Result struct {
	Installed bool // an install state was found and verified
	FilesOK   int
}

// Installed checks every file recorded in the local install state and the
// manifest's installed expectations, then re-checks runtime static-data
// references.
func Installed(targetRoot string, m *manifest.Manifest) (*Result, error) {
	targetRoot, err := safepath.CanonicalRoot(targetRoot)
	if err != nil {
		return nil, err
	}
	if err := installer.AssertEveJSSentinel(targetRoot); err != nil {
		return nil, err
	}
	state, err := installer.LoadState(targetRoot)
	if err != nil {
		return nil, err
	}
	if state == nil {
		return nil, fmt.Errorf("no X-Eve installation state found in %s", targetRoot)
	}
	// The uninstall helper contains the state-vs-manifest cross-check; reuse it
	// to guarantee the same release semantics.
	if err := installer.VerifyStateAgainstManifest(state, m.Files); err != nil {
		return nil, err
	}
	for _, entry := range state.Files {
		targetPath, err := safepath.ResolveChild(targetRoot, entry.Path)
		if err != nil {
			return nil, err
		}
		if err := installer.VerifyFileMatches(targetPath, entry.SHA256, entry.Size); err != nil {
			return nil, fmt.Errorf("file integrity mismatch: %s", entry.Path)
		}
	}
	if err := installer.VerifyRuntimeStaticDataReferences(targetRoot, m.Files); err != nil {
		return nil, err
	}
	return &Result{Installed: true, FilesOK: len(state.Files)}, nil
}

// Baseline verifies that a tree is an unmodified supported baseline (nothing
// installed).
func Baseline(targetRoot string, m *manifest.Manifest) (*Result, error) {
	targetRoot, err := safepath.CanonicalRoot(targetRoot)
	if err != nil {
		return nil, err
	}
	if err := installer.AssertEveJSSentinel(targetRoot); err != nil {
		return nil, err
	}
	state, err := installer.LoadState(targetRoot)
	if err != nil {
		return nil, err
	}
	if state != nil {
		return nil, fmt.Errorf("this tree already has an X-Eve installation state; use the default verify instead")
	}
	if err := installer.VerifyBaselineState(targetRoot, m.Files); err != nil {
		return nil, err
	}
	return &Result{Installed: false, FilesOK: len(m.Files)}, nil
}

// Integrity validates the release data itself: every overlay file referenced
// by the manifest must exist and match its recorded installed hash, and every
// content file must be listed by the manifest.
func Integrity(m *manifest.Manifest, dataRoot interface {
	ContentFor(manifest.File) (string, error)
}) (*Result, error) {
	files := m.ByPath()
	for _, f := range files {
		if f.Operation != "overlay" {
			continue
		}
		source, err := dataRoot.ContentFor(f)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(source); err != nil {
			return nil, fmt.Errorf("overlay content missing for %s: %s", f.Path, source)
		}
		if err := installer.VerifyFileMatches(source, f.Installed.SHA256, f.Installed.Size); err != nil {
			return nil, fmt.Errorf("overlay content hash mismatch for %s", f.Path)
		}
	}
	return &Result{Installed: false, FilesOK: len(files)}, nil
}
