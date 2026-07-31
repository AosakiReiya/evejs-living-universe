package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/modules"
	"github.com/AosakiReiya/evejs-living-universe/internal/patch"
	"github.com/AosakiReiya/evejs-living-universe/internal/verify"
)

func cmdManifest(dataRootFlag string, args []string) int {
	if len(args) == 0 {
		fmt.Println("Usage: xeve-patch manifest <generate|validate> [options]")
		return 2
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "generate":
		return cmdManifestGenerate(dataRootFlag, rest)
	case "validate":
		return cmdManifestValidate(dataRootFlag, rest)
	default:
		return fail(fmt.Errorf("unknown manifest subcommand %q", sub))
	}
}

func cmdManifestValidate(dataRootFlag string, args []string) int {
	flags, _, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch manifest validate [--data-root <dir>]")
		return 0
	}
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	if _, err := verify.Integrity(m, root); err != nil {
		return fail(err)
	}
	okf("Manifest v%d validated: %s (%d files), EveJS %s.",
		m.SchemaVersion, m.Release.Version, len(m.Files), m.Release.EveJS)
	return 0
}

func cmdManifestGenerate(dataRootFlag string, args []string) int {
	flags, _, err := splitFlags(args)
	if err != nil {
		return fail(err)
	}
	if flags["help"] == "1" {
		fmt.Println("Usage: xeve-patch manifest generate --baseline <tree> [--version v] [--evejs v] [--archive-name n] [--archive-sha256 s]")
		return 0
	}
	root, err := patch.ResolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	baseline := flags["baseline"]
	if baseline == "" {
		return fail(fmt.Errorf("manifest generate requires --baseline <clean EveJS tree>"))
	}

	opts := manifest.GenerateOptions{
		Version:           flags["version"],
		EveJS:             flags["evejs"],
		ArchiveName:       flags["archive-name"],
		ArchiveSHA:        flags["archive-sha256"],
		OverlayRoot:       filepath.Join(root.Root, "files"),
		DockerOverlayRoot: filepath.Join(root.Root, "docker-overlay"),
		BaselineRoot:      baseline,
	}
	// Defaults can be derived from an existing manifest or the VERSION file.
	if m, err := manifest.Load(root.ManifestPath()); err == nil {
		if opts.EveJS == "" {
			opts.EveJS = m.Release.EveJS
		}
		if opts.ArchiveName == "" {
			opts.ArchiveName = m.Release.ArchiveName
		}
		if opts.ArchiveSHA == "" {
			opts.ArchiveSHA = m.Release.ArchiveSHA
		}
		if opts.Note == "" {
			opts.Note = m.Release.Note
		}
	}
	if opts.Version == "" {
		if raw, err := os.ReadFile(filepath.Join(filepath.Dir(root.Root), "VERSION")); err == nil {
			opts.Version = firstLine(raw)
		}
	}

	m, err := manifest.Generate(opts)
	if err != nil {
		return fail(err)
	}
	idx, err := modules.Load(modulesIndexPath(root.Root))
	if err != nil {
		return fail(fmt.Errorf("module index: %w", err))
	}
	moduleFor := make(map[string]string, len(m.Files))
	for _, name := range idx.Names() {
		mod := idx.Modules[name]
		for _, p := range append(append(append([]string{}, mod.Files...), mod.Verify...), mod.Scripts...) {
			moduleFor[p] = name
		}
	}
	if err := m.ApplyModules(moduleFor); err != nil {
		return fail(fmt.Errorf("%w (add the new file to scripts/build-module-index.py and rerun `make modules`)", err))
	}
	out := root.ManifestPath()
	if err := m.Save(out); err != nil {
		return fail(err)
	}
	okf("Wrote %s (v%d, %s, %d files, EveJS %s).",
		out, m.SchemaVersion, m.Release.Version, len(m.Files), m.Release.EveJS)
	return 0
}

func cmdAudit(dataRootFlag string) int {
	root, m, err := resolveDataRoot(dataRootFlag)
	if err != nil {
		return fail(err)
	}
	if _, err := verify.Integrity(m, root); err != nil {
		return fail(err)
	}
	for _, dir := range []string{"files", "docker-overlay"} {
		if err := walkNoSymlinks(filepath.Join(root.Root, dir)); err != nil {
			return fail(err)
		}
	}
	if err := validateModuleIndex(root, root.Root, m); err != nil {
		return fail(fmt.Errorf("module index: %w", err))
	}
	okf("Audit passed: release package is internally consistent (%d files, module index valid).", len(m.Files))
	return 0
}

func firstLine(raw []byte) string {
	for i, b := range raw {
		if b == '\n' || b == '\r' {
			return string(raw[:i])
		}
	}
	return string(raw)
}

func walkNoSymlinks(root string) error {
	return filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symbolic links are not allowed in the release package: %s", p)
		}
		return nil
	})
}
