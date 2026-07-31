"use strict";

const { performance } = require("perf_hooks");

const SCHEMA_VERSION = 1;
const MAX_RETAINED_INTERSECTIONS = 512;
const DEFAULT_MAX_TRANSITIONS = 64;

const PHASE = Object.freeze({
  STAGING: "staging",
  DWELLING: "dwelling",
  TRANSIT: "transit",
  CAMPING: "camping",
});

const DEFAULT_TIMING = Object.freeze({
  initialDelay: Object.freeze({ minMs: 5 * 60_000, maxMs: 90 * 60_000 }),
  dwell: Object.freeze({ minMs: 60_000, maxMs: 5 * 60_000 }),
  transit: Object.freeze({ minMs: 45_000, maxMs: 4 * 60_000 }),
  camp: Object.freeze({ minMs: 15 * 60_000, maxMs: 90 * 60_000 }),
  cooldown: Object.freeze({ minMs: 15 * 60_000, maxMs: 60 * 60_000 }),
});

const METRIC_KEYS = Object.freeze([
  "groupsRegistered",
  "groupsRemoved",
  "transitionsProcessed",
  "staleDeadlinesDiscarded",
  "operationsStarted",
  "operationsCompleted",
  "campsStarted",
  "campsCompleted",
  "intersectionCandidates",
  "intersectionCandidatesSuppressed",
  "presenceChecksSuppressed",
  "observedWindows",
  "observedIntersections",
  "adapterErrors",
  "budgetDeferrals",
]);

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function stableHash32(...parts) {
  const text = parts.map((part) => String(part)).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicUnit(...parts) {
  return stableHash32(...parts) / 0x100000000;
}

function normalizeRange(value, fallback, minimumMs = 1) {
  const source = value && typeof value === "object"
    ? value
    : Number.isFinite(Number(value))
      ? { minMs: Number(value), maxMs: Number(value) }
      : {};
  const minMs = Math.max(
    minimumMs,
    Math.round(toFiniteNumber(source.minMs, fallback.minMs)),
  );
  const maxMs = Math.max(
    minMs,
    Math.round(toFiniteNumber(source.maxMs, fallback.maxMs)),
  );
  return { minMs, maxMs };
}

function chooseDurationMs(state, group, range, label, discriminator = "") {
  if (range.maxMs <= range.minMs) return range.minMs;
  const unit = deterministicUnit(
    state.seed,
    group.groupID,
    group.definitionRevision,
    group.operationNumber,
    group.transitionNumber,
    label,
    discriminator,
  );
  return Math.round(range.minMs + ((range.maxMs - range.minMs) * unit));
}

function normalizeStringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim())
    .filter(Boolean))]
    .sort();
}

function normalizeSystemIDs(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => toPositiveInt(entry, 0))
    .filter(Boolean);
}

function normalizeGateIDs(value, edgeCount) {
  const input = Array.isArray(value) ? value : [];
  return Array.from({ length: edgeCount }, (_, index) => {
    const gateID = input[index];
    if (gateID === null || gateID === undefined || gateID === "") return "";
    return String(gateID);
  });
}

function normalizeCampWeights(value, edgeCount) {
  const input = Array.isArray(value) ? value : [];
  return Array.from({ length: edgeCount }, (_, index) => (
    clamp(toFiniteNumber(input[index], 1), 0, 4)
  ));
}

function normalizeEdgeIndexes(value, edgeCount) {
  const normalized = [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => Math.trunc(Number(entry)))
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry < edgeCount))]
    .sort((left, right) => left - right);
  return normalized.length > 0
    ? normalized
    : Array.from({ length: edgeCount }, (_, index) => index);
}

function normalizeTaskGroupSpec(spec = {}) {
  const groupID = String(spec.groupID || "").trim();
  if (!groupID) throw new Error("Roaming task groups require a groupID.");

  const routeInput = spec.route && typeof spec.route === "object" ? spec.route : {};
  const systemIDs = normalizeSystemIDs(routeInput.systemIDs || spec.systemIDs);
  if (systemIDs.length < 2) {
    throw new Error(`Roaming task group ${groupID} requires at least two route systems.`);
  }
  const edgeCount = systemIDs.length - 1;
  const timingInput = spec.timing && typeof spec.timing === "object" ? spec.timing : {};
  const campInput = spec.campPolicy && typeof spec.campPolicy === "object"
    ? spec.campPolicy
    : {};
  const directionPolicy = ["forward", "reverse", "deterministic"].includes(
    String(spec.directionPolicy || ""),
  )
    ? String(spec.directionPolicy)
    : "deterministic";

  const normalized = {
    groupID,
    factionKey: String(spec.factionKey || "independent"),
    coalitionKey: String(spec.coalitionKey || ""),
    campaignID: String(spec.campaignID || ""),
    doctrineKey: String(spec.doctrineKey || ""),
    engagementRole: ["aggressor", "defender", "either"].includes(
      String(spec.engagementRole || ""),
    )
      ? String(spec.engagementRole)
      : "either",
    memberFlightIDs: normalizeStringList(spec.memberFlightIDs),
    hostileFactionKeys: normalizeStringList(spec.hostileFactionKeys),
    hostileGroupIDs: normalizeStringList(spec.hostileGroupIDs),
    directionPolicy,
    combatCapable: spec.combatCapable !== false,
    route: {
      routeID: String(routeInput.routeID || spec.routeID || `roam_${groupID}`),
      systemIDs,
      gateIDs: normalizeGateIDs(routeInput.gateIDs, edgeCount),
      reverseGateIDs: normalizeGateIDs(routeInput.reverseGateIDs, edgeCount),
      transitMsByEdge: Array.isArray(routeInput.transitMsByEdge)
        ? routeInput.transitMsByEdge.slice(0, edgeCount).map((entry) => (
          entry && typeof entry === "object"
            ? normalizeRange(entry, DEFAULT_TIMING.transit)
            : Number.isFinite(Number(entry))
              ? normalizeRange(Number(entry), DEFAULT_TIMING.transit)
              : null
        ))
        : [],
    },
    timing: {
      initialDelay: normalizeRange(timingInput.initialDelay, DEFAULT_TIMING.initialDelay),
      dwell: normalizeRange(timingInput.dwell, DEFAULT_TIMING.dwell),
      transit: normalizeRange(timingInput.transit, DEFAULT_TIMING.transit),
      camp: normalizeRange(timingInput.camp, DEFAULT_TIMING.camp),
      cooldown: normalizeRange(timingInput.cooldown, DEFAULT_TIMING.cooldown),
    },
    campPolicy: {
      enabled: campInput.enabled === true,
      probability: clamp(toFiniteNumber(campInput.probability, 0.2), 0, 1),
      edgeIndexes: normalizeEdgeIndexes(campInput.edgeIndexes, edgeCount),
      edgeWeights: normalizeCampWeights(campInput.edgeWeights, edgeCount),
    },
    targetPolicy: normalizeTargetPolicy(spec.targetPolicy),
    metadata: spec.metadata && typeof spec.metadata === "object"
      ? cloneValue(spec.metadata)
      : {},
  };
  normalized.definitionFingerprint = stableHash32(JSON.stringify(normalized));
  return normalized;
}

