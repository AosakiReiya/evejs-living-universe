"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const campaignCatalog = require(path.join(__dirname, "./livingConflictCampaignCatalog"));

const PHASE = Object.freeze({
  STAGING: "staging",
  ACTIVE: "active",
  RESOLVED: "resolved",
});

const ACTIVE_PHASES = new Set([PHASE.STAGING, PHASE.ACTIVE]);
const MAX_RETAINED_ENCOUNTERS = 250;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function deterministicUnit(...parts) {
  const text = parts.map((part) => String(part)).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function getOffGridActivityTimeMultiplier() {
  return Math.max(
    1,
    Math.min(
      100,
      toFiniteNumber(config.livingUniverseOffGridActivityTimeMultiplier, 1),
    ),
  );
}

function scaleOffGridDurationMs(durationMs, minimumMs) {
  return Math.max(
    minimumMs,
    Math.round(Math.max(minimumMs, toFiniteNumber(durationMs, minimumMs)) /
      getOffGridActivityTimeMultiplier()),
  );
}

function getActorSurvivability(actor) {
  const profile = actor && actor.survivabilityProfile &&
    typeof actor.survivabilityProfile === "object"
    ? actor.survivabilityProfile
    : {};
  return {
    virtualLossWeight: Math.max(0.05, toFiniteNumber(profile.virtualLossWeight, 1)),
    casualtyChanceMultiplier: Math.max(
      0.1,
      Math.min(2, toFiniteNumber(profile.casualtyChanceMultiplier, 1)),
    ),
    combatPower: Math.max(0, toFiniteNumber(profile.combatPower, 0)),
  };
}

function chooseWeightedVictim(state, actorIDs, seedParts) {
  const weighted = (Array.isArray(actorIDs) ? actorIDs : [])
    .map((actorID) => ({
      actorID,
      weight: getActorSurvivability(state.actors && state.actors[actorID]).virtualLossWeight,
    }))
    .filter((entry) => entry.actorID && entry.weight > 0)
    .sort((left, right) => String(left.actorID).localeCompare(String(right.actorID)));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let cursor = deterministicUnit(...seedParts) * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.actorID;
  }
  return weighted[weighted.length - 1].actorID;
}

function getInitialDelayMs() {
  return scaleOffGridDurationMs(
    Math.max(10_000, toFiniteNumber(config.livingConflictInitialDelaySeconds, 90) * 1_000),
    1_000,
  );
}

function getIntervalMs() {
  return scaleOffGridDurationMs(
    Math.max(
      60_000,
      toFiniteNumber(config.livingConflictEncounterIntervalSeconds, 2_700) * 1_000,
    ),
    5_000,
  );
}

function getDurationMs() {
  return scaleOffGridDurationMs(
    Math.max(
      60_000,
      toFiniteNumber(config.livingConflictEncounterDurationSeconds, 600) * 1_000,
    ),
    5_000,
  );
}

function getMaxActive() {
  return Math.max(
    1,
    Math.min(10, toPositiveInt(config.livingConflictMaxActiveEncounters, 2)),
  );
}

function ensureState(state, nowMs = Date.now()) {
  if (!state || typeof state !== "object") return null;
  if (!state.encounters || typeof state.encounters !== "object") state.encounters = {};
  state.nextEncounterNumber = Math.max(1, toPositiveInt(state.nextEncounterNumber, 1));
  state.nextConflictAtMs = Math.max(0, toFiniteNumber(state.nextConflictAtMs, 0));
  state.metrics = state.metrics && typeof state.metrics === "object" ? state.metrics : {};
  for (const key of [
    "encountersScheduled",
    "encountersObserved",
    "encountersResolved",
    "encountersResolvedOffGrid",
    "wreckEvidenceMaterialized",
    "distressSignalsActivated",
    "responsesDispatched",
    "responsesArrived",
    "responsesUnavailable",
  ]) {
    state.metrics[key] = Math.max(0, toFiniteNumber(state.metrics[key], 0));
  }
  state.metrics.campaigns = state.metrics.campaigns && typeof state.metrics.campaigns === "object"
    ? state.metrics.campaigns
    : {};
  if (state.nextConflictAtMs <= 0) {
    state.nextConflictAtMs = nowMs + getInitialDelayMs();
  }
  return state;
}

function ensureCampaignMetrics(state, campaignID) {
  const id = String(campaignID || "");
  if (!id) return null;
  state.metrics.campaigns = state.metrics.campaigns && typeof state.metrics.campaigns === "object"
    ? state.metrics.campaigns
    : {};
  const current = state.metrics.campaigns[id] && typeof state.metrics.campaigns[id] === "object"
    ? state.metrics.campaigns[id]
    : {};
  for (const key of ["encountersScheduled", "encountersResolved", "shipLosses"]) {
    current[key] = Math.max(0, toFiniteNumber(current[key], 0));
  }
  state.metrics.campaigns[id] = current;
  return current;
}

