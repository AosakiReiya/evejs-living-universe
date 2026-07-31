"use strict";

/**
 * Phase 0 — gameStore table ownership map (curated source of truth).
 *
 * Declares, for every gameStore table, which subsystem OWNS it (is the
 * authoritative mutator) and whether it is runtime or static. This is the
 * foundation for decoupling state ownership ahead of any multi-core work:
 * the `in-space` runtime tables are the ones that must travel with a sol
 * node. A `shared` (multi-writer) seam would be a cross-domain transaction
 * that gates partitioning — but the Phase 0 reroute drove every table to a
 * single owner, so NO table is classified `shared` today (the category is a
 * dormant capability; see the formerly-shared block below).
 *
 * HOW THIS WAS DERIVED
 *   - `scanner`  — writer attributed by the static analysis in
 *     scripts/Ownership/scan-table-access.js (literal/constant first args).
 *   - `inferred` — the writer is hidden behind a param-helper store
 *     (e.g. space/npc/nativeNpcStore.js, services/bookmark/bookmarkRuntimeStore.js
 *     forward a `tableName` parameter to database.write); the domain is taken
 *     from the owning module's location. Verified by reading the store module.
 *   - `review`   — runtime-persisted but the owning domain is not yet
 *     confidently attributed; needs a human pass.
 *   Runtime vs static is principled: a table is runtime iff it is in
 *   gameStore's SQLITE_TABLES set. (As of the 2026-06-25 backfill, every
 *   runtime table is SQLite-backed — npcCargo/npcWrecks/npcWreckItems and
 *   corporations, previously missed, were migrated.) Everything else is
 *   static SDE/reference data, loaded read-only into memory.
 *
 * LIMITATION: the scanner cannot trace tables written through cross-file
 * param-helpers, so `inferred`/`review` entries are best-effort and meant to
 * be refined. The guard test only enforces COMPLETENESS (every real table is
 * classified) and NO-STALE (no entry for a non-existent table), not the
 * correctness of the domain label — exactly like fixtureIdentityGuard.
 *
 * Consumed by the ownership guard test (Phase 0 / 0.D, live/green) and the
 * repository layer (0.C, adopted by ~33 owner modules). The remaining planned
 * consumer is frozen-view / in-place-mutation detection (0.B), still open.
 */

const TIERS = Object.freeze({ RUNTIME: "runtime", STATIC: "static" });
const CONFIDENCE = Object.freeze({
  SCANNER: "scanner",
  INFERRED: "inferred",
  REVIEW: "review",
});

const TABLE_OWNERSHIP = {};

function define(tables, { tier, domain = null, confidence, note = null }) {
  for (const table of tables) {
    if (TABLE_OWNERSHIP[table]) {
      throw new Error(`tableOwnership: duplicate classification for "${table}"`);
    }
    TABLE_OWNERSHIP[table] = { table, tier, domain, confidence, note };
  }
}

// ── Formerly-shared seams, now single-writer ─────────────────────────
// These four were multi-writer aggregates; the Phase 0 reroute (6d8a05d0)
// funneled every writer through one owner API, so each is single-writer today
// (domain != "shared"). Documented individually because each remains a Phase 3
// transaction boundary — especially `items`, the 0.E item-custody seam.
TABLE_OWNERSHIP.characters = {
  table: "characters",
  tier: TIERS.RUNTIME,
  domain: "service:character",
  confidence: CONFIDENCE.SCANNER,
  note: "Multi-domain aggregate, but funneled through characterState's owner API (writeCharacterRecord/removeCharacterRecord). As of the Phase 0 reroute (6d8a05d0) ONLY the character domain writes this table; skills/structure/inventory/legacy-npc now call the owner API. Single-writer achieved.",
};
TABLE_OWNERSHIP.items = {
  table: "items",
  tier: TIERS.RUNTIME,
  domain: "service:inventory",
  confidence: CONFIDENCE.SCANNER,
  note: "Sole table-writer is itemStore.js (the items owner). Other domains (dogma, space, market) mutate items only through itemStore's CRUD + custody API (createSpaceItemForCharacter / updateInventoryItem / removeInventoryItem / moveItemToLocation / moveShipToSpace). The item-custody boundary (Phase 0 / 0.E).",
};
TABLE_OWNERSHIP.skills = {
  table: "skills",
  tier: TIERS.RUNTIME,
  domain: "service:skills",
  confidence: CONFIDENCE.SCANNER,
  note: "Owned by skillState (sole table-writer). Other domains delete skills records via skillState.removeSkillsRecord (Phase 0 reroute). Single-writer achieved.",
};
TABLE_OWNERSHIP.accounts = {
  table: "accounts",
  tier: TIERS.RUNTIME,
  domain: "service:login",
  confidence: CONFIDENCE.SCANNER,
  note: "Login/auth account records, owned by services/login/accountStore (sole writer). The TCP handshake and chat admin write via accountStore; userService reads. Single swap point for a future relational accounts table. Single-writer achieved.",
};

