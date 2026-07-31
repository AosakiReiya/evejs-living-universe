"use strict";

const assert = require("assert/strict");

const config = require("../src/config");
const conflict = require("../src/space/npc/ambientTraffic/livingConflictRuntime");
const economy = require("../src/space/npc/ambientTraffic/livingEconomyRuntime");
const universeStateStore = require("../src/space/npc/ambientTraffic/livingUniverseState");

function actor(actorID, flightID, overrides = {}) {
  return {
    actorID,
    flightID,
    profileID: "living_jita_jita_pirate_standard_cormorant_v1",
    shipTypeID: 16238,
    role: "highsec_pirate",
    equipmentBand: "standard",
    homeStationID: 60005203,
    homeSystemID: 30002813,
    corporationID: 1000127,
    ...overrides,
  };
}

function flight(flightID, family, actorIDs, systemID) {
  return {
    flightID,
    family,
    actorIDs,
    currentSystemID: systemID,
    currentNodeIndex: 0,
    direction: 1,
    phase: "docked",
    nextTransitionAtMs: 1_700_000_060_000,
    materialized: false,
    routeID: family === "pirate" ? "jita_tama" : "mining_tama",
    campaignID: "tama_border_pressure",
  };
}

function buildState(nowMs) {
  const state = universeStateStore.buildDefaultState();
  state.createdAtMs = nowMs;
  state.nextConflictAtMs = nowMs;
  state.actors.pirate = actor("pirate", "pirate_flight");
  state.actors.miner = actor("miner", "miner_flight", {
    profileID: "living_jita_jita_miner_standard_venture_v1",
    shipTypeID: 32880,
    role: "miner",
    homeStationID: 60000880,
    homeSystemID: 30002781,
  });
  state.flights.pirate_flight = flight("pirate_flight", "pirate", ["pirate"], 30002813);
  state.flights.miner_flight = flight("miner_flight", "miner", ["miner"], 30002781);
  return state;
}

function main() {
  // This verifier exercises pure helpers only. Prevent the standalone process
  // from ever dispatching the configured live universe/economy background loop.
  config.livingUniverseEnabled = false;
  config.livingEconomyEnabled = false;
  assert.equal(config.livingConflictEnabled, true);
  const nowMs = 1_700_000_000_000;
  const state = buildState(nowMs);
  const encounter = conflict._testing.scheduleEncounter(state, nowMs, {
    isFlightEligible: () => true,
    getSecurity: () => 0.3,
    estimateTravelMs: () => 180_000,
  });
  assert.ok(encounter);
  assert.equal(encounter.phase, conflict.PHASE.STAGING);
  assert.equal(encounter.kind, "regional_campaign_engagement");
  assert.equal(encounter.campaignID, "tama_border_pressure");
  assert.equal(encounter.startsAtMs, nowMs + 180_000);
  assert.equal(state.flights.pirate_flight.encounterID, encounter.encounterID);
  assert.equal(state.flights.miner_flight.encounterID, encounter.encounterID);

  let materialized = 0;
  let finalized = null;
  const result = conflict.tick(state, encounter.startsAtMs, {
    isFlightEligible: () => true,
    isLossEligibleActor: () => true,
    getSecurity: () => 0.3,
    estimateTravelMs: () => 180_000,
    moveFlightToSystem(selectedFlight, systemID) {
      selectedFlight.currentSystemID = systemID;
    },
    isSystemObserved: () => true,
    materializeEncounter() {
      materialized += 1;
      return { success: true };
    },
    collectLiveLosses() {
      return ["miner"];
    },
    applyPhysicalOutcome(_encounter, actorIDs) {
      return { destroyedActorIDs: actorIDs };
    },
    finalizeEncounter(resolvedEncounter, victimActorIDs) {
      finalized = { resolvedEncounter, victimActorIDs };
      return { evidence: [{ actorID: "miner" }] };
    },
  });
  assert.equal(result.changed, true);
  assert.equal(materialized, 1);
  assert.ok(finalized);
  assert.deepEqual(finalized.victimActorIDs, ["miner"]);
  assert.equal(encounter.phase, conflict.PHASE.RESOLVED);
  assert.equal(encounter.observed, true);
  assert.equal(state.metrics.encountersObserved, 1);
  assert.equal(state.metrics.encountersResolved, 1);
  assert.equal(state.metrics.campaigns.tama_border_pressure.encountersResolved, 1);
  assert.equal(state.metrics.campaigns.tama_border_pressure.shipLosses, 1);

  const campaignSupply = economy._testing.buildCampaignSupplyRequirements(0.85);
  const campaignQuantities = new Map(
    campaignSupply.map((entry) => [entry.typeID, entry.quantity]),
  );
  assert.equal(campaignQuantities.get(210), 408, "campaign missile consumption was not scaled");
  assert.equal(campaignQuantities.get(222), 408, "campaign hybrid-ammo consumption was not scaled");
  assert.equal(campaignQuantities.get(2464), 2, "campaign drone consumption was not scaled");
  assert.equal(campaignQuantities.get(28668), 34, "campaign repair consumption was not scaled");

  const cormorant = economy._testing.buildReplacementRequirements(state.actors.pirate);
  const quantities = new Map(cormorant.map((entry) => [entry.typeID, entry.quantity]));
  assert.equal(quantities.get(16238), 1, "Cormorant hull was not requested");
  assert.equal(quantities.get(10678), 4, "railguns were not requested from the governed fit");
  assert.equal(quantities.get(377), 1, "shield extender was not requested");
  assert.equal(quantities.get(439), 1, "afterburner was not requested");
  assert.equal(quantities.get(2046), 1, "damage control was not requested");
  assert.equal(quantities.get(222), 320, "replacement ammunition did not follow weapon count");

  const virtualLossSamples = [];
  for (let index = 1; index <= 50; index += 1) {
    virtualLossSamples.push(...conflict._testing.chooseVirtualVictims(state, {
      encounterID: `sample-${index}`,
      targetSystemID: 30002813,
      attackerActorIDs: ["pirate"],
      defenderActorIDs: ["miner"],
      defenderFlightID: "miner_flight",
      victimActorIDs: [],
    }, {
      getSecurity: () => 0.3,
      isLossEligibleActor: () => true,
    }));
  }
  assert.ok(virtualLossSamples.length > 0, "low-security off-grid combat never produced a loss");

  console.log(JSON.stringify({
    success: true,
    scheduledTravelSeconds: (encounter.startsAtMs - nowMs) / 1_000,
    campaignID: encounter.campaignID,
    campaignSupply,
    witnessedEncounterMaterializations: materialized,
    witnessedVictims: finalized.victimActorIDs,
    cormorantReplacementRequirements: cormorant,
    lowSecurityVirtualLossesAcross50Samples: virtualLossSamples.length,
  }, null, 2));
  process.exit(0);
}

main();
