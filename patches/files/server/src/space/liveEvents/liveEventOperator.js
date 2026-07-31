"use strict";

const path = require("path");

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value === undefined || value === null ? "" : value).trim();
  return normalized || fallback;
}

function resolveDependencies(options = {}) {
  return {
    runtime: options.runtime || require("./liveEventRuntime").getDefaultRuntime(),
    physicalBudget: options.physicalBudget || require(path.join(
      __dirname,
      "../npc/npcPhysicalBudget",
    )),
    spaceRuntime: options.spaceRuntime || require(path.join(__dirname, "../runtime")),
  };
}

function getSessionSystemID(session) {
  return toPositiveInt(
    session && session._space && session._space.systemID ||
      session && session.solarsystemid2 ||
      session && session.solarsystemid,
    0,
  );
}

function buildOperatorSnapshot(options = {}) {
  const dependencies = resolveDependencies(options);
  const eventRuntime = dependencies.runtime.getSnapshot();
  const physicalBudget = dependencies.physicalBudget.getStatus();
  const tickSummary = dependencies.spaceRuntime &&
    typeof dependencies.spaceRuntime.getLastRuntimeTickSummary === "function"
    ? dependencies.spaceRuntime.getLastRuntimeTickSummary()
    : null;
  const activeEvents = eventRuntime.events.filter((event) => event.phase !== "completed");
  return {
    generatedAtMs: Math.max(0, Math.trunc(Number(options.nowMs ?? Date.now()) || 0)),
    eventRuntime,
    activeEventCount: activeEvents.length,
    activeEvents,
    physicalBudget,
    serverTick: tickSummary
      ? {
          targetTickIntervalMs: Number(tickSummary.targetTickIntervalMs) || 100,
          actualIntervalMs: Number(tickSummary.actualIntervalMs) || 0,
          tickDurationMs: Number(tickSummary.tickDurationMs) || 0,
          sceneCount: Number(tickSummary.sceneCount) || 0,
          tickedSceneCount: Number(tickSummary.tickedSceneCount) || 0,
        }
      : null,
  };
}

function formatStatus(snapshot) {
  const eventRuntime = snapshot.eventRuntime;
  const metrics = eventRuntime.metrics || {};
  const budget = snapshot.physicalBudget;
  const tick = snapshot.serverTick;
  return [
    `Live events ${eventRuntime.enabled ? "enabled" : "disabled"}/${eventRuntime.started ? "running" : "stopped"}: ${snapshot.activeEventCount} active, ${eventRuntime.queueSize} queued.`,
    `Scheduler last ${Number(metrics.lastPassDurationMs || 0).toFixed(3)} ms, max ${Number(metrics.maxPassDurationMs || 0).toFixed(3)} ms, failures ${Number(metrics.failedJobs) || 0}.`,
    `Shared physical NPC budget ${budget.reservedShips}/${budget.limits.global} globally; ${budget.reservationCount} reservation(s).`,
    tick
      ? `Server tick ${Number(tick.actualIntervalMs || 0).toFixed(1)} ms interval, ${Number(tick.tickDurationMs || 0).toFixed(1)} ms work.`
      : "Server tick telemetry is not available yet.",
  ].join(" ");
}

function formatEventList(snapshot) {
  if (snapshot.activeEvents.length <= 0) {
    return "No active live events.";
  }
  const rows = snapshot.activeEvents
    .slice()
    .sort((left, right) => Number(left.nextTransitionAtMs || 0) - Number(right.nextTransitionAtMs || 0))
    .slice(0, 10)
    .map((event) => (
      `${event.eventID} ${event.definitionID} system=${event.systemID || "virtual"} phase=${event.phase}/${event.eventPhase}`
    ));
  const omitted = Math.max(0, snapshot.activeEvents.length - rows.length);
  return `Active live events: ${rows.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}.`;
}

