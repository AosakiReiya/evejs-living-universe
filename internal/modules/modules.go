// Package modules defines the module index that describes which overlay file
// belongs to which subsystem. The index is pure metadata: it never moves
// files and never changes hashes.
package modules

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
)

const SchemaVersion = 1

// Core is the always-installed shared platform module.
const Core = "core"

// ModuleData describes one subsystem.
type ModuleData struct {
	Name        string   `json:"name"`
	Gate        string   `json:"gate"` // empty for core
	Description string   `json:"description"`
	Files       []string `json:"files"`
	Verify      []string `json:"verify"`
	Scripts     []string `json:"scripts"`
}

// ModuleMap maps module names to their data. It serializes in canonical order
// so the generated index is byte-stable.
type ModuleMap map[string]ModuleData

// moduleJSON is the on-disk form that maps an empty core gate to JSON null.
type moduleJSON struct {
	Name        string   `json:"name"`
	Gate        any      `json:"gate"`
	Description string   `json:"description"`
	Files       []string `json:"files"`
	Verify      []string `json:"verify"`
	Scripts     []string `json:"scripts"`
}

// MarshalJSON writes the modules in canonical order with a JSON null gate for
// core, using no HTML escaping so the output matches the original generator.
func (m ModuleMap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	for _, name := range canonicalOrder {
		data, ok := m[name]
		if !ok {
			continue
		}
		mj := moduleJSON{
			Name:        data.Name,
			Description: data.Description,
			Files:       data.Files,
			Verify:      data.Verify,
			Scripts:     data.Scripts,
		}
		if data.Gate != "" {
			mj.Gate = data.Gate
		}
		var value bytes.Buffer
		venc := json.NewEncoder(&value)
		venc.SetEscapeHTML(false)
		if err := venc.Encode(mj); err != nil {
			return nil, err
		}
		if !first {
			buf.WriteByte(',')
		}
		first = false
		buf.WriteString(strconv.Quote(name))
		buf.WriteByte(':')
		buf.Write(bytes.TrimRight(value.Bytes(), "\n"))
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// Index is the top-level modules.json document.
type Index struct {
	SchemaVersion int       `json:"schemaVersion"`
	Modules       ModuleMap `json:"modules"`
}

// Save writes the index atomically with stable ordering and no HTML escaping.
func (idx *Index) Save(path string) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(idx); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Load reads and validates the index structure from disk.
func Load(path string) (*Index, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read module index: %w", err)
	}
	var idx Index
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("module index %s is not valid JSON: %w", path, err)
	}
	if idx.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("module index has unsupported schemaVersion %d", idx.SchemaVersion)
	}
	if len(idx.Modules) == 0 {
		return nil, fmt.Errorf("module index has no modules")
	}
	if _, ok := idx.Modules[Core]; !ok {
		return nil, fmt.Errorf("module index is missing the %q core module", Core)
	}
	return &idx, nil
}

// Names returns the module names in a stable order.
func (idx *Index) Names() []string {
	names := make([]string, 0, len(idx.Modules))
	for name := range idx.Modules {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// TotalFiles returns the number of entries in a module (files + verify + scripts).
func (idx *Index) TotalFiles(module string) int {
	m := idx.Modules[module]
	return len(m.Files) + len(m.Verify) + len(m.Scripts)
}

// Classify returns the module owning a path, or "" if none.
func (idx *Index) Classify(path string) string {
	for name, m := range idx.Modules {
		for _, p := range m.Files {
			if p == path {
				return name
			}
		}
		for _, p := range m.Verify {
			if p == path {
				return name
			}
		}
		for _, p := range m.Scripts {
			if p == path {
				return name
			}
		}
	}
	return ""
}

// Validate checks the index is consistent with the release manifest and the
// installed config gates.
func (idx *Index) Validate(manifestPaths map[string]bool, configKeys map[string]bool) error {
	assigned := map[string]bool{}
	for name, m := range idx.Modules {
		if name == Core {
			if m.Gate != "" {
				return fmt.Errorf("core module must not declare a feature gate")
			}
		} else if m.Gate != "" {
			if len(configKeys) > 0 && !configKeys[m.Gate] {
				return fmt.Errorf("module %q gate %q is not a key in evejs.config.x-eve.json", name, m.Gate)
			}
		}
		for _, p := range append(append(append([]string{}, m.Files...), m.Verify...), m.Scripts...) {
			if assigned[p] {
				return fmt.Errorf("path %s is assigned to more than one module", p)
			}
			assigned[p] = true
			if !manifestPaths[p] {
				return fmt.Errorf("module %q references a path missing from the manifest: %s", name, p)
			}
		}
	}
	for p := range manifestPaths {
		if !assigned[p] {
			return fmt.Errorf("manifest path is not assigned to any module: %s", p)
		}
	}
	return nil
}

// Summary returns a per-module line-oriented summary.
func (idx *Index) Summary() string {
	var b strings.Builder
	for _, name := range idx.Names() {
		m := idx.Modules[name]
		fmt.Fprintf(&b, "%-20s %4d files (src %3d, verify %3d, ops %2d)  %s\n",
			name,
			idx.TotalFiles(name),
			len(m.Files),
			len(m.Verify),
			len(m.Scripts),
			m.Name)
	}
	return b.String()
}

// EffectiveGates computes the effective value of every module gate given the
// shipped config values and local overrides. Core has no gate and is always
// enabled.
func EffectiveGates(idx *Index, shipped, local map[string]bool) map[string]bool {
	out := make(map[string]bool, len(idx.Modules))
	for name, m := range idx.Modules {
		if m.Gate == "" {
			out[name] = true
			continue
		}
		value, ok := local[m.Gate]
		if !ok {
			value = shipped[m.Gate]
		}
		out[name] = value
	}
	return out
}

// SummaryWithState renders the summary with an enabled marker per module.
func (idx *Index) SummaryWithState(gates map[string]bool) string {
	var b strings.Builder
	for _, name := range idx.Names() {
		mark := "[ ]"
		if gates[name] {
			mark = "[x]"
		}
		m := idx.Modules[name]
		gate := "  (always installed)"
		if m.Gate != "" {
			gate = "  gate: " + m.Gate
		}
		fmt.Fprintf(&b, "%s %-18s %4d files%s\n", mark, name, idx.TotalFiles(name), gate)
	}
	return b.String()
}