function listActive(state) {
  return Object.values(state && state.encounters || {})
    .filter((encounter) => ACTIVE_PHASES.has(String(encounter && encounter.phase || "")));
}

function snapshotFlight(flight, nowMs) {
  return {
    routeID: String(flight.routeID || ""),
    dynamicRouteSpec: flight.dynamicRouteSpec || null,
    routeClass: String(flight.routeClass || ""),
    riskBand: String(flight.riskBand || ""),
    currentNodeIndex: Number(flight.currentNodeIndex) || 0,
    currentSystemID: toPositiveInt(flight.currentSystemID, 0),
    direction: Number(flight.direction) < 0 ? -1 : 1,
    phase: String(flight.phase || "docked"),
    remainingTransitionMs: Math.max(
      1_000,
      toFiniteNumber(flight.nextTransitionAtMs, nowMs) - nowMs,
    ),
    virtualTravel: flight.virtualTravel || null,
  };
}

function chooseRow(rows, seedParts, getWeight = () => 1) {
  const weighted = rows
    .map((row) => ({ row, weight: Math.max(0, toFiniteNumber(getWeight(row), 0)) }))
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => String(left.row.flightID).localeCompare(String(right.row.flightID)));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  let cursor = deterministicUnit(...seedParts) * total;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) return entry.row;
  }
  return weighted[weighted.length - 1].row;
}

function getEncounterSideFlightIDs(encounter, side) {
  const pluralKey = side === "attacker" ? "attackerFlightIDs" : "defenderFlightIDs";
  const singularKey = side === "attacker" ? "attackerFlightID" : "defenderFlightID";
  return [...new Set([
    ...(Array.isArray(encounter && encounter[pluralKey]) ? encounter[pluralKey] : []),
    encounter && encounter[singularKey],
  ].map(String).filter(Boolean))];
}

function chooseWingFlights(rows, primary, desiredCount, seedParts) {
  const selected = primary ? [primary] : [];
  let remaining = rows.filter((row) => row && (!primary || row.flightID !== primary.flightID));
  while (selected.length < desiredCount && remaining.length > 0) {
    const usedGroups = new Set(selected.map((row) => String(row.spawnGroupID || "")));
    const diverse = remaining.filter((row) => !usedGroups.has(String(row.spawnGroupID || "")));
    const candidates = diverse.length > 0 ? diverse : remaining;
    const tier = (row) => {
      const id = String(row && row.spawnGroupID || "").toLowerCase();
      if (id.includes("command")) return 4;
      if (id.includes("elite")) return 3;
      if (id.includes("veteran")) return 2;
      return 1;
    };
    const highestTier = Math.max(...candidates.map(tier));
    const preferred = candidates.filter((row) => tier(row) === highestTier);
    const next = chooseRow(preferred, [...seedParts, selected.length]);
    if (!next) break;
    selected.push(next);
    remaining = remaining.filter((row) => row.flightID !== next.flightID);
  }
  return selected;
}