// Players are excluded from roaming target selection unless the spec explicitly opts in
// (Resident track: per-player hostility admission happens downstream in the combat engine;
// this policy only governs the kernel's own target eligibility). Key order is stable so
// default-policy groups keep their definition fingerprints.
function normalizeTargetPolicy(input) {
  const policy = input && typeof input === "object" ? input : {};
  const playersExcluded = policy.playersExcluded !== false;
  return {
    playersExcluded,
    playerEngagement: playersExcluded ? "excluded" : "hostiles_only",
    npcEngagement: "hostiles_only",
  };
}

function buildDefaultMetrics() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
}

function createState(options = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    seed: String(options.seed || "living-roaming-v1"),
    createdAtMs: Math.max(0, toFiniteNumber(options.createdAtMs, 0)),
    updatedAtMs: Math.max(0, toFiniteNumber(options.createdAtMs, 0)),
    groups: {},
    deadlineHeap: [],
    presenceIndex: {},
    intersectionHistory: [],
    intersectionIDIndex: {},
    activeCampCount: 0,
    metrics: buildDefaultMetrics(),
  };
}

function compareDeadlines(left, right) {
  const timeDelta = toFiniteNumber(left && left.atMs, 0) -
    toFiniteNumber(right && right.atMs, 0);
  if (timeDelta !== 0) return timeDelta;
  const groupDelta = String(left && left.groupID || "")
    .localeCompare(String(right && right.groupID || ""));
  if (groupDelta !== 0) return groupDelta;
  return toPositiveInt(left && left.token, 0) - toPositiveInt(right && right.token, 0);
}

function heapPush(heap, value) {
  heap.push(value);
  let cursor = heap.length - 1;
  while (cursor > 0) {
    const parent = Math.floor((cursor - 1) / 2);
    if (compareDeadlines(heap[parent], value) <= 0) break;
    heap[cursor] = heap[parent];
    cursor = parent;
  }
  heap[cursor] = value;
}

function heapPop(heap) {
  if (heap.length <= 0) return null;
  const root = heap[0];
  const tail = heap.pop();
  if (heap.length <= 0) return root;

  let cursor = 0;
  while (true) {
    const left = (cursor * 2) + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    if (right < heap.length && compareDeadlines(heap[right], heap[left]) < 0) {
      child = right;
    }
    if (compareDeadlines(tail, heap[child]) <= 0) break;
    heap[cursor] = heap[child];
    cursor = child;
  }
  heap[cursor] = tail;
  return root;
}

function removePresenceIndexEntry(state, key, groupID) {
  const current = Array.isArray(state.presenceIndex[key]) ? state.presenceIndex[key] : [];
  const next = current.filter((entry) => entry !== groupID);
  if (next.length > 0) state.presenceIndex[key] = next;
  else delete state.presenceIndex[key];
}

function removePresence(state, group) {
  if (!group || !group.presence) return;
  for (const key of group.presence.keys || []) {
    removePresenceIndexEntry(state, key, group.groupID);
  }
  group.presence = null;
}

function rebuildIndexes(state) {
  state.presenceIndex = {};
  state.intersectionIDIndex = {};
  let activeCampCount = 0;
  for (const group of Object.values(state.groups || {})) {
    if (group && group.phase === PHASE.CAMPING) activeCampCount += 1;
    if (!group || !group.presence) continue;
    for (const key of group.presence.keys || []) {
      const rows = Array.isArray(state.presenceIndex[key]) ? state.presenceIndex[key] : [];
      if (!rows.includes(group.groupID)) rows.push(group.groupID);
      rows.sort();
      state.presenceIndex[key] = rows;
    }
  }
  for (const candidate of state.intersectionHistory || []) {
    if (candidate && candidate.candidateID) {
      state.intersectionIDIndex[candidate.candidateID] = true;
    }
  }
  state.activeCampCount = activeCampCount;
  return state;
}

