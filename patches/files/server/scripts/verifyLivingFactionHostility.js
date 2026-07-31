"use strict";

// Resident track R1 verifier: per-player faction hostility, combat-target admission,
// player kill-credit ledger, and the kill standing-gain path.
//
// Pure/patched verification only: the store is isolated, standings and session lookups are
// monkeypatched module-object calls, and no live GameStore rows are read or written.

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-faction-hostility-"));
const dataDirectory = path.join(temporaryRoot, "data");
fs.mkdirSync(dataDirectory, { recursive: true });
process.env.EVEJS_GAMESTORE_DATA_DIR = dataDirectory;
process.env.EVEJS_PERSISTENCE_WORKER = "0";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_MINING_NPC_STARTUP_ENABLED = "false";

const config = require("../src/config");
const factionHostilityRuntime = require(
  "../src/services/character/factionHostilityRuntime",
);
const standingRuntime = require("../src/services/character/standingRuntime");
const sessionRegistry = require("../src/services/chat/sessionRegistry");
const factionKillStandingRuntime = require(
  "../src/services/character/factionKillStandingRuntime",
);
const npcStandingsAuthority = require(
  "../src/services/character/npcStandingsAuthority",
);
const factionState = require("../src/services/faction/factionState");
const livingKillCreditLedger = require(
  "../src/space/npc/ambientTraffic/livingKillCreditLedger",
);
const npcBehaviorLoop = require("../src/space/npc/npcBehaviorLoop");

const {
  isValidCombatTarget,
  isLivingPlayerTargetWithoutHostility,
} = npcBehaviorLoop.__testing;

const NOW_MS = 1_800_000_000_000;
const PLAYER_CHARACTER_ID = 91_000_001;
const OTHER_CHARACTER_ID = 91_000_002;
const GURISTAS = 500010;
const CALDARI = 500001;
const GALLENTE = 500004;

const summary = {};

function withPatched(object, key, replacement, run) {
  const original = object[key];
  object[key] = replacement;
  try {
    return run();
  } finally {
    object[key] = original;
  }
}

function buildLivingPirateEntity(overrides = {}) {
  return {
    itemID: 9_001,
    kind: "ship",
    npcEntityType: "npc",
    nativeNpc: true,
    livingUniverseActorID: "LUA-TEST-0001",
    livingUniverseFlightID: "LUF-TEST-0001",
    warFactionID: GURISTAS,
    position: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function buildPlayerShipEntity(overrides = {}) {
  return {
    itemID: 9_002,
    kind: "ship",
    session: { characterID: PLAYER_CHARACTER_ID },
    position: { x: 10, y: 0, z: 0 },
    ...overrides,
  };
}

// --- 1. Aggression timer: declare, refresh, expire -------------------------------------------

factionHostilityRuntime._reset();
assert.equal(config.livingHostilityEnabled, true, "livingHostilityEnabled must default true");
assert.equal(
  factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS),
  false,
  "no hostility before aggression",
);

const declared = factionHostilityRuntime.markHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS);
assert.ok(declared && declared.refreshed === false, "first aggression declares");
assert.equal(
  factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS + 1_000),
  true,
  "hostile immediately after aggression",
);
const windowMs = factionHostilityRuntime.getHostilityWindowMs();
assert.equal(windowMs, 15 * 60 * 1000, "default window is 15 minutes");
assert.equal(
  factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS + windowMs + 1_000),
  false,
  "hostility expires after the window",
);

const redeclared = factionHostilityRuntime.markHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS);
assert.ok(redeclared && redeclared.refreshed === false, "post-expiry aggression is a fresh declaration");
const refreshed = factionHostilityRuntime.markHostile(
  PLAYER_CHARACTER_ID,
  GURISTAS,
  NOW_MS + (10 * 60 * 1000),
);
assert.ok(refreshed && refreshed.refreshed === true, "repeat aggression refreshes");
assert.equal(
  factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS + (20 * 60 * 1000)),
  true,
  "refreshed window extends past the original expiry",
);
assert.equal(
  factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS + (26 * 60 * 1000)),
  false,
  "refreshed window still expires",
);
assert.equal(
  factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, CALDARI, NOW_MS + 1_000),
  false,
  "hostility is per-faction",
);
summary.aggressionTimer = "pass";

