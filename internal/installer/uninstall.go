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

// Uninstall restores the verified baseline from the install-time backups and
// removes the local install state. It refuses to run unless every installed
// file still matches the recorded state.
func Uninstall(targetRoot string, m *manifest.Manifest, manifestPath string, logf func(string, ...any)) error {
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
		return fmt.Errorf("no X-Eve installation state found in %s; nothing to uninstall", targetRoot)
	}

	manifestSHA, _, err := hashutil.File(manifestPath)
	if err != nil {
		return fmt.Errorf("cannot hash release manifest: %w", err)
	}
	if state.ManifestSHA256 != manifestSHA {
		return fmt.Errorf("local install state does not match this release manifest; expected %s, found %s", state.ManifestSHA256, manifestSHA)
	}

	files := m.ByPath()
	if err := VerifyStateAgainstManifest(state, files); err != nil {
		return err
	}

	installRoot := InstallRoot(targetRoot)
	if err := safepath.AssertNoSymlink(targetRoot, installRoot); err != nil {
		return err
	}
	release, err := AcquireLock(targetRoot)
	if err != nil {
		return err
	}
	defer release()

	backupRootAbs, err := safepath.ResolveChild(installRoot, state.BackupRoot)
	if err != nil {
		return fmt.Errorf("invalid backupRoot in install state: %w", err)
	}

	if err := verifyInstalledState(targetRoot, state); err != nil {
		return err
	}
	logf("Verifying that no installed file has been modified")

	if err := verifyBaselineBackups(backupRootAbs, files); err != nil {
		return err
	}
	logf("Verifying every original-file backup before changing anything")

	stagingRoot := ""
	started := false
	committed := false

	if err := func() error {
		ts := time.Now().UTC().Format("20060102T150405000Z")
		stagingRoot = filepath.Join(installRoot, "uninstall-staging", ts)
		if err := safepath.AssertNoSymlink(targetRoot, stagingRoot); err != nil {
			return err
		}
		if err := os.MkdirAll(stagingRoot, 0o755); err != nil {
			return err
		}
		for _, entry := range state.Files {
			source, err := safepath.ResolveChild(targetRoot, entry.Path)
			if err != nil {
				return err
			}
			dest, err := safepath.ResolveChild(stagingRoot, entry.Path)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			if err := copyBytes(source, dest); err != nil {
				return fmt.Errorf("uninstall staging failed for %s: %w", entry.Path, err)
			}
			if err := VerifyFileMatches(dest, entry.SHA256, entry.Size); err != nil {
				return fmt.Errorf("uninstall staging verification failed for %s: %w", entry.Path, err)
			}
		}

		started = true
		for _, f := range files {
			if f.Operation != "overlay" {
				continue
			}
			targetPath, err := safepath.ResolveChild(targetRoot, f.Path)
			if err != nil {
				return err
			}
			if f.Kind == "modified" {
				backupPath, err := safepath.ResolveChild(backupRootAbs, f.Path)
				if err != nil {
					return err
				}
				if err := copyBytes(backupPath, targetPath); err != nil {
					return fmt.Errorf("restore %s: %w", f.Path, err)
				}
				continue
			}
			if err := os.Remove(targetPath); err != nil {
				return fmt.Errorf("remove added file %s: %w", f.Path, err)
			}
			RemoveEmptyParents(targetRoot, targetPath)
		}
		logf("Restoring modified originals and removing only unchanged added files")

		if err := VerifyBaselineState(targetRoot, files); err != nil {
			return fmt.Errorf("restored baseline verification failed: %w", err)
		}

		if err := os.Remove(StatePath(targetRoot)); err != nil {
			return fmt.Errorf("cannot remove install state: %w", err)
		}
		committed = true
		logf("X-Eve Living Universe %s was uninstalled successfully", m.Release.Version)
		logf("The verified original-file backup was retained at: %s", backupRootAbs)
		return nil
	}(); err != nil {
		if started && !committed && stagingRoot != "" {
			if rbErr := restoreStaging(targetRoot, stagingRoot, state); rbErr != nil {
				return fmt.Errorf("uninstall failed: %v; uninstall rollback also failed: %v", err, rbErr)
			}
		}
		return fmt.Errorf("uninstall failed: %w", err)
	}

	if committed && stagingRoot != "" {
		_ = os.RemoveAll(stagingRoot)
	}
	return nil
}

// VerifyStateAgainstManifest checks the recorded state matches the release
// manifest's installed expectations.
func VerifyStateAgainstManifest(state *State, files []manifest.File) error {
	manifestMap := make(map[string]manifest.File, len(files))
	for _, f := range files {
		manifestMap[f.Path] = f
	}
	for _, entry := range state.Files {
		f, ok := manifestMap[entry.Path]
		if !ok {
			return fmt.Errorf("local install state contains a path missing from the release manifest: %s", entry.Path)
		}
		if entry.Kind != f.Kind || entry.SHA256 != f.Installed.SHA256 || entry.Size != f.Installed.Size {
			return fmt.Errorf("local install state does not match the release metadata for %s", entry.Path)
		}
	}
	if len(state.Files) != len(files) {
		return fmt.Errorf("local install state and the release manifest disagree about the file set")
	}
	return nil
}

// verifyInstalledState hashes every recorded file on disk.
func verifyInstalledState(targetRoot string, state *State) error {
	for _, entry := range state.Files {
		targetPath, err := safepath.ResolveChild(targetRoot, entry.Path)
		if err != nil {
			return err
		}
		if err := VerifyFileMatches(targetPath, entry.SHA256, entry.Size); err != nil {
			return fmt.Errorf("refusing to uninstall because an installed file was modified: %s", entry.Path)
		}
	}
	return nil
}

// verifyBaselineBackups checks the recorded original files still match.
func verifyBaselineBackups(backupRootAbs string, files []manifest.File) error {
	for _, f := range files {
		if f.Operation != "overlay" || f.Kind != "modified" {
			continue
		}
		backupPath, err := safepath.ResolveChild(backupRootAbs, f.Path)
		if err != nil {
			return err
		}
		if err := VerifyFileMatches(backupPath, f.Baseline.SHA256, f.Baseline.Size); err != nil {
			return fmt.Errorf("baseline backup failed verification: %s", f.Path)
		}
	}
	return nil
}

// restoreStaging restores the installed files from the uninstall staging tree.
func restoreStaging(targetRoot, stagingRoot string, state *State) error {
	for _, entry := range state.Files {
		source, err := safepath.ResolveChild(stagingRoot, entry.Path)
		if err != nil {
			return err
		}
		if err := VerifyFileMatches(source, entry.SHA256, entry.Size); err != nil {
			return fmt.Errorf("uninstall rollback staging is missing or corrupt: %s", entry.Path)
		}
		targetPath, err := safepath.ResolveChild(targetRoot, entry.Path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		if err := copyBytes(source, targetPath); err != nil {
			return err
		}
	}
	return verifyInstalledState(targetRoot, state)
}
