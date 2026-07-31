package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/modules"
	"github.com/AosakiReiya/evejs-living-universe/internal/patch"
)

func cmdModules(dataRootFlag string, args []string) int {
	if len(args) > 0 && args[0] == "generate" {
		return cmdModulesGenerate(dataRootFlag, args[1:])
	}
	flags, positionals, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch modules [evejs-path] [--module <name>] [--json]")
		fmt.Println("       xeve-patch modules generate [--data-root <dir>]")
		return 0
	}
	root, _, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	idx, err := modules.Load(modulesIndexPath(root.Root))
	if err != nil {
		return fail(err)
	}

	if flags["json"] == "1" {
		raw, err := json.MarshalIndent(idx, "", "  ")
		if err != nil {
			return fail(err)
		}
		fmt.Println(string(raw))
		return 0
	}

	name := flags["module"]
	if name == "" {
		fmt.Printf("X-Eve Living Universe modules (schema v%d)\n\n", idx.SchemaVersion)
		if len(positionals) > 0 {
			gates, err := effectiveGatesForTree(root, positionals[0])
			if err != nil {
				return fail(err)
			}
			fmt.Print(idx.SummaryWithState(gates))
		} else {
			fmt.Print(idx.Summary())
		}
		return 0
	}
	m, ok := idx.Modules[name]
	if !ok {
		return fail(fmt.Errorf("unknown module %q (valid: %s)", name, strings.Join(idx.Names(), ", ")))
	}
	gate := m.Gate
	if gate == "" {
		gate = "(always installed)"
	}
	fmt.Printf("Module:        %s (%s)\n", name, m.Name)
	fmt.Printf("Feature gate:  %s\n", gate)
	fmt.Printf("Description:   %s\n\n", m.Description)
	printGroup("Overlay files", m.Files)
	printGroup("Verify scripts", m.Verify)
	printGroup("Ops scripts", m.Scripts)
	return 0
}

// cmdModulesGenerate regenerates patches/modules.json from the release manifest.
func cmdModulesGenerate(dataRootFlag string, args []string) int {
	flags, _, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch modules generate [--data-root <dir>]")
		return 0
	}
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	paths := make([]string, 0, len(m.Files))
	for _, f := range m.Files {
		paths = append(paths, f.Path)
	}
	idx, err := modules.Generate(paths)
	if err != nil {
		return fail(err)
	}
	out := modulesIndexPath(root.Root)
	if err := idx.Save(out); err != nil {
		return fail(err)
	}
	okf("Wrote %s (schema v%d, %d modules).", out, idx.SchemaVersion, len(idx.Modules))
	fmt.Print(idx.Summary())
	return 0
}

// effectiveGatesForTree computes each module's effective gate from the shipped
// profile overridden by the target tree's evejs.config.x-eve.local.json.
func effectiveGatesForTree(root *patch.DataRoot, targetRoot string) (map[string]bool, error) {
	idx, err := modules.Load(modulesIndexPath(root.Root))
	if err != nil {
		return nil, err
	}
	shipped, err := loadConfigValues(root)
	if err != nil {
		return nil, err
	}
	local := map[string]bool{}
	localPath := filepath.Join(targetRoot, "evejs.config.x-eve.local.json")
	if raw, err := os.ReadFile(localPath); err == nil {
		var config map[string]any
		if err := json.Unmarshal(raw, &config); err != nil {
			return nil, fmt.Errorf("evejs.config.x-eve.local.json is not valid JSON: %w", err)
		}
		for k, v := range config {
			if b, ok := v.(bool); ok {
				local[k] = b
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return modules.EffectiveGates(idx, shipped, local), nil
}

// loadConfigValues reads the boolean values of the installed config profile.
func loadConfigValues(root *patch.DataRoot) (map[string]bool, error) {
	path, err := root.OverlayFile("evejs.config.x-eve.json")
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, fmt.Errorf("evejs.config.x-eve.json is not valid JSON: %w", err)
	}
	values := make(map[string]bool, len(config))
	for k, v := range config {
		if b, ok := v.(bool); ok {
			values[k] = b
		}
	}
	return values, nil
}

func printGroup(title string, paths []string) {
	if len(paths) == 0 {
		fmt.Printf("%s: (none)\n", title)
		return
	}
	fmt.Printf("%s (%d):\n", title, len(paths))
	for _, p := range paths {
		fmt.Printf("  %s\n", p)
	}
	fmt.Println()
}

// modulesIndexPath returns the modules.json path inside a data root.
func modulesIndexPath(dataRoot string) string {
	return filepath.Join(dataRoot, "modules.json")
}

// validateModuleIndex checks the module index against the manifest and the
// installed config gates.
func validateModuleIndex(root interface {
	OverlayFile(string) (string, error)
}, dataRoot string, m *manifest.Manifest) error {
	idx, err := modules.Load(modulesIndexPath(dataRoot))
	if err != nil {
		return err
	}
	manifestPaths := make(map[string]bool, len(m.Files))
	for _, f := range m.Files {
		manifestPaths[f.Path] = true
	}
	configKeys, err := loadConfigKeys(root)
	if err != nil {
		return err
	}
	if err := idx.Validate(manifestPaths, configKeys); err != nil {
		return err
	}
	return nil
}

// loadConfigKeys reads the top-level boolean gates of the installed config.
func loadConfigKeys(root interface {
	OverlayFile(string) (string, error)
}) (map[string]bool, error) {
	path, err := root.OverlayFile("evejs.config.x-eve.json")
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config map[string]any
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, fmt.Errorf("evejs.config.x-eve.json is not valid JSON: %w", err)
	}
	keys := make(map[string]bool, len(config))
	for k := range config {
		keys[k] = true
	}
	return keys, nil
}