function executeOperatorCommand(argumentText = "", options = {}) {
  const dependencies = resolveDependencies(options);
  const tokens = normalizeText(argumentText, "status").split(/\s+/).filter(Boolean);
  const subcommand = normalizeText(tokens.shift(), "status").toLowerCase();
  const nowMs = Math.max(0, Math.trunc(Number(options.nowMs ?? Date.now()) || 0));

  if (subcommand === "status") {
    const snapshot = buildOperatorSnapshot({ ...dependencies, nowMs });
    return { success: true, message: formatStatus(snapshot), data: snapshot };
  }
  if (subcommand === "list") {
    const snapshot = buildOperatorSnapshot({ ...dependencies, nowMs });
    return { success: true, message: formatEventList(snapshot), data: snapshot.activeEvents };
  }
  if (subcommand === "telemetry") {
    const snapshot = buildOperatorSnapshot({ ...dependencies, nowMs });
    return { success: true, message: formatStatus(snapshot), data: snapshot };
  }
  if (subcommand === "definitions") {
    const definitions = dependencies.runtime.listDefinitions({ includeDisabled: true });
    return {
      success: true,
      message: definitions.length > 0
        ? `Live-event definitions: ${definitions.map((definition) => `${definition.definitionID}${definition.enabled ? "" : " [disabled]"}`).join(", ")}.`
        : "No live-event definitions are available.",
      data: definitions,
    };
  }
  if (subcommand === "spawn") {
    const definitionID = normalizeText(tokens.shift());
    if (!definitionID) {
      return { success: false, message: "Usage: /event spawn <definitionID> [systemID] [force]" };
    }
    const explicitSystemID = toPositiveInt(tokens[0], 0);
    if (explicitSystemID > 0) {
      tokens.shift();
    }
    const force = tokens.some((token) => ["force", "--force"].includes(token.toLowerCase()));
    const ignoreCaps = tokens.some((token) => ["ignorecaps", "--ignore-caps"].includes(token.toLowerCase()));
    const systemID = explicitSystemID || getSessionSystemID(options.session);
    const result = dependencies.runtime.scheduleEvent(definitionID, {
      systemID,
      force,
      ignoreCaps,
      nowMs,
    });
    return result && result.success
      ? {
          success: true,
          message: `Scheduled ${result.data.eventID} (${definitionID}) in ${systemID || "virtual space"}; phase=${result.data.phase}.`,
          data: result.data,
        }
      : {
          success: false,
          message: `Live-event spawn failed: ${normalizeText(result && result.errorMsg, "UNKNOWN_ERROR")}.`,
        };
  }
  if (subcommand === "advance") {
    const eventID = normalizeText(tokens.shift());
    if (!eventID) {
      return { success: false, message: "Usage: /event advance <eventID>" };
    }
    const result = dependencies.runtime.advanceEventNow(eventID, nowMs);
    return result && result.success
      ? {
          success: true,
          message: `Advanced ${eventID} to ${result.data.phase}/${result.data.eventPhase}.`,
          data: result.data,
        }
      : {
          success: false,
          message: `Live-event advance failed: ${normalizeText(result && result.errorMsg, "UNKNOWN_ERROR")}.`,
        };
  }
  if (subcommand === "despawn" || subcommand === "cleanup") {
    const eventID = normalizeText(tokens.shift());
    if (!eventID) {
      return { success: false, message: "Usage: /event despawn <eventID>" };
    }
    const cleanupResult = dependencies.runtime.requestCleanup(eventID, {
      nowMs,
      reason: "chat-operator-request",
    });
    if (!cleanupResult || cleanupResult.success !== true) {
      return {
        success: false,
        message: `Live-event cleanup request failed: ${normalizeText(cleanupResult && cleanupResult.errorMsg, "UNKNOWN_ERROR")}.`,
      };
    }
    const advanceResult = dependencies.runtime.advanceEventNow(eventID, nowMs);
    return advanceResult && advanceResult.success
      ? {
          success: true,
          message: `Cleaned up ${eventID}; phase=${advanceResult.data.phase}.`,
          data: advanceResult.data,
        }
      : {
          success: false,
          message: `Cleanup was queued for ${eventID}, but immediate advance failed: ${normalizeText(advanceResult && advanceResult.errorMsg, "UNKNOWN_ERROR")}.`,
        };
  }

  return {
    success: false,
    message: "Usage: /event [status|list|telemetry|definitions|spawn <definitionID> [systemID] [force]|advance <eventID>|despawn <eventID>]",
  };
}

module.exports = {
  buildOperatorSnapshot,
  executeOperatorCommand,
  formatEventList,
  formatStatus,
  getSessionSystemID,
};

