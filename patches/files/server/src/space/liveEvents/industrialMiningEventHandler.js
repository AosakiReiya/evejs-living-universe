"use strict";

const path = require("path");

const OPERATOR_KIND = "liveEvent";
const DEFAULT_OBSERVATION_POLL_MS = 15_000;
const DEFAULT_VIRTUAL_CYCLE_MS = 60_000;
const DEFAULT_VIRTUAL_QUANTITY = 500;
const DEFAULT_EMPTY_CHECK_LIMIT = 3;

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function getDependencies(options = {}) {
  return {
    miningState: options.miningState || require(path.join(
      __dirname,
      "../../services/mining/miningRuntimeState",
    )),
    miningOperations: options.miningOperations || require(path.join(
      __dirname,
      "../../services/mining/miningNpcOperations",
    )),
    physicalBudget: options.physicalBudget || require(path.join(
      __dirname,
      "../npc/npcPhysicalBudget",
    )),
  };
}

function getDefinitionContent(definition) {
  return definition && definition.content && typeof definition.content === "object"
    ? definition.content
    : {};
}

function getScene(spaceRuntime, systemID) {
  return spaceRuntime && spaceRuntime.scenes instanceof Map
    ? spaceRuntime.scenes.get(toPositiveInt(systemID, 0)) || null
    : null;
}

function hasObservers(scene) {
  return Boolean(scene && scene.sessions instanceof Map && scene.sessions.size > 0);
}

function getPersistedCandidates(miningState, systemID, beltID = 0) {
  const entities = miningState.readPersistedSystemEntities(systemID);
  return Object.values(entities && typeof entities === "object" ? entities : {})
    .filter((state) => (
      state &&
      toPositiveInt(state.entityID, 0) > 0 &&
      toPositiveInt(state.beltID, 0) > 0 &&
      toPositiveInt(state.remainingQuantity, 0) > 0 &&
      (beltID <= 0 || toPositiveInt(state.beltID, 0) === beltID)
    ))
    .sort((left, right) => toPositiveInt(left.entityID, 0) - toPositiveInt(right.entityID, 0));
}

function ensurePersistedCandidates(miningState, systemID, beltID = 0, nowMs = Date.now()) {
  let candidates = getPersistedCandidates(miningState, systemID, beltID);
  if (
    candidates.length <= 0 &&
    miningState &&
    typeof miningState.ensurePersistedAsteroidBaselines === "function"
  ) {
    const seedOptions = {
      maximumBelts: beltID > 0 ? undefined : 1,
      nowMs,
    };
    if (beltID > 0) {
      seedOptions.beltIDs = [beltID];
    }
    const seedResult = miningState.ensurePersistedAsteroidBaselines(systemID, seedOptions);
    if (seedResult && seedResult.success === true) {
      candidates = getPersistedCandidates(miningState, systemID, beltID);
    }
  }
  return candidates;
}

function selectBeltID(candidates, seed = 0) {
  const beltIDs = [...new Set(candidates.map((state) => toPositiveInt(state.beltID, 0)))]
    .filter((beltID) => beltID > 0)
    .sort((left, right) => left - right);
  return beltIDs.length > 0
    ? beltIDs[Math.abs(Math.trunc(Number(seed) || 0)) % beltIDs.length]
    : 0;
}

function buildVirtualAllocations(candidates, requestedQuantity, maximumTargets = 4) {
  const allocations = [];
  let remainingRequest = Math.max(1, toPositiveInt(requestedQuantity, DEFAULT_VIRTUAL_QUANTITY));
  for (const state of candidates.slice(0, Math.max(1, maximumTargets))) {
    if (remainingRequest <= 0) {
      break;
    }
    const available = toPositiveInt(state.remainingQuantity, 0);
    const quantity = Math.min(available, remainingRequest);
    if (quantity <= 0) {
      continue;
    }
    allocations.push({
      entityID: toPositiveInt(state.entityID, 0),
      requestedQuantity: quantity,
    });
    remainingRequest -= quantity;
  }
  return allocations;
}