function rebuildDeadlineHeap(state) {
  state.deadlineHeap = [];
  for (const group of Object.values(state.groups || {})) {
    if (!group || !Number.isFinite(Number(group.nextActionAtMs))) continue;
    heapPush(state.deadlineHeap, {
      atMs: Number(group.nextActionAtMs),
      groupID: group.groupID,
      token: toPositiveInt(group.deadlineToken, 1),
    });
  }
  return state;
}

function ensureState(state, nowMs = Date.now()) {
  const current = state && typeof state === "object" ? state : createState();
  current.schemaVersion = SCHEMA_VERSION;
  current.seed = String(current.seed || "living-roaming-v1");
  current.createdAtMs = Math.max(0, toFiniteNumber(current.createdAtMs, nowMs));
  current.updatedAtMs = Math.max(0, toFiniteNumber(current.updatedAtMs, nowMs));
  current.groups = current.groups && typeof current.groups === "object" ? current.groups : {};
  current.activeCampCount = Number.isFinite(Number(current.activeCampCount))
    ? Math.max(0, Math.trunc(Number(current.activeCampCount)))
    : Object.values(current.groups).filter(
        (group) => group && group.phase === PHASE.CAMPING,
      ).length;
  current.intersectionHistory = Array.isArray(current.intersectionHistory)
    ? current.intersectionHistory
    : [];
  current.metrics = current.metrics && typeof current.metrics === "object"
    ? current.metrics
    : {};
  for (const key of METRIC_KEYS) {
    current.metrics[key] = Math.max(0, toFiniteNumber(current.metrics[key], 0));
  }
  if (!Array.isArray(current.deadlineHeap)) rebuildDeadlineHeap(current);
  if (!current.presenceIndex || typeof current.presenceIndex !== "object") {
    rebuildIndexes(current);
  }
  if (!current.intersectionIDIndex || typeof current.intersectionIDIndex !== "object") {
    rebuildIndexes(current);
  }
  return current;
}

function scheduleDeadline(state, group, atMs) {
  group.deadlineToken = toPositiveInt(group.deadlineToken, 0) + 1;
  group.nextActionAtMs = Math.max(0, Math.round(toFiniteNumber(atMs, 0)));
  heapPush(state.deadlineHeap, {
    atMs: group.nextActionAtMs,
    groupID: group.groupID,
    token: group.deadlineToken,
  });
}

function upsertTaskGroup(state, spec, nowMs = Date.now()) {
  const current = ensureState(state, nowMs);
  const definition = normalizeTaskGroupSpec(spec);
  const existing = current.groups[definition.groupID];
  if (
    existing &&
    Number(existing.definitionFingerprint) === Number(definition.definitionFingerprint)
  ) {
    return { changed: false, group: existing };
  }

  if (existing) {
    if (existing.phase === PHASE.CAMPING) {
      current.activeCampCount = Math.max(0, current.activeCampCount - 1);
    }
    removePresence(current, existing);
  }
  const definitionRevision = toPositiveInt(existing && existing.definitionRevision, 0) + 1;
  const group = {
    ...definition,
    definitionRevision,
    phase: PHASE.STAGING,
    operationNumber: 0,
    transitionNumber: 0,
    deadlineToken: toPositiveInt(existing && existing.deadlineToken, 0),
    currentSystemID: 0,
    routeCursor: 0,
    direction: 1,
    currentEdgeIndex: -1,
    currentGateID: "",
    phaseStartedAtMs: nowMs,
    nextActionAtMs: 0,
    presence: null,
    metrics: {
      operationsStarted: 0,
      operationsCompleted: 0,
      campsStarted: 0,
      campsCompleted: 0,
      intersections: 0,
    },
  };
  const initialDelayMs = chooseDurationMs(
    current,
    group,
    group.timing.initialDelay,
    "initial-delay",
  );
  scheduleDeadline(current, group, nowMs + initialDelayMs);
  current.groups[group.groupID] = group;
  current.updatedAtMs = nowMs;
  current.metrics.groupsRegistered += existing ? 0 : 1;
  return { changed: true, group };
}

function removeTaskGroup(state, groupID, nowMs = Date.now()) {
  const current = ensureState(state, nowMs);
  const id = String(groupID || "");
  const group = current.groups[id];
  if (!group) return false;
  if (group.phase === PHASE.CAMPING) {
    current.activeCampCount = Math.max(0, current.activeCampCount - 1);
  }
  removePresence(current, group);
  delete current.groups[id];
  current.updatedAtMs = nowMs;
  current.metrics.groupsRemoved += 1;
  return true;
}

function edgeIndexForGroup(group) {
  return group.direction > 0 ? group.routeCursor : group.routeCursor - 1;
}

function edgeKeyForSystems(leftSystemID, rightSystemID) {
  // Direction matters while a group is clearing its departure gate. Two
  // flights travelling opposite ways are on different grids until one has
  // completed the jump and appears in the other's system.
  return `edge:${leftSystemID}:${rightSystemID}`;
}

function buildEdgeContext(group) {
  const edgeIndex = edgeIndexForGroup(group);
  const nextCursor = group.routeCursor + group.direction;
  if (edgeIndex < 0 || nextCursor < 0 || nextCursor >= group.route.systemIDs.length) {
    return null;
  }
  const fromSystemID = group.route.systemIDs[group.routeCursor];
  const toSystemID = group.route.systemIDs[nextCursor];
  return {
    edgeIndex,
    fromSystemID,
    toSystemID,
    edgeKey: edgeKeyForSystems(fromSystemID, toSystemID),
    gateID: String(
      (group.direction > 0
        ? group.route.gateIDs[edgeIndex]
        : (group.route.reverseGateIDs || [])[edgeIndex]) || "",
    ),
  };
}

