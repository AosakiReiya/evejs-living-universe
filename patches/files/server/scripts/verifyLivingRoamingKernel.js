"use strict";

const assert = require("assert");
const path = require("path");

const roamingKernel = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingRoamingKernel",
));

const nowMs = 1_800_000_000_000;

function buildSpec({
  groupID,
  factionKey,
  hostileFactionKeys,
  memberFlightIDs,
  systemIDs,
  initialDelayMs,
  campEdgeIndexes = [],
  campEnabled = false,
  engagementRole = "either",
}) {
  return {
    groupID,
    factionKey,
    hostileFactionKeys,
    memberFlightIDs,
    engagementRole,
    campaignID: "forge-border-skirmish",
    directionPolicy: "forward",
    route: {
      routeID: `route-${groupID}`,
      systemIDs,
      gateIDs: systemIDs.slice(0, -1).map((systemID, index) => (
        `gate-${Math.min(systemID, systemIDs[index + 1])}-${Math.max(
          systemID,
          systemIDs[index + 1],
        )}`
      )),
    },
    timing: {
      initialDelay: initialDelayMs,
      dwell: 10,
      transit: 20,
      camp: 30,
      cooldown: 50,
    },
    campPolicy: {
      enabled: campEnabled,
      probability: campEnabled ? 1 : 0,
      edgeIndexes: campEdgeIndexes,
    },
  };
}

function buildScenario() {
  const state = roamingKernel.createState({
    seed: "focused-roaming-kernel-verifier",
    createdAtMs: nowMs,
  });
  roamingKernel.upsertTaskGroup(state, buildSpec({
    groupID: "caldari-patrol",
    factionKey: "caldari",
    hostileFactionKeys: ["guristas"],
    memberFlightIDs: ["flight-caldari-1", "flight-caldari-2"],
    systemIDs: [100, 200, 300],
    initialDelayMs: 10,
    campEnabled: true,
    campEdgeIndexes: [1],
    engagementRole: "defender",
  }), nowMs);
  roamingKernel.upsertTaskGroup(state, buildSpec({
    groupID: "guristas-roam",
    factionKey: "guristas",
    hostileFactionKeys: ["caldari"],
    memberFlightIDs: ["flight-guristas-1"],
    systemIDs: [400, 200, 500],
    initialDelayMs: 15,
    engagementRole: "aggressor",
  }), nowMs);
  roamingKernel.upsertTaskGroup(state, buildSpec({
    groupID: "guristas-runner",
    factionKey: "guristas",
    hostileFactionKeys: ["caldari"],
    memberFlightIDs: ["flight-guristas-2"],
    systemIDs: [300, 200],
    initialDelayMs: 25,
    engagementRole: "aggressor",
  }), nowMs);
  return state;
}

const baselineState = buildScenario();
const serializedState = JSON.stringify(baselineState);
assert.deepEqual(
  buildScenario(),
  baselineState,
  "The same seed and definitions should reproduce the persisted schedule.",
);

const initialDeadlines = Object.values(baselineState.groups)
  .map((group) => group.nextActionAtMs - nowMs)
  .sort((left, right) => left - right);
assert.deepEqual(
  initialDeadlines,
  [10, 15, 25],
  "Task groups should retain independent launch deadlines.",
);

const queueProbeState = roamingKernel.createState({
  seed: "queue-probe",
  createdAtMs: nowMs,
});
roamingKernel.upsertTaskGroup(queueProbeState, buildSpec({
  groupID: "queue-probe",
  factionKey: "caldari",
  hostileFactionKeys: [],
  memberFlightIDs: ["flight-queue-probe"],
  systemIDs: [100, 200],
  initialDelayMs: 100,
}), nowMs);
let groupEnumerations = 0;
queueProbeState.groups = new Proxy(queueProbeState.groups, {
  ownKeys(target) {
    groupEnumerations += 1;
    return Reflect.ownKeys(target);
  },
});
roamingKernel.tick(queueProbeState, nowMs + 50);
roamingKernel.tick(queueProbeState, nowMs + 100);
assert.equal(
  groupEnumerations,
  0,
  "Deadline processing must not enumerate the complete task-group collection.",
);