// --- 2. Standing floor: shoot-on-sight below the floor ----------------------------------------

factionHostilityRuntime._reset();
withPatched(
  standingRuntime,
  "getCharacterEffectiveStanding",
  (characterID) => ({
    standing: characterID === PLAYER_CHARACTER_ID ? -6 : -4,
  }),
  () => {
    assert.equal(
      factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS),
      true,
      "standing below the floor is shoot-on-sight without any aggression",
    );
    assert.equal(
      factionHostilityRuntime.isHostile(OTHER_CHARACTER_ID, GURISTAS, NOW_MS),
      false,
      "standing above the floor stays neutral",
    );
  },
);
// The 30s standing cache must not leak the patched value once invalidated.
factionHostilityRuntime._invalidateStandingCache();
summary.standingFloor = "pass";

// --- 3. Config gate: disabling restores legacy behavior ---------------------------------------

factionHostilityRuntime._reset();
const priorEnabled = config.livingHostilityEnabled;
config.livingHostilityEnabled = false;
try {
  assert.equal(
    factionHostilityRuntime.markHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS),
    null,
    "disabled: aggression does not declare",
  );
  assert.equal(
    factionHostilityRuntime.isHostile(PLAYER_CHARACTER_ID, GURISTAS, NOW_MS),
    false,
    "disabled: never hostile",
  );
  assert.equal(
    isLivingPlayerTargetWithoutHostility(buildLivingPirateEntity(), buildPlayerShipEntity()),
    false,
    "disabled: admission check stands aside (legacy posture)",
  );
} finally {
  config.livingHostilityEnabled = priorEnabled;
}
summary.configGate = "pass";

// --- 4. Combat-target admission ---------------------------------------------------------------

factionHostilityRuntime._reset();
const livingPirate = buildLivingPirateEntity();
const playerShip = buildPlayerShipEntity();

assert.equal(
  isValidCombatTarget(livingPirate, playerShip),
  false,
  "living pirate must NOT admit a neutral player",
);
factionHostilityRuntime.markHostile(PLAYER_CHARACTER_ID, GURISTAS, Date.now());
assert.equal(
  isValidCombatTarget(livingPirate, playerShip),
  true,
  "living pirate admits the aggressor",
);
const otherPlayer = buildPlayerShipEntity({
  itemID: 9_003,
  session: { characterID: OTHER_CHARACTER_ID },
});
assert.equal(
  isValidCombatTarget(livingPirate, otherPlayer),
  false,
  "admission is per-player: bystanders stay excluded",
);

const ambientRat = buildLivingPirateEntity({ itemID: 9_004 });
delete ambientRat.livingUniverseActorID;
delete ambientRat.livingUniverseFlightID;
assert.equal(
  isValidCombatTarget(ambientRat, otherPlayer),
  true,
  "non-living NPCs are unaffected by the admission check",
);

// Industrial/mining crew hulls reuse livingUniverseActorID but never carry a flight ID — they
// must stay on legacy targeting, not the living admission gate.
const crewHull = buildLivingPirateEntity({ itemID: 9_008 });
delete crewHull.livingUniverseFlightID;
assert.equal(
  isLivingPlayerTargetWithoutHostility(crewHull, otherPlayer),
  false,
  "crew hulls (actorID without flightID) are exempt from the admission gate",
);

const factionlessLiving = buildLivingPirateEntity({ itemID: 9_005, warFactionID: 0 });
assert.equal(
  isValidCombatTarget(factionlessLiving, playerShip),
  false,
  "living NPC without a faction never engages players",
);

const livingVsNpcTarget = buildLivingPirateEntity({ itemID: 9_006 });
const npcTarget = buildLivingPirateEntity({
  itemID: 9_007,
  livingUniverseActorID: "LUA-TEST-0002",
  warFactionID: CALDARI,
});
assert.equal(
  isLivingPlayerTargetWithoutHostility(livingVsNpcTarget, npcTarget),
  false,
  "NPC-vs-NPC targeting is untouched by the admission check",
);
factionHostilityRuntime._reset();
summary.combatAdmission = "pass";