function scheduleEncounter(state, nowMs, adapters = {}, options = {}) {
  const requestedAttackerFlightIDs = [...new Set(
    (Array.isArray(options.attackerFlightIDs) ? options.attackerFlightIDs : [])
      .map(String)
      .filter(Boolean),
  )].slice(0, 4);
  const requestedDefenderFlightIDs = [...new Set(
    (Array.isArray(options.defenderFlightIDs) ? options.defenderFlightIDs : [])
      .map(String)
      .filter(Boolean),
  )].slice(0, 4);
  const explicitFlightIDs = [...new Set([
    ...requestedAttackerFlightIDs,
    ...requestedDefenderFlightIDs,
  ])];
  // Operation-driven contacts already know the exact participants. Resolve
  // those IDs directly so a route overlap does not scan every persistent
  // flight in the universe.
  const sourceFlights = explicitFlightIDs.length > 0
    ? explicitFlightIDs.map((flightID) => state.flights && state.flights[flightID])
    : Object.values(state.flights || {});
  const flights = sourceFlights.filter((flight) => (
    flight &&
    !flight.encounterID &&
    (options.allowMaterializedFlights === true || flight.materialized !== true)
  ));
  const eligible = typeof adapters.isFlightEligible === "function"
    ? flights.filter((flight) => adapters.isFlightEligible(flight, state))
    : flights;
  let pirates = eligible.filter((flight) => String(flight.family || "") === "pirate");
  let defenders = eligible.filter((flight) => (
    ["hauler", "convoy", "miner", "police"].includes(String(flight.family || ""))
  ));
  if (requestedAttackerFlightIDs.length > 0) {
    const requested = new Set(requestedAttackerFlightIDs);
    pirates = pirates.filter((flight) => requested.has(String(flight.flightID)));
  }
  if (requestedDefenderFlightIDs.length > 0) {
    const requested = new Set(requestedDefenderFlightIDs);
    defenders = defenders.filter((flight) => requested.has(String(flight.flightID)));
  }
  if (options.preferCivilianDefender === true) {
    const civilianDefenders = defenders.filter((flight) => (
      ["hauler", "convoy", "miner"].includes(String(flight.family || ""))
    ));
    if (civilianDefenders.length > 0) defenders = civilianDefenders;
  }
  if (pirates.length <= 0 || defenders.length <= 0) return null;

  const encounterNumber = state.nextEncounterNumber;
  const requestedSystemID = toPositiveInt(options.targetSystemID, 0);
  let campaign = null;
  if (
    config.livingConflictCampaignsEnabled === true &&
    options.preferCivilianDefender !== true
  ) {
    const candidates = campaignCatalog.CAMPAIGNS.filter((entry) => (
      pirates.some((flight) => flight.campaignID === entry.campaignID) &&
      defenders.some((flight) => flight.campaignID === entry.campaignID)
    ));
    const requestedCampaignID = String(options.campaignID || "");
    campaign = requestedCampaignID
      ? candidates.find((entry) => entry.campaignID === requestedCampaignID) || null
      : requestedSystemID
        ? candidates.find((entry) => entry.systemIDs.includes(requestedSystemID)) || null
        : null;
    if (!campaign && candidates.length > 0 && !requestedSystemID) {
      const totalIntensity = candidates.reduce(
        (sum, entry) => sum + Math.max(0.1, toFiniteNumber(entry.intensity, 1)),
        0,
      );
      let cursor = deterministicUnit(state.createdAtMs, encounterNumber, "campaign") * totalIntensity;
      campaign = candidates[candidates.length - 1];
      for (const entry of candidates) {
        cursor -= Math.max(0.1, toFiniteNumber(entry.intensity, 1));
        if (cursor <= 0) {
          campaign = entry;
          break;
        }
      }
    }
    if (campaign) {
      pirates = pirates.filter((flight) => flight.campaignID === campaign.campaignID);
      defenders = defenders.filter((flight) => flight.campaignID === campaign.campaignID);
    }
  }
  if (options.combatDefendersOnly === true) {
    const combatDefenders = defenders.filter((flight) => String(flight.family || "") === "police");
    if (combatDefenders.length > 0) defenders = combatDefenders;
  }
  const defender = requestedDefenderFlightIDs.length > 0
    ? defenders.find(
        (flight) => String(flight.flightID) === requestedDefenderFlightIDs[0],
      ) || null
    : chooseRow(
        defenders,
        [state.createdAtMs, encounterNumber, "defender"],
        (flight) => {
          const familyWeight = {
            hauler: campaign ? 2 : 3,
            convoy: campaign ? 3 : 3.5,
            miner: campaign ? 1.5 : 2.5,
            police: campaign ? 5 : 1.5,
          }[String(flight.family || "")] || 1;
          const security = typeof adapters.getSecurity === "function"
            ? toFiniteNumber(adapters.getSecurity(flight.currentSystemID), 1)
            : 1;
          return familyWeight * (security < 0.5 ? 3 : security < 0.8 ? 1.5 : 1);
        },
      );
  if (!defender) return null;
  const attacker = requestedAttackerFlightIDs.length > 0
    ? pirates.find(
        (flight) => String(flight.flightID) === requestedAttackerFlightIDs[0],
      ) || null
    : chooseRow(
        pirates,
        [state.createdAtMs, encounterNumber, defender.flightID, "attacker"],
      );
  if (!attacker || attacker.flightID === defender.flightID) return null;

  const requestedBattleClass = String(options.battleClass || "");
  const major = options.forceMajor === true || requestedBattleClass === "major" || Boolean(
    campaign && deterministicUnit(state.createdAtMs, encounterNumber, "battle-class") < 0.25,
  );
  const requestedWingCount = toPositiveInt(options.wingFlightCount, 0);
  const attackerWingCount = Math.max(1, Math.min(4,
    requestedWingCount || (major ? 3 : campaign ? 2 : 1),
  ));
  const defenderWingCount = Math.max(1, Math.min(4,
    requestedWingCount || (major ? 3 : campaign ? 2 : 1),
  ));
  const attackerFlights = requestedAttackerFlightIDs.length > 0
    ? requestedAttackerFlightIDs
        .map((flightID) => pirates.find(
          (flight) => String(flight.flightID) === flightID,
        ))
        .filter(Boolean)
    : chooseWingFlights(
        pirates,
        attacker,
        attackerWingCount,
        [state.createdAtMs, encounterNumber, "attacker-wing"],
      );
  const policeReinforcements = defenders.filter((flight) => (
    flight.flightID !== defender.flightID && String(flight.family || "") === "police"
  ));
  const defenderReinforcementPool = [
    ...policeReinforcements,
    ...defenders.filter((flight) => (
      flight.flightID !== defender.flightID &&
      !policeReinforcements.some((candidate) => candidate.flightID === flight.flightID)
    )),
  ];
  const defenderFlights = requestedDefenderFlightIDs.length > 0
    ? requestedDefenderFlightIDs
        .map((flightID) => defenders.find(
          (flight) => String(flight.flightID) === flightID,
        ))
        .filter(Boolean)
    : chooseWingFlights(
        defenderReinforcementPool,
        defender,
        defenderWingCount,
        [state.createdAtMs, encounterNumber, "defender-wing"],
      );
  if (attackerFlights.length <= 0 || defenderFlights.length <= 0) return null;
  const attackerFlightIDs = attackerFlights.map((flight) => flight.flightID);
  const defenderFlightIDs = defenderFlights.map((flight) => flight.flightID);
  const attackerActorIDs = [...new Set(attackerFlights.flatMap((flight) => flight.actorIDs || []))];
  const defenderActorIDs = [...new Set(defenderFlights.flatMap((flight) => flight.actorIDs || []))];

  const encounterID = `LUC-${String(encounterNumber).padStart(8, "0")}`;
  state.nextEncounterNumber = encounterNumber + 1;
  const targetSystemID = requestedSystemID || toPositiveInt(defender.currentSystemID, 0);
  const estimatedStagingMs = typeof adapters.estimateTravelMs === "function"
    ? Math.max(...attackerFlights.map((flight) => (
        toFiniteNumber(adapters.estimateTravelMs(flight, targetSystemID), 30_000)
      )))
    : 30_000;
  const baseStagingMs = options.stagingDelayMs !== undefined
    ? Math.max(5_000, toFiniteNumber(options.stagingDelayMs, 15_000))
    : Math.max(30_000, estimatedStagingMs);
  const stagingMs = scaleOffGridDurationMs(baseStagingMs, 1_000);
  const startsAtMs = nowMs + stagingMs;
  const participantSnapshots = {};
  for (const flight of [...attackerFlights, ...defenderFlights]) {
    participantSnapshots[flight.flightID] = snapshotFlight(flight, nowMs);
  }
  const encounter = {
    encounterID,
    phase: PHASE.STAGING,
    kind: String(options.kind || "") || (
      campaign
        ? "regional_campaign_engagement"
        : String(defender.family || "civilian") === "police"
          ? "police_interception"
          : "pirate_interdiction"
    ),
    campaignID: campaign && campaign.campaignID || null,
    campaignName: campaign && campaign.name || null,
    campaignTheater: campaign && campaign.theater || null,
    campaignIntensity: campaign ? toFiniteNumber(campaign.intensity, 1) : 0,
    targetSystemID,
    attackerFlightID: attacker.flightID,
    defenderFlightID: defender.flightID,
    attackerFlightIDs,
    defenderFlightIDs,
    attackerActorIDs,
    defenderActorIDs,
    participantSnapshots,
    battleClass: ["major", "engagement", "skirmish"].includes(requestedBattleClass)
      ? requestedBattleClass
      : major
        ? "major"
        : campaign
          ? "engagement"
          : "skirmish",
    sourceOperationID: String(options.sourceOperationID || "") || null,
    contactKind: String(options.contactKind || "") || null,
    targetAnchorID: toPositiveInt(options.targetAnchorID, 0) || null,
    targetGateID: toPositiveInt(options.targetGateID, 0) || null,
    playerNeutral: options.playerNeutral !== false,
    plannedShipCount: attackerActorIDs.length + defenderActorIDs.length,
    forcedByOperator: options.forcedByOperator === true,
    scheduledAtMs: nowMs,
    startsAtMs,
    endsAtMs: startsAtMs + getDurationMs(),
    observed: false,
    materialized: false,
    victimActorIDs: [],
    evidence: [],
    evidencePending: false,
    lastError: null,
  };
  state.encounters[encounterID] = encounter;
  for (const flight of [...attackerFlights, ...defenderFlights]) {
    flight.encounterID = encounterID;
    flight.nextTransitionAtMs = startsAtMs;
    flight.lastTransitionReason = "living-conflict-staging";
  }
  state.metrics.encountersScheduled += 1;
  const campaignMetrics = ensureCampaignMetrics(state, encounter.campaignID);
  if (campaignMetrics) campaignMetrics.encountersScheduled += 1;
  return encounter;
}