function isTerminal(group) {
  const nextCursor = group.routeCursor + group.direction;
  return nextCursor < 0 || nextCursor >= group.route.systemIDs.length;
}

function shouldCamp(state, group, edge, execution) {
  if (!edge || !group.campPolicy.enabled) return false;
  if (
    execution &&
    state.activeCampCount >= toPositiveInt(execution.maxActiveCamps, 1)
  ) {
    return false;
  }
  if (!group.campPolicy.edgeIndexes.includes(edge.edgeIndex)) return false;
  const weight = clamp(
    toFiniteNumber(group.campPolicy.edgeWeights[edge.edgeIndex], 1),
    0,
    4,
  );
  const probability = clamp(group.campPolicy.probability * weight, 0, 1);
  return deterministicUnit(
    state.seed,
    group.groupID,
    group.definitionRevision,
    group.operationNumber,
    edge.edgeIndex,
    "gate-camp",
  ) < probability;
}

function chooseDirection(state, group) {
  if (group.directionPolicy === "forward") return 1;
  if (group.directionPolicy === "reverse") return -1;
  return deterministicUnit(
    state.seed,
    group.groupID,
    group.definitionRevision,
    group.operationNumber,
    "direction",
  ) < 0.5
    ? 1
    : -1;
}

function groupsAreHostile(left, right, adapters) {
  if (!left || !right || left.groupID === right.groupID) return false;
  if (!left.combatCapable || !right.combatCapable) return false;
  if (adapters && typeof adapters.areGroupsHostile === "function") {
    try {
      const result = adapters.areGroupsHostile(left, right);
      if (typeof result === "boolean") return result;
    } catch {
      // Adapter errors are counted by the caller when the candidate is emitted.
    }
  }
  if (left.hostileGroupIDs.includes(right.groupID)) return true;
  if (right.hostileGroupIDs.includes(left.groupID)) return true;
  if (left.hostileFactionKeys.includes(right.factionKey)) return true;
  if (right.hostileFactionKeys.includes(left.factionKey)) return true;
  return false;
}

function windowsOverlap(left, right) {
  return Math.max(left.fromMs, right.fromMs) < Math.min(left.untilMs, right.untilMs);
}

function buildCandidateID(leftPresence, rightPresence) {
  const windows = [leftPresence.windowID, rightPresence.windowID].sort();
  const first = stableHash32("intersection-a", ...windows).toString(16).padStart(8, "0");
  const second = stableHash32("intersection-b", ...windows).toString(16).padStart(8, "0");
  return `LURI-${first}${second}`;
}

function snapshotGroup(group) {
  return {
    groupID: group.groupID,
    factionKey: group.factionKey,
    coalitionKey: group.coalitionKey,
    campaignID: group.campaignID,
    doctrineKey: group.doctrineKey,
    engagementRole: group.engagementRole,
    memberFlightIDs: [...group.memberFlightIDs],
    assignedFlightIDs: [...group.memberFlightIDs],
    phase: group.phase,
    operationNumber: group.operationNumber,
    routeID: group.route.routeID,
    routeCursor: group.routeCursor,
    direction: group.direction,
    currentSystemID: group.currentSystemID,
    currentEdgeIndex: group.currentEdgeIndex,
    currentGateID: group.currentGateID,
    nextActionAtMs: group.nextActionAtMs,
    nextWakeAtMs: group.nextActionAtMs,
    targetPolicy: { ...group.targetPolicy },
    playerNeutral: true,
    metadata: cloneValue(group.metadata),
  };
}

function sharedPresenceKey(left, right) {
  const rightKeys = new Set(right.keys || []);
  const shared = (left.keys || []).filter((key) => rightKeys.has(key)).sort();
  return shared.find((key) => key.startsWith("edge:")) ||
    shared.find((key) => key.startsWith("gate:")) ||
    shared[0] ||
    "";
}

function chooseEncounterSides(left, right) {
  if (left.phase === PHASE.CAMPING && right.phase !== PHASE.CAMPING) {
    return { attacker: left, defender: right };
  }
  if (right.phase === PHASE.CAMPING && left.phase !== PHASE.CAMPING) {
    return { attacker: right, defender: left };
  }
  if (left.engagementRole === "aggressor" && right.engagementRole !== "aggressor") {
    return { attacker: left, defender: right };
  }
  if (right.engagementRole === "aggressor" && left.engagementRole !== "aggressor") {
    return { attacker: right, defender: left };
  }
  const ordered = [left, right].sort((a, b) => a.groupID.localeCompare(b.groupID));
  return { attacker: ordered[0], defender: ordered[1] };
}

function chooseIntersectionSystemID(leftPresence, rightPresence) {
  const directSystemID = toPositiveInt(
    leftPresence.systemID || rightPresence.systemID,
    0,
  );
  if (directSystemID) return directSystemID;
  const candidates = [...new Set([
    leftPresence.fromSystemID,
    leftPresence.toSystemID,
    rightPresence.fromSystemID,
    rightPresence.toSystemID,
  ].map((entry) => toPositiveInt(entry, 0)).filter(Boolean))]
    .sort((left, right) => left - right);
  if (candidates.length <= 0) return 0;
  const choice = stableHash32(
    leftPresence.windowID,
    rightPresence.windowID,
    "intersection-system",
  ) % candidates.length;
  return candidates[choice];
}