// --- 5. Attacker player resolution ------------------------------------------------------------

assert.equal(
  factionHostilityRuntime.resolveAttackerPlayerCharacterID(buildPlayerShipEntity()),
  PLAYER_CHARACTER_ID,
  "session ship resolves to its character",
);
assert.equal(
  factionHostilityRuntime.resolveAttackerPlayerCharacterID(buildLivingPirateEntity()),
  0,
  "living NPC ship is not a player",
);
withPatched(
  sessionRegistry,
  "findSessionByCharacterID",
  (characterID) => (characterID === PLAYER_CHARACTER_ID ? { characterID } : null),
  () => {
    assert.equal(
      factionHostilityRuntime.resolveAttackerPlayerCharacterID({
        itemID: 9_010,
        kind: "drone",
        ownerID: PLAYER_CHARACTER_ID,
      }),
      PLAYER_CHARACTER_ID,
      "player drone resolves through its owner session",
    );
    assert.equal(
      factionHostilityRuntime.resolveAttackerPlayerCharacterID({
        itemID: 9_011,
        kind: "drone",
        ownerID: OTHER_CHARACTER_ID,
      }),
      0,
      "NPC drone owner without a session is not a player",
    );
    assert.equal(
      factionHostilityRuntime.resolveAttackerPlayerCharacterID({
        itemID: 9_012,
        kind: "fighter",
        controllerOwnerID: PLAYER_CHARACTER_ID,
      }),
      PLAYER_CHARACTER_ID,
      "player fighter resolves through its controller session",
    );
    assert.equal(
      factionHostilityRuntime.resolveAttackerPlayerCharacterID({
        itemID: 9_013,
        kind: "fighter",
        controllerOwnerID: OTHER_CHARACTER_ID,
      }),
      0,
      "NPC fighter owner without a session is not a player",
    );
  },
);
summary.attackerResolution = "pass";

// --- 6. Kill-credit ledger --------------------------------------------------------------------

livingKillCreditLedger._reset();
assert.equal(
  livingKillCreditLedger.recordPlayerKillCredit("LUA-A", PLAYER_CHARACTER_ID, NOW_MS),
  true,
  "credit records",
);
assert.equal(
  livingKillCreditLedger.peekKillCredit("LUA-A"),
  PLAYER_CHARACTER_ID,
  "peek sees the credit",
);
assert.equal(
  livingKillCreditLedger.consumeKillCredit("LUA-A", NOW_MS + 1_000),
  PLAYER_CHARACTER_ID,
  "consume returns the killer",
);
assert.equal(
  livingKillCreditLedger.consumeKillCredit("LUA-A", NOW_MS + 2_000),
  0,
  "consume is one-shot",
);
livingKillCreditLedger.recordPlayerKillCredit("LUA-B", PLAYER_CHARACTER_ID, NOW_MS);
assert.equal(
  livingKillCreditLedger.consumeKillCredit(
    "LUA-B",
    NOW_MS + livingKillCreditLedger.TTL_MS + 1_000,
  ),
  0,
  "expired credit does not attribute",
);
assert.equal(
  livingKillCreditLedger.recordPlayerKillCredit("", PLAYER_CHARACTER_ID, NOW_MS),
  false,
  "empty actorID rejected",
);
assert.equal(
  livingKillCreditLedger.recordPlayerKillCredit("LUA-C", 0, NOW_MS),
  false,
  "missing killer rejected",
);
livingKillCreditLedger._reset();
summary.killCreditLedger = "pass";

// --- 7. Standing gains on kill ----------------------------------------------------------------

factionKillStandingRuntime._resetDebounce();
assert.equal(config.factionStandingGainOnKillEnabled, true, "gain path defaults enabled");

