package modules

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testIndex() *Index {
	return &Index{
		SchemaVersion: 1,
		Modules: map[string]ModuleData{
			"core": {
				Name:  "Core platform",
				Files: []string{"server/src/config/index.js"},
			},
			"livingEconomy": {
				Name:   "Living Economy",
				Gate:   "livingEconomyEnabled",
				Files:  []string{"server/src/services/market/marketProxyService.js"},
				Verify: []string{"server/scripts/verifyLivingEconomy.js"},
			},
		},
	}
}

func TestLoadAndValidate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "modules.json")
	idx := testIndex()
	raw, err := jsonMarshal(idx)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.TotalFiles("livingEconomy") != 2 {
		t.Errorf("TotalFiles(livingEconomy) = %d, want 2", loaded.TotalFiles("livingEconomy"))
	}
	if got := loaded.Classify("server/src/services/market/marketProxyService.js"); got != "livingEconomy" {
		t.Errorf("Classify = %q, want livingEconomy", got)
	}
}

func TestValidateConsistency(t *testing.T) {
	idx := testIndex()
	manifestPaths := map[string]bool{
		"server/src/config/index.js":                       true,
		"server/src/services/market/marketProxyService.js": true,
		"server/scripts/verifyLivingEconomy.js":            true,
	}
	if err := idx.Validate(manifestPaths, map[string]bool{"livingEconomyEnabled": true}); err != nil {
		t.Fatalf("valid index rejected: %v", err)
	}

	// A manifest file missing from the index must be rejected.
	if err := idx.Validate(map[string]bool{"server/src/extra.js": true}, nil); err == nil {
		t.Error("expected missing assignment to be rejected")
	}

	// A non-core module with a bogus gate must be rejected when config keys are given.
	bad := testIndex()
	bad.Modules["livingEconomy"] = ModuleData{Gate: "nope", Files: []string{"server/src/services/market/marketProxyService.js"}}
	if err := bad.Validate(manifestPaths, map[string]bool{"livingEconomyEnabled": true}); err == nil {
		t.Error("expected bad gate to be rejected")
	}
}

func TestValidateCoreGate(t *testing.T) {
	idx := testIndex()
	idx.Modules["core"] = ModuleData{Gate: "livingUniverseEnabled", Files: []string{"server/src/config/index.js"}}
	if err := idx.Validate(map[string]bool{"server/src/config/index.js": true}, nil); err == nil {
		t.Error("expected core module with a gate to be rejected")
	}
}

func TestDuplicateAssignmentRejected(t *testing.T) {
	idx := testIndex()
	dup := ModuleData{Gate: "livingEconomyEnabled", Files: []string{"server/src/config/index.js"}}
	idx.Modules["dupe"] = dup
	manifestPaths := map[string]bool{
		"server/src/config/index.js":                       true,
		"server/src/services/market/marketProxyService.js": true,
		"server/scripts/verifyLivingEconomy.js":            true,
	}
	if err := idx.Validate(manifestPaths, nil); err == nil || !strings.Contains(err.Error(), "more than one") {
		t.Errorf("expected duplicate rejection, got %v", err)
	}
}

func TestMissingCoreRejected(t *testing.T) {
	idx := &Index{SchemaVersion: 1, Modules: map[string]ModuleData{"livingEconomy": {}}}
	if _, err := Load(writeTemp(t, idx)); err == nil {
		t.Error("expected missing core module to be rejected")
	}
}

func TestEffectiveGates(t *testing.T) {
	idx := testIndex()
	shipped := map[string]bool{"livingEconomyEnabled": true}
	// Local override flips the gate off.
	gates := EffectiveGates(idx, shipped, map[string]bool{"livingEconomyEnabled": false})
	if gates["core"] != true {
		t.Error("core must always be enabled")
	}
	if gates["livingEconomy"] != false {
		t.Error("local override should flip livingEconomy off")
	}
	// Without a local override, the shipped value wins.
	gates = EffectiveGates(idx, shipped, map[string]bool{})
	if gates["livingEconomy"] != true {
		t.Error("shipped value should be used when no local override")
	}
}

func TestSummaryWithState(t *testing.T) {
	idx := testIndex()
	out := idx.SummaryWithState(map[string]bool{"core": true, "livingEconomy": false})
	if !strings.Contains(out, "[x] core") {
		t.Errorf("core should be marked enabled:\n%s", out)
	}
	if !strings.Contains(out, "[ ] livingEconomy") {
		t.Errorf("livingEconomy should be marked disabled:\n%s", out)
	}
	if !strings.Contains(out, "gate: livingEconomyEnabled") {
		t.Errorf("summary should show the gate:\n%s", out)
	}
}

