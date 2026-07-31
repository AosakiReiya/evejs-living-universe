package cli

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/installer"
	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/modules"
	"github.com/AosakiReiya/evejs-living-universe/internal/patch"
	"github.com/AosakiReiya/evejs-living-universe/internal/verify"
)

func cmdInstall(dataRootFlag string, args []string) int {
	flags, positionals, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch install <evejs-path> [--silent] [--yes]")
		return 0
	}
	if len(positionals) == 0 {
		return fail(fmt.Errorf("install requires an EveJS path argument"))
	}
	target := positionals[0]
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}

	logf := okf
	if flags["silent"] == "1" {
		logf = func(string, ...any) {}
	}
	if flags["yes"] != "1" && flags["silent"] != "1" && isTerminal() {
		if !confirm(bufio.NewReader(os.Stdin), fmt.Sprintf("Install %s (%s) into %s? [y/N] ", m.Release.Version, m.Release.EveJS, target)) {
			fmt.Println("Cancelled.")
			return 0
		}
	}
	if err := installer.Install(target, m, root.ManifestPath(), root, logf); err != nil {
		return fail(err)
	}
	return 0
}

func cmdVerify(dataRootFlag string, args []string) int {
	flags, positionals, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch verify <evejs-path> [--integrity] [--module <name>] [--tests] [--filter <substr>]")
		return 0
	}
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}

	if flags["integrity"] == "1" {
		result, err := verify.Integrity(m, root)
		if err != nil {
			return fail(err)
		}
		okf("Release data integrity passed (%d overlay files verified).", result.FilesOK)
		return 0
	}
	if len(positionals) == 0 {
		return fail(fmt.Errorf("verify requires an EveJS path argument (or --integrity)"))
	}
	target := positionals[0]

	state, _ := installer.LoadState(target)
	if state != nil {
		result, err := verify.Installed(target, m)
		if err != nil {
			return fail(err)
		}
		okf("Installed deployment state verification passed (%d files).", result.FilesOK)
	} else {
		result, err := verify.Baseline(target, m)
		if err != nil {
			return fail(err)
		}
		okf("Clean %s baseline integrity passed (%d files).", m.Release.EveJS, result.FilesOK)
	}

	if flags["tests"] == "1" || flags["all-tests"] == "1" || flags["module"] != "" {
		return runVerificationScripts(root, m, target, flags)
	}
	return 0
}

// runVerificationScripts runs the selected verify scripts inside the target
// tree and returns the process exit code.
func runVerificationScripts(root *patch.DataRoot, m *manifest.Manifest, target string, flags map[string]string) int {
	if _, err := installer.LoadState(target); err != nil {
		return fail(fmt.Errorf("running verification scripts requires an installed patch and install state: %w", err))
	}

	idx, err := modules.Load(modulesIndexPath(root.Root))
	if err != nil {
		return fail(fmt.Errorf("module index: %w", err))
	}

	var scripts []string
	if moduleName := flags["module"]; moduleName != "" {
		mod, ok := idx.Modules[moduleName]
		if !ok {
			return fail(fmt.Errorf("unknown module %q (valid: %s)", moduleName, strings.Join(idx.Names(), ", ")))
		}
		scripts = append(scripts, mod.Verify...)
	} else {
		for _, name := range idx.Names() {
			scripts = append(scripts, idx.Modules[name].Verify...)
		}
	}
	if filter := flags["filter"]; filter != "" {
		var filtered []string
		for _, s := range scripts {
			if strings.Contains(s, filter) {
				filtered = append(filtered, s)
			}
		}
		scripts = filtered
	}
	scripts = verify.SortedCopy(scripts)
	// modules.json stores full manifest paths (server/scripts/x.js); the
	// runner executes `node scripts/x.js` from the target's server root.
	for i := range scripts {
		scripts[i] = strings.TrimPrefix(scripts[i], "server/scripts/")
	}
	if len(scripts) == 0 {
		okf("No verification scripts selected.")
		return 0
	}

	nodePath, err := verify.FindNode()
	if err != nil {
		return fail(err)
	}
	serverRoot := filepath.Join(target, "server")
	if depsMissing(serverRoot) {
		okf("note: server dependencies (node_modules) are not installed; integration scripts may fail with MODULE_NOT_FOUND. Start the normal Play.bat once, let setup finish, then retry.")
	}
	okf("Running %d verification scripts with %s", len(scripts), nodePath)
	results := verify.RunTests(nodePath, serverRoot, scripts)
	fmt.Print(verify.FormatTestResults(results))
	if !verify.AllPassed(results) {
		fmt.Printf("[X-Eve] %s\n", verify.SummaryLine(results))
		return 1
	}
	okf("%s", verify.SummaryLine(results))
	return 0
}

// depsMissing reports whether the target's server dependencies are absent.
func depsMissing(serverRoot string) bool {
	_, err := os.Stat(filepath.Join(serverRoot, "node_modules"))
	return os.IsNotExist(err)
}

func cmdRepair(dataRootFlag string, args []string) int {
	flags, positionals, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch repair <evejs-path>")
		return 0
	}
	if len(positionals) == 0 {
		return fail(fmt.Errorf("repair requires an EveJS path argument"))
	}
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	if err := installer.Repair(positionals[0], m, root.ManifestPath(), root, okf); err != nil {
		return fail(err)
	}
	return 0
}

func cmdUninstall(dataRootFlag string, args []string) int {
	flags, positionals, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch uninstall <evejs-path> [--yes]")
		return 0
	}
	if len(positionals) == 0 {
		return fail(fmt.Errorf("uninstall requires an EveJS path argument"))
	}
	target := positionals[0]
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	if flags["yes"] != "1" && isTerminal() {
		if !confirm(bufio.NewReader(os.Stdin), fmt.Sprintf("Uninstall %s from %s? [y/N] ", m.Release.Version, target)) {
			fmt.Println("Cancelled.")
			return 0
		}
	}
	if err := installer.Uninstall(target, m, root.ManifestPath(), okf); err != nil {
		return fail(err)
	}
	return 0
}

func cmdStatus(dataRootFlag string, args []string) int {
	flags, positionals, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch status <evejs-path>")
		return 0
	}
	if len(positionals) == 0 {
		return fail(fmt.Errorf("status requires an EveJS path argument"))
	}
	_, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	status, err := installer.GetStatus(positionals[0], m)
	if err != nil {
		return fail(err)
	}
	fmt.Print(status.String())
	return 0
}

// confirm asks for y/N confirmation on the given reader.
func confirm(r *bufio.Reader, prompt string) bool {
	line, err := readLine(r, prompt)
	if err != nil {
		return false
	}
	return strings.EqualFold(line, "y") || strings.EqualFold(line, "yes")
}

// isTerminal reports whether stdout is an interactive terminal.
func isTerminal() bool {
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