const appliedCalls = [];
const relationsFixture = [
  { toID: CALDARI, standing: -9 },
  { toID: GALLENTE, standing: -5 },
  { toID: 500_002, standing: -2 },   // qualifies at the -1 threshold but loses the top-2 cut
  { toID: 1_000_127, standing: -9 }, // not a faction (corp-shaped)
];
const runGains = (nowMs) => factionKillStandingRuntime.recordNpcFactionStandingGains(
  { warFactionID: GURISTAS, systemID: 30_000_142, typeID: 17_715 },
  PLAYER_CHARACTER_ID,
  { nowMs },
);
const gainsResult = withPatched(
  npcStandingsAuthority,
  "getRelationsForOwner",
  () => relationsFixture,
  () => withPatched(
    factionState,
    "isFactionID",
    (ownerID) => ownerID < 1_000_000,
    () => withPatched(
      standingRuntime,
      "applyStandingChanges",
      (characterID, changes, options) => {
        appliedCalls.push({ characterID, changes, options });
        return { success: true, appliedChanges: changes };
      },
      () => {
        const first = runGains(NOW_MS);
        const debounced = runGains(NOW_MS + 60_000);
        const laterWindow = runGains(NOW_MS + (11 * 60 * 1000));
        return { first, debounced, laterWindow };
      },
    ),
  ),
);

assert.ok(gainsResult.first && gainsResult.first.applied === true, "gains applied");
assert.deepEqual(
  gainsResult.first.gains.map((gain) => gain.factionID),
  [CALDARI, GALLENTE],
  "top-2 designated enemies receive the gain, strongest enmity first",
);
assert.equal(gainsResult.debounced, null, "same-window kill is debounced");
assert.ok(
  gainsResult.laterWindow && gainsResult.laterWindow.applied === true,
  "gain window reopens after the debounce",
);
assert.ok(
  appliedCalls.every((call) => (
    call.options && call.options.disableDerived === true &&
    call.changes.length === 1 &&
    call.changes[0].rawChange === config.factionStandingGainPerKillRaw &&
    call.changes[0].rawChange > 0
  )),
  "each gain is a small positive non-derived single-faction change",
);

const priorGainEnabled = config.factionStandingGainOnKillEnabled;
config.factionStandingGainOnKillEnabled = false;
try {
  assert.equal(runGains(NOW_MS + (30 * 60 * 1000)), null, "disabled gain path applies nothing");
} finally {
  config.factionStandingGainOnKillEnabled = priorGainEnabled;
}
factionKillStandingRuntime._resetDebounce();

// Deterministic tie-break: at equal standing the executiveEnemyFaction (arch-enemy) row wins,
// then the lower toID — ties must never pick nondeterministically.
factionKillStandingRuntime._resetDebounce();
const tieResult = withPatched(
  npcStandingsAuthority,
  "getRelationsForOwner",
  () => [
    { toID: 500_003, standing: -1, source: "enemyID" },
    { toID: CALDARI, standing: -1, source: "executiveEnemyFaction" },
    { toID: 500_002, standing: -1, source: "enemyID" },
  ],
  () => withPatched(
    factionState,
    "isFactionID",
    () => true,
    () => withPatched(
      standingRuntime,
      "applyStandingChanges",
      () => ({ success: true, appliedChanges: [] }),
      () => runGains(NOW_MS),
    ),
  ),
);
assert.deepEqual(
  tieResult.gains.map((gain) => gain.factionID),
  [CALDARI, 500_002],
  "tie-break: executiveEnemyFaction first, then lowest toID",
);
factionKillStandingRuntime._resetDebounce();
summary.standingGains = "pass";