func TestGenerate(t *testing.T) {
	paths := []string{
		"server/src/services/market/marketProxyService.js",
		"server/scripts/verifyLivingEconomy.js",
		"server/scripts/bootstrapLivingEconomyMarket.js",
		"server/src/space/runtime.js",
		"server/src/config/index.js",
		"server/src/services/xEve/xEveLedger.js",
		"server/scripts/verifyXEveCore.js",
	}
	idx, err := Generate(paths)
	if err != nil {
		t.Fatal(err)
	}
	if got := idx.Classify("server/src/services/market/marketProxyService.js"); got != "livingEconomy" {
		t.Errorf("market service -> %q, want livingEconomy", got)
	}
	if got := idx.Classify("server/scripts/verifyLivingEconomy.js"); got != "livingEconomy" {
		t.Errorf("verify script -> %q, want livingEconomy", got)
	}
	if got := idx.Classify("server/scripts/bootstrapLivingEconomyMarket.js"); got != "livingEconomy" {
		t.Errorf("ops script -> %q, want livingEconomy", got)
	}
	if got := idx.Classify("server/src/space/runtime.js"); got != "core" {
		t.Errorf("runtime -> %q, want core", got)
	}
	if got := idx.Classify("server/src/services/xEve/xEveLedger.js"); got != "xEve" {
		t.Errorf("xEve ledger -> %q, want xEve", got)
	}
	eco := idx.Modules["livingEconomy"]
	if len(eco.Files) != 1 || len(eco.Verify) != 1 || len(eco.Scripts) != 1 {
		t.Errorf("economy buckets wrong: files=%d verify=%d scripts=%d", len(eco.Files), len(eco.Verify), len(eco.Scripts))
	}
}

func TestGenerateRejectsUnclassified(t *testing.T) {
	if _, err := Generate([]string{"server/src/unknown/path.js"}); err == nil {
		t.Error("expected unclassified path to be rejected")
	}
}

func TestGenerateEmpty(t *testing.T) {
	if _, err := Generate(nil); err == nil {
		t.Error("expected empty input to be rejected")
	}
}

func TestSaveIsDeterministic(t *testing.T) {
	paths := []string{
		"server/src/config/index.js",
		"server/src/services/xEve/xEveLedger.js",
		"server/src/services/market/marketProxyService.js",
		"server/scripts/verifyXEveCore.js",
		"server/scripts/verifyLivingEconomy.js",
	}
	idx, err := Generate(paths)
	if err != nil {
		t.Fatal(err)
	}
	first := filepath.Join(t.TempDir(), "m1.json")
	second := filepath.Join(t.TempDir(), "m2.json")
	if err := idx.Save(first); err != nil {
		t.Fatal(err)
	}
	if err := idx.Save(second); err != nil {
		t.Fatal(err)
	}
	raw1, _ := os.ReadFile(first)
	raw2, _ := os.ReadFile(second)
	if string(raw1) != string(raw2) {
		t.Errorf("Save is not deterministic")
	}
	if !strings.Contains(string(raw1), `"gate": null`) {
		t.Errorf("core gate should serialize as null:\n%s", raw1)
	}
	if !strings.Contains(string(raw1), `"verify": []`) {
		t.Errorf("empty verify should serialize as [], got:\n%s", raw1)
	}
	if !strings.Contains(string(raw1), `"name": "Industrial Hirelings & Mining Crews"`) {
		t.Errorf("HTML chars must not be escaped:\n%s", raw1)
	}
	// canonical order: core before livingEconomy before xEve.
	if strings.Index(string(raw1), `"core"`) > strings.Index(string(raw1), `"xEve"`) {
		t.Errorf("modules must be written in canonical order:\n%s", raw1)
	}
}

func TestGenerateMatchesManifest(t *testing.T) {
	// The real manifest must classify with no gaps.
	manifestPaths := []string{
		"Play.bat",
		"evejs.config.x-eve.json",
		"server/index.js",
		"server/src/space/runtime.js",
		"server/src/gameStore/sqliteStore.js",
		"docker/entrypoint.sh",
		".dockerignore",
		"server/scripts/verifyDeadlineQueue.js",
		"server/src/space/liveEvents/deadlineQueue.js",
		"server/tests/industrialHirelingNavigation.test.js",
	}
	idx, err := Generate(manifestPaths)
	if err != nil {
		t.Fatal(err)
	}
	_ = idx
}

func jsonMarshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func writeTemp(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "modules.json")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
