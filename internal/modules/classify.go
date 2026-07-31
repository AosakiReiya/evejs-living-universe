package modules

import (
	"fmt"
	"sort"
	"strings"
)

// canonicalOrder is the fixed output order of the module index, matching the
// original generator.
var canonicalOrder = []string{
	"core",
	"livingUniverse",
	"livingEconomy",
	"livingConflict",
	"industrialHirelings",
	"familyEstate",
	"liveEvents",
	"xEve",
}

// moduleMeta holds the human metadata for each module.
var moduleMeta = map[string]struct {
	name        string
	gate        string
	description string
}{
	"core": {
		name: "Core platform",
		description: "Shared, always-installed platform: launchers, configuration, " +
			"persistence (gameStore), chat infrastructure, the main space " +
			"tick, movement/destiny, networking, image/web gateways, and the " +
			"general NPC engine.",
	},
	"livingUniverse": {
		name: "Living Universe",
		gate: "livingUniverseEnabled",
		description: "Persistent NPC pilots, virtual travel, observed materialization, " +
			"portraits, affiliations, and ambient traffic.",
	},
	"livingEconomy": {
		name: "Living Economy",
		gate: "livingEconomyEnabled",
		description: "Conserved regional stock, mining, hauling, procurement, " +
			"production, market topology, and the Rust market daemon changes.",
	},
	"livingConflict": {
		name: "Living Conflict",
		gate: "livingConflictEnabled",
		description: "Witnessable combat, faction hostility, kill credit, losses, " +
			"replacement demand, roaming conflicts, and security responses.",
	},
	"industrialHirelings": {
		name: "Industrial Hirelings & Mining Crews",
		gate: "industrialHirelingsEnabled",
		description: "Corporation-visible industrial crews: hirelings, mining crews, " +
			"pooled defensive drones, employee projections, and contracts.",
	},
	"familyEstate": {
		name: "Family Estate",
		gate: "familyEstateEnabled",
		description: "Shared-corporation estate, restoration flow, and the permanent " +
			"estate wormhole conduits/signatures.",
	},
	"liveEvents": {
		name:        "Live Events",
		gate:        "liveEventsEnabled",
		description: "Deadline-driven optional event framework and its definitions.",
	},
	"xEve": {
		name: "X-Eve Core",
		gate: "xEveEnabled",
		description: "Experimental economic kernel, ledger, event circuit, load " +
			"governor, and adaptive scheduler.",
	},
}

// rules is the ordered classification table. First matching prefix wins, so
// specific paths are listed before general ones. These rules are curated and
// must be kept in sync with the manifest file set.
var rules = []struct {
	module   string
	prefixes []string
}{
	{"liveEvents", []string{
		"server/scripts/verifyLiveEvent",
		"server/scripts/verifyDeadlineQueue",
		"server/src/gameStore/data/liveEventDefinitions/data.json",
		"server/src/space/liveEvents/",
	}},
	{"xEve", []string{
		"server/scripts/verifyXEve",
		"server/scripts/captureXEveStressSample",
		"server/src/services/xEve/",
	}},
	{"familyEstate", []string{
		"server/scripts/verifyFamilyEstate",
		"server/src/services/estate/",
		"server/src/services/exploration/",
		"server/src/services/chat/wormhole/",
	}},
	{"industrialHirelings", []string{
		"server/scripts/verifyIndustrial",
		"server/scripts/verifyManagedIndustrialCrewDefense",
		"server/scripts/verifyCorporationSyntheticEmployeeProjection",
		"server/scripts/migrateIndustrialHirelingsToCrews",
		"server/src/services/industrialHirelings/",
		"server/src/services/drone/",
		"server/src/services/corporation/corpReadOnlyEmployeeProjection.js",
		"server/src/space/npc/governance/industrialCrewDoctrineCatalog.js",
		"server/tests/",
	}},
	{"livingConflict", []string{
		"server/scripts/verifyLivingConflict",
		"server/scripts/verifyLivingFactionHostility",
		"server/scripts/verifyLivingReplacementCoverage",
		"server/scripts/verifyLivingRoaming",
		"server/scripts/verifyDestructionReplacementTelemetry",
		"server/scripts/analyzeDestructionReplacementStress",
		"server/src/space/npc/ambientTraffic/livingConflict",
		"server/src/space/npc/ambientTraffic/livingKill",
		"server/src/space/npc/ambientTraffic/livingRoaming",
		"server/src/space/combat/",
		"server/src/space/npc/empireSecurity/",
		"server/src/services/character/factionHostilityRuntime.js",
		"server/src/services/character/factionKillStandingRuntime.js",
		"server/src/services/bounty/bountyProxyService.js",
		"server/src/services/structure/structureState.js",
	}},
	{"livingEconomy", []string{
		"server/scripts/verifyLivingEconomy",
		"server/scripts/bootstrapLivingEconomyMarket",
		"server/scripts/auditLivingEconomyTransit",
		"server/scripts/inspectLivingEconomy",
		"server/scripts/reportLivingEconomyTelemetry",
		"server/scripts/recoverLivingEconomyIndustryJobs",
		"server/scripts/repairLivingEconomyIndustryReplay",
		"server/scripts/syncLivingEconomyMarketTopology",
		"server/src/space/npc/ambientTraffic/livingEconomy",
		"server/src/space/asteroids/asteroidService.js",
		"server/src/space/modules/salvagerRuntime.js",
		"server/src/services/market/",
		"server/src/services/mining/",
		"externalservices/",
		"tools/market-seed/",
	}},
	{"livingUniverse", []string{
		"server/scripts/verifyLivingUniverse",
		"server/scripts/syncLivingUniversePortraits",
		"server/scripts/verifyAmbientTrafficPilot",
		"server/scripts/verifySyntheticChatPresence",
		"server/src/space/npc/ambientTraffic/livingUniverse",
		"server/src/space/npc/ambientTraffic/ambientTraffic",
		"server/src/services/character/charMgrService.js",
		"server/src/services/character/characterState.js",
		"server/src/space/npc/governance/npcDoctrineGovernance.js",
		"server/src/space/npc/governance/trafficDoctrineCatalog.js",
		"server/src/space/npc/governance/regionalTrafficDoctrineCatalog.js",
	}},
	{"core", []string{
		"server/index.js",
		"evejs.config.x-eve.json",
		"Play.bat",
		"README.md",
		"StartMarketServer.bat",
		"StartServer.bat",
		".dockerignore",
		"docker/",
		"tools/ServerStack/",
		"server/src/config/",
		"server/src/_secondary/",
		"server/src/gameStore/",
		"server/src/network/",
		"server/src/services/config/",
		"server/src/services/chat/",
		"server/src/services/corporation/",
		"server/src/services/ship/",
		"server/src/space/runtime.js",
		"server/src/space/transitions.js",
		"server/src/space/worldData.js",
		"server/src/space/runtimePerformanceTelemetry.js",
		"server/src/space/destiny/",
		"server/src/space/npc/",
	}},
}