function forceEncounter(state, nowMs, targetSystemID, adapters = {}, options = {}) {
  const current = ensureState(state, nowMs);
  if (!current || config.livingConflictEnabled !== true) return null;
  return scheduleEncounter(current, nowMs, adapters, {
    ...options,
    targetSystemID,
    forceMajor: options.forceMajor !== false,
    combatDefendersOnly: options.combatDefendersOnly !== false,
    stagingDelayMs: options.stagingDelayMs === undefined ? 15_000 : options.stagingDelayMs,
    forcedByOperator: true,
  });
}

function beginEncounter(state, encounter, nowMs, adapters) {
  encounter.phase = PHASE.ACTIVE;
  encounter.startedAtMs = nowMs;
  encounter.endsAtMs = Math.max(
    encounter.endsAtMs,
    nowMs + scaleOffGridDurationMs(60_000, 5_000),
  );
  for (const flightID of [
    ...getEncounterSideFlightIDs(encounter, "attacker"),
    ...getEncounterSideFlightIDs(encounter, "defender"),
  ]) {
    const flight = state.flights[flightID];
    if (!flight) continue;
    flight.currentSystemID = encounter.targetSystemID;
    flight.nextTransitionAtMs = encounter.endsAtMs;
    flight.lastTransitionReason = "living-conflict-active";
    if (typeof adapters.moveFlightToSystem === "function") {
      adapters.moveFlightToSystem(flight, encounter.targetSystemID);
    }
  }
}

