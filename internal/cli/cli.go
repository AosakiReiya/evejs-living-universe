// Package cli implements the xeve-patch command-line interface: command mode
// for scripting/CI and an interactive menu when invoked without arguments.
package cli

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/buildinfo"
	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/patch"
)

const programName = "xeve-patch"

// Run dispatches a command and returns a process exit code.
func Run(args []string) int {
	dataRootFlag := ""
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--data-root":
			if i+1 >= len(args) {
				return fail(fmt.Errorf("--data-root requires a value"))
			}
			i++
			dataRootFlag = args[i]
		case strings.HasPrefix(arg, "--data-root="):
			dataRootFlag = strings.TrimPrefix(arg, "--data-root=")
		default:
			rest = append(rest, arg)
		}
	}

	if len(rest) == 0 {
		return interactive(dataRootFlag)
	}

	cmd := rest[0]
	cmdArgs := rest[1:]

	switch cmd {
	case "install":
		return cmdInstall(dataRootFlag, cmdArgs)
	case "verify":
		return cmdVerify(dataRootFlag, cmdArgs)
	case "repair":
		return cmdRepair(dataRootFlag, cmdArgs)
	case "uninstall":
		return cmdUninstall(dataRootFlag, cmdArgs)
	case "status":
		return cmdStatus(dataRootFlag, cmdArgs)
	case "manifest":
		return cmdManifest(dataRootFlag, cmdArgs)
	case "modules":
		return cmdModules(dataRootFlag, cmdArgs)
	case "audit":
		return cmdAudit(dataRootFlag)
	case "version", "--version", "-v":
		fmt.Printf("%s %s\n", programName, buildinfo.Version)
		return 0
	case "help", "--help", "-h":
		printUsage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "%s: unknown command %q\n", programName, cmd)
		printUsage(os.Stderr)
		return 2
	}
}

func printUsage(w *os.File) {
	fmt.Fprintf(w, `%s - X-Eve Living Universe patch manager v%s

Usage:
  %s <command> [options] [--data-root <dir>]

Commands:
  install <evejs-path>    Apply the patch to a clean EveJS tree
  verify <evejs-path>     Verify an installed patch or a clean baseline
  verify --integrity      Validate the release data itself
  repair <evejs-path>     Re-apply overlay files to restore the installed state
  uninstall <evejs-path>  Restore the baseline and remove the patch
  status <evejs-path>     Show install state for a tree
  manifest                Manifest tooling (generate, validate)
  modules                 Show the subsystem module map
  audit                   Validate this release package
  version                 Print the version

Options:
  --data-root <dir>   Path to the patches/ data directory (default: next to
                      the executable, then ./patches)
  --silent            Suppress progress output (install)
  --yes               Do not prompt for confirmation

Run with no arguments for the interactive menu.
`, programName, buildinfo.Version, programName)
}

func fail(err error) int {
	fmt.Fprintf(os.Stderr, "[%s] error: %v\n", programName, err)
	return 1
}

func okf(format string, args ...any) {
	fmt.Printf("[X-Eve] "+format+"\n", args...)
}

// splitFlags partitions args into flags and positional values. Boolean flags
// never consume the following argument; only value flags do.
func splitFlags(args []string) (flags map[string]string, positionals []string, err error) {
	flags = map[string]string{}
	valueFlags := map[string]bool{
		"baseline":       true,
		"version":        true,
		"evejs":          true,
		"archive-name":   true,
		"archive-sha256": true,
		"module":         true,
		"filter":         true,
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--help" || arg == "-h":
			flags["help"] = "1"
		case strings.HasPrefix(arg, "--"):
			name := strings.TrimPrefix(arg, "--")
			var value string
			if eq := strings.IndexByte(name, '='); eq >= 0 {
				value = name[eq+1:]
				name = name[:eq]
			} else if valueFlags[name] && i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				value = args[i]
			} else {
				value = "1"
			}
			flags[name] = value
		default:
			positionals = append(positionals, arg)
		}
	}
	return flags, positionals, nil
}

// resolveDataRoot loads the data root and manifest.
func resolveDataRoot(explicit string) (*patch.DataRoot, *manifest.Manifest, error) {
	root, err := patch.ResolveDataRoot(explicit)
	if err != nil {
		return nil, nil, err
	}
	m, err := manifest.Load(root.ManifestPath())
	if err != nil {
		return nil, nil, err
	}
	return root, m, nil
}

// readLine prompts on the given reader and returns the trimmed input.
func readLine(r *bufio.Reader, prompt string) (string, error) {
	fmt.Print(prompt)
	line, err := r.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}