function buildIntersectionCandidate(left, right, detectedAtMs) {
  const leftPresence = left.presence;
  const rightPresence = right.presence;
  const commonKey = sharedPresenceKey(leftPresence, rightPresence);
  const hasCamp = left.phase === PHASE.CAMPING || right.phase === PHASE.CAMPING;
  const bothTransit = left.phase === PHASE.TRANSIT && right.phase === PHASE.TRANSIT;
  const systemID = chooseIntersectionSystemID(leftPresence, rightPresence);
  const sides = chooseEncounterSides(left, right);
  const campaignIDs = [...new Set([
    left.campaignID,
    right.campaignID,
  ].map(String).filter(Boolean))].sort();
  const campPresence = left.phase === PHASE.CAMPING
    ? leftPresence
    : right.phase === PHASE.CAMPING
      ? rightPresence
      : null;
  // A camp contact always resolves on the camp's actual gate, even when the
  // other group was discovered through the broader system-presence index.
  const gateID = String(
    campPresence && campPresence.gateID ||
    leftPresence.gateID ||
    rightPresence.gateID ||
    "",
  );
  return {
    candidateID: buildCandidateID(leftPresence, rightPresence),
    kind: hasCamp
      ? "gate_camp_interception"
      : bothTransit
        ? "route_crossing"
        : "system_contact",
    groupIDs: [left.groupID, right.groupID].sort(),
    groupSnapshots: [snapshotGroup(left), snapshotGroup(right)]
      .sort((a, b) => a.groupID.localeCompare(b.groupID)),
    attackerGroupID: sides.attacker.groupID,
    defenderGroupID: sides.defender.groupID,
    attackerFlightID: sides.attacker.memberFlightIDs[0] || "",
    defenderFlightID: sides.defender.memberFlightIDs[0] || "",
    attackerFlightIDs: [...sides.attacker.memberFlightIDs],
    defenderFlightIDs: [...sides.defender.memberFlightIDs],
    campaignID: campaignIDs.length === 1 ? campaignIDs[0] : "",
    campaignIDs,
    detectedAtMs,
    overlapStartsAtMs: Math.max(leftPresence.fromMs, rightPresence.fromMs),
    overlapEndsAtMs: Math.min(leftPresence.untilMs, rightPresence.untilMs),
    location: {
      key: commonKey,
      systemID,
      gateID,
      anchorID: gateID,
      edgeKey: commonKey.startsWith("edge:") ? commonKey : "",
    },
    targetPolicy: normalizeTargetPolicy({
      playersExcluded: !(
        (sides.attacker.targetPolicy && sides.attacker.targetPolicy.playersExcluded === false) ||
        (sides.defender.targetPolicy && sides.defender.targetPolicy.playersExcluded === false)
      ),
    }),
    playerNeutral: true,
  };
}

function callAdapter(state, adapters, name, ...args) {
  if (!adapters || typeof adapters[name] !== "function") return undefined;
  try {
    return adapters[name](...args);
  } catch (error) {
    state.metrics.adapterErrors += 1;
    return { success: false, errorMsg: error && error.message || String(error) };
  }
}

function isSystemObserved(state, adapters, systemID, context) {
  if (!systemID || !adapters || typeof adapters.isSystemObserved !== "function") {
    return false;
  }
  const result = callAdapter(state, adapters, "isSystemObserved", systemID, context);
  return result === true;
}

function retainIntersection(state, candidate) {
  if (state.intersectionIDIndex[candidate.candidateID]) return false;
  state.intersectionIDIndex[candidate.candidateID] = true;
  state.intersectionHistory.push(candidate);
  while (state.intersectionHistory.length > MAX_RETAINED_INTERSECTIONS) {
    const removed = state.intersectionHistory.shift();
    if (removed && removed.candidateID) {
      delete state.intersectionIDIndex[removed.candidateID];
    }
  }
  state.metrics.intersectionCandidates += 1;
  for (const groupID of candidate.groupIDs) {
    const group = state.groups[groupID];
    if (group && group.metrics) group.metrics.intersections += 1;
  }
  return true;
}

function detectIntersections(state, group, adapters, detectedAtMs, execution) {
  if (!group.presence) return [];
  const candidates = [];
  const seenOtherIDs = new Set();
  const keys = [...(group.presence.keys || [])].sort((left, right) => {
    const priority = (key) => key.startsWith("edge:")
      ? 0
      : key.startsWith("gate:")
        ? 1
        : 2;
    return priority(left) - priority(right) || left.localeCompare(right);
  });
  let exhausted = false;

  for (const key of keys) {
    for (const otherID of state.presenceIndex[key] || []) {
      if (otherID === group.groupID || seenOtherIDs.has(otherID)) continue;
      if (
        execution.remainingPresenceChecks <= 0 ||
        execution.remainingIntersections <= 0 ||
        candidates.length >= execution.maxIntersectionsPerPresence
      ) {
        exhausted = true;
        break;
      }
      seenOtherIDs.add(otherID);
      execution.remainingPresenceChecks -= 1;
      const other = state.groups[otherID];
      if (
        !other ||
        !other.presence ||
        !windowsOverlap(group.presence, other.presence) ||
        !groupsAreHostile(group, other, adapters)
      ) {
        continue;
      }
      const candidate = buildIntersectionCandidate(group, other, detectedAtMs);
      if (!retainIntersection(state, candidate)) continue;
      candidates.push(candidate);
      execution.remainingIntersections -= 1;
      callAdapter(state, adapters, "onIntersectionCandidate", cloneValue(candidate));
      const observedSystemID = toPositiveInt(candidate.location.systemID, 0);
      if (isSystemObserved(state, adapters, observedSystemID, candidate)) {
        state.metrics.observedIntersections += 1;
        callAdapter(state, adapters, "onObservedIntersection", cloneValue(candidate));
      }
    }
    if (exhausted) break;
  }
  if (exhausted) {
    state.metrics.intersectionCandidatesSuppressed += 1;
    execution.intersectionBudgetExhausted = true;
    if (execution.remainingPresenceChecks <= 0) {
      state.metrics.presenceChecksSuppressed += 1;
      execution.presenceCheckBudgetExhausted = true;
    }
  }
  return candidates;
}