function addVictims(encounter, actorIDs) {
  const victims = new Set(encounter.victimActorIDs || []);
  for (const actorID of Array.isArray(actorIDs) ? actorIDs : []) {
    if (actorID) victims.add(String(actorID));
  }
  encounter.victimActorIDs = [...victims].sort();
}

function sideDestroyed(encounter, actorIDs) {
  const victims = new Set(encounter.victimActorIDs || []);
  return actorIDs.length > 0 && actorIDs.every((actorID) => victims.has(actorID));
}

function chooseVirtualVictims(state, encounter, adapters = {}) {
  if ((encounter.victimActorIDs || []).length > 0) return [];
  const security = typeof adapters.getSecurity === "function"
    ? toFiniteNumber(adapters.getSecurity(encounter.targetSystemID), 1)
    : 1;
  const baseCasualtyChance = security < 0.5 ? 0.62 : security < 0.8 ? 0.35 : 0.18;
  const campaignBonus = encounter.campaignID
    ? 0.08 * Math.max(0.5, toFiniteNumber(encounter.campaignIntensity, 1))
    : 0;
  const defender = state.flights[encounter.defenderFlightID];
  const defenderFamily = String(defender && defender.family || "");
  const attackerCandidates = (encounter.attackerActorIDs || []).filter((actorID) => (
    !adapters.isLossEligibleActor || adapters.isLossEligibleActor(state.actors[actorID])
  ));
  const defenderCandidates = (encounter.defenderActorIDs || []).filter((actorID) => (
    !adapters.isLossEligibleActor || adapters.isLossEligibleActor(state.actors[actorID])
  ));
  const defenderSurvivability = defenderCandidates.map(
    (actorID) => getActorSurvivability(state.actors && state.actors[actorID]),
  );
  const defenderCombatPower = defenderSurvivability.reduce(
    (sum, profile) => sum + profile.combatPower,
    0,
  );
  const defenderCasualtyMultiplier = defenderSurvivability.length > 0
    ? defenderSurvivability.reduce(
        (sum, profile) => sum + profile.casualtyChanceMultiplier,
        0,
      ) / defenderSurvivability.length
    : 1;
  const attackerLossChance = defenderFamily === "police"
    ? 1
    : Math.min(0.75, 0.22 + (defenderCombatPower * 0.06));
  const attackerLoses = deterministicUnit(encounter.encounterID, "side") < attackerLossChance;
  const casualtyChance = Math.min(
    0.85,
    (baseCasualtyChance + campaignBonus) * (attackerLoses ? 1 : defenderCasualtyMultiplier),
  );
  const casualtyRoll = deterministicUnit(encounter.encounterID, "casualty");
  if (casualtyRoll >= casualtyChance) return [];

  const candidates = attackerLoses ? attackerCandidates : defenderCandidates;
  if (candidates.length <= 0) return [];
  const firstVictim = chooseWeightedVictim(
    state,
    candidates,
    [encounter.encounterID, "victim"],
  );
  if (!firstVictim) return [];
  const victims = [firstVictim];
  const maximumLosses = encounter.battleClass === "major"
    ? Math.min(5, candidates.length)
    : encounter.battleClass === "engagement"
      ? Math.min(3, candidates.length)
      : Math.min(2, candidates.length);
  for (let lossIndex = 1; lossIndex < maximumLosses; lossIndex += 1) {
    const additionalLossChance = Math.max(
      0.05,
      (security < 0.5 ? 0.42 : security < 0.8 ? 0.26 : 0.14) - ((lossIndex - 1) * 0.08),
    );
    if (
      deterministicUnit(encounter.encounterID, "additional-victim", lossIndex) >=
      additionalLossChance
    ) {
      break;
    }
    const remaining = candidates.filter((actorID) => !victims.includes(actorID));
    if (remaining.length <= 0) break;
    const nextVictim = chooseWeightedVictim(
      state,
      remaining,
      [encounter.encounterID, "additional-victim-choice", lossIndex],
    );
    if (!nextVictim) break;
    victims.push(nextVictim);
  }
  const opposingCandidates = attackerLoses
    ? defenderCandidates
    : attackerCandidates;
  const reciprocalBaseChance = encounter.battleClass === "major"
    ? (security < 0.5 ? 0.58 : security < 0.8 ? 0.42 : 0.24)
    : encounter.battleClass === "engagement"
      ? (security < 0.5 ? 0.34 : security < 0.8 ? 0.22 : 0.12)
      : (security < 0.5 ? 0.12 : 0.06);
  if (
    opposingCandidates.length > 0 &&
    deterministicUnit(encounter.encounterID, "reciprocal-casualty") <
      reciprocalBaseChance
  ) {
    const reciprocalVictim = chooseWeightedVictim(
      state,
      opposingCandidates,
      [encounter.encounterID, "reciprocal-victim"],
    );
    if (reciprocalVictim && !victims.includes(reciprocalVictim)) {
      victims.push(reciprocalVictim);
    }
    const maximumReciprocalLosses = encounter.battleClass === "major"
      ? Math.min(3, opposingCandidates.length)
      : encounter.battleClass === "engagement"
        ? Math.min(2, opposingCandidates.length)
        : 1;
    for (
      let reciprocalIndex = 1;
      reciprocalIndex < maximumReciprocalLosses;
      reciprocalIndex += 1
    ) {
      const reciprocalChance = Math.max(
        0.08,
        reciprocalBaseChance - (reciprocalIndex * 0.16),
      );
      if (
        deterministicUnit(
          encounter.encounterID,
          "additional-reciprocal-casualty",
          reciprocalIndex,
        ) >= reciprocalChance
      ) {
        break;
      }
      const remaining = opposingCandidates.filter(
        (actorID) => !victims.includes(actorID),
      );
      if (remaining.length <= 0) break;
      const nextVictim = chooseWeightedVictim(
        state,
        remaining,
        [
          encounter.encounterID,
          "additional-reciprocal-victim",
          reciprocalIndex,
        ],
      );
      if (!nextVictim) break;
      victims.push(nextVictim);
    }
  }
  return victims;
}

