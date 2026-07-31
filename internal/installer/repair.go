package installer

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/AosakiReiya/evejs-living-universe/internal/hashutil"
	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

// Repair re-applies every overlay file from the release content tree so the
// target returns to the exact installed state recorded by the manifest. It
// requires an existing local install state and refuses to touch a tree whose
// patch release differs from the local manifest.
func Repair(targetRoot string, m *manifest.Manifest, manifestPath string, dataRoot interface {
	ContentFor(manifest.File) (string, error)
}, logf func(string, ...any)) error {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	targetRoot, err := safepath.CanonicalRoot(targetRoot)
	if err != nil {
		return err
	}
	if err := AssertEveJSSentinel(targetRoot); err != nil {
		return err
	}

	state, err := LoadState(targetRoot)
	if err != nil {
		return err
	}
	if state == nil {
		return fmt.Errorf("no X-Eve installation state found in %s; install the patch before repairing", targetRoot)
	}

	manifestSHA, _, err := hashutil.File(manifestPath)
	if err != nil {
		return fmt.Errorf("cannot hash release manifest: %w", err)
	}
	if state.ManifestSHA256 != manifestSHA {
		return fmt.Errorf("local install state does not match this release manifest; expected %s, found %s", state.ManifestSHA256, manifestSHA)
	}

	if err := safepath.AssertNoSymlink(targetRoot, InstallRoot(targetRoot)); err != nil {
		return err
	}
	release, err := AcquireLock(targetRoot)
	if err != nil {
		return err
	}
	defer release()

	for _, f := range m.ByPath() {
		if f.Operation != "overlay" {
			continue
		}
		source, err := dataRoot.ContentFor(f)
		if err != nil {
			return err
		}
		targetPath, err := safepath.ResolveChild(targetRoot, f.Path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if err := copyBytes(source, targetPath); err != nil {
			return fmt.Errorf("repair %s: %w", f.Path, err)
		}
		if err := VerifyFileMatches(targetPath, f.Installed.SHA256, f.Installed.Size); err != nil {
			return fmt.Errorf("repair verification failed for %s: %w", f.Path, err)
		}
	}
	if err := VerifyRuntimeStaticDataReferences(targetRoot, m.ByPath()); err != nil {
		return err
	}

	if err := WriteJSONAtomically(StatePath(targetRoot), &State{
		SchemaVersion:  StateSchemaVersion,
		PluginVersion:  m.Release.Version,
		EveJSVersion:   m.Release.EveJS,
		InstalledAtUTC: time.Now().UTC().Format(time.RFC3339),
		ManifestSHA256: manifestSHA,
		BackupRoot:     state.BackupRoot,
		Files:          filesFromManifest(m),
	}); err != nil {
		return err
	}
	logf("Repair completed; %s %s restored to the verified installed state", "X-Eve Living Universe", m.Release.Version)
	return nil
}

// filesFromManifest builds the final state records from the manifest.
func filesFromManifest(m *manifest.Manifest) []FileEntry {
	out := make([]FileEntry, 0, len(m.Files))
	for _, f := range m.ByPath() {
		if f.Operation != "overlay" {
			continue
		}
		out = append(out, FileEntry{
			Path:   f.Path,
			SHA256: f.Installed.SHA256,
			Size:   f.Installed.Size,
			Kind:   f.Kind,
			Source: f.Source,
		})
	}
	return out
}