let transitionHooks = 0;
let observationHooks = 0;
let observedIntersectionHooks = 0;
const adapters = {
  isSystemObserved(systemID) {
    return systemID === 200;
  },
  onTransition() {
    transitionHooks += 1;
  },
  onObservationCandidate(candidate) {
    observationHooks += 1;
    assert.equal(candidate.playerNeutral, true);
    assert.equal(candidate.targetPolicy.playersExcluded, true);
  },
  onObservedIntersection(candidate) {
    observedIntersectionHooks += 1;
    assert.equal(candidate.playerNeutral, true);
  },
};

const noWork = roamingKernel.tick(
  baselineState,
  nowMs + 9,
  adapters,
  { maxTransitions: 128 },
);
assert.equal(noWork.processed, 0);
assert.equal(transitionHooks, 0);
assert.equal(noWork.nextWakeAtMs || noWork.nextDeadlineAtMs, nowMs + 10);

const result = roamingKernel.tick(
  baselineState,
  nowMs + 52,
  adapters,
  {
    maxTransitions: 128,
    maxIntersectionCandidates: 16,
    maxIntersectionsPerPresence: 4,
  },
);
assert.equal(result.deferred, false);
assert.equal(result.intersectionBudgetExhausted, false);
assert.ok(result.processed > 0);
assert.equal(transitionHooks, result.processed);

const systemContact = result.intersections.find((entry) => (
  entry.kind === "system_contact" &&
  entry.groupIDs.includes("caldari-patrol") &&
  entry.groupIDs.includes("guristas-roam")
));
assert.ok(systemContact, "Hostile groups should produce a deterministic system contact.");
assert.equal(systemContact.location.systemID, 200);
assert.equal(systemContact.attackerGroupID, "guristas-roam");
assert.equal(systemContact.defenderGroupID, "caldari-patrol");
assert.deepEqual(systemContact.attackerFlightIDs, ["flight-guristas-1"]);
assert.deepEqual(
  systemContact.defenderFlightIDs,
  ["flight-caldari-1", "flight-caldari-2"],
);
assert.equal(systemContact.campaignID, "forge-border-skirmish");
assert.equal(systemContact.playerNeutral, true);

const gateCampContact = result.intersections.find((entry) => (
  entry.kind === "gate_camp_interception" &&
  entry.groupIDs.includes("caldari-patrol") &&
  entry.groupIDs.includes("guristas-runner")
));
assert.ok(gateCampContact, "A temporary gate camp should intercept an overlapping roam.");
assert.equal(gateCampContact.attackerGroupID, "caldari-patrol");
assert.equal(gateCampContact.location.systemID, 200);
assert.ok(gateCampContact.location.anchorID);

const patrol = baselineState.groups["caldari-patrol"];
assert.equal(patrol.phase, roamingKernel.PHASE.CAMPING);
assert.equal(patrol.routeCursor, 1);
assert.equal(patrol.currentSystemID, 200);
assert.equal(patrol.nextActionAtMs, nowMs + 80);

const camps = roamingKernel.listActiveCamps(baselineState, {
  nowMs: nowMs + 52,
  systemID: 200,
});
assert.equal(camps.length, 1);
assert.equal(camps[0].groupID, "caldari-patrol");
assert.deepEqual(camps[0].assignedFlightIDs, [
  "flight-caldari-1",
  "flight-caldari-2",
]);
assert.equal(camps[0].activeFromMs, nowMs + 50);
assert.equal(camps[0].activeUntilMs, nowMs + 80);
assert.equal(camps[0].playerNeutral, true);