function setPresence(state, group, presence, adapters, detectedAtMs, execution) {
  removePresence(state, group);
  group.presence = presence;
  const intersections = detectIntersections(
    state,
    group,
    adapters,
    detectedAtMs,
    execution,
  );
  for (const key of presence.keys) {
    const rows = Array.isArray(state.presenceIndex[key])
      ? state.presenceIndex[key]
      : [];
    if (!rows.includes(group.groupID)) rows.push(group.groupID);
    rows.sort();
    state.presenceIndex[key] = rows;
  }
  const systemID = toPositiveInt(presence.systemID, 0);
  if (isSystemObserved(state, adapters, systemID, snapshotGroup(group))) {
    state.metrics.observedWindows += 1;
    callAdapter(state, adapters, "onObservationCandidate", {
      kind: "roaming_task_group",
      systemID,
      fromMs: presence.fromMs,
      untilMs: presence.untilMs,
      group: snapshotGroup(group),
      targetPolicy: { ...group.targetPolicy },
      playerNeutral: true,
    });
  }
  return intersections;
}

function presenceWindowID(group, phase) {
  return [
    group.groupID,
    group.definitionRevision,
    group.operationNumber,
    group.transitionNumber,
    phase,
  ].join(":");
}

function beginDwelling(state, group, atMs, adapters, execution) {
  group.phase = PHASE.DWELLING;
  group.phaseStartedAtMs = atMs;
  group.currentSystemID = group.route.systemIDs[group.routeCursor];
  group.currentEdgeIndex = -1;
  group.currentGateID = "";
  const durationMs = chooseDurationMs(
    state,
    group,
    group.timing.dwell,
    "dwell",
    group.routeCursor,
  );
  scheduleDeadline(state, group, atMs + durationMs);
  const intersections = setPresence(state, group, {
    windowID: presenceWindowID(group, PHASE.DWELLING),
    kind: "system",
    systemID: group.currentSystemID,
    gateID: "",
    edgeKey: "",
    fromMs: atMs,
    untilMs: group.nextActionAtMs,
    keys: [`system:${group.currentSystemID}`],
  }, adapters, atMs, execution);
  return { transition: "dwell_started", intersections };
}

function getTransitRange(group, edgeIndex) {
  return group.route.transitMsByEdge[edgeIndex] || group.timing.transit;
}

function beginTransit(state, group, atMs, adapters, execution) {
  const edge = buildEdgeContext(group);
  if (!edge) return completeOperation(state, group, atMs);
  group.phase = PHASE.TRANSIT;
  group.phaseStartedAtMs = atMs;
  // A transit window represents the group clearing and aligning at the
  // departure gate before the abstract jump completes. Keeping the source
  // system indexed makes the operation discoverable to a player who is
  // actually present without requiring a universe-wide scan.
  group.currentSystemID = edge.fromSystemID;
  group.currentEdgeIndex = edge.edgeIndex;
  group.currentGateID = edge.gateID;
  const durationMs = chooseDurationMs(
    state,
    group,
    getTransitRange(group, edge.edgeIndex),
    "transit",
    edge.edgeIndex,
  );
  scheduleDeadline(state, group, atMs + durationMs);
  const keys = [edge.edgeKey, `system:${edge.fromSystemID}`];
  if (edge.gateID) keys.push(`gate:${edge.gateID}`);
  const intersections = setPresence(state, group, {
    windowID: presenceWindowID(group, PHASE.TRANSIT),
    kind: "route_edge",
    systemID: edge.fromSystemID,
    gateID: edge.gateID,
    edgeKey: edge.edgeKey,
    fromSystemID: edge.fromSystemID,
    toSystemID: edge.toSystemID,
    fromMs: atMs,
    untilMs: group.nextActionAtMs,
    keys,
  }, adapters, atMs, execution);
  return { transition: "transit_started", intersections };
}

function beginCamp(state, group, edge, atMs, adapters, execution) {
  group.phase = PHASE.CAMPING;
  group.phaseStartedAtMs = atMs;
  group.currentSystemID = group.route.systemIDs[group.routeCursor];
  group.currentEdgeIndex = edge.edgeIndex;
  group.currentGateID = edge.gateID;
  const durationMs = chooseDurationMs(
    state,
    group,
    group.timing.camp,
    "gate-camp-duration",
    edge.edgeIndex,
  );
  scheduleDeadline(state, group, atMs + durationMs);
  group.metrics.campsStarted += 1;
  state.metrics.campsStarted += 1;
  state.activeCampCount += 1;
  const keys = [`system:${group.currentSystemID}`, edge.edgeKey];
  if (edge.gateID) keys.push(`gate:${edge.gateID}`);
  const intersections = setPresence(state, group, {
    windowID: presenceWindowID(group, PHASE.CAMPING),
    kind: "gate_camp",
    systemID: group.currentSystemID,
    gateID: edge.gateID,
    edgeKey: edge.edgeKey,
    fromSystemID: edge.fromSystemID,
    toSystemID: edge.toSystemID,
    fromMs: atMs,
    untilMs: group.nextActionAtMs,
    keys,
  }, adapters, atMs, execution);
  return { transition: "gate_camp_started", intersections };
}