// ── Runtime · in-space (must travel with a sol node) ─────────────────
define(["npcControlState"], {
  tier: TIERS.RUNTIME,
  domain: "in-space",
  confidence: CONFIDENCE.SCANNER,
});
define(["liveEventRuntime"], {
  tier: TIERS.RUNTIME,
  domain: "in-space",
  confidence: CONFIDENCE.SCANNER,
  note: "Persistent live-event lifecycle, transaction journal, and bounded archive state.",
});
define(["livingEconomyEventJournal"], {
  tier: TIERS.RUNTIME,
  domain: "in-space",
  confidence: CONFIDENCE.SCANNER,
  note: "Durable row-scoped source journal feeding the X-Eve event inbox.",
});
define(["xEveRuntime"], {
  tier: TIERS.RUNTIME,
  domain: "service:x-eve",
  confidence: CONFIDENCE.SCANNER,
  note: "X-Eve accounts, balanced transaction journal, event inbox/outbox, and bounded work orders.",
});
define(
  [
    "npcEntities",
    "npcModules",
    "npcRuntimeState",
    "npcRuntimeControllers",
    "npcCargo",
    "npcWrecks",
    "npcWreckItems",
    "npcSpawnSites",
  ],
  {
    tier: TIERS.RUNTIME,
    domain: "in-space",
    confidence: CONFIDENCE.INFERRED,
    note: "NPC runtime, written via space/npc/nativeNpcStore.js param-helper.",
  },
);
define(["authoredSpaceProps"], {
  tier: TIERS.STATIC,
  domain: "sde",
  confidence: CONFIDENCE.INFERRED,
  note: "Static authored scenery — per-system JSON (Jita.json, Perimeter.json, …) under gameStore/data/authoredSpaceProps/, loaded directly via fs by space/authoredSpaceProps.js, NOT the gameStore API. Removed from SQLITE_TABLES 2026-06-25 (vestigial; no writer).",
});