const observed = roamingKernel.listObservationCandidates(
  baselineState,
  200,
  nowMs + 52,
);
assert.ok(observed.some((entry) => entry.group.groupID === "caldari-patrol"));
assert.ok(observed.every((entry) => entry.playerNeutral === true));
assert.ok(observationHooks > 0);
assert.ok(observedIntersectionHooks > 0);

assert.equal(
  roamingKernel.isTargetEligible(systemContact, {
    kind: "player",
    isPlayer: true,
  }),
  false,
  "Players must remain excluded from autonomous target selection.",
);
assert.equal(
  roamingKernel.isTargetEligible(systemContact, {
    kind: "npc_task_group",
  }),
  true,
);

const resumedState = JSON.parse(JSON.stringify(baselineState));
const uninterruptedState = JSON.parse(JSON.stringify(baselineState));
const resumedResult = roamingKernel.tick(
  resumedState,
  nowMs + 200,
  {},
  { maxTransitions: 128 },
);
const uninterruptedResult = roamingKernel.tick(
  uninterruptedState,
  nowMs + 200,
  {},
  { maxTransitions: 128 },
);
assert.deepEqual(
  resumedState,
  uninterruptedState,
  "A serialized schedule should resume deterministically.",
);
assert.deepEqual(resumedResult, uninterruptedResult);

const budgetState = JSON.parse(serializedState);
const budgeted = roamingKernel.tick(
  budgetState,
  nowMs + 200,
  {},
  { maxTransitions: 2 },
);
assert.equal(budgeted.processed, 2);
assert.equal(budgeted.deferred, true);
assert.ok(
  budgeted.nextDeadlineAtMs <= nowMs + 200,
  "Due work should remain queued instead of forcing an unbounded catch-up.",
);

const staleDeadlineState = roamingKernel.createState({
  seed: "stale-deadline-budget",
  createdAtMs: nowMs,
});
for (let revision = 0; revision < 6; revision += 1) {
  roamingKernel.upsertTaskGroup(staleDeadlineState, {
    ...buildSpec({
      groupID: "reconfigured-roam",
      factionKey: "caldari",
      hostileFactionKeys: [],
      memberFlightIDs: ["flight-reconfigured"],
      systemIDs: [100, 200],
      initialDelayMs: 10,
    }),
    metadata: { revision },
  }, nowMs);
}
const staleBudget = roamingKernel.tick(
  staleDeadlineState,
  nowMs + 10,
  {},
  { maxTransitions: 1, maxDeadlinePops: 2 },
);
assert.equal(staleBudget.processed, 0);
assert.equal(staleBudget.deadlinesExamined, 2);
assert.equal(staleBudget.deferred, true);
assert.equal(staleBudget.deadlineBudgetExhausted, true);
assert.equal(staleBudget.changed, true);

const crowdedState = roamingKernel.createState({
  seed: "crowded-choke-budget",
  createdAtMs: nowMs,
});
const crowdedFactions = ["faction-a", "faction-b", "faction-c", "faction-d", "faction-e"];
for (const [index, factionKey] of crowdedFactions.entries()) {
  roamingKernel.upsertTaskGroup(crowdedState, buildSpec({
    groupID: `crowded-${index}`,
    factionKey,
    hostileFactionKeys: crowdedFactions.filter((entry) => entry !== factionKey),
    memberFlightIDs: [`flight-crowded-${index}`],
    systemIDs: [100, 200],
    initialDelayMs: 10,
  }), nowMs);
}
const crowded = roamingKernel.tick(
  crowdedState,
  nowMs + 10,
  {},
  {
    maxTransitions: 16,
    maxIntersectionCandidates: 2,
    maxIntersectionsPerPresence: 2,
    maxPresenceChecks: 4,
  },
);
assert.equal(crowded.intersections.length, 2);
assert.equal(crowded.intersectionBudgetExhausted, true);
assert.ok(
  crowdedState.metrics.intersectionCandidatesSuppressed > 0,
  "Crowded systems should honor a hard encounter-candidate budget.",
);