function completeOperation(state, group, atMs) {
  removePresence(state, group);
  group.phase = PHASE.STAGING;
  group.phaseStartedAtMs = atMs;
  group.currentSystemID = 0;
  group.currentEdgeIndex = -1;
  group.currentGateID = "";
  group.metrics.operationsCompleted += 1;
  state.metrics.operationsCompleted += 1;
  const cooldownMs = chooseDurationMs(
    state,
    group,
    group.timing.cooldown,
    "operation-cooldown",
  );
  scheduleDeadline(state, group, atMs + cooldownMs);
  return { transition: "operation_completed", intersections: [] };
}

function advanceGroup(state, group, deadline, adapters, execution) {
  const atMs = deadline.atMs;
  removePresence(state, group);
  group.transitionNumber += 1;
  let result;

  if (group.phase === PHASE.STAGING) {
    group.operationNumber += 1;
    group.direction = chooseDirection(state, group);
    group.routeCursor = group.direction > 0 ? 0 : group.route.systemIDs.length - 1;
    group.metrics.operationsStarted += 1;
    state.metrics.operationsStarted += 1;
    result = beginDwelling(state, group, atMs, adapters, execution);
    result.transition = "operation_started";
  } else if (group.phase === PHASE.DWELLING) {
    if (isTerminal(group)) {
      result = completeOperation(state, group, atMs);
    } else {
      const edge = buildEdgeContext(group);
      result = shouldCamp(state, group, edge, execution)
        ? beginCamp(state, group, edge, atMs, adapters, execution)
        : beginTransit(state, group, atMs, adapters, execution);
    }
  } else if (group.phase === PHASE.CAMPING) {
    state.activeCampCount = Math.max(0, state.activeCampCount - 1);
    group.metrics.campsCompleted += 1;
    state.metrics.campsCompleted += 1;
    result = beginTransit(state, group, atMs, adapters, execution);
    result.transition = "gate_camp_completed";
  } else if (group.phase === PHASE.TRANSIT) {
    group.routeCursor += group.direction;
    result = beginDwelling(state, group, atMs, adapters, execution);
    result.transition = "system_arrival";
  } else {
    group.phase = PHASE.STAGING;
    result = completeOperation(state, group, atMs);
  }

  const event = {
    kind: result.transition,
    scheduledAtMs: atMs,
    group: snapshotGroup(group),
  };
  callAdapter(state, adapters, "onTransition", cloneValue(event));
  return { event, intersections: result.intersections || [] };
}

function tick(state, nowMs = Date.now(), adapters = {}, options = {}) {
  const current = ensureState(state, nowMs);
  const startedAtMs = performance.now();
  const workBudgetMs = Number.isFinite(Number(options.workBudgetMs))
    ? clamp(Number(options.workBudgetMs), 0.05, 100)
    : Infinity;
  const maxTransitions = clamp(
    toPositiveInt(options.maxTransitions, DEFAULT_MAX_TRANSITIONS),
    1,
    1_024,
  );
  const events = [];
  const intersections = [];
  const execution = {
    remainingIntersections: clamp(
      toPositiveInt(options.maxIntersectionCandidates, 32),
      1,
      256,
    ),
    maxIntersectionsPerPresence: clamp(
      toPositiveInt(options.maxIntersectionsPerPresence, 8),
      1,
      32,
    ),
    remainingPresenceChecks: clamp(
      toPositiveInt(options.maxPresenceChecks, 256),
      1,
      4_096,
    ),
    intersectionBudgetExhausted: false,
    presenceCheckBudgetExhausted: false,
    maxActiveCamps: clamp(
      toPositiveInt(options.maxActiveCamps, 6),
      1,
      64,
    ),
  };
  const maxDeadlinePops = clamp(
    toPositiveInt(options.maxDeadlinePops, maxTransitions * 4),
    maxTransitions,
    4_096,
  );
  let processed = 0;
  let examined = 0;
  let workBudgetExhausted = false;

  while (processed < maxTransitions && examined < maxDeadlinePops) {
    if (processed > 0 && performance.now() - startedAtMs >= workBudgetMs) {
      workBudgetExhausted = true;
      break;
    }
    const next = current.deadlineHeap[0];
    if (!next || toFiniteNumber(next.atMs, Infinity) > nowMs) break;
    const deadline = heapPop(current.deadlineHeap);
    examined += 1;
    const group = current.groups[String(deadline.groupID || "")];
    if (
      !group ||
      toPositiveInt(deadline.token, 0) !== toPositiveInt(group.deadlineToken, 0) ||
      toFiniteNumber(deadline.atMs, -1) !== toFiniteNumber(group.nextActionAtMs, -2)
    ) {
      current.metrics.staleDeadlinesDiscarded += 1;
      continue;
    }
    const result = advanceGroup(current, group, deadline, adapters, execution);
    events.push(result.event);
    intersections.push(...result.intersections);
    processed += 1;
    current.metrics.transitionsProcessed += 1;
  }

  const next = current.deadlineHeap[0] || null;
  const deferred = Boolean(next && toFiniteNumber(next.atMs, Infinity) <= nowMs);
  if (deferred) current.metrics.budgetDeferrals += 1;
  current.updatedAtMs = nowMs;
  return {
    changed: examined > 0,
    processed,
    deadlinesExamined: examined,
    deferred,
    deadlineBudgetExhausted: deferred && examined >= maxDeadlinePops,
    workBudgetExhausted,
    nextDeadlineAtMs: next ? toFiniteNumber(next.atMs, 0) : 0,
    nextWakeAtMs: next ? toFiniteNumber(next.atMs, 0) : 0,
    events,
    intersections,
    intersectionBudgetExhausted: execution.intersectionBudgetExhausted,
    presenceCheckBudgetExhausted: execution.presenceCheckBudgetExhausted,
  };
}

