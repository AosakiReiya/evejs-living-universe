package safepath

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRel(t *testing.T) {
	valid := []string{
		"server/index.js",
		"evejs.config.x-eve.json",
		"server/src/gameStore/data/liveEventDefinitions/data.json",
		"docker/entrypoint.sh",
	}
	for _, p := range valid {
		if err := ValidateRel(p); err != nil {
			t.Errorf("ValidateRel(%q) = %v, want nil", p, err)
		}
	}
	invalid := []string{
		"",
		"/abs/path",
		`server\index.js`,
		"C:/windows",
		"../escape",
		"a/../b",
		"_local/x",
		"server/logs/x",
		"server/certs/x",
		".env",
		"server/.env.local",
		"server/data/state.sqlite",
		"server/src/gameStore/data/other/data.json",
		"a:b",
		"a\x00b",
	}
	for _, p := range invalid {
		if err := ValidateRel(p); err == nil {
			t.Errorf("ValidateRel(%q) = nil, want error", p)
		}
	}
}

func TestResolveChild(t *testing.T) {
	root := t.TempDir()
	rel := "server/scripts/new.js"
	got, err := ResolveChild(root, rel)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "server", "scripts", "new.js")
	if got != want {
		t.Errorf("ResolveChild = %q, want %q", got, want)
	}
	if _, err := ResolveChild(root, "../escape"); err == nil {
		t.Error("expected traversal to be rejected")
	}
}

func TestResolveChildRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "server"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "server"), filepath.Join(root, "link")); err != nil {
		t.Skip("symlinks not supported")
	}
	if _, err := ResolveChild(root, "link/index.js"); err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Errorf("expected symlink rejection, got %v", err)
	}
}

func TestCanonicalRoot(t *testing.T) {
	root := t.TempDir()
	got, err := CanonicalRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Clean(root) {
		t.Errorf("CanonicalRoot = %q, want %q", got, root)
	}
	if _, err := CanonicalRoot("/"); err == nil {
		t.Error("expected filesystem root to be rejected")
	}
	if _, err := CanonicalRoot(filepath.Join(root, "missing")); err == nil {
		t.Error("expected missing dir to be rejected")
	}
}
