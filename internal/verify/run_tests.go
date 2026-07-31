package verify

import (
	"bytes"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// TestResult reports the outcome of one verify script.
type TestResult struct {
	Script   string
	Passed   bool
	Output   string
	Duration time.Duration
}

// FindNode returns the path to a usable node binary, or an error.
func FindNode() (string, error) {
	path, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("node is required to run verification scripts, but was not found on PATH")
	}
	return path, nil
}

// RunTests executes each script with `node scripts/<name>` from the server
// root, captures output, and reports pass/fail per script.
func RunTests(nodePath, serverRoot string, scripts []string) []TestResult {
	results := make([]TestResult, 0, len(scripts))
	for _, script := range scripts {
		started := time.Now()
		cmd := exec.Command(nodePath, "scripts/"+script)
		cmd.Dir = serverRoot
		var buf bytes.Buffer
		cmd.Stdout = &buf
		cmd.Stderr = &buf
		err := cmd.Run()
		results = append(results, TestResult{
			Script:   script,
			Passed:   err == nil,
			Output:   strings.TrimSpace(buf.String()),
			Duration: time.Since(started).Round(time.Millisecond),
		})
	}
	return results
}

// AllPassed reports whether every result passed.
func AllPassed(results []TestResult) bool {
	for _, r := range results {
		if !r.Passed {
			return false
		}
	}
	return true
}

// FormatTestResults renders a per-script report.
func FormatTestResults(results []TestResult) string {
	var b strings.Builder
	for _, r := range results {
		status := "PASS"
		if !r.Passed {
			status = "FAIL"
		}
		base := r.Script
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		fmt.Fprintf(&b, "  %s  %s  (%s)\n", status, base, r.Duration)
		if !r.Passed {
			if out := r.Output; out != "" {
				lines := strings.Split(out, "\n")
				if len(lines) > 12 {
					lines = append([]string{"..."}, lines[len(lines)-12:]...)
				}
				for _, line := range lines {
					fmt.Fprintf(&b, "      %s\n", line)
				}
			} else {
				fmt.Fprintf(&b, "      (no output)\n")
			}
		}
	}
	return b.String()
}

// SummaryLine returns a one-line pass/fail summary.
func SummaryLine(results []TestResult) string {
	passed, failed := 0, 0
	for _, r := range results {
		if r.Passed {
			passed++
		} else {
			failed++
		}
	}
	if failed == 0 {
		return fmt.Sprintf("All %d verification scripts passed.", passed)
	}
	return fmt.Sprintf("%d passed, %d failed.", passed, failed)
}

// SortedCopy returns a sorted copy of the scripts.
func SortedCopy(scripts []string) []string {
	out := make([]string, len(scripts))
	copy(out, scripts)
	sort.Strings(out)
	return out
}