// --- 7b. Gains against the REAL shipped authority data ----------------------------------------
// The original implementation shipped with a -4 enmity threshold while the shipped payload's
// strongest authored enmity is -1 — the gain path was dead code and the monkeypatched fixture
// above could not see it. This section pins the threshold to the actual data: for every pirate
// faction with living flights, the real relations must yield at least one designated enemy, and
// running the gain path over the real Guristas rows must credit Caldari.
const authorityPayloadPath = [
  path.join(__dirname, "../../_local/gameStore/data/npcStandingsAuthority/data.json"),
  path.join(__dirname, "../../tools/DatabaseCreator/staticTables/npcStandingsAuthority/data.json"),
  path.join(__dirname, "../tools/DatabaseCreator/staticTables/npcStandingsAuthority/data.json"),
].find((candidate) => fs.existsSync(candidate));
assert.ok(
  authorityPayloadPath,
  "npcStandingsAuthority payload must be present for the real-data gain assertion",
);
const authorityPayload = JSON.parse(fs.readFileSync(authorityPayloadPath, "utf8"));
const relationsByOwnerID = authorityPayload.relationsByOwnerID || {};
const PIRATE_FACTIONS = [500010, 500011, 500012, 500019, 500020];
for (const pirateFactionID of PIRATE_FACTIONS) {
  const relations = relationsByOwnerID[String(pirateFactionID)] || [];
  const enemies = relations.filter((relation) => (
    Number.isFinite(relation && relation.standing) && relation.standing <= -1
  ));
  assert.ok(
    enemies.length > 0,
    `pirate faction ${pirateFactionID} must have at least one designated enemy in the shipped data`,
  );
}
factionKillStandingRuntime._resetDebounce();
const realDataCalls = [];
const realDataResult = withPatched(
  npcStandingsAuthority,
  "getRelationsForOwner",
  (ownerID) => relationsByOwnerID[String(ownerID)] || [],
  () => withPatched(
    factionState,
    "isFactionID",
    (ownerID) => ownerID >= 500_001 && ownerID <= 500_999,
    () => withPatched(
      standingRuntime,
      "applyStandingChanges",
      (characterID, changes) => {
        realDataCalls.push({ characterID, changes });
        return { success: true, appliedChanges: changes };
      },
      () => runGains(NOW_MS),
    ),
  ),
);
assert.ok(
  realDataResult && realDataResult.applied === true,
  "gain path fires against the real shipped authority data",
);
assert.ok(
  realDataResult.gains.some((gain) => gain.factionID === CALDARI),
  "killing Guristas credits Caldari standing with the real data",
);
factionKillStandingRuntime._resetDebounce();
summary.standingGainsRealData = "pass";

// --- 8. Gain/loss debounce isolation ----------------------------------------------------------

// The loss path key has no prefix and the gain path uses "gain:"; a loss must not consume the
// gain window or vice versa. Verified indirectly: a loss applied at NOW_MS must not block a gain
// at NOW_MS + 1s (both patched to succeed).
factionKillStandingRuntime._resetDebounce();
const isolation = withPatched(
  npcStandingsAuthority,
  "getRelationsForOwner",
  () => [{ toID: CALDARI, standing: -9 }],
  () => withPatched(
    factionState,
    "isFactionID",
    () => true,
    () => withPatched(
      standingRuntime,
      "applyStandingChanges",
      () => ({ success: true, appliedChanges: [] }),
      () => {
        const loss = factionKillStandingRuntime.recordNpcFactionStandingLoss(
          { warFactionID: GURISTAS, systemID: 30_000_142, typeID: 17_715 },
          PLAYER_CHARACTER_ID,
          { nowMs: NOW_MS },
        );
        const gain = runGains(NOW_MS + 1_000);
        return { loss, gain };
      },
    ),
  ),
);
assert.ok(isolation.loss && isolation.loss.applied === true, "loss applies");
assert.ok(isolation.gain && isolation.gain.applied === true, "gain applies in the same window");
factionKillStandingRuntime._resetDebounce();
summary.debounceIsolation = "pass";

console.log(JSON.stringify({
  verifier: "livingFactionHostility",
  config: {
    livingHostilityEnabled: config.livingHostilityEnabled,
    livingHostilityMinutes: config.livingHostilityMinutes,
    livingHostilityStandingFloor: config.livingHostilityStandingFloor,
    factionStandingGainOnKillEnabled: config.factionStandingGainOnKillEnabled,
    factionStandingGainPerKillRaw: config.factionStandingGainPerKillRaw,
  },
  results: summary,
}, null, 2));