function resolveEncounter(state, encounter, nowMs, adapters, reason) {
  const selected = chooseVirtualVictims(state, encounter, adapters);
  if (selected.length > 0 && encounter.materialized && typeof adapters.applyPhysicalOutcome === "function") {
    const result = adapters.applyPhysicalOutcome(encounter, selected, nowMs) || {};
    addVictims(encounter, result.destroyedActorIDs || selected);
  } else {
    addVictims(encounter, selected);
  }
  const result = typeof adapters.finalizeEncounter === "function"
    ? adapters.finalizeEncounter(encounter, encounter.victimActorIDs, nowMs) || {}
    : {};
  encounter.phase = PHASE.RESOLVED;
  encounter.resolvedAtMs = nowMs;
  encounter.resolutionReason = String(reason || "combat-window-ended");
  encounter.materialized = false;
  encounter.evidence = Array.isArray(result.evidence) ? result.evidence : [];
  encounter.evidencePending = encounter.evidence.length > 0 && (
    encounter.observed !== true || result.evidenceNeedsMaterialization === true
  );
  state.metrics.encountersResolved += 1;
  if (encounter.observed !== true) state.metrics.encountersResolvedOffGrid += 1;
  const campaignMetrics = ensureCampaignMetrics(state, encounter.campaignID);
  if (campaignMetrics) {
    campaignMetrics.encountersResolved += 1;
    campaignMetrics.shipLosses += (encounter.victimActorIDs || []).length;
  }
}