// ── Runtime · single-service domains (scanner-attributed) ────────────
define(["accessGroups", "characterEnergyState", "characterNotes"], {
  tier: TIERS.RUNTIME, domain: "service:character", confidence: CONFIDENCE.SCANNER,
});
define(["characterExpertSystems", "corpSkillPlans", "skillPlans", "skillQueues", "skillTradingState"], {
  tier: TIERS.RUNTIME, domain: "service:skills", confidence: CONFIDENCE.SCANNER,
});
define(["calendarEvents", "calendarResponses"], {
  tier: TIERS.RUNTIME, domain: "service:calendar", confidence: CONFIDENCE.SCANNER,
});
define(["contractRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:contracts", confidence: CONFIDENCE.SCANNER,
});
define(["industrialHirelingContracts"], {
  tier: TIERS.RUNTIME,
  domain: "service:industrialHirelings",
  confidence: CONFIDENCE.SCANNER,
  note: "Persistent player-to-NPC industrial employment contracts, orders, and bounded history.",
});
define(["corporationBills"], {
  tier: TIERS.RUNTIME, domain: "service:account", confidence: CONFIDENCE.SCANNER,
});
define(["corporationGoals", "corporationVotes", "lpWallets"], {
  tier: TIERS.RUNTIME, domain: "service:corporation", confidence: CONFIDENCE.SCANNER,
});
define(["dailyGoals"], {
  tier: TIERS.RUNTIME, domain: "service:dailyGoals", confidence: CONFIDENCE.SCANNER,
});
define(["dungeonRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:dungeon", confidence: CONFIDENCE.SCANNER,
});
define(["evermarkEntitlements"], {
  tier: TIERS.RUNTIME, domain: "service:evermarks", confidence: CONFIDENCE.SCANNER,
});
define(["identityState"], {
  tier: TIERS.RUNTIME, domain: "service:_shared", confidence: CONFIDENCE.SCANNER,
  note: "Identity allocator (services/_shared/identityAllocator.js).",
});
define(["insuranceContracts"], {
  tier: TIERS.RUNTIME, domain: "service:insurance", confidence: CONFIDENCE.SCANNER,
});
define(["killmails"], {
  tier: TIERS.RUNTIME, domain: "service:killmail", confidence: CONFIDENCE.SCANNER,
});
define(["killRights", "pendingNpcBounties", "playerBounties"], {
  tier: TIERS.RUNTIME, domain: "service:bounty", confidence: CONFIDENCE.SCANNER,
});
define(["mail"], {
  tier: TIERS.RUNTIME, domain: "service:mail", confidence: CONFIDENCE.SCANNER,
});
define(["mapTelemetry", "solarSystemInterferenceState"], {
  tier: TIERS.RUNTIME, domain: "service:map", confidence: CONFIDENCE.SCANNER,
});
define(["marketEscrow", "marketRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:market", confidence: CONFIDENCE.SCANNER,
});
define(["miningLedger", "miningRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:mining", confidence: CONFIDENCE.SCANNER,
});
define(["missionRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:agent", confidence: CONFIDENCE.SCANNER,
});
define(["moduleGroupingState"], {
  tier: TIERS.RUNTIME, domain: "service:moduleGrouping", confidence: CONFIDENCE.SCANNER,
});
define(["moonExtractions", "structureAssetSafety", "structurePaintwork", "structureProfiles", "structureTetherRestrictions"], {
  tier: TIERS.RUNTIME, domain: "service:structure", confidence: CONFIDENCE.SCANNER,
});
define(["newEdenStoreRuntime", "newEdenStore"], {
  tier: TIERS.RUNTIME, domain: "service:newEdenStore", confidence: CONFIDENCE.SCANNER,
  note: "newEdenStore is runtime (written by storeState via AUTHORITY_TABLE), SQLite-backed as of the 2026-06-25 backfill.",
});
define(["notifications"], {
  tier: TIERS.RUNTIME, domain: "service:notifications", confidence: CONFIDENCE.SCANNER,
});
define(["chatState", "chatStaticContracts", "chatBacklog"], {
  tier: TIERS.RUNTIME, domain: "service:chat", confidence: CONFIDENCE.INFERRED,
  note: "Owned by _secondary/chat/chatStore.js; migrated from _secondary/data/chat JSON/JSONL sidecars.",
});
define(["overviewSharedPresets"], {
  tier: TIERS.RUNTIME, domain: "service:overview", confidence: CONFIDENCE.SCANNER,
});
define(["planetOrbitalState", "planetRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:planet", confidence: CONFIDENCE.SCANNER,
});
define(["probeRuntimeState", "wormholeRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:exploration", confidence: CONFIDENCE.SCANNER,
});
define(["raffles", "rafflesRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:raffles", confidence: CONFIDENCE.SCANNER,
});
define(["sharedSettings"], {
  tier: TIERS.RUNTIME, domain: "service:settings", confidence: CONFIDENCE.SCANNER,
});
define(["shipCosmetics", "shipDirt", "shipKillCounters", "shipLogoFittings"], {
  tier: TIERS.RUNTIME, domain: "service:ship", confidence: CONFIDENCE.SCANNER,
});