const oppositeDirectionState = roamingKernel.createState({
  seed: "opposite-direction-transit",
  createdAtMs: nowMs,
});
const directionalRoute = {
  routeID: "directional-route",
  systemIDs: [100, 200],
  gateIDs: ["gate-100-to-200"],
  reverseGateIDs: ["gate-200-to-100"],
};
roamingKernel.upsertTaskGroup(oppositeDirectionState, {
  ...buildSpec({
    groupID: "directional-forward",
    factionKey: "caldari",
    hostileFactionKeys: ["guristas"],
    memberFlightIDs: ["flight-directional-forward"],
    systemIDs: directionalRoute.systemIDs,
    initialDelayMs: 10,
  }),
  directionPolicy: "forward",
  route: directionalRoute,
}, nowMs);
roamingKernel.upsertTaskGroup(oppositeDirectionState, {
  ...buildSpec({
    groupID: "directional-reverse",
    factionKey: "guristas",
    hostileFactionKeys: ["caldari"],
    memberFlightIDs: ["flight-directional-reverse"],
    systemIDs: directionalRoute.systemIDs,
    initialDelayMs: 10,
  }),
  directionPolicy: "reverse",
  route: directionalRoute,
}, nowMs);
const oppositeDirectionTransit = roamingKernel.tick(
  oppositeDirectionState,
  nowMs + 20,
  {},
  { maxTransitions: 8 },
);
assert.equal(
  oppositeDirectionState.groups["directional-forward"].phase,
  roamingKernel.PHASE.TRANSIT,
);
assert.equal(
  oppositeDirectionState.groups["directional-reverse"].phase,
  roamingKernel.PHASE.TRANSIT,
);
assert.deepEqual(
  oppositeDirectionTransit.intersections,
  [],
  "Opposite-direction transit windows must not intersect before either group arrives.",
);
assert.equal(
  oppositeDirectionState.intersectionHistory.length,
  0,
  "Opposite-direction transit created a retained historical contact.",
);

const status = roamingKernel.getStatus(baselineState, nowMs + 52);
assert.equal(status.groups, 3);
assert.equal(status.activeCamps, 1);
assert.equal(status.phaseCounts.camping, 1);
assert.ok(status.queuedDeadlines >= 3);

console.log(JSON.stringify({
  success: true,
  independentInitialDeadlinesMs: initialDeadlines,
  transitionsProcessed: result.processed,
  intersections: result.intersections.map((candidate) => ({
    candidateID: candidate.candidateID,
    kind: candidate.kind,
    groups: candidate.groupIDs,
    systemID: candidate.location.systemID,
    anchorID: candidate.location.anchorID,
    activeWindowMs: [
      candidate.overlapStartsAtMs - nowMs,
      candidate.overlapEndsAtMs - nowMs,
    ],
    playerNeutral: candidate.playerNeutral,
  })),
  activeCamp: camps[0],
  observationHooks,
  observedIntersectionHooks,
  nextWakeAtMs: result.nextWakeAtMs || result.nextDeadlineAtMs,
  budgetedCatchUp: budgeted,
  noFullGroupEnumeration: groupEnumerations === 0,
  staleDeadlineBudget: staleBudget,
  crowdedCandidateBudget: {
    produced: crowded.intersections.length,
    intersectionBudgetExhausted: crowded.intersectionBudgetExhausted,
    presenceCheckBudgetExhausted: crowded.presenceCheckBudgetExhausted,
  },
  oppositeDirectionTransit: {
    forwardPresence: oppositeDirectionState.groups["directional-forward"].presence,
    reversePresence: oppositeDirectionState.groups["directional-reverse"].presence,
    contacts: oppositeDirectionTransit.intersections.length,
  },
  status,
}, null, 2));