function findSceneMiningTarget(scene, miningState, beltID = 0) {
  if (!scene) {
    return null;
  }
  miningState.ensureSceneMiningState(scene);
  return (Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
    .map((entity) => ({
      entity,
      state: miningState.getMineableState(scene, entity && entity.itemID),
    }))
    .filter((entry) => (
      beltID <= 0 || toPositiveInt(entry.state && entry.state.beltID, 0) === beltID
    ))
    .find((entry) => entry.state && toPositiveInt(entry.state.remainingQuantity, 0) > 0) || null;
}

function getReservationID(event) {
  return `live-event:${String(event && event.eventID || "unknown")}`;
}

function releaseReservation(physicalBudget, event) {
  const reservationID = String(
    event && event.data && event.data.physicalReservationID || getReservationID(event),
  );
  if (physicalBudget.getReservation(reservationID)) {
    return physicalBudget.release(reservationID);
  }
  return typeof physicalBudget.releaseOwner === "function"
    ? physicalBudget.releaseOwner(OPERATOR_KIND, event.eventID) > 0
    : false;
}

function cleanupPhysicalState(dependencies, event) {
  const data = event.data && typeof event.data === "object" ? cloneValue(event.data) : {};
  if (toPositiveInt(data.miningFleetID, 0) > 0) {
    dependencies.miningOperations.destroyManagedMiningFleet(data.miningFleetID, {
      operatorKind: OPERATOR_KIND,
      operatorID: event.eventID,
    });
  }
  if (typeof dependencies.miningOperations.destroyManagedMiningFleetsByOwner === "function") {
    dependencies.miningOperations.destroyManagedMiningFleetsByOwner({
      operatorKind: OPERATOR_KIND,
      operatorID: event.eventID,
    });
  }
  releaseReservation(dependencies.physicalBudget, event);
  return {
    ...data,
    miningFleetID: 0,
    physicalEntityIDs: [],
    physicalReservationID: null,
    materializedAtMs: 0,
    lastObservedAtMs: 0,
  };
}

function createIndustrialMiningEventHandler(options = {}) {
  return {
    advance(context) {
      const dependencies = getDependencies(options);
      const event = context.event;
      const definition = context.definition;
      const nowMs = Math.max(0, Math.trunc(Number(context.nowMs) || 0));
      const spaceRuntime = context.spaceRuntime || options.spaceRuntime || null;
      const content = getDefinitionContent(definition);
      const lifecycle = definition.lifecycle || {};
      const data = event.data && typeof event.data === "object" ? cloneValue(event.data) : {};
      const metrics = event.metrics && typeof event.metrics === "object"
        ? cloneValue(event.metrics)
        : {};
      const engagementMs = Math.max(
        60_000,
        toPositiveInt(lifecycle.engagementSeconds, 1_800) * 1_000,
      );
      const virtualCycleMs = Math.max(
        15_000,
        toPositiveInt(content.virtualCycleSeconds, DEFAULT_VIRTUAL_CYCLE_MS / 1_000) * 1_000,
      );
      const observerGraceMs = Math.max(
        15_000,
        toPositiveInt(content.lastObserverGraceSeconds, 60) * 1_000,
      );
      const physicalShipLimit = Math.max(
        1,
        toPositiveInt(definition.limits && definition.limits.physicalShips, 15),
      );

      if (event.phase === "scheduled") {
        const candidates = ensurePersistedCandidates(
          dependencies.miningState,
          event.systemID,
          toPositiveInt(data.beltID || event.anchor && event.anchor.beltID, 0),
          nowMs,
        );
        const beltID = toPositiveInt(data.beltID, 0) || selectBeltID(candidates, event.seed);
        return {
          phase: "dormant",
          eventPhase: "virtual_operation",
          nextTransitionAtMs: nowMs + 1,
          patch: {
            data: {
              ...data,
              beltID,
              startedAtMs: toPositiveInt(data.startedAtMs, nowMs),
              expiresAtMs: toPositiveInt(data.expiresAtMs, nowMs + engagementMs),
              virtualCycle: toPositiveInt(data.virtualCycle, 0),
              totalVirtualMined: toPositiveInt(data.totalVirtualMined, 0),
              emptyChecks: 0,
            },
            metrics,
          },
        };
      }

      if (event.phase === "cleanup") {
        return {
          phase: "completed",
          eventPhase: "completed",
          patch: { data: cleanupPhysicalState(dependencies, event), metrics },
        };
      }

      if (event.phase === "resolving" || event.phase === "aftermath") {
        return {
          phase: "cleanup",
          eventPhase: "cleanup",
          nextTransitionAtMs: nowMs + 1,
          patch: { data: cleanupPhysicalState(dependencies, event), metrics },
        };
      }

      if (event.phase === "recovery_pending") {
        return {
          phase: "dormant",
          eventPhase: "restart_recovered_virtual",
          nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
          patch: { data: cleanupPhysicalState(dependencies, event), metrics },
        };
      }

      if (event.phase === "materializing") {
        if (toPositiveInt(data.expiresAtMs, 0) > 0 && nowMs >= data.expiresAtMs) {
          return {
            phase: "dormant",
            eventPhase: "expired_before_materialization",
            nextTransitionAtMs: nowMs + 1,
            patch: { data, metrics },
          };
        }
        const scene = getScene(spaceRuntime, event.systemID);
        if (!hasObservers(scene)) {
          return {
            phase: "dormant",
            eventPhase: "virtual_operation",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data, metrics },
          };
        }
        const targetEntry = findSceneMiningTarget(
          scene,
          dependencies.miningState,
          toPositiveInt(data.beltID, 0),
        );
        if (!targetEntry) {
          return {
            phase: "dormant",
            eventPhase: "waiting_for_mineable_belt",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data: { ...data, lastWaitReason: "MINEABLE_TARGET_NOT_FOUND" }, metrics },
          };
        }
        if (!dependencies.physicalBudget.canReserve({
          reservationID: getReservationID(event),
          ownerKind: OPERATOR_KIND,
          ownerID: event.eventID,
          systemID: event.systemID,
          shipCount: physicalShipLimit,
        })) {
          metrics.materializationBudgetDeferrals =
            toPositiveInt(metrics.materializationBudgetDeferrals, 0) + 1;
          return {
            phase: "dormant",
            eventPhase: "physical_budget_deferred",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data, metrics },
          };
        }

        const spawnResult = dependencies.miningOperations.spawnManagedMiningFleet(scene, {
          source: "live-event",
          operatorKind: OPERATOR_KIND,
          operatorID: event.eventID,
          physicalShipLimit,
          centerTarget: targetEntry.entity,
          minerAmount: Math.max(1, toPositiveInt(content.minerCount, 4)),
          haulerAmount: toNonNegativeInt(content.haulerCount, 1),
          minerQuery: String(content.minerProfileOrPool || "").trim(),
          haulerQuery: String(content.haulerProfileOrPool || "").trim(),
        });
        if (!spawnResult.success || !spawnResult.data) {
          metrics.materializationFailures = toPositiveInt(metrics.materializationFailures, 0) + 1;
          return {
            phase: "dormant",
            eventPhase: "materialization_failed",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: {
              data: { ...data, lastMaterializationError: spawnResult.errorMsg || "SPAWN_FAILED" },
              metrics,
            },
          };
        }
        const entityIDs = Array.isArray(spawnResult.data.entityIDs)
          ? spawnResult.data.entityIDs.map((entityID) => toPositiveInt(entityID, 0)).filter(Boolean)
          : [];
        if (entityIDs.length <= 0 || entityIDs.length > physicalShipLimit) {
          dependencies.miningOperations.destroyManagedMiningFleet(
            spawnResult.data.fleetRecord && spawnResult.data.fleetRecord.fleetID,
            { operatorKind: OPERATOR_KIND, operatorID: event.eventID },
          );
          return {
            phase: "dormant",
            eventPhase: "materialization_rejected",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data: { ...data, lastMaterializationError: "PHYSICAL_SHIP_LIMIT" }, metrics },
          };
        }
        const reservation = dependencies.physicalBudget.reserve({
          reservationID: getReservationID(event),
          ownerKind: OPERATOR_KIND,
          ownerID: event.eventID,
          systemID: event.systemID,
          shipCount: physicalShipLimit,
          priority: 50,
          metadata: {
            definitionID: event.definitionID,
            actualShips: entityIDs.length,
          },
        });
        if (!reservation.success) {
          dependencies.miningOperations.destroyManagedMiningFleet(
            spawnResult.data.fleetRecord && spawnResult.data.fleetRecord.fleetID,
            { operatorKind: OPERATOR_KIND, operatorID: event.eventID },
          );
          return {
            phase: "dormant",
            eventPhase: "physical_budget_race",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data, metrics },
          };
        }
        metrics.materializations = toPositiveInt(metrics.materializations, 0) + 1;
        return {
          phase: "active",
          eventPhase: "observed_mining_operation",
          nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
          patch: {
            data: {
              ...data,
              beltID: toPositiveInt(data.beltID, toPositiveInt(targetEntry.state.beltID, 0)),
              miningFleetID: toPositiveInt(
                spawnResult.data.fleetRecord && spawnResult.data.fleetRecord.fleetID,
                0,
              ),
              physicalEntityIDs: entityIDs,
              physicalReservationID: reservation.reservation.reservationID,
              materializedAtMs: nowMs,
              lastObservedAtMs: nowMs,
              lastMaterializationError: null,
            },
            metrics,
          },
        };
      }

      if (event.phase === "active") {
        const scene = getScene(spaceRuntime, event.systemID);
        const fleet = dependencies.miningOperations.getManagedMiningFleet(data.miningFleetID, {
          operatorKind: OPERATOR_KIND,
          operatorID: event.eventID,
        });
        if (!fleet) {
          releaseReservation(dependencies.physicalBudget, event);
          metrics.physicalFleetLosses = toPositiveInt(metrics.physicalFleetLosses, 0) + 1;
          return {
            phase: "resolving",
            eventPhase: "fleet_lost",
            nextTransitionAtMs: nowMs + 1,
            patch: {
              data: {
                ...data,
                miningFleetID: 0,
                physicalEntityIDs: [],
                physicalReservationID: null,
              },
              metrics,
            },
          };
        }
        if (toPositiveInt(data.expiresAtMs, 0) > 0 && nowMs >= data.expiresAtMs) {
          return {
            phase: "resolving",
            eventPhase: "operation_expired",
            nextTransitionAtMs: nowMs + 1,
            patch: { data, metrics },
          };
        }
        if (hasObservers(scene)) {
          return {
            phase: "active",
            eventPhase: "observed_mining_operation",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data: { ...data, lastObservedAtMs: nowMs }, metrics },
          };
        }
        const lastObservedAtMs = toPositiveInt(data.lastObservedAtMs, nowMs);
        if (nowMs - lastObservedAtMs < observerGraceMs) {
          return {
            phase: "active",
            eventPhase: "observer_grace",
            nextTransitionAtMs: Math.min(
              nowMs + DEFAULT_OBSERVATION_POLL_MS,
              lastObservedAtMs + observerGraceMs,
            ),
            patch: { data, metrics },
          };
        }
        metrics.dematerializations = toPositiveInt(metrics.dematerializations, 0) + 1;
        return {
          phase: "dormant",
          eventPhase: "virtual_operation",
          nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
          patch: { data: cleanupPhysicalState(dependencies, event), metrics },
        };
      }

      if (event.phase === "dormant") {
        if (toPositiveInt(data.expiresAtMs, 0) > 0 && nowMs >= data.expiresAtMs) {
          return {
            phase: "completed",
            eventPhase: "completed",
            patch: { data: cleanupPhysicalState(dependencies, event), metrics },
          };
        }
        const scene = getScene(spaceRuntime, event.systemID);
        if (hasObservers(scene)) {
          const targetEntry = findSceneMiningTarget(
            scene,
            dependencies.miningState,
            toPositiveInt(data.beltID, 0),
          );
          return {
            phase: targetEntry ? "materializing" : "dormant",
            eventPhase: targetEntry ? "player_observed" : "waiting_for_mineable_belt",
            nextTransitionAtMs: nowMs + (targetEntry ? 1 : DEFAULT_OBSERVATION_POLL_MS),
            patch: {
              data: targetEntry && !toPositiveInt(data.beltID, 0)
                ? { ...data, beltID: toPositiveInt(targetEntry.state.beltID, 0) }
                : data,
              metrics,
            },
          };
        }
        if (hasObservers(getScene(spaceRuntime, event.systemID))) {
          return {
            phase: "dormant",
            eventPhase: "loaded_scene_paused",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: { data, metrics },
          };
        }
        const lastVirtualAtMs = toPositiveInt(data.lastVirtualAtMs, 0);
        if (lastVirtualAtMs > 0 && nowMs - lastVirtualAtMs < virtualCycleMs) {
          return {
            phase: "dormant",
            eventPhase: "virtual_operation",
            nextTransitionAtMs: Math.min(
              nowMs + DEFAULT_OBSERVATION_POLL_MS,
              lastVirtualAtMs + virtualCycleMs,
            ),
            patch: { data, metrics },
          };
        }
        let beltID = toPositiveInt(data.beltID, 0);
        let candidates = ensurePersistedCandidates(
          dependencies.miningState,
          event.systemID,
          beltID,
          nowMs,
        );
        if (beltID <= 0) {
          const allCandidates = ensurePersistedCandidates(
            dependencies.miningState,
            event.systemID,
            0,
            nowMs,
          );
          beltID = selectBeltID(allCandidates, event.seed);
          candidates = allCandidates.filter((state) => toPositiveInt(state.beltID, 0) === beltID);
        }
        const allocations = buildVirtualAllocations(
          candidates,
          toPositiveInt(content.virtualQuantityPerCycle, DEFAULT_VIRTUAL_QUANTITY),
          toPositiveInt(content.virtualTargetsPerCycle, 4),
        );
        if (beltID <= 0 || allocations.length <= 0) {
          const emptyChecks = toPositiveInt(data.emptyChecks, 0) + 1;
          if (emptyChecks >= toPositiveInt(content.emptyCheckLimit, DEFAULT_EMPTY_CHECK_LIMIT)) {
            return {
              phase: "completed",
              eventPhase: "no_persisted_resources",
              patch: { data: { ...data, beltID, emptyChecks }, metrics },
            };
          }
          return {
            phase: "dormant",
            eventPhase: "waiting_for_persisted_resources",
            nextTransitionAtMs: nowMs + virtualCycleMs,
            patch: { data: { ...data, beltID, emptyChecks }, metrics },
          };
        }
        const virtualCycle = toPositiveInt(data.virtualCycle, 0) + 1;
        const transactionID = `${event.eventID}:virtual:${String(virtualCycle).padStart(6, "0")}`;
        const miningResult = dependencies.miningState.applyPersistedMiningBatch({
          transactionID,
          eventID: event.eventID,
          systemID: event.systemID,
          beltID,
          allocations,
        }, {
          nowMs,
          isSystemSceneLoaded: (systemID) => hasObservers(getScene(spaceRuntime, systemID)),
        });
        if (!miningResult.success) {
          const emptyChecks = miningResult.errorMsg === "NO_ELIGIBLE_RESOURCES"
            ? toPositiveInt(data.emptyChecks, 0) + 1
            : toPositiveInt(data.emptyChecks, 0);
          return {
            phase: "dormant",
            eventPhase: miningResult.errorMsg === "SCENE_ACTIVE"
              ? "loaded_scene_paused"
              : "virtual_mining_deferred",
            nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
            patch: {
              data: {
                ...data,
                beltID,
                emptyChecks,
                lastVirtualError: miningResult.errorMsg || "VIRTUAL_MINING_FAILED",
              },
              metrics,
            },
          };
        }
        const loadedScene = getScene(spaceRuntime, event.systemID);
        if (
          loadedScene &&
          !hasObservers(loadedScene) &&
          typeof dependencies.miningState.syncPersistedMiningBatchToScene === "function"
        ) {
          dependencies.miningState.syncPersistedMiningBatchToScene(
            loadedScene,
            miningResult.data,
            { broadcast: false, nowMs },
          );
        }
        const acceptedQuantity = toPositiveInt(
          miningResult.data && miningResult.data.totalAcceptedQuantity,
          0,
        );
        metrics.virtualCycles = toPositiveInt(metrics.virtualCycles, 0) + 1;
        metrics.virtualUnitsMined = toPositiveInt(metrics.virtualUnitsMined, 0) + acceptedQuantity;
        return {
          phase: "dormant",
          eventPhase: "virtual_operation",
          nextTransitionAtMs: nowMs + virtualCycleMs,
          patch: {
            data: {
              ...data,
              beltID,
              virtualCycle,
              totalVirtualMined: toPositiveInt(data.totalVirtualMined, 0) + acceptedQuantity,
              lastVirtualAtMs: nowMs,
              lastVirtualTransactionID: transactionID,
              lastVirtualError: null,
              emptyChecks: 0,
            },
            metrics,
          },
        };
      }

      return {
        phase: event.phase,
        eventPhase: event.eventPhase,
        nextTransitionAtMs: nowMs + DEFAULT_OBSERVATION_POLL_MS,
        patch: { data, metrics },
      };
    },
  };
}

module.exports = {
  OPERATOR_KIND,
  createIndustrialMiningEventHandler,
  _testing: {
    buildVirtualAllocations,
    cleanupPhysicalState,
    findSceneMiningTarget,
    getPersistedCandidates,
    ensurePersistedCandidates,
    hasObservers,
    selectBeltID,
  },
};