function listObservationCandidates(state, systemID, nowMs = Date.now()) {
  const current = ensureState(state, nowMs);
  const normalizedSystemID = toPositiveInt(systemID, 0);
  if (!normalizedSystemID) return [];
  return (current.presenceIndex[`system:${normalizedSystemID}`] || [])
    .map((groupID) => current.groups[groupID])
    .filter((group) => (
      group &&
      group.presence &&
      group.presence.fromMs <= nowMs &&
      group.presence.untilMs > nowMs
    ))
    .sort((left, right) => left.groupID.localeCompare(right.groupID))
    .map((group) => ({
      kind: "roaming_task_group",
      systemID: normalizedSystemID,
      fromMs: group.presence.fromMs,
      untilMs: group.presence.untilMs,
      group: snapshotGroup(group),
      targetPolicy: { ...group.targetPolicy },
      playerNeutral: true,
    }));
}

function listActiveCamps(state, options = {}) {
  const nowMs = toFiniteNumber(options.nowMs, Date.now());
  const systemID = toPositiveInt(options.systemID, 0);
  const current = ensureState(state, nowMs);
  const candidates = systemID
    ? (current.presenceIndex[`system:${systemID}`] || [])
      .map((groupID) => current.groups[groupID])
    : Object.values(current.groups);
  return candidates
    .filter((group) => (
      group &&
      group.phase === PHASE.CAMPING &&
      group.presence &&
      group.presence.fromMs <= nowMs &&
      group.presence.untilMs > nowMs &&
      (!systemID || group.currentSystemID === systemID)
    ))
    .sort((left, right) => left.groupID.localeCompare(right.groupID))
    .map((group) => ({
      campID: group.presence.windowID,
      groupID: group.groupID,
      assignedFlightIDs: [...group.memberFlightIDs],
      systemID: group.currentSystemID,
      gateID: group.currentGateID,
      anchorID: group.currentGateID,
      activeFromMs: group.presence.fromMs,
      activeUntilMs: group.presence.untilMs,
      nextWakeAtMs: group.nextActionAtMs,
      campaignID: group.campaignID,
      playerNeutral: true,
      targetPolicy: { ...group.targetPolicy },
      group: snapshotGroup(group),
    }));
}

function listIntersectionCandidates(state, options = {}) {
  const current = ensureState(state, toFiniteNumber(options.nowMs, Date.now()));
  const fromMs = toFiniteNumber(options.fromMs, -Infinity);
  const untilMs = toFiniteNumber(options.untilMs, Infinity);
  const systemID = toPositiveInt(options.systemID, 0);
  return current.intersectionHistory
    .filter((candidate) => (
      candidate.overlapEndsAtMs > fromMs &&
      candidate.overlapStartsAtMs < untilMs &&
      (!systemID || candidate.location.systemID === systemID)
    ))
    .map(cloneValue);
}

function isTargetEligible(source, target) {
  const policy = source && source.targetPolicy && typeof source.targetPolicy === "object"
    ? source.targetPolicy
    : { playersExcluded: true };
  const isPlayer = Boolean(
    target && (
      target.isPlayer === true ||
      target.kind === "player" ||
      target.ownerKind === "player" ||
      target.pilotKind === "player"
    ),
  );
  if (isPlayer && policy.playersExcluded !== false) return false;
  return Boolean(target) && target.protected !== true;
}

function getStatus(state, nowMs = Date.now()) {
  const current = ensureState(state, nowMs);
  const phaseCounts = {
    [PHASE.STAGING]: 0,
    [PHASE.DWELLING]: 0,
    [PHASE.TRANSIT]: 0,
    [PHASE.CAMPING]: 0,
  };
  for (const group of Object.values(current.groups)) {
    const phase = String(group && group.phase || PHASE.STAGING);
    phaseCounts[phase] = toFiniteNumber(phaseCounts[phase], 0) + 1;
  }
  const next = current.deadlineHeap[0] || null;
  return {
    schemaVersion: current.schemaVersion,
    groups: Object.keys(current.groups).length,
    phaseCounts,
    queuedDeadlines: current.deadlineHeap.length,
    nextDeadlineAtMs: next ? toFiniteNumber(next.atMs, 0) : 0,
    nextWakeAtMs: next ? toFiniteNumber(next.atMs, 0) : 0,
    nextDeadlineInMs: next
      ? Math.max(0, toFiniteNumber(next.atMs, nowMs) - nowMs)
      : 0,
    retainedIntersections: current.intersectionHistory.length,
    activeCamps: current.activeCampCount,
    metrics: { ...current.metrics },
  };
}

module.exports = {
  PHASE,
  SCHEMA_VERSION,
  createState,
  ensureState,
  getStatus,
  isTargetEligible,
  listActiveCamps,
  listIntersectionCandidates,
  listObservationCandidates,
  rebuildDeadlineHeap,
  rebuildIndexes,
  removeTaskGroup,
  tick,
  upsertTaskGroup,
  _testing: {
    buildEdgeContext,
    compareDeadlines,
    deterministicUnit,
    edgeKeyForSystems,
    heapPop,
    heapPush,
    normalizeTaskGroupSpec,
    stableHash32,
  },
};
