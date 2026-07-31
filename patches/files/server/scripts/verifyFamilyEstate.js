"use strict";

process.env.EVEJS_FAMILY_ESTATE_ENABLED = "true";

const assert = require("assert/strict");

const {
  getFamilyEstateProfile,
  validateFamilyEstateProfile,
} = require("../src/services/estate/familyEstateProfile");
const familyEstateRuntime = require("../src/services/estate/familyEstateRuntime");
const wormholeRuntime = require("../src/services/exploration/wormholes/wormholeRuntime");

const nowMs = 1_800_000_000_000;
const profile = getFamilyEstateProfile();
const validation = validateFamilyEstateProfile(profile);
assert.equal(validation.success, true, validation.errorMsg || "estate profile must validate");
assert.equal(validation.data.homeAuthority.wormholeClassID, 2);
assert.equal(validation.data.homeAuthority.environmentFamily, null);
assert.equal(validation.data.highSecSystem.solarSystemName, "Uitra");
assert.equal(validation.data.lowSecSystem.solarSystemName, "Oinasiken");
assert.equal(validation.data.moon.solarSystemID, profile.homeSystemID);

const table = {
  version: 5,
  nextPairSequence: 1,
  nextEndpointSequence: 1,
  universeSeededAtMs: nowMs,
  pairsByID: {},
  staticSlotsByKey: {},
  polarizationByCharacter: {},
};

const firstEnsure = wormholeRuntime._testing.ensureFamilyEstateConnectionsInTable(
  table,
  nowMs,
  { profile },
);
assert.equal(firstEnsure.success, true, firstEnsure.errorMsg);
assert.equal(firstEnsure.createdPairs.length, 4);
const activePairs = Object.values(table.pairsByID).filter((pair) => pair.state === "active");
assert.equal(activePairs.length, 4);
assert.equal(activePairs.filter((pair) => pair.persistent).length, 2);
assert.equal(activePairs.filter((pair) => pair.estateConnectionRole === "random").length, 2);
assert.ok(activePairs.every((pair) => pair.source.systemID === profile.homeSystemID));
assert.ok(activePairs.filter((pair) => pair.persistent).every((pair) => (
  pair.expiresAtMs === 0 &&
  pair.unlimitedMass === true &&
  pair.unrestrictedShipMass === true &&
  pair.maxJumpMass === 0 &&
  pair.source.visibilityState === "visible" &&
  pair.destination.visibilityState === "visible" &&
  wormholeRuntime._testing.projectRemainingMass(pair, nowMs + 10_000_000) === pair.totalMass
)));
const highSecPair = activePairs.find((pair) => pair.estateConnectionRole === "highsec");
const lowSecPair = activePairs.find((pair) => pair.estateConnectionRole === "lowsec");
const persistentMassBefore = highSecPair && highSecPair.remainingMass;
assert.equal(
  wormholeRuntime._testing.exceedsShipMassLimit(highSecPair, Number.MAX_SAFE_INTEGER),
  false,
  "permanent estate conduits must accept ships of any mass",
);
wormholeRuntime._testing.applyJumpMassConsumption(highSecPair, 250_000_000, nowMs + 5_000);
assert.equal(
  highSecPair.remainingMass,
  persistentMassBefore,
  "a permitted ship jump must not consume permanent-conduit cumulative mass",
);
const randomMassPair = activePairs.find((pair) => pair.estateConnectionRole === "random");
assert.equal(randomMassPair.unrestrictedShipMass, undefined);
assert.equal(
  wormholeRuntime._testing.exceedsShipMassLimit(
    randomMassPair,
    randomMassPair.maxJumpMass + 1,
  ),
  true,
  "ordinary estate apertures must retain their individual ship-mass limit",
);
const randomMassBefore = randomMassPair.remainingMass;
wormholeRuntime._testing.applyJumpMassConsumption(randomMassPair, 10_000_000, nowMs + 5_000);
assert.equal(
  randomMassPair.remainingMass,
  randomMassBefore - 10_000_000,
  "ordinary estate apertures must retain normal cumulative-mass consumption",
);

assert.equal(highSecPair.destination.systemID, profile.highSecSystemID);
assert.equal(highSecPair.destination.wormholeClassID, 7);
assert.equal(lowSecPair.destination.systemID, profile.lowSecSystemID);
assert.equal(lowSecPair.destination.wormholeClassID, 8);

const secondEnsure = wormholeRuntime._testing.ensureFamilyEstateConnectionsInTable(
  table,
  nowMs + 1,
  { profile },
);
assert.equal(secondEnsure.success, true);
assert.equal(secondEnsure.createdPairs.length, 0, "estate ensure must be idempotent");
assert.equal(Object.values(table.pairsByID).filter((pair) => pair.state === "active").length, 4);

const moon = validation.data.moon;
const structurePosition = familyEstateRuntime.buildFamilyEstateStructurePosition(moon);
const moonDistance = Math.hypot(
  structurePosition.x - moon.position.x,
  structurePosition.y - moon.position.y,
  structurePosition.z - moon.position.z,
);
assert.ok(moonDistance >= familyEstateRuntime.ESTATE_STRUCTURE_OFFSET_METERS);

console.table(activePairs.map((pair) => ({
  role: pair.estateConnectionRole,
  sourceCode: pair.source.code,
  destinationSystemID: pair.destination.systemID,
  destinationClassID: pair.destination.wormholeClassID,
  permanent: pair.persistent,
  unlimitedMass: pair.unlimitedMass,
  unrestrictedShipMass: pair.unrestrictedShipMass === true,
  lifetimeMinutes: pair.lifetimeMinutes,
})));
console.log(
  `Family estate verification passed: ${validation.data.homeSystem.solarSystemName}, ` +
  `${activePairs.length} connections, moon ${validation.data.moon.itemName}.`,
);