function processResolvedEvidence(state, encounter, nowMs, adapters) {
  if (!encounter.evidencePending || typeof adapters.isSystemObserved !== "function") return;
  if (!adapters.isSystemObserved(encounter.targetSystemID)) return;
  const result = typeof adapters.materializeEvidence === "function"
    ? adapters.materializeEvidence(encounter, nowMs) || {}
    : {};
  if (result.success === true) {
    encounter.evidencePending = false;
    encounter.evidenceMaterializedAtMs = nowMs;
    encounter.wreckIDs = Array.isArray(result.wreckIDs) ? result.wreckIDs : [];
    state.metrics.wreckEvidenceMaterialized += encounter.wreckIDs.length;
  } else if (result.errorMsg) {
    encounter.lastError = result.errorMsg;
  }
}

function pruneEncounters(state, nowMs) {
  const records = Object.values(state.encounters || {}).sort(
    (left, right) => toFiniteNumber(right.scheduledAtMs, 0) - toFiniteNumber(left.scheduledAtMs, 0),
  );
  const keep = new Set(records
    .filter((encounter, index) => (
      ACTIVE_PHASES.has(String(encounter.phase || "")) ||
      encounter.evidencePending === true ||
      (index < MAX_RETAINED_ENCOUNTERS && toFiniteNumber(encounter.resolvedAtMs, nowMs) >= nowMs - RETENTION_MS)
    ))
    .map((encounter) => encounter.encounterID));
  for (const encounterID of Object.keys(state.encounters || {})) {
    if (!keep.has(encounterID)) delete state.encounters[encounterID];
  }
}

function tick(state, nowMs = Date.now(), adapters = {}) {
  const current = ensureState(state, nowMs);
  if (!current || config.livingConflictEnabled !== true) return { changed: false };
  let changed = false;

  for (const flight of Object.values(current.flights || {})) {
    const encounterID = String(flight && flight.encounterID || "");
    if (!encounterID) continue;
    const encounter = current.encounters[encounterID];
    if (!encounter || encounter.phase === PHASE.RESOLVED) {
      flight.encounterID = null;
      changed = true;
    }
  }

  for (const encounter of Object.values(current.encounters)) {
    if (encounter.phase === PHASE.RESOLVED) {
      const wasPending = encounter.evidencePending;
      processResolvedEvidence(current, encounter, nowMs, adapters);
      changed = changed || wasPending !== encounter.evidencePending;
      continue;
    }
    if (encounter.phase === PHASE.STAGING && nowMs >= encounter.startsAtMs) {
      beginEncounter(current, encounter, nowMs, adapters);
      changed = true;
    }
    if (encounter.phase !== PHASE.ACTIVE) continue;

    const observed = typeof adapters.isSystemObserved === "function" &&
      adapters.isSystemObserved(encounter.targetSystemID);
    if (observed && encounter.observed !== true) {
      encounter.observed = true;
      encounter.firstObservedAtMs = nowMs;
      current.metrics.encountersObserved += 1;
      changed = true;
    }
    if (observed && !encounter.materialized && typeof adapters.materializeEncounter === "function") {
      const result = adapters.materializeEncounter(encounter, nowMs) || {};
      encounter.materialized = result.success === true;
      encounter.lastError = result.success === true ? null : result.errorMsg || encounter.lastError;
      changed = changed || result.success === true;
    }
    if (
      encounter.materialized &&
      encounter.distressBeaconActive !== true &&
      typeof adapters.activateDistress === "function"
    ) {
      const firstActivation = !encounter.distressActivatedAtMs;
      const result = adapters.activateDistress(encounter, nowMs) || {};
      if (result.success === true) {
        encounter.distressActivatedAtMs = encounter.distressActivatedAtMs || nowMs;
        encounter.distressBeaconActive = true;
        encounter.distressBeaconID = toPositiveInt(result.beaconID, 0) || null;
        encounter.distressPosition = result.position || encounter.distressPosition || null;
        if (firstActivation) current.metrics.distressSignalsActivated += 1;
        changed = true;
      } else if (result.errorMsg) {
        encounter.lastError = result.errorMsg;
      }
    }
    if (
      encounter.materialized &&
      !encounter.response &&
      typeof adapters.dispatchResponse === "function"
    ) {
      const result = adapters.dispatchResponse(encounter, nowMs) || {};
      encounter.response = result.success === true
        ? {
            status: "enroute",
            kind: String(result.kind || "security"),
            flightID: String(result.flightID || ""),
            actorIDs: Array.isArray(result.actorIDs) ? [...result.actorIDs] : [],
            sourceSystemID: toPositiveInt(result.sourceSystemID, 0),
            dispatchedAtMs: nowMs,
            arrivesAtMs: Math.max(nowMs, toFiniteNumber(result.arrivesAtMs, nowMs)),
            providerName: String(result.providerName || "Regional Security"),
          }
        : {
            status: String(result.status || "unavailable"),
            kind: String(result.kind || "security"),
            dispatchedAtMs: nowMs,
            providerName: String(result.providerName || "Regional Security"),
            reason: String(result.reason || result.errorMsg || "NO_RESPONSE_AVAILABLE"),
          };
      if (result.success === true) {
        current.metrics.responsesDispatched += 1;
        encounter.endsAtMs = Math.max(
          encounter.endsAtMs,
          encounter.response.arrivesAtMs + 120_000,
        );
      } else {
        current.metrics.responsesUnavailable += 1;
      }
      changed = true;
    }
    if (
      encounter.response &&
      encounter.response.status === "enroute" &&
      nowMs >= toFiniteNumber(encounter.response.arrivesAtMs, nowMs) &&
      typeof adapters.arriveResponse === "function"
    ) {
      const result = adapters.arriveResponse(encounter, nowMs) || {};
      if (result.success === true) {
        encounter.response.status = "arrived";
        encounter.response.arrivedAtMs = nowMs;
        current.metrics.responsesArrived += 1;
        changed = true;
      } else if (result.errorMsg) {
        encounter.lastError = result.errorMsg;
      }
    }
    if (encounter.materialized && typeof adapters.collectLiveLosses === "function") {
      addVictims(encounter, adapters.collectLiveLosses(encounter, nowMs));
    }
    if (!observed && encounter.materialized && typeof adapters.dematerializeEncounter === "function") {
      const result = adapters.dematerializeEncounter(encounter, nowMs) || {};
      addVictims(encounter, result.victimActorIDs || []);
      encounter.materialized = false;
      encounter.distressBeaconActive = false;
      encounter.distressBeaconID = null;
      changed = true;
    }
    if (
      sideDestroyed(encounter, encounter.attackerActorIDs || []) ||
      sideDestroyed(encounter, encounter.defenderActorIDs || [])
    ) {
      resolveEncounter(current, encounter, nowMs, adapters, "one-side-destroyed");
      changed = true;
      continue;
    }
    if (nowMs >= encounter.endsAtMs) {
      resolveEncounter(current, encounter, nowMs, adapters, "combat-window-ended");
      changed = true;
    }
  }

  if (
    adapters.allowLegacyScheduling !== false &&
    listActive(current).length < getMaxActive() &&
    nowMs >= current.nextConflictAtMs
  ) {
    const encounter = scheduleEncounter(current, nowMs, adapters, {
      // Preserve a bounded stream of cargo/mining loss pressure alongside the
      // denser operation-driven pirate-versus-patrol contacts.
      preferCivilianDefender: deterministicUnit(
        current.createdAtMs,
        current.nextEncounterNumber,
        "legacy-civilian-pressure",
      ) < 0.35,
    });
    const cadenceJitter = 0.75 + deterministicUnit(
      current.createdAtMs,
      current.nextEncounterNumber,
      "cadence",
    ) * 0.5;
    current.nextConflictAtMs = nowMs + Math.round(getIntervalMs() * cadenceJitter);
    changed = changed || Boolean(encounter);
  }
  pruneEncounters(current, nowMs);
  return { changed, active: listActive(current).length };
}

