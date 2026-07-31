package installer

import (
	"fmt"
	"strings"

	"github.com/AosakiReiya/evejs-living-universe/internal/manifest"
	"github.com/AosakiReiya/evejs-living-universe/internal/safepath"
)

// Status is a read-only report about a target tree.
type Status struct {
	State     *State
	Installed bool // patch installed per local state
	Baseline  bool // target tree matches the clean baseline
}

// GetStatus inspects a target tree without modifying it.
func GetStatus(targetRoot string, m *manifest.Manifest) (*Status, error) {
	targetRoot, err := safepath.CanonicalRoot(targetRoot)
	if err != nil {
		return nil, err
	}
	state, err := LoadState(targetRoot)
	if err != nil {
		return nil, err
	}
	status := &Status{State: state, Installed: state != nil}
	baselineErr := VerifyBaselineState(targetRoot, m.ByPath())
	status.Baseline = baselineErr == nil
	return status, nil
}

// String renders a human-readable status block.
func (s *Status) String() string {
	var b strings.Builder
	if s.State != nil {
		fmt.Fprintf(&b, "Installed:        yes\n")
		fmt.Fprintf(&b, "Plugin version:   %s\n", s.State.PluginVersion)
		fmt.Fprintf(&b, "EveJS version:    %s\n", s.State.EveJSVersion)
		fmt.Fprintf(&b, "Installed at:     %s\n", s.State.InstalledAtUTC)
		fmt.Fprintf(&b, "Backup root:      %s\n", s.State.BackupRoot)
		fmt.Fprintf(&b, "Tracked files:    %d\n", len(s.State.Files))
	} else {
		fmt.Fprintf(&b, "Installed:        no\n")
	}
	if s.Baseline {
		fmt.Fprintf(&b, "Baseline state:   clean (matches the supported EveJS archive)\n")
	} else {
		fmt.Fprintf(&b, "Baseline state:   modified or not from the supported archive\n")
	}
	return b.String()
}