// ── Runtime · single-service domains (inferred via param-helper) ─────
define(["corporationRuntime", "corporations", "alliances"], {
  tier: TIERS.RUNTIME, domain: "service:corporation", confidence: CONFIDENCE.INFERRED,
  note: "Written via corporationState/corporationRuntimeState param-helpers; all SQLite-backed (corporations migrated 2026-06-25).",
});
define(["bookmarks", "bookmarkFolders", "bookmarkGroups", "bookmarkKnownFolders", "bookmarkSubfolders", "bookmarkRuntimeState", "sharedBookmarkFolders"], {
  tier: TIERS.RUNTIME, domain: "service:bookmark", confidence: CONFIDENCE.INFERRED,
  note: "Written via services/bookmark/bookmarkRuntimeStore.js (table constants forwarded through a wrapper).",
});
define(["industryJobs", "industryRuntime", "industryBlueprintState", "industryFacilityState"], {
  tier: TIERS.RUNTIME, domain: "service:industry", confidence: CONFIDENCE.INFERRED,
  note: "Written via industryRuntimeState/industryFacilityState param-helpers.",
});
define(["reprocessingFacilityState"], {
  tier: TIERS.RUNTIME, domain: "service:reprocessing", confidence: CONFIDENCE.INFERRED,
});
define(["sovereignty"], {
  tier: TIERS.RUNTIME, domain: "service:sovereignty", confidence: CONFIDENCE.INFERRED,
});
define(["structures"], {
  tier: TIERS.RUNTIME, domain: "service:structure", confidence: CONFIDENCE.INFERRED,
});

// ── Runtime · domain not yet attributed (needs review) ───────────────
define(["savedFittings"], {
  tier: TIERS.RUNTIME, domain: "secondary:fitting", confidence: CONFIDENCE.SCANNER,
  note: "Owned by _secondary/fitting/fittingStore.js (writes SAVED_FITTINGS_TABLE). Also touched cross-cuttingly by character deletion and player transfer.",
});

// ── Static · read-only SDE / reference data ──────────────────────────
define(
  [
    "agentAuthority", "asteroidBelts", "asteroidFieldStyles", "asteroidTypesBySolarSystemID",
    "capitalNpcAuthority", "celestials", "characterCreationBloodlines", "characterCreationRaces",
    "characterCreationSchools", "clientEntityStandings", "clientTypeLists", "dbuffCollections",
    "dungeonAuthority", "dynamicItemAttributes", "evermarksCatalog", "expertSystems",
    "explorationAuthority", "explorationWormholeStatic", "factions", "fighterAbilities",
    "industryBlueprints", "industryFacilities", "itemIcons", "itemTypes", "liveEventDefinitions", "mapTagsAuthority",
    "missionAuthority", "movementAttributes", "npcBehaviorProfiles",
    "npcHostileUtilities", "npcLoadouts", "npcLootTables", "npcProfiles", "npcSpawnGroups",
    "npcSpawnPools", "npcStandingsAuthority", "npcStartupRules", "planetSchematics",
    "reprocessingClientRandomizedMaterials", "reprocessingStatic", "shipCosmeticsCatalog",
    "shipDogmaAttributes", "shipInsurancePrices", "shipTypes", "skillTrainingAlphaCaps",
    "skillTypes", "solarSystems", "sovereigntyStatic", "stargateTypes", "stargateVisualOverrides",
    "stargates", "starterShipFittings", "stationGraphicLocators", "stationStandingsRestrictions",
    "stationTypes", "stations", "structureGraphicLocators", "structureTypes",
    "trigDrifterSpawnAuthority", "typeDogma",
  ],
  { tier: TIERS.STATIC, domain: "sde", confidence: CONFIDENCE.INFERRED,
    note: "Treated as read-only reference (not in any runtime-persisted set)." },
);

// ── Query API ────────────────────────────────────────────────────────
function getTableOwnership(table) {
  return Object.prototype.hasOwnProperty.call(TABLE_OWNERSHIP, table)
    ? TABLE_OWNERSHIP[table]
    : null;
}
function isClassified(table) {
  return getTableOwnership(table) !== null;
}
function isRuntimeTable(table) {
  const entry = getTableOwnership(table);
  return entry !== null && entry.tier === TIERS.RUNTIME;
}
function listTables() {
  return Object.keys(TABLE_OWNERSHIP).sort();
}
function listByDomain(domain) {
  return listTables().filter((t) => TABLE_OWNERSHIP[t].domain === domain);
}
function listInSpaceTables() {
  return listByDomain("in-space");
}
function listSharedSeams() {
  return listByDomain("shared");
}
function listForReview() {
  return listTables().filter((t) => TABLE_OWNERSHIP[t].confidence === CONFIDENCE.REVIEW);
}

module.exports = {
  TIERS,
  CONFIDENCE,
  TABLE_OWNERSHIP,
  getTableOwnership,
  isClassified,
  isRuntimeTable,
  listTables,
  listByDomain,
  listInSpaceTables,
  listSharedSeams,
  listForReview,
};