function getStatus(state, nowMs = Date.now()) {
  const current = ensureState(state, nowMs) || { encounters: {}, metrics: {} };
  const records = Object.values(current.encounters || {});
  const active = records.filter((encounter) => ACTIVE_PHASES.has(String(encounter.phase || "")));
  const pendingEvidence = records.filter((encounter) => encounter.evidencePending === true);
  return {
    enabled: config.livingConflictEnabled === true,
    active: active.length,
    activeEncounters: active.map((encounter) => ({ ...encounter })),
    pendingEvidence: pendingEvidence.length,
    nextEncounterInSeconds: Math.max(
      0,
      Math.ceil((toFiniteNumber(current.nextConflictAtMs, nowMs) - nowMs) / 1_000),
    ),
    metrics: { ...(current.metrics || {}) },
    campaigns: campaignCatalog.CAMPAIGNS.map((campaign) => {
      const campaignActive = active.filter(
        (encounter) => encounter.campaignID === campaign.campaignID,
      );
      return {
        campaignID: campaign.campaignID,
        name: campaign.name,
        theater: campaign.theater,
        intensity: campaign.intensity,
        active: campaignActive.length,
        metrics: { ...(current.metrics.campaigns[campaign.campaignID] || {}) },
      };
    }),
  };
}

module.exports = {
  PHASE,
  tick,
  getStatus,
  forceEncounter,
  scheduleEncounter,
  _testing: {
    deterministicUnit,
    getOffGridActivityTimeMultiplier,
    getInitialDelayMs,
    getIntervalMs,
    getDurationMs,
    ensureState,
    scheduleEncounter,
    getEncounterSideFlightIDs,
    chooseVirtualVictims,
    resolveEncounter,
    ensureCampaignMetrics,
  },
};
