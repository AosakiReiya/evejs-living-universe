package installer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/AosakiReiya/evejs-living-universe/internal/hashutil"
	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

// Install applies the overlay content tree to a verified clean EveJS baseline
// and records the local install state.
func Install(targetRoot string, m *manifest.Manifest, manifestPath string, dataRoot interface {
	ContentFor(manifest.File) (string, error)
	OverlayFile(string) (string, error)
	DockerOverlayFile(string) (string, error)
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
	if state != nil {
		return fmt.Errorf("an X-Eve installation state already exists; verify or uninstall it before installing again: %s", StatePath(targetRoot))
	}

	manifestSHA, _, err := hashutil.File(manifestPath)
	if err != nil {
		return fmt.Errorf("cannot hash release manifest: %w", err)
	}

	files := m.ByPath()

	if err := VerifyBaselineState(targetRoot, files); err != nil {
		return fmt.Errorf("baseline verification failed: %w", err)
	}
	logf("Checking the exact EveJS %s baseline", m.Release.EveJS)

	installRoot := InstallRoot(targetRoot)
	if err := safepath.AssertNoSymlink(targetRoot, installRoot); err != nil {
		return err
	}
	release, err := AcquireLock(targetRoot)
	if err != nil {
		return err
	}
	defer release()

	backupRoot := ""
	backupRootAbs := ""
	attemptedApply := false
	installed := []FileEntry{}

	cleanup := func() error {
		if !attemptedApply || backupRootAbs == "" {
			return nil
		}
		if err := restoreBaseline(targetRoot, backupRootAbs, files); err != nil {
			return fmt.Errorf("rollback also failed: %w", err)
		}
		_ = os.Remove(StatePath(targetRoot))
		return nil
	}

	if err := func() error {
		ts := time.Now().UTC().Format("20060102T150405000Z")
		backupRoot = "backups/" + ts
		backupRootAbs = filepath.Join(installRoot, filepath.FromSlash(backupRoot))
		if err := safepath.AssertNoSymlink(targetRoot, backupRootAbs); err != nil {
			return err
		}
		if err := os.MkdirAll(backupRootAbs, 0o755); err != nil {
			return err
		}

		if err := backupBaselineModified(targetRoot, backupRootAbs, files); err != nil {
			return err
		}
		logf("Backing up only the original files that the patch modifies")

		attemptedApply = true
		for _, f := range files {
			if f.Operation != "overlay" || f.Source != "patch" {
				continue
			}
			source, err := dataRoot.OverlayFile(f.Path)
			if err != nil {
				return err
			}
			if err := copyFile(source, targetRoot, f.Path); err != nil {
				return fmt.Errorf("apply overlay %s: %w", f.Path, err)
			}
		}
		logf("Applying the release patch")

		for _, f := range files {
			if f.Operation != "overlay" || f.Source != "docker-overlay" {
				continue
			}
			source, err := dataRoot.DockerOverlayFile(f.Path)
			if err != nil {
				return err
			}
			if err := copyFile(source, targetRoot, f.Path); err != nil {
				return fmt.Errorf("apply docker overlay %s: %w", f.Path, err)
			}
		}
		logf("Applying Docker deployment overlay")

		for _, f := range files {
			if f.Operation != "overlay" {
				continue
			}
			targetPath, err := safepath.ResolveChild(targetRoot, f.Path)
			if err != nil {
				return err
			}
			if err := VerifyFileMatches(targetPath, f.Installed.SHA256, f.Installed.Size); err != nil {
				return fmt.Errorf("installed file verification failed for %s: %w", f.Path, err)
			}
			installed = append(installed, FileEntry{
				Path:   f.Path,
				SHA256: f.Installed.SHA256,
				Size:   f.Installed.Size,
				Kind:   f.Kind,
				Source: f.Source,
			})
		}
		logf("Verifying every installed file")

		if err := VerifyRuntimeStaticDataReferences(targetRoot, files); err != nil {
			return err
		}

		state := State{
			SchemaVersion:  StateSchemaVersion,
			PluginVersion:  m.Release.Version,
			EveJSVersion:   m.Release.EveJS,
			InstalledAtUTC: time.Now().UTC().Format(time.RFC3339),
			ManifestSHA256: manifestSHA,
			BackupRoot:     backupRoot,
			Files:          installed,
		}
		if err := WriteJSONAtomically(StatePath(targetRoot), &state); err != nil {
			return err
		}
		logf("%s %s installed successfully", "X-Eve Living Universe", m.Release.Version)
		logf("Backup: %s", backupRootAbs)
		logf("Install state: %s", StatePath(targetRoot))
		return nil
	}(); err != nil {
		if rbErr := cleanup(); rbErr != nil {
			return fmt.Errorf("installation failed: %v; %v", err, rbErr)
		}
		return fmt.Errorf("installation failed: %w", err)
	}
	return nil
}

// VerifyBaselineState checks every touched path against its expected baseline
// state (modified files must match exactly; added files must be absent).
func VerifyBaselineState(targetRoot string, files []manifest.File) error {
	for _, f := range files {
		if f.Operation != "overlay" {
			continue
		}
		targetPath, err := safepath.ResolveChild(targetRoot, f.Path)
		if err != nil {
			return err
		}
		if f.Kind == "added" {
			if _, err := os.Stat(targetPath); err == nil {
				return fmt.Errorf("the patch expects to add a path that already exists: %s", f.Path)
			} else if !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if _, err := os.Stat(targetPath); err != nil {
			return fmt.Errorf("a required %s baseline file is missing: %s", f.Path, f.Path)
		}
		if err := VerifyFileMatches(targetPath, f.Baseline.SHA256, f.Baseline.Size); err != nil {
			return fmt.Errorf("baseline mismatch for %s (the file is modified or not from the supported archive): %w", f.Path, err)
		}
	}
	return nil
}

// backupBaselineModified copies original modified files into the backup tree.
func backupBaselineModified(targetRoot, backupRootAbs string, files []manifest.File) error {
	for _, f := range files {
		if f.Operation != "overlay" || f.Kind != "modified" {
			continue
		}
		source, err := safepath.ResolveChild(targetRoot, f.Path)
		if err != nil {
			return err
		}
		dest, err := safepath.ResolveChild(backupRootAbs, f.Path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := copyBytes(source, dest); err != nil {
			return fmt.Errorf("backup %s: %w", f.Path, err)
		}
		if err := VerifyFileMatches(dest, f.Baseline.SHA256, f.Baseline.Size); err != nil {
			return fmt.Errorf("backup verification failed for %s: %w", f.Path, err)
		}
	}
	return nil
}

// restoreBaseline restores modified originals and removes added files.
func restoreBaseline(targetRoot, backupRootAbs string, files []manifest.File) error {
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
			if err := VerifyFileMatches(backupPath, f.Baseline.SHA256, f.Baseline.Size); err != nil {
				return fmt.Errorf("cannot roll back because the baseline backup is missing: %s", f.Path)
			}
			if err := copyBytes(backupPath, targetPath); err != nil {
				return err
			}
			continue
		}
		info, err := os.Stat(targetPath)
		if err == nil {
			if !info.Mode().IsRegular() {
				return fmt.Errorf("cannot roll back added path because it is no longer a regular file: %s", f.Path)
			}
			if err := os.Remove(targetPath); err != nil {
				return err
			}
			RemoveEmptyParents(targetRoot, targetPath)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return VerifyBaselineState(targetRoot, files)
}

// copyFile copies overlay content into the target tree, creating parents.
func copyFile(source, targetRoot, rel string) error {
	targetPath, err := safepath.ResolveChild(targetRoot, rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	return copyBytes(source, targetPath)
}

// copyBytes copies file bytes exactly, preserving the source permissions.
func copyBytes(source, dest string) error {
	raw, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	mode := info.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	return os.WriteFile(dest, raw, mode)
}

// VerifyRuntimeStaticDataReferences checks ../gameStore/data/*/data.json
// references used by the patched server stay inside the target tree.
func VerifyRuntimeStaticDataReferences(targetRoot string, files []manifest.File) error {
	for _, f := range files {
		if f.Operation != "overlay" || !strings.HasSuffix(f.Path, ".js") {
			continue
		}
		sourcePath, err := safepath.ResolveChild(targetRoot, f.Path)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(sourcePath)
		if err != nil {
			return err
		}
		text := string(raw)
		for _, match := range dataRefRe.FindAllString(text, -1) {
			refPath := filepath.Join(filepath.Dir(sourcePath), filepath.FromSlash(match))
			abs, err := filepath.Abs(refPath)
			if err != nil {
				return err
			}
			prefix := strings.TrimRight(targetRoot, `/\`) + string(filepath.Separator)
			if !strings.HasPrefix(abs, prefix) {
				return fmt.Errorf("runtime static-data reference escapes EveJSPath: %s -> %s", f.Path, match)
			}
			if _, err := os.Stat(abs); err != nil {
				return fmt.Errorf("runtime static-data reference is missing after patch application: %s -> %s", f.Path, match)
			}
		}
	}
	return nil
}