// classifyPath returns the owning module for a manifest path, or "" if none.
func classifyPath(path string) string {
	for _, r := range rules {
		for _, prefix := range r.prefixes {
			if strings.HasPrefix(path, prefix) {
				return r.module
			}
		}
	}
	return ""
}

// Generate builds a module index from the authoritative manifest file paths.
// Every path must classify to exactly one module; the union must equal the
// input set.
func Generate(paths []string) (*Index, error) {
	if len(paths) == 0 {
		return nil, fmt.Errorf("no manifest paths to classify")
	}
	index := &Index{
		SchemaVersion: SchemaVersion,
		Modules:       ModuleMap{},
	}
	for _, name := range canonicalOrder {
		meta := moduleMeta[name]
		index.Modules[name] = ModuleData{
			Name:        meta.name,
			Gate:        meta.gate,
			Description: meta.description,
			Files:       []string{},
			Verify:      []string{},
			Scripts:     []string{},
		}
	}

	var unclassified []string
	for _, path := range paths {
		module := classifyPath(path)
		if module == "" {
			unclassified = append(unclassified, path)
			continue
		}
		entry := index.Modules[module]
		if strings.HasPrefix(path, "server/scripts/") {
			base := path[strings.LastIndex(path, "/")+1:]
			if strings.HasPrefix(base, "verify") {
				entry.Verify = append(entry.Verify, path)
			} else {
				entry.Scripts = append(entry.Scripts, path)
			}
		} else {
			entry.Files = append(entry.Files, path)
		}
		index.Modules[module] = entry
	}
	if len(unclassified) > 0 {
		sort.Strings(unclassified)
		return nil, fmt.Errorf("unclassified files:\n  %s", strings.Join(unclassified, "\n  "))
	}

	assigned := map[string]bool{}
	for _, name := range canonicalOrder {
		entry := index.Modules[name]
		for _, p := range append(append(append([]string{}, entry.Files...), entry.Verify...), entry.Scripts...) {
			if assigned[p] {
				return nil, fmt.Errorf("path assigned to multiple modules: %s", p)
			}
			assigned[p] = true
		}
		sort.Strings(entry.Files)
		sort.Strings(entry.Verify)
		sort.Strings(entry.Scripts)
		index.Modules[name] = entry
	}
	for _, path := range paths {
		if !assigned[path] {
			return nil, fmt.Errorf("path has no module assignment: %s", path)
		}
	}
	if len(assigned) != len(paths) {
		return nil, fmt.Errorf("module index references a path outside the manifest")
	}
	return index, nil
}
