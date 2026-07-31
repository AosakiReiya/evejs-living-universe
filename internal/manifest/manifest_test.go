package manifest

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testManifest() *Manifest {
	return &Manifest{
		SchemaVersion: 3,
		Release: Release{
			Version:    "0.3.0",
			EveJS:      "0.12.3.1",
			ArchiveSHA: strings.Repeat("A", 64),
		},
		Files: []File{
			{
				Path:      "server/a.js",
				Operation: "overlay",
				Kind:      "modified",
				Source:    "patch",
				Baseline:  FileState{SHA256: strings.Repeat("B", 64), Size: 3},
				Installed: FileState{SHA256: strings.Repeat("C", 64), Size: 4},
				Module:    "core",
			},
			{
				Path:      "server/new.js",
				Operation: "overlay",
				Kind:      "added",
				Source:    "patch",
				Installed: FileState{SHA256: strings.Repeat("D", 64), Size: 5},
				Module:    "livingEconomy",
			},
		},
	}
}

func TestValidate(t *testing.T) {
	m := testManifest()
	if err := m.Validate(); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	m.Files[0].Path = "../escape"
	if err := m.Validate(); err == nil {
		t.Error("traversal path accepted")
	}
	m = testManifest()
	m.Files[0].Baseline = FileState{}
	if err := m.Validate(); err == nil {
		t.Error("modified file without baseline hash accepted")
	}
	m = testManifest()
	m.Files[0].Installed = FileState{}
	if err := m.Validate(); err == nil {
		t.Error("file without installed hash accepted")
	}
	m = testManifest()
	m.Files[0].Module = ""
	if err := m.Validate(); err == nil {
		t.Error("v3 file without module assignment accepted")
	}
}

func TestApplyModules(t *testing.T) {
	raw := &Manifest{
		SchemaVersion: 2,
		Release: Release{
			Version:    "0.3.0",
			EveJS:      "0.12.3.1",
			ArchiveSHA: strings.Repeat("A", 64),
		},
		Files: []File{
			{
				Path:      "server/a.js",
				Operation: "overlay",
				Kind:      "modified",
				Source:    "patch",
				Baseline:  FileState{SHA256: strings.Repeat("B", 64), Size: 3},
				Installed: FileState{SHA256: strings.Repeat("C", 64), Size: 4},
			},
		},
	}
	if err := raw.ApplyModules(map[string]string{"server/a.js": "core"}); err != nil {
		t.Fatalf("ApplyModules: %v", err)
	}
	if raw.SchemaVersion != 3 || raw.Files[0].Module != "core" {
		t.Errorf("ApplyModules did not bump schema or stamp module: %+v", raw)
	}
	if err := raw.ApplyModules(map[string]string{}); err == nil {
		t.Error("ApplyModules accepted a missing assignment")
	}
}

func TestSaveLoad(t *testing.T) {
	m := testManifest()
	path := filepath.Join(t.TempDir(), "manifest.json")
	if err := m.Save(path); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 2 || got.Release.Version != "0.3.0" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestGenerate(t *testing.T) {
	overlay := t.TempDir()
	overlayFiles := filepath.Join(overlay, "files")
	dockerOverlay := filepath.Join(overlay, "docker-overlay")
	baseline := t.TempDir()

	writeFile(t, filepath.Join(overlayFiles, "server", "index.js"), "patched index")
	writeFile(t, filepath.Join(overlayFiles, "server", "new.js"), "added file")
	writeFile(t, filepath.Join(dockerOverlay, "docker", "entrypoint.sh"), "overlay sh")
	writeFile(t, filepath.Join(overlayFiles, "server", "shared.js"), "patch version")
	writeFile(t, filepath.Join(dockerOverlay, "server", "shared.js"), "docker version")

	writeFile(t, filepath.Join(baseline, "server", "index.js"), "baseline index")
	writeFile(t, filepath.Join(baseline, "docker", "entrypoint.sh"), "baseline sh")
	writeFile(t, filepath.Join(baseline, "server", "shared.js"), "baseline shared")

	m, err := Generate(GenerateOptions{
		Version:           "0.3.0",
		EveJS:             "0.12.3.1",
		ArchiveSHA:        strings.Repeat("A", 64),
		OverlayRoot:       overlayFiles,
		DockerOverlayRoot: dockerOverlay,
		BaselineRoot:      baseline,
	})
	if err != nil {
		t.Fatal(err)
	}
	byPath := m.Map()
	if got := byPath["server/index.js"]; got.Kind != "modified" {
		t.Errorf("index kind = %q, want modified", got.Kind)
	}
	if got := byPath["server/new.js"]; got.Kind != "added" {
		t.Errorf("new kind = %q, want added", got.Kind)
	}
	if got := byPath["server/shared.js"]; got.Source != "docker-overlay" {
		t.Errorf("shared source = %q, want docker-overlay (overlap wins)", got.Source)
	}
	if got := byPath["docker/entrypoint.sh"]; got.Source != "docker-overlay" || got.Kind != "modified" {
		t.Errorf("entrypoint = source %q kind %q", got.Source, got.Kind)
	}
	// The docker-overlap file's installed hash must be the docker version.
	shared, ok := byPath["server/shared.js"]
	if !ok {
		t.Fatal("shared.js missing")
	}
	raw, _ := os.ReadFile(filepath.Join(dockerOverlay, "server", "shared.js"))
	if shared.Installed.SHA256 != hashBytes(raw) {
		t.Error("installed hash for overlapped file does not match docker content")
	}
}

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
