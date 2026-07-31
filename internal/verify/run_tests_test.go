package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeFakeNode creates a stub `node` executable that passes or fails based on
// the script name, and returns its directory.
func makeFakeNode(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	script := `#!/bin/sh
case "$1" in
  scripts/pass.js) exit 0;;
  scripts/fail.js) exit 1;;
  *) echo "unknown: $1"; exit 1;;
esac
`
	node := filepath.Join(dir, "node")
	if err := os.WriteFile(node, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRunTests(t *testing.T) {
	nodeDir := makeFakeNode(t)
	node := filepath.Join(nodeDir, "node")
	serverRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(serverRoot, "scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pass.js", "fail.js"} {
		if err := os.WriteFile(filepath.Join(serverRoot, "scripts", name), []byte("// stub"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	results := RunTests(node, serverRoot, []string{"pass.js", "fail.js"})
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}
	if !results[0].Passed || results[1].Passed {
		t.Errorf("expected pass then fail, got %+v", results)
	}
	if AllPassed(results) {
		t.Error("AllPassed should be false with a failure")
	}
	if got := SummaryLine(results); !strings.Contains(got, "1 passed, 1 failed") {
		t.Errorf("unexpected summary: %q", got)
	}
	if got := FormatTestResults(results); !strings.Contains(got, "PASS") || !strings.Contains(got, "FAIL") {
		t.Errorf("unexpected report:\n%s", got)
	}
}

func TestRunTestsAllPass(t *testing.T) {
	nodeDir := makeFakeNode(t)
	node := filepath.Join(nodeDir, "node")
	serverRoot := t.TempDir()
	results := RunTests(node, serverRoot, []string{"pass.js"})
	if !AllPassed(results) {
		t.Errorf("expected all pass, got %+v", results)
	}
}

func TestSortedCopy(t *testing.T) {
	in := []string{"b", "a", "c"}
	out := SortedCopy(in)
	if out[0] != "a" || out[2] != "c" {
		t.Errorf("SortedCopy = %v", out)
	}
	if &in[0] == &out[0] {
		t.Error("SortedCopy must not mutate its input")
	}
}
