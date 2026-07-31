package installer

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
)

// fakeDataRoot implements the overlay content provider used by Install/Repair.
type fakeDataRoot struct {
	overlayRoot       string
	dockerOverlayRoot string
}

func (f *fakeDataRoot) ContentFor(m manifest.File) (string, error) {
	if m.Source == "docker-overlay" {
		return filepath.Join(f.dockerOverlayRoot, filepath.FromSlash(m.Path)), nil
	}
	return filepath.Join(f.overlayRoot, filepath.FromSlash(m.Path)), nil
}

func (f *fakeDataRoot) OverlayFile(rel string) (string, error) {
	return filepath.Join(f.overlayRoot, filepath.FromSlash(rel)), nil
}

func (f *fakeDataRoot) DockerOverlayFile(rel string) (string, error) {
	return filepath.Join(f.dockerOverlayRoot, filepath.FromSlash(rel)), nil
}

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func buildEveJSBaseline(t *testing.T, root string) {
	t.Helper()
	write := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("server/package.json", `{"name":"eve.js"}`)
	write("server/index.js", "baseline index")
	write("server/src/a.js", "baseline a")
	write("docker/entrypoint.sh", "baseline sh")
	write("externalservices/market-server/placeholder", "x")
	write("server/src/gameStore/data/liveEventDefinitions/data.json", `{"events":[]}`)
}

func testManifestAndOverlay(t *testing.T) (*manifest.Manifest, *fakeDataRoot) {
	t.Helper()
	tmp := t.TempDir()
	overlay := filepath.Join(tmp, "files")
	dockerOverlay := filepath.Join(tmp, "docker-overlay")
	for _, d := range []string{overlay, dockerOverlay} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(root, rel, content string) {
		t.Helper()
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(overlay, "server/index.js", "patched index")
	write(overlay, "server/src/a.js", "patched a")
	write(overlay, "server/scripts/new.js", "added script")
	write(dockerOverlay, "docker/entrypoint.sh", "docker sh")
	write(overlay, "server/src/gameStore/data/liveEventDefinitions/data.json", `{"events":[]}`)

	m := &manifest.Manifest{
		SchemaVersion: 2,
		Release: manifest.Release{
			Version:    "0.3.0",
			EveJS:      "0.12.3.1",
			ArchiveSHA: strings.Repeat("A", 64),
		},
		Files: []manifest.File{
			{
				Path:      "server/index.js",
				Operation: "overlay",
				Kind:      "modified",
				Source:    "patch",
				Baseline:  manifest.FileState{SHA256: hashBytes([]byte("baseline index")), Size: int64(len("baseline index"))},
				Installed: manifest.FileState{SHA256: hashBytes([]byte("patched index")), Size: int64(len("patched index"))},
			},
			{
				Path:      "server/src/a.js",
				Operation: "overlay",
				Kind:      "modified",
				Source:    "patch",
				Baseline:  manifest.FileState{SHA256: hashBytes([]byte("baseline a")), Size: int64(len("baseline a"))},
				Installed: manifest.FileState{SHA256: hashBytes([]byte("patched a")), Size: int64(len("patched a"))},
			},
			{
				Path:      "server/scripts/new.js",
				Operation: "overlay",
				Kind:      "added",
				Source:    "patch",
				Installed: manifest.FileState{SHA256: hashBytes([]byte("added script")), Size: int64(len("added script"))},
			},
			{
				Path:      "docker/entrypoint.sh",
				Operation: "overlay",
				Kind:      "modified",
				Source:    "docker-overlay",
				Baseline:  manifest.FileState{SHA256: hashBytes([]byte("baseline sh")), Size: int64(len("baseline sh"))},
				Installed: manifest.FileState{SHA256: hashBytes([]byte("docker sh")), Size: int64(len("docker sh"))},
			},
		},
	}
	return m, &fakeDataRoot{overlayRoot: overlay, dockerOverlayRoot: dockerOverlay}
}

func TestFullLifecycle(t *testing.T) {
	base := t.TempDir()
	buildEveJSBaseline(t, base)
	m, root := testManifestAndOverlay(t)
	manifestPath := saveManifest(t, m)

	if err := Install(base, m, manifestPath, root, nil); err != nil {
		t.Fatalf("install: %v", err)
	}
	assertContent(t, base, "server/index.js", "patched index")
	assertContent(t, base, "server/src/a.js", "patched a")
	assertContent(t, base, "server/scripts/new.js", "added script")
	assertContent(t, base, "docker/entrypoint.sh", "docker sh")

	// A second install must be refused.
	if err := Install(base, m, manifestPath, root, nil); err == nil {
		t.Fatal("expected second install to be refused")
	}

	// Tamper and verify detection.
	if err := os.WriteFile(filepath.Join(base, "server", "index.js"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Repair restores the installed state.
	if err := Repair(base, m, manifestPath, root, nil); err != nil {
		t.Fatalf("repair: %v", err)
	}
	assertContent(t, base, "server/index.js", "patched index")

	// Uninstall restores the baseline.
	if err := Uninstall(base, m, manifestPath, nil); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	assertContent(t, base, "server/index.js", "baseline index")
	assertContent(t, base, "server/src/a.js", "baseline a")
	assertContent(t, base, "docker/entrypoint.sh", "baseline sh")
	if _, err := os.Stat(filepath.Join(base, "server", "scripts", "new.js")); !os.IsNotExist(err) {
		t.Error("added file was not removed")
	}
	if _, err := os.Stat(StatePath(base)); !os.IsNotExist(err) {
		t.Error("install state was not removed")
	}

	// Tree must now verify as a clean baseline.
	st, err := GetStatus(base, m)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Baseline {
		t.Error("tree should verify as a clean baseline after uninstall")
	}
}

func saveManifest(t *testing.T, m *manifest.Manifest) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "manifest.json")
	if err := m.Save(path); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertContent(t *testing.T, root, rel, want string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != want {
		t.Errorf("%s = %q, want %q", rel, string(raw), want)
	}
}

func TestRejectsNonEveJS(t *testing.T) {
	dir := t.TempDir()
	m, root := testManifestAndOverlay(t)
	err := Install(dir, m, saveManifest(t, m), root, nil)
	if err == nil || !strings.Contains(err.Error(), "EveJS") {
		t.Fatalf("expected EveJS sentinel error, got %v", err)
	}
}

func TestRejectsReparsePoint(t *testing.T) {
	base := t.TempDir()
	buildEveJSBaseline(t, base)
	link := filepath.Join(base, "server-link")
	if err := os.Symlink(filepath.Join(base, "server"), link); err != nil {
		t.Skip("symlinks not supported")
	}
	m, root := testManifestAndOverlay(t)
	// CanonicalRoot must reject a target root that is itself a symlink.
	if _, err := GetStatus(link, m); err == nil {
		t.Error("expected symlink target root to be rejected")
	}
	_ = root
}

func TestBackupRetainedAfterUninstall(t *testing.T) {
	base := t.TempDir()
	buildEveJSBaseline(t, base)
	m, root := testManifestAndOverlay(t)
	stateDir := InstallRoot(base)
	backups := filepath.Join(stateDir, "backups")
	if err := Install(base, m, saveManifest(t, m), root, nil); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(backups)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected one backup directory, got %d", len(entries))
	}
	if err := Uninstall(base, m, saveManifest(t, m), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(backups, entries[0].Name(), "server", "index.js")); err != nil {
		t.Errorf("backup was not retained: %v", err)
	}
}
