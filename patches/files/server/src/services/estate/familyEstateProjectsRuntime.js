"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  grantItemToOwnerLocation,
  grantItemsToOwnerLocation,
  listContainerItems,
  takeItemTypeFromCharacterLocation,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  CORPORATION_WALLET_KEY_START,
  applyCorporationWalletOperation,
  adjustCorporationWalletDivisionBalance,
  getCorporationWalletBalance,
  getCorporationWalletJournal,
  getCorporationWalletOperation,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_SERVICE_SLOT_FLAGS,
} = require(path.join(__dirname, "../structure/structureServiceModules"));
const {
  PROJECT_DEFINITIONS,
  appendLedger,
  ensureState,
  readState,
  updateState,
} = require("./familyEstateProjectState");

const SETTLEMENT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_CATCHUP_INTERVALS = 24;
const SCHEDULER_INTERVAL_MS = 60 * 1000;
const REPROCESSING_MODULE_TYPE_ID = 35899;
const ACTIVE_DELIVERY_STATES = new Set(["reserved", "delivery_pending"]);
const ESTATE_FREIGHT_FEE_RATE = 0.05;
const ESTATE_MINIMUM_FREIGHT_FEE_ISK = 50_000;

let scheduler = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function roundIsk(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function buildStableFingerprint(parts = []) {
  return parts.map((value) => String(value === undefined || value === null ? "" : value)).join("|");
}

function getProjectReservedQuantity(project, typeID, excludedReservationID = null) {
  return Object.values(project && project.procurement && project.procurement.reservations || {})
    .filter((reservation) => (
      ACTIVE_DELIVERY_STATES.has(String(reservation && reservation.status || "")) &&
      Number(reservation && reservation.typeID) === Number(typeID) &&
      String(reservation && reservation.reservationID || "") !== String(excludedReservationID || "")
    ))
    .reduce((sum, reservation) => sum + toPositiveInt(reservation.quantity, 0), 0);
}

function getActiveEstateCommitmentISK(state) {
  return roundIsk(Object.values(state && state.projects || {}).reduce(
    (projectSum, project) => projectSum + Object.values(
      project && project.procurement && project.procurement.reservations || {},
    ).filter((reservation) => ACTIVE_DELIVERY_STATES.has(
      String(reservation && reservation.status || ""),
    )).reduce(
      (reservationSum, reservation) => reservationSum + Math.max(
        0,
        Number(reservation && reservation.totalISK) || 0,
      ),
      0,
    ),
    0,
  ));
}

function getOutstandingProjectLaborCommitmentISK(state) {
  return roundIsk(Object.entries(PROJECT_DEFINITIONS).reduce((sum, [key, definition]) => {
    const project = state && state.projects && state.projects[key];
    if (
      !project ||
      project.status !== "available" ||
      project.funding.status === "applied" ||
      project.procurement.autoStart !== true ||
      !["commissioned", "fulfilled"].includes(project.procurement.status)
    ) {
      return sum;
    }
    return sum + definition.iskCost;
  }, 0));
}

function estimateFreightQuote(typeID, quantity) {
  const catalog = require(path.join(
    __dirname,
    "../../space/npc/ambientTraffic/livingEconomyCatalog",
  ));
  const good = catalog.getGood(typeID);
  if (!good || quantity <= 0) {
    return { goodsISK: 0, freightISK: 0, invoiceISK: 0, shipments: 0 };
  }
  const shipmentQuantity = Math.max(1, toPositiveInt(good.shipmentQuantity, 1));
  let remaining = toPositiveInt(quantity, 0);
  let goodsISK = 0;
  let freightISK = 0;
  let shipments = 0;
  while (remaining > 0) {
    const units = Math.min(shipmentQuantity, remaining);
    const shipmentGoodsISK = roundIsk(units * good.priceAnchor);
    goodsISK = roundIsk(goodsISK + shipmentGoodsISK);
    freightISK = roundIsk(freightISK + Math.max(
      ESTATE_MINIMUM_FREIGHT_FEE_ISK,
      shipmentGoodsISK * ESTATE_FREIGHT_FEE_RATE,
    ));
    shipments += 1;
    remaining -= units;
  }
  return {
    goodsISK,
    freightISK,
    invoiceISK: roundIsk(goodsISK + freightISK),
    shipments,
  };
}

function getEstateRuntime() {
  return require("./familyEstateRuntime");
}

function notifyLivingEconomyDemandChanged() {
  if (config.livingEconomyEnabled !== true) return;
  try {
    require(path.join(
      __dirname,
      "../../space/npc/ambientTraffic/livingEconomyRuntime",
    )).notifyExternalFreightDemandMutation();
  } catch (error) {
    log.warn(`[FamilyEstateProjects] Freight-demand invalidation failed: ${error.message}`);
  }
}

function getContext(options = {}) {
  const estateRuntime = getEstateRuntime();
  const profile = options.profile || require("./familyEstateProfile").getFamilyEstateProfile();
  const structure = options.structure || estateRuntime.findFamilyEstateStructure({ includeDestroyed: true });
  const claimState = options.claimState || estateRuntime.getFamilyEstateClaimState({ profile, structure });
  return { estateRuntime, profile, structure, claimState };
}

function getSessionCharacterID(session) {
  return toPositiveInt(session && (session.characterID || session.charid), 0);
}

function getSessionStructureID(session) {
  return toPositiveInt(session && (session.structureID || session.structureid), 0);
}

function getStackQuantity(item) {
  return Number(item && item.singleton) === 1
    ? 1
    : Math.max(0, Math.trunc(Number(item && (item.stacksize ?? item.quantity)) || 0));
}

function projectDependenciesComplete(state, definition) {
  return definition.dependsOn.every(
    (dependency) => state.projects[dependency] && state.projects[dependency].status === "completed",
  );
}

function projectMaterialsComplete(project, definition) {
  return definition.materials.every(
    (requirement) => toPositiveInt(project.contributed[String(requirement.typeID)], 0) >= requirement.quantity,
  );
}

function buildProjectViews(state) {
  return Object.values(PROJECT_DEFINITIONS).map((definition) => {
    const record = state.projects[definition.key];
    const activeReservations = Object.values(record.procurement.reservations || {})
      .filter((reservation) => ACTIVE_DELIVERY_STATES.has(
        String(reservation && reservation.status || ""),
      ));
    const activeCommittedISK = roundIsk(activeReservations.reduce(
      (sum, reservation) => sum + Math.max(0, Number(reservation.totalISK) || 0),
      0,
    ));
    const arrivedAwaitingPayment = activeReservations.filter(
      (reservation) => reservation.status === "delivery_pending",
    );
    const estimatedOutstanding = definition.materials.reduce((summary, requirement) => {
      const remainingToContract = Math.max(
        0,
        requirement.quantity -
          toPositiveInt(record.contributed[String(requirement.typeID)], 0) -
          getProjectReservedQuantity(record, requirement.typeID),
      );
      const quote = estimateFreightQuote(requirement.typeID, remainingToContract);
      summary.goodsISK = roundIsk(summary.goodsISK + quote.goodsISK);
      summary.freightISK = roundIsk(summary.freightISK + quote.freightISK);
      summary.invoiceISK = roundIsk(summary.invoiceISK + quote.invoiceISK);
      summary.shipments += quote.shipments;
      return summary;
    }, { goodsISK: 0, freightISK: 0, invoiceISK: 0, shipments: 0 });
    return {
      ...definition,
      ...record,
      procurement: {
        ...record.procurement,
        activeCommittedISK,
        activeDeliveries: activeReservations.length,
        arrivedAwaitingPayment: arrivedAwaitingPayment.length,
        arrivedAwaitingPaymentISK: roundIsk(arrivedAwaitingPayment.reduce(
          (sum, reservation) => sum + Math.max(0, Number(reservation.totalISK) || 0),
          0,
        )),
        estimatedOutstandingGoodsISK: estimatedOutstanding.goodsISK,
        estimatedOutstandingFreightISK: estimatedOutstanding.freightISK,
        estimatedOutstandingInvoiceISK: estimatedOutstanding.invoiceISK,
        estimatedOutstandingShipments: estimatedOutstanding.shipments,
      },
      dependenciesComplete: projectDependenciesComplete(state, definition),
      materialsComplete: projectMaterialsComplete(record, definition),
      materials: definition.materials.map((requirement) => ({
        ...requirement,
        contributed: toPositiveInt(record.contributed[String(requirement.typeID)], 0),
        reserved: getProjectReservedQuantity(record, requirement.typeID),
        remaining: Math.max(
          0,
          requirement.quantity - toPositiveInt(record.contributed[String(requirement.typeID)], 0),
        ),
        remainingToContract: Math.max(
          0,
          requirement.quantity -
            toPositiveInt(record.contributed[String(requirement.typeID)], 0) -
            getProjectReservedQuantity(record, requirement.typeID),
        ),
      })),
    };
  });
}

function requireClaimedResident(session, context, options = {}) {
  if (!context.structure || context.structure.destroyedAt) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DESTROYED" };
  }
  if (context.claimState.status !== "claimed") {
    return { success: false, errorMsg: "FAMILY_ESTATE_UNCLAIMED" };
  }
  const characterID = getSessionCharacterID(session);
  const corporationID = toPositiveInt(
    session && (session.corporationID || session.corpid || session.corpID),
    0,
  );
  const role = context.estateRuntime.resolveFamilyEstateMemberRole(
    characterID,
    corporationID,
    context.claimState,
  );
  if (role === "outsider") {
    return { success: false, errorMsg: "FAMILY_ESTATE_RESIDENT_REQUIRED" };
  }
  if (
    options.requireDocking !== false &&
    getSessionStructureID(session) !== toPositiveInt(context.structure.structureID, 0)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DOCKING_REQUIRED" };
  }
  if (
    options.requireManager === true &&
    options.bypassAuthority !== true &&
    !context.estateRuntime.canManageFamilyEstate(session, context.claimState)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_STEWARD_REQUIRED" };
  }
  return { success: true, characterID, corporationID, role };
}

function syncChanges(session, changes = []) {
  const { syncInventoryItemForSession } = require(path.join(
    __dirname,
    "../character/characterState",
  ));
  for (const change of changes) {
    if (change && change.item) {
      syncInventoryItemForSession(session, change.item, change.previousData || {}, {
        emitCfgLocation: false,
      });
    }
  }
}

function contributeToProject(session, projectKey, options = {}) {
  const key = String(projectKey || "").trim().toLowerCase();
  const definition = PROJECT_DEFINITIONS[key];
  if (!definition) return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_INVALID" };
  const context = getContext(options);
  const access = requireClaimedResident(session, context, { requireDocking: true });
  if (!access.success) return access;
  const state = reconcileEstateProjects(options.nowMs || Date.now(), { settleCommercial: false });
  const project = state.projects[key];
  if (project.status === "completed") {
    return { success: true, unchanged: true, data: { state, project } };
  }
  if (project.status === "in_progress") {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_ALREADY_STARTED" };
  }

  const availableByTypeID = {};
  for (const item of listContainerItems(access.characterID, context.structure.structureID, ITEM_FLAGS.HANGAR)) {
    availableByTypeID[String(item.typeID)] = (
      availableByTypeID[String(item.typeID)] || 0
    ) + getStackQuantity(item);
  }
  const contributions = definition.materials.map((requirement) => {
    const remaining = Math.max(
      0,
      requirement.quantity -
        toPositiveInt(project.contributed[String(requirement.typeID)], 0) -
        getProjectReservedQuantity(project, requirement.typeID),
    );
    return {
      ...requirement,
      quantity: Math.min(remaining, availableByTypeID[String(requirement.typeID)] || 0),
    };
  }).filter((entry) => entry.quantity > 0);
  if (contributions.length <= 0) {
    return { success: false, errorMsg: "FAMILY_ESTATE_NO_PROJECT_MATERIALS" };
  }

  const consumed = [];
  const changes = [];
  for (const entry of contributions) {
    const result = takeItemTypeFromCharacterLocation(
      access.characterID,
      context.structure.structureID,
      ITEM_FLAGS.HANGAR,
      entry.typeID,
      entry.quantity,
    );
    if (!result.success) {
      grantItemsToOwnerLocation(
        access.characterID,
        context.structure.structureID,
        ITEM_FLAGS.HANGAR,
        consumed.map((restored) => ({ itemType: restored, quantity: restored.quantity })),
      );
      return result;
    }
    consumed.push(entry);
    changes.push(...(result.data && result.data.changes || []));
  }

  const nowMs = options.nowMs || Date.now();
  const writeResult = updateState((next) => {
    for (const entry of consumed) {
      const typeKey = String(entry.typeID);
      next.projects[key].contributed[typeKey] = Math.min(
        definition.materials.find((item) => item.typeID === entry.typeID).quantity,
        toPositiveInt(next.projects[key].contributed[typeKey], 0) + entry.quantity,
      );
      appendLedger(next, {
        id: `contribution:${key}:${access.characterID}:${entry.typeID}:${nowMs}`,
        atMs: nowMs,
        kind: "material_contribution",
        projectKey: key,
        characterID: access.characterID,
        corporationID: access.corporationID,
        typeID: entry.typeID,
        quantity: entry.quantity,
        note: entry.name,
      });
    }
    return next;
  }, nowMs);
  if (!writeResult.success) {
    grantItemsToOwnerLocation(
      access.characterID,
      context.structure.structureID,
      ITEM_FLAGS.HANGAR,
      consumed.map((entry) => ({ itemType: entry, quantity: entry.quantity })),
    );
    return writeResult;
  }
  syncChanges(session, changes);
  return { success: true, data: { state: writeResult.data, contributions: consumed } };
}

function commissionProject(session, projectKey, options = {}) {
  const key = String(projectKey || "").trim().toLowerCase();
  const definition = PROJECT_DEFINITIONS[key];
  if (!definition) return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_INVALID" };
  if (
    config.familyEstateLogisticsEnabled !== true ||
    config.livingUniverseEnabled !== true ||
    config.livingEconomyEnabled !== true
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_LOGISTICS_DISABLED" };
  }
  const context = getContext(options);
  const access = requireClaimedResident(session, context, {
    requireDocking: true,
    requireManager: true,
    bypassAuthority: options.bypassAuthority,
  });
  if (!access.success) return access;
  const nowMs = options.nowMs || Date.now();
  const state = reconcileEstateProjects(nowMs, { settleCommercial: false });
  const project = state.projects[key];
  if (project.status === "completed" || project.status === "in_progress") {
    return { success: true, unchanged: true, data: { state, project } };
  }
  if (!projectDependenciesComplete(state, definition)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_DEPENDENCY_REQUIRED" };
  }
  if (project.procurement.status === "commissioned") {
    return { success: true, unchanged: true, data: { state, project } };
  }
  const result = updateState((next) => {
    const target = next.projects[key];
    target.procurement.status = projectMaterialsComplete(target, definition)
      ? "fulfilled"
      : "commissioned";
    target.procurement.autoStart = options.autoStart !== false;
    target.procurement.commissionedAtMs = nowMs;
    target.procurement.commissionedByCharacterID = access.characterID;
    target.procurement.corporationID = context.claimState.ownerCorporationID;
    target.procurement.lastError = null;
    appendLedger(next, {
      id: `procurement-commission:${key}:${context.claimState.ownerCorporationID}`,
      atMs: nowMs,
      kind: "procurement_commissioned",
      projectKey: key,
      characterID: access.characterID,
      corporationID: context.claimState.ownerCorporationID,
      note: "Independent regional haulers authorized; automatic project start enabled.",
    });
    return next;
  }, nowMs, { durable: true });
  if (result.success) {
    notifyLivingEconomyDemandChanged();
    return { success: true, data: { state: result.data, project: result.data.projects[key] } };
  }
  return result;
}

function ensureProjectFundingIntent(key, definition, context, actorCharacterID, nowMs) {
  const corporationID = toPositiveInt(context.claimState.ownerCorporationID, 0);
  const structureID = toPositiveInt(context.structure && context.structure.structureID, 0);
  const operationID = `estate-project:${corporationID}:${structureID}:${key}:labor`;
  const fingerprint = buildStableFingerprint([
    "family-estate-project-labor-v1",
    corporationID,
    structureID,
    key,
    definition.iskCost,
  ]);
  let conflict = false;
  const result = updateState((next) => {
    const funding = next.projects[key].funding;
    if (funding.status === "applied") return next;
    if (
      funding.operationID &&
      (funding.operationID !== operationID || funding.fingerprint !== fingerprint)
    ) {
      funding.lastError = "FAMILY_ESTATE_PROJECT_FUNDING_CONFLICT";
      conflict = true;
      return next;
    }
    funding.status = "pending";
    funding.operationID = operationID;
    funding.fingerprint = fingerprint;
    funding.amountISK = definition.iskCost;
    funding.requestedAtMs = funding.requestedAtMs || nowMs;
    funding.requestedByCharacterID = funding.requestedByCharacterID || actorCharacterID || null;
    funding.lastError = null;
    return next;
  }, nowMs, { durable: true });
  if (conflict) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_FUNDING_CONFLICT" };
  }
  return result.success
    ? { success: true, data: { state: result.data, operationID, fingerprint } }
    : result;
}

function fundAndStartProject(key, definition, context, actorCharacterID, nowMs, options = {}) {
  let state = readState(nowMs);
  const project = state.projects[key];
  if (project.status === "completed" || project.status === "in_progress") {
    return { success: true, unchanged: true, data: { state, project } };
  }
  if (!projectDependenciesComplete(state, definition)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_DEPENDENCY_REQUIRED" };
  }
  if (!projectMaterialsComplete(project, definition)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_MATERIALS_REQUIRED" };
  }
  const intent = ensureProjectFundingIntent(
    key,
    definition,
    context,
    actorCharacterID,
    nowMs,
  );
  if (!intent.success) return intent;

  const walletResult = applyCorporationWalletOperation({
    operationID: intent.data.operationID,
    fingerprint: intent.data.fingerprint,
    kind: "family_estate_project_labor",
    corporationID: context.claimState.ownerCorporationID,
    accountKey: CORPORATION_WALLET_KEY_START,
    delta: -definition.iskCost,
    nowMs,
    description: `Family estate project: ${definition.label}`,
    ownerID1: context.claimState.ownerCorporationID,
    ownerID2: actorCharacterID,
    counterpartyID: actorCharacterID,
    referenceID: context.structure.structureID,
  });
  if (!walletResult.success) {
    updateState((next) => {
      next.projects[key].funding.lastError = walletResult.errorMsg || "WALLET_OPERATION_FAILED";
      return next;
    }, nowMs, { durable: true });
    return {
      success: false,
      errorMsg: walletResult.errorMsg === "INSUFFICIENT_FUNDS"
        ? "FAMILY_ESTATE_PROJECT_ISK_REQUIRED"
        : walletResult.errorMsg,
      requiredISK: definition.iskCost,
      balance: getCorporationWalletBalance(
        context.claimState.ownerCorporationID,
        CORPORATION_WALLET_KEY_START,
      ),
      uncertain: walletResult.uncertain === true,
    };
  }

  const writeResult = updateState((next) => {
    const target = next.projects[key];
    if (target.status === "completed" || target.status === "in_progress") return next;
    target.status = "in_progress";
    target.iskCommitted = definition.iskCost;
    target.startedAtMs = nowMs;
    target.completesAtMs = nowMs + definition.durationMs;
    target.startedByCharacterID = actorCharacterID || null;
    target.funding.status = "applied";
    target.funding.appliedAtMs = walletResult.data.appliedAtMs || nowMs;
    target.funding.lastError = null;
    if (target.procurement.status === "commissioned") {
      target.procurement.status = "fulfilled";
    }
    if (!(next.ledger || []).some((entry) => entry.id === `project-start:${key}`)) {
      appendLedger(next, {
        id: `project-start:${key}`,
        atMs: nowMs,
        kind: "project_expense",
        projectKey: key,
        characterID: actorCharacterID || null,
        corporationID: context.claimState.ownerCorporationID,
        expenseISK: definition.iskCost,
        netISK: -definition.iskCost,
        note: definition.label,
      });
    }
    return next;
  }, nowMs, { durable: true });
  if (!writeResult.success) {
    return { ...writeResult, uncertain: true };
  }
  return {
    success: true,
    replayed: walletResult.replayed === true,
    data: { state: writeResult.data, project: writeResult.data.projects[key] },
  };
}

function startProject(session, projectKey, options = {}) {
  const key = String(projectKey || "").trim().toLowerCase();
  const definition = PROJECT_DEFINITIONS[key];
  if (!definition) return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_INVALID" };
  const context = getContext(options);
  const access = requireClaimedResident(session, context, {
    requireDocking: true,
    requireManager: true,
    bypassAuthority: options.bypassAuthority,
  });
  if (!access.success) return access;
  const nowMs = options.nowMs || Date.now();
  const state = reconcileEstateProjects(nowMs, { settleCommercial: false });
  const project = state.projects[key];
  if (project.status === "completed" || project.status === "in_progress") {
    return { success: true, unchanged: true, data: { state, project } };
  }
  if (!projectDependenciesComplete(state, definition)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_DEPENDENCY_REQUIRED" };
  }
  if (!projectMaterialsComplete(project, definition)) {
    if (options.commissionIfMissing === true) {
      return commissionProject(session, key, {
        ...options,
        autoStart: true,
      });
    }
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_MATERIALS_REQUIRED" };
  }
  return fundAndStartProject(
    key,
    definition,
    context,
    access.characterID,
    nowMs,
    options,
  );
}

function getCommissionedMaterialRequirements(options = {}) {
  if (
    config.familyEstateEnabled !== true ||
    config.familyEstateLogisticsEnabled !== true ||
    config.livingUniverseEnabled !== true ||
    config.livingEconomyEnabled !== true
  ) {
    return [];
  }
  const context = getContext(options);
  if (
    context.claimState.status !== "claimed" ||
    !context.structure ||
    context.structure.destroyedAt
  ) {
    return [];
  }
  const state = readState(options.nowMs || Date.now());
  const requirements = [];
  for (const [projectKey, definition] of Object.entries(PROJECT_DEFINITIONS)) {
    const project = state.projects[projectKey];
    if (
      project.status !== "available" ||
      project.procurement.status !== "commissioned" ||
      !projectDependenciesComplete(state, definition)
    ) {
      continue;
    }
    for (const material of definition.materials) {
      const contributed = toPositiveInt(project.contributed[String(material.typeID)], 0);
      const reserved = getProjectReservedQuantity(project, material.typeID);
      const remainingQuantity = Math.max(0, material.quantity - contributed - reserved);
      if (remainingQuantity <= 0) continue;
      requirements.push({
        projectKey,
        typeID: material.typeID,
        typeName: material.name,
        remainingQuantity,
        contributed,
        reserved,
        corporationID: context.claimState.ownerCorporationID,
        destinationStructureID: context.structure.structureID,
        destinationSystemID: context.profile.homeSystemID,
      });
    }
  }
  return requirements;
}

function buildEstateConduitRouteSpec(sourceStation, context) {
  const marketTopology = require(path.join(__dirname, "../market/marketTopology"));
  const wormholeRuntime = require(path.join(
    __dirname,
    "../exploration/wormholes/wormholeRuntime",
  ));
  const sourceSystemID = toPositiveInt(sourceStation && sourceStation.systemID, 0);
  if (!sourceSystemID) return null;
  let knownSpacePath = marketTopology.getShortestPath(
    sourceSystemID,
    context.profile.highSecSystemID,
  );
  if (sourceSystemID === context.profile.highSecSystemID) {
    knownSpacePath = [sourceSystemID];
  }
  if (!Array.isArray(knownSpacePath) || knownSpacePath.length <= 0) return null;
  const conduit = wormholeRuntime.listFamilyEstateConnectionViews({
    includeCollapsed: false,
    includeUndiscovered: true,
  }).find((entry) => (
    entry.persistent === true &&
    String(entry.estateConnectionRole || "") === "highsec" &&
    Number(entry.destinationSystemID) === Number(context.profile.highSecSystemID) &&
    Number(entry.sourceSystemID) === Number(context.profile.homeSystemID)
  ));
  if (!conduit) return null;
  const systemIDs = [...knownSpacePath, context.profile.homeSystemID];
  const conduitEdgeIndex = systemIDs.length - 2;
  return {
    routeID:
      `living_estate_${sourceStation.stationID}_${context.structure.structureID}_` +
      `${String(conduit.pairID || "conduit").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    systemIDs,
    endpointStationIDs: [sourceStation.stationID, context.structure.structureID],
    endpointAnchors: [
      {
        kind: "station",
        itemID: sourceStation.stationID,
        systemID: sourceStation.systemID,
      },
      {
        kind: "structure",
        itemID: context.structure.structureID,
        systemID: context.profile.homeSystemID,
      },
    ],
    typedEdges: [{
      index: conduitEdgeIndex,
      kind: "wormhole",
      sourceSystemID: context.profile.highSecSystemID,
      destinationSystemID: context.profile.homeSystemID,
      sourceAnchorID: conduit.destinationEndpointID,
      destinationAnchorID: conduit.sourceEndpointID,
      sourceAnchor: {
        kind: "wormhole",
        itemID: conduit.destinationEndpointID,
        systemID: context.profile.highSecSystemID,
        position: conduit.destinationPosition,
        radius: conduit.destinationRadius,
      },
      destinationAnchor: {
        kind: "wormhole",
        itemID: conduit.sourceEndpointID,
        systemID: context.profile.homeSystemID,
        position: conduit.sourcePosition,
        radius: conduit.sourceRadius,
      },
      pairID: conduit.pairID,
    }],
    riskBand: "nullsec",
    routeClass: "frontier",
    lowSecurity: true,
    allowedLogisticsClasses: ["secure"],
    dynamic: true,
    familyEstate: true,
  };
}

async function buildFamilyEstateFreightOpportunities(
  stockMap,
  getStockRow,
  nowMs = Date.now(),
  options = {},
) {
  const requirements = getCommissionedMaterialRequirements({ nowMs });
  if (requirements.length <= 0) return [];
  const catalog = require(path.join(
    __dirname,
    "../../space/npc/ambientTraffic/livingEconomyCatalog",
  ));
  const routePlanner = require(path.join(
    __dirname,
    "../../space/npc/ambientTraffic/livingEconomyRoutePlanner",
  ));
  const context = getContext();
  const workBudget = options.workBudget;
  const multiplier = Math.max(
    1,
    Math.min(100, Number(config.livingUniverseOffGridTravelTimeMultiplier) || 1),
  );
  const opportunities = [];
  let scanned = 0;
  for (const requirement of requirements) {
    const good = catalog.getGood(requirement.typeID);
    if (!good) continue;
    const sources = [];
    for (const station of catalog.STATIONS) {
      const row = getStockRow(stockMap, station.stationID, good.typeID);
      const quantity = toPositiveInt(row && row.quantity, 0);
      if (quantity <= 0) continue;
      const target = catalog.getTargetQuantity(station, good);
      const producerCeiling = catalog.getProducerCeiling(station, good);
      const reserve = producerCeiling > 0
        ? Math.min(Math.max(0, quantity - 1), Math.round(target * 0.25))
        : Math.round(target * 0.2);
      const available = Math.max(0, quantity - reserve);
      if (available <= 0) continue;
      const routeSpec = buildEstateConduitRouteSpec(station, context);
      if (!routeSpec) continue;
      const unitPrice = Math.max(0.01, Number(row && row.price) || good.priceAnchor);
      const jumps = routeSpec.systemIDs.length - 1;
      const modeledTravelMinutes = routePlanner.getEstimatedTravelMinutes(jumps);
      sources.push({
        station,
        available,
        unitPrice,
        routeSpec,
        jumps,
        modeledTravelMinutes,
      });
      scanned += 1;
      if (
        workBudget &&
        typeof workBudget.checkpoint === "function" &&
        scanned % 32 === 0
      ) {
        await workBudget.checkpoint();
      }
    }
    sources.sort((left, right) => (
      left.unitPrice - right.unitPrice ||
      left.modeledTravelMinutes - right.modeledTravelMinutes ||
      right.available - left.available
    ));
    for (const source of sources.slice(0, 4)) {
      const destinationStation = {
        stationID: requirement.destinationStructureID,
        systemID: requirement.destinationSystemID,
        regionID: 0,
        name: context.structure.name || context.structure.itemName || "The Family Holding",
        archetype: "family_estate",
        hubTier: "estate",
      };
      opportunities.push({
        good,
        sourceStation: source.station,
        destinationStation,
        sourceAvailable: source.available,
        destinationNeeded: requirement.remainingQuantity,
        sourceUnitPrice: source.unitPrice,
        destinationUnitPrice: Math.round(source.unitPrice * 1.05 * 100) / 100,
        routeSpec: source.routeSpec,
        jumps: source.jumps,
        travelMinutes: source.modeledTravelMinutes / multiplier,
        modeledTravelMinutes: source.modeledTravelMinutes,
        priorityDemandUnits: requirement.remainingQuantity,
        estateDelivery: {
          projectKey: requirement.projectKey,
          corporationID: requirement.corporationID,
          destinationStructureID: requirement.destinationStructureID,
        },
        score:
          1_000_000_000_000 +
          (requirement.remainingQuantity * 10_000) -
          source.modeledTravelMinutes -
          (source.unitPrice / Math.max(1, good.priceAnchor)),
      });
    }
  }
  return opportunities.sort((left, right) => right.score - left.score);
}

function findFamilyEstateDeliveryReservation(state, reservationID) {
  const id = String(reservationID || "").trim();
  for (const [projectKey, project] of Object.entries(state && state.projects || {})) {
    const reservation = project && project.procurement &&
      project.procurement.reservations && project.procurement.reservations[id];
    if (reservation) return { projectKey, project, reservation };
  }
  return null;
}

function ensureFamilyEstateDeliveryEscrow(projectKey, reservationID, nowMs = Date.now()) {
  let state = readState(nowMs);
  let located = findFamilyEstateDeliveryReservation(state, reservationID);
  if (!located || located.projectKey !== projectKey) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_FOUND" };
  }
  let { reservation } = located;
  if (reservation.escrowStatus === "escrowed" || reservation.escrowStatus === "paid") {
    return { success: true, replayed: true, data: reservation };
  }
  if (!ACTIVE_DELIVERY_STATES.has(reservation.status)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_SETTLEABLE" };
  }
  const corporationID = toPositiveInt(
    reservation.corporationID || located.project.procurement.corporationID,
    0,
  );
  const accountKey = toPositiveInt(
    reservation.accountKey,
    CORPORATION_WALLET_KEY_START,
  );
  if (!corporationID || !reservation.escrowOperationID || !reservation.escrowFingerprint) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_ESCROW_INVALID" };
  }
  const wallet = applyCorporationWalletOperation({
    operationID: reservation.escrowOperationID,
    fingerprint: reservation.escrowFingerprint,
    kind: "family_estate_freight_escrow",
    corporationID,
    accountKey,
    delta: -reservation.totalISK,
    nowMs,
    description:
      `Estate freight escrow ${projectKey}: ${reservation.typeName} x${reservation.quantity}`,
    ownerID1: corporationID,
    referenceID: reservation.destinationStructureID,
  });
  if (!wallet.success) {
    const errorMsg = wallet.errorMsg === "INSUFFICIENT_FUNDS"
      ? "FAMILY_ESTATE_DELIVERY_CREDIT_REQUIRED"
      : wallet.errorMsg || "FAMILY_ESTATE_DELIVERY_ESCROW_FAILED";
    const balance = getCorporationWalletBalance(corporationID, accountKey);
    const write = updateState((next) => {
      const target = next.projects[projectKey].procurement.reservations[reservationID];
      if (target) {
        target.lastError = errorMsg;
        if (wallet.uncertain !== true && wallet.errorMsg === "INSUFFICIENT_FUNDS") {
          target.status = "cancelled";
          target.closedAtMs = nowMs;
        }
      }
      const procurement = next.projects[projectKey].procurement;
      procurement.lastError = errorMsg;
      procurement.lastRequiredISK = reservation.totalISK;
      procurement.lastBalanceISK = balance;
      return next;
    }, nowMs, { durable: true });
    if (!write.success) return { ...write, uncertain: true };
    if (wallet.errorMsg === "INSUFFICIENT_FUNDS") notifyLivingEconomyDemandChanged();
    return {
      success: false,
      errorMsg,
      requiredISK: reservation.totalISK,
      balance,
      uncertain: wallet.uncertain === true,
    };
  }
  const write = updateState((next) => {
    const target = next.projects[projectKey].procurement.reservations[reservationID];
    if (!target) return next;
    target.corporationID = corporationID;
    target.accountKey = accountKey;
    target.escrowStatus = "escrowed";
    target.escrowedAtMs = target.escrowedAtMs || nowMs;
    target.lastError = null;
    const procurement = next.projects[projectKey].procurement;
    procurement.lastError = null;
    procurement.lastRequiredISK = 0;
    procurement.lastBalanceISK = 0;
    return next;
  }, nowMs, { durable: true });
  if (!write.success) return { ...write, uncertain: true };
  state = write.data;
  reservation = state.projects[projectKey].procurement.reservations[reservationID];
  return {
    success: true,
    replayed: wallet.replayed === true,
    data: reservation,
  };
}

function reserveFamilyEstateNpcDelivery(details = {}, nowMs = Date.now()) {
  const projectKey = String(details.projectKey || "").trim().toLowerCase();
  const definition = PROJECT_DEFINITIONS[projectKey];
  const reservationID = String(details.reservationID || details.jobID || "").trim();
  const typeID = toPositiveInt(details.typeID, 0);
  const quantity = toPositiveInt(details.quantity, 0);
  if (!definition || !reservationID || !typeID || !quantity) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_INVALID" };
  }
  const context = getContext();
  if (
    context.claimState.status !== "claimed" ||
    !context.structure ||
    context.structure.destroyedAt
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_UNAVAILABLE" };
  }
  const state = readState(nowMs);
  const project = state.projects[projectKey];
  const existing = project.procurement.reservations[reservationID];
  const corporationID = context.claimState.ownerCorporationID;
  const destinationStructureID = context.structure.structureID;
  const fingerprint = buildStableFingerprint([
    "family-estate-delivery-reservation-v2",
    projectKey,
    reservationID,
    typeID,
    quantity,
    details.sourceStationID,
    destinationStructureID,
    details.assignedFlightID,
    corporationID,
    roundIsk(details.goodsISK),
  ]);
  if (existing) {
    const matches = buildStableFingerprint([
      "family-estate-delivery-reservation-v2",
      projectKey,
      existing.reservationID,
      existing.typeID,
      existing.quantity,
      existing.sourceStationID,
      existing.destinationStructureID,
      existing.assignedFlightID,
      existing.corporationID,
      existing.goodsISK,
    ]) === fingerprint;
    if (!matches) {
      return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_CONFLICT" };
    }
    if (!ACTIVE_DELIVERY_STATES.has(existing.status)) {
      return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_CLOSED" };
    }
    const escrow = ensureFamilyEstateDeliveryEscrow(projectKey, reservationID, nowMs);
    return escrow.success ? { ...escrow, replayed: true } : escrow;
  }
  if (project.status !== "available" || project.procurement.status !== "commissioned") {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROCUREMENT_NOT_ACTIVE" };
  }
  const requirement = definition.materials.find((entry) => Number(entry.typeID) === typeID);
  if (!requirement) return { success: false, errorMsg: "FAMILY_ESTATE_MATERIAL_NOT_REQUIRED" };
  const remaining = Math.max(
    0,
    requirement.quantity -
      toPositiveInt(project.contributed[String(typeID)], 0) -
      getProjectReservedQuantity(project, typeID),
  );
  if (remaining < quantity) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_SHORTFALL_CHANGED" };
  }
  const goodsISK = Math.max(0.01, roundIsk(details.goodsISK));
  const freightFeeISK = roundIsk(Math.max(
    ESTATE_MINIMUM_FREIGHT_FEE_ISK,
    goodsISK * ESTATE_FREIGHT_FEE_RATE,
  ));
  const totalISK = roundIsk(goodsISK + freightFeeISK);
  const laborCommittedISK = getOutstandingProjectLaborCommitmentISK(state);
  const pendingEscrowISK = roundIsk(Object.values(state.projects).reduce(
    (sum, record) => sum + Object.values(record.procurement.reservations || {})
      .filter((entry) => (
        ACTIVE_DELIVERY_STATES.has(entry.status) && entry.escrowStatus === "pending"
      ))
      .reduce((inner, entry) => inner + Math.max(0, Number(entry.totalISK) || 0), 0),
    0,
  ));
  const requiredBalanceISK = roundIsk(pendingEscrowISK + laborCommittedISK + totalISK);
  const walletBalanceISK = getCorporationWalletBalance(
    corporationID,
    CORPORATION_WALLET_KEY_START,
  );
  if (walletBalanceISK + 0.0001 < requiredBalanceISK) {
    updateState((next) => {
      const procurement = next.projects[projectKey].procurement;
      procurement.lastError = "FAMILY_ESTATE_DELIVERY_CREDIT_REQUIRED";
      procurement.lastRequiredISK = requiredBalanceISK;
      procurement.lastBalanceISK = walletBalanceISK;
      return next;
    }, nowMs, { durable: true });
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_DELIVERY_CREDIT_REQUIRED",
      requiredISK: requiredBalanceISK,
      balance: walletBalanceISK,
      committedISK: roundIsk(pendingEscrowISK + laborCommittedISK),
    };
  }
  if (
    details.corporationID && Number(details.corporationID) !== Number(corporationID) ||
    details.destinationStructureID &&
      Number(details.destinationStructureID) !== Number(destinationStructureID)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_IDENTITY_MISMATCH" };
  }
  const escrowOperationID = `estate-delivery:${corporationID}:${reservationID}:escrow`;
  const escrowFingerprint = buildStableFingerprint([
    "family-estate-delivery-escrow-v1",
    corporationID,
    destinationStructureID,
    projectKey,
    reservationID,
    typeID,
    quantity,
    totalISK,
  ]);
  const refundOperationID = `estate-delivery:${corporationID}:${reservationID}:refund`;
  const refundFingerprint = buildStableFingerprint([
    "family-estate-delivery-refund-v1",
    corporationID,
    destinationStructureID,
    projectKey,
    reservationID,
    totalISK,
  ]);
  const write = updateState((next) => {
    next.projects[projectKey].procurement.reservations[reservationID] = {
      reservationID,
      jobID: reservationID,
      status: "reserved",
      typeID,
      typeName: requirement.name,
      quantity,
      acceptedQuantity: 0,
      sourceStationID: toPositiveInt(details.sourceStationID, 0) || null,
      destinationStructureID,
      assignedFlightID: String(details.assignedFlightID || "") || null,
      corporationID,
      accountKey: CORPORATION_WALLET_KEY_START,
      goodsISK,
      freightFeeISK,
      totalISK,
      escrowStatus: "pending",
      escrowOperationID,
      escrowFingerprint,
      refundOperationID,
      refundFingerprint,
      walletOperationID: escrowOperationID,
      walletFingerprint: escrowFingerprint,
      reservedAtMs: nowMs,
      lastError: null,
    };
    next.projects[projectKey].procurement.lastError = null;
    next.projects[projectKey].procurement.lastRequiredISK = 0;
    next.projects[projectKey].procurement.lastBalanceISK = 0;
    return next;
  }, nowMs, { durable: true });
  if (!write.success) return write;
  return ensureFamilyEstateDeliveryEscrow(projectKey, reservationID, nowMs);
}

function markFamilyEstateNpcDeliveryArrived(reservationID, nowMs = Date.now()) {
  const id = String(reservationID || "").trim();
  if (!id) return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_INVALID" };
  let found = null;
  const write = updateState((next) => {
    for (const project of Object.values(next.projects)) {
      const reservation = project.procurement.reservations[id];
      if (!reservation) continue;
      found = reservation;
      if (reservation.status === "reserved" && reservation.escrowStatus === "escrowed") {
        reservation.status = "delivery_pending";
        reservation.arrivedAtMs = nowMs;
        reservation.lastError = null;
      }
      break;
    }
    return next;
  }, nowMs, { durable: true });
  if (!found) return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_FOUND" };
  if (!write.success) return write;
  const persisted = findFamilyEstateDeliveryReservation(write.data, id);
  if (!persisted || !["delivery_pending", "delivered"].includes(persisted.reservation.status)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_ESCROW_REQUIRED" };
  }
  return { success: true, data: persisted.reservation };
}

function closeFamilyEstateNpcDelivery(
  reservationID,
  status,
  reason,
  nowMs = Date.now(),
  options = {},
) {
  const id = String(reservationID || "").trim();
  const normalizedStatus = status === "lost" ? "lost" : "cancelled";
  const state = readState(nowMs);
  const located = findFamilyEstateDeliveryReservation(state, id);
  if (!located) return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_FOUND" };
  const { projectKey, project, reservation } = located;
  if (reservation.status === "delivered") {
    return { success: true, replayed: true, data: reservation };
  }
  if (["lost", "cancelled"].includes(reservation.status) && reservation.escrowStatus === "refunded") {
    return { success: true, replayed: true, data: reservation };
  }
  if (reservation.status === "delivery_pending" && options.allowArrived !== true) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_ALREADY_ARRIVED" };
  }
  const corporationID = toPositiveInt(
    reservation.corporationID || project.procurement.corporationID,
    0,
  );
  const accountKey = toPositiveInt(reservation.accountKey, CORPORATION_WALLET_KEY_START);
  const escrowReceipt = corporationID && reservation.escrowOperationID
    ? getCorporationWalletOperation(corporationID, reservation.escrowOperationID)
    : null;
  let refund = { success: true, replayed: true, data: null };
  if (reservation.escrowStatus === "escrowed" || escrowReceipt) {
    refund = applyCorporationWalletOperation({
      operationID: reservation.refundOperationID,
      fingerprint: reservation.refundFingerprint,
      kind: "family_estate_freight_refund",
      corporationID,
      accountKey,
      delta: reservation.totalISK,
      nowMs,
      description:
        `Estate freight refund ${projectKey}: ${reservation.typeName} x${reservation.quantity}`,
      ownerID1: corporationID,
      referenceID: reservation.destinationStructureID,
    });
    if (!refund.success) return { ...refund, uncertain: refund.uncertain === true };
  }
  const write = updateState((next) => {
    const target = next.projects[projectKey].procurement.reservations[id];
    if (!target || target.status === "delivered") return next;
    target.status = normalizedStatus;
    target.escrowStatus = "refunded";
    target.refundedAtMs = nowMs;
    target.closedAtMs = nowMs;
    target.lastError = String(reason || normalizedStatus).slice(0, 240);
    if (options.quarantine === true) {
      target.quarantinedAtMs = nowMs;
      target.quarantineReason = target.lastError;
      if (!(next.ledger || []).some((entry) => entry.id === `npc-delivery-quarantine:${id}`)) {
        appendLedger(next, {
          id: `npc-delivery-quarantine:${id}`,
          atMs: nowMs,
          kind: "npc_freight_quarantined",
          projectKey,
          corporationID,
          typeID: target.typeID,
          quantity: target.quantity,
          note: target.quarantineReason,
        });
      }
    }
    return next;
  }, nowMs, { durable: true });
  if (write.success) {
    notifyLivingEconomyDemandChanged();
    return {
      success: true,
      replayed: refund.replayed === true,
      data: write.data.projects[projectKey].procurement.reservations[id],
    };
  }
  return { ...write, uncertain: Boolean(escrowReceipt || refund.success) };
}

function quarantineFamilyEstateNpcDelivery(
  reservationID,
  reason,
  nowMs = Date.now(),
) {
  return closeFamilyEstateNpcDelivery(
    reservationID,
    "cancelled",
    reason || "estate-delivery-quarantined",
    nowMs,
    { allowArrived: true, quarantine: true },
  );
}

function validateFamilyEstateNpcDeliveryDestination(
  reservationID,
  nowMs = Date.now(),
) {
  const located = findFamilyEstateDeliveryReservation(
    readState(nowMs),
    reservationID,
  );
  if (!located) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_FOUND" };
  }
  const context = getContext();
  if (
    context.claimState.status !== "claimed" ||
    !context.structure ||
    context.structure.destroyedAt
  ) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_DELIVERY_DESTINATION_UNAVAILABLE",
    };
  }
  if (
    Number(located.reservation.corporationID) !==
      Number(context.claimState.ownerCorporationID) ||
    Number(located.reservation.destinationStructureID) !==
      Number(context.structure.structureID)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_IDENTITY_MISMATCH" };
  }
  return {
    success: true,
    data: {
      projectKey: located.projectKey,
      reservation: located.reservation,
      structure: context.structure,
    },
  };
}

function settleFamilyEstateNpcDelivery(reservationID, nowMs = Date.now()) {
  const id = String(reservationID || "").trim();
  if (!id) return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_INVALID" };
  let state = readState(nowMs);
  let projectKey = null;
  let reservation = null;
  for (const [key, project] of Object.entries(state.projects)) {
    if (project.procurement.reservations[id]) {
      projectKey = key;
      reservation = project.procurement.reservations[id];
      break;
    }
  }
  if (!reservation || !projectKey) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_FOUND" };
  }
  if (reservation.status === "delivered") {
    return { success: true, replayed: true, data: { state, projectKey, reservation } };
  }
  if (reservation.status !== "delivery_pending") {
    return { success: false, errorMsg: "FAMILY_ESTATE_DELIVERY_NOT_SETTLEABLE" };
  }
  const destination = validateFamilyEstateNpcDeliveryDestination(id, nowMs);
  if (!destination.success) return destination;
  const context = getContext();
  if (reservation.escrowStatus !== "escrowed") {
    const escrow = ensureFamilyEstateDeliveryEscrow(projectKey, id, nowMs);
    if (!escrow.success) return escrow;
    state = readState(nowMs);
    reservation = state.projects[projectKey].procurement.reservations[id];
  }
  const definition = PROJECT_DEFINITIONS[projectKey];
  const requirement = definition && definition.materials.find(
    (entry) => Number(entry.typeID) === Number(reservation.typeID),
  );
  const currentContribution = toPositiveInt(
    state.projects[projectKey].contributed[String(reservation.typeID)],
    0,
  );
  if (
    !requirement ||
    state.projects[projectKey].status !== "available" ||
    currentContribution + reservation.quantity > requirement.quantity
  ) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_INVARIANT",
    };
  }
  let settlementInvariantFailed = false;
  const write = updateState((next) => {
    const project = next.projects[projectKey];
    const target = project.procurement.reservations[id];
    if (!target || target.status === "delivered") return next;
    const requirement = definition.materials.find(
      (entry) => Number(entry.typeID) === Number(target.typeID),
    );
    const current = toPositiveInt(project.contributed[String(target.typeID)], 0);
    const accepted = Math.min(target.quantity, Math.max(0, requirement.quantity - current));
    if (accepted !== target.quantity) {
      target.lastError = "FAMILY_ESTATE_DELIVERY_RESERVATION_INVARIANT";
      project.procurement.lastError = target.lastError;
      settlementInvariantFailed = true;
      return next;
    }
    project.contributed[String(target.typeID)] = current + accepted;
    target.status = "delivered";
    target.escrowStatus = "paid";
    target.acceptedQuantity = accepted;
    target.settledAtMs = nowMs;
    target.closedAtMs = nowMs;
    target.lastError = null;
    project.procurement.deliveries += 1;
    project.procurement.unitsDelivered += accepted;
    project.procurement.goodsSpentISK = roundIsk(
      project.procurement.goodsSpentISK + target.goodsISK,
    );
    project.procurement.freightSpentISK = roundIsk(
      project.procurement.freightSpentISK + target.freightFeeISK,
    );
    project.procurement.lastError = null;
    project.procurement.lastRequiredISK = 0;
    project.procurement.lastBalanceISK = 0;
    if (projectMaterialsComplete(project, definition)) {
      project.procurement.status = "fulfilled";
    }
    if (!(next.ledger || []).some((entry) => entry.id === `npc-delivery:${id}`)) {
      appendLedger(next, {
        id: `npc-delivery:${id}`,
        atMs: nowMs,
        kind: "npc_freight_delivery",
        projectKey,
        corporationID: context.claimState.ownerCorporationID,
        typeID: target.typeID,
        quantity: accepted,
        expenseISK: target.totalISK,
        netISK: -target.totalISK,
        note:
          `${target.typeName}; goods ${roundIsk(target.goodsISK)} ISK, ` +
          `carrier ${roundIsk(target.freightFeeISK)} ISK`,
      });
    }
    return next;
  }, nowMs, { durable: true });
  if (!write.success) return { ...write, uncertain: true };
  const persistedReservation = write.data.projects[projectKey]
    .procurement.reservations[id];
  if (settlementInvariantFailed || !persistedReservation || persistedReservation.status !== "delivered") {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_DELIVERY_RESERVATION_INVARIANT",
      uncertain: true,
    };
  }
  notifyLivingEconomyDemandChanged();
  state = write.data;
  const project = state.projects[projectKey];
  let autoStartError = null;
  if (
    project.procurement.autoStart === true &&
    projectMaterialsComplete(project, definition)
  ) {
    const start = fundAndStartProject(
      projectKey,
      definition,
      context,
      project.procurement.commissionedByCharacterID,
      nowMs,
      { automatic: true },
    );
    if (start.success) state = start.data.state;
    else autoStartError = start.errorMsg || "FAMILY_ESTATE_PROJECT_START_FAILED";
  }
  return {
    success: true,
    replayed: false,
    data: {
      state,
      projectKey,
      reservation: state.projects[projectKey].procurement.reservations[id],
      autoStartError,
    },
  };
}

function listActiveFamilyEstateNpcDeliveries(nowMs = Date.now()) {
  const state = readState(nowMs);
  const rows = [];
  for (const [projectKey, project] of Object.entries(state.projects)) {
    for (const reservation of Object.values(project.procurement.reservations || {})) {
      if (!ACTIVE_DELIVERY_STATES.has(String(reservation.status || ""))) continue;
      rows.push({ projectKey, ...reservation });
    }
  }
  return rows;
}

function getFamilyEstateNpcDelivery(reservationID, nowMs = Date.now()) {
  const located = findFamilyEstateDeliveryReservation(
    readState(nowMs),
    reservationID,
  );
  return located
    ? { projectKey: located.projectKey, ...located.reservation }
    : null;
}

function reconcileCommissionedProjects(state, nowMs, options = {}) {
  const context = getContext(options);
  if (
    context.claimState.status !== "claimed" ||
    !context.structure ||
    context.structure.destroyedAt
  ) {
    return state;
  }
  for (const [key, definition] of Object.entries(PROJECT_DEFINITIONS)) {
    const project = state.projects[key];
    if (
      project.status !== "available" ||
      project.procurement.autoStart !== true ||
      !["commissioned", "fulfilled"].includes(project.procurement.status) ||
      !projectDependenciesComplete(state, definition) ||
      !projectMaterialsComplete(project, definition)
    ) {
      continue;
    }
    const result = fundAndStartProject(
      key,
      definition,
      context,
      project.procurement.commissionedByCharacterID,
      nowMs,
      { automatic: true },
    );
    if (result.success) state = result.data.state;
  }
  return state;
}

function fitRestoredReprocessingModule(context) {
  const structureID = toPositiveInt(context.structure && context.structure.structureID, 0);
  const existing = listContainerItems(null, structureID, null).find(
    (item) => toPositiveInt(item.typeID, 0) === REPROCESSING_MODULE_TYPE_ID,
  );
  if (existing) return { success: true, unchanged: true, data: existing };
  const occupiedFlags = new Set(
    listContainerItems(null, structureID, null).map((item) => toPositiveInt(item.flagID, 0)),
  );
  const targetFlag = STRUCTURE_SERVICE_SLOT_FLAGS.find((flagID) => !occupiedFlags.has(flagID));
  if (!targetFlag) return { success: false, errorMsg: "FAMILY_ESTATE_SERVICE_SLOT_REQUIRED" };
  return grantItemToOwnerLocation(
    context.claimState.ownerCorporationID,
    structureID,
    targetFlag,
    { typeID: REPROCESSING_MODULE_TYPE_ID, name: "Standup Reprocessing Facility I" },
    1,
    { singleton: true, moduleState: { online: false } },
  );
}

function applyProjectCompletion(key, context, nowMs) {
  if (key === "stabilization") {
    const repairResult = structureState.repairStructure(context.structure.structureID);
    if (!repairResult.success) return repairResult;
    return structureState.updateStructureRecord(
      context.structure.structureID,
      (structure) => ({
        ...structure,
        devFlags: { ...(structure.devFlags || {}), estateState: "stabilized" },
      }),
      { emitLive: true },
    );
  }
  if (key === "reprocessing") {
    const fitResult = fitRestoredReprocessingModule(context);
    if (!fitResult.success) return fitResult;
    const unlockResult = context.estateRuntime.unlockFamilyEstateCapability("reprocessing", {
      system: true,
      actorCharacterID: context.claimState.claimantCharacterID,
      nowMs,
      reason: "Ore-processing restoration project completed.",
    });
    if (!unlockResult.success) return unlockResult;
    return structureState.updateStructureRecord(
      context.structure.structureID,
      (structure) => ({
        ...structure,
        devFlags: { ...(structure.devFlags || {}), estateState: "reprocessing_restored" },
      }),
      { emitLive: true },
    );
  }
  return { success: true };
}

function completeDueProjects(state, nowMs, options = {}) {
  const context = getContext(options);
  if (context.claimState.status !== "claimed" || !context.structure || context.structure.destroyedAt) {
    return state;
  }
  for (const [key, definition] of Object.entries(PROJECT_DEFINITIONS)) {
    const project = state.projects[key];
    const forced = options.forceProjectKey === key;
    if (
      project.status !== "in_progress" ||
      (!forced && toPositiveInt(project.completesAtMs, 0) > nowMs)
    ) {
      continue;
    }
    const result = applyProjectCompletion(key, context, nowMs);
    if (!result.success) {
      log.warn(`[FamilyEstateProjects] Completion failed project=${key}: ${result.errorMsg || "UNKNOWN"}`);
      continue;
    }
    const writeResult = updateState((next) => {
      next.projects[key].status = "completed";
      next.projects[key].completedAtMs = nowMs;
      next.projects[key].completedBy = forced ? "operator" : "scheduler";
      appendLedger(next, {
        id: `project-complete:${key}:${nowMs}`,
        atMs: nowMs,
        kind: "project_completed",
        projectKey: key,
        corporationID: context.claimState.ownerCorporationID,
        note: definition.label,
      });
      return next;
    }, nowMs);
    if (writeResult.success) state = writeResult.data;
  }
  return state;
}

function calculateHourlyCommercialSettlement(context, state) {
  const residents = context.estateRuntime.listFamilyEstateResidents({
    profile: context.profile,
    structure: context.structure,
    claimState: context.claimState,
  }).length;
  const connectionViews = require("../exploration/wormholes/wormholeRuntime")
    .listFamilyEstateConnectionViews({ includeCollapsed: false, includeUndiscovered: true });
  const permanentConnections = connectionViews.filter((entry) => entry.persistent === true).length;
  const randomConnections = connectionViews.filter(
    (entry) => entry.estateConnectionRole === "random",
  ).length;
  const stabilized = state.projects.stabilization.status === "completed";
  const reprocessing = state.projects.reprocessing.status === "completed";
  const baseGross = 25_000 + Math.min(10, residents) * 25_000 +
    permanentConnections * 30_000 + randomConnections * 20_000;
  const conditionFactor = stabilized ? 1 : 0.5;
  const grossISK = roundIsk(baseGross * conditionFactor + (reprocessing ? 250_000 : 0));
  const expenseISK = roundIsk(50_000 + (reprocessing ? 125_000 : 0));
  return {
    grossISK,
    expenseISK,
    netISK: roundIsk(grossISK - expenseISK),
    residents,
    permanentConnections,
    randomConnections,
  };
}

function settleCommercialIncome(state, nowMs, options = {}) {
  // X-Eve replaces this prototype's synthetic hourly wallet credit with
  // explicit buyers, expenses, and balanced settlement accounts.
  if (config.xEveEnabled === true && options.allowSyntheticIncome !== true) {
    return state;
  }
  const context = getContext(options);
  if (context.claimState.status !== "claimed" || !context.structure || context.structure.destroyedAt) {
    return state;
  }
  const lastSettledAtMs = toPositiveInt(state.commercial.lastSettledAtMs, nowMs);
  const dueIntervals = Math.min(
    MAX_CATCHUP_INTERVALS,
    Math.floor(Math.max(0, nowMs - lastSettledAtMs) / SETTLEMENT_INTERVAL_MS),
  );
  if (dueIntervals <= 0) return state;
  const perHour = calculateHourlyCommercialSettlement(context, state);
  const throughMs = lastSettledAtMs + dueIntervals * SETTLEMENT_INTERVAL_MS;
  const settlementID = `estate-settlement:${lastSettledAtMs}:${throughMs}`;
  const description = `Family estate commercial settlement ${settlementID}`;
  const alreadyCredited = getCorporationWalletJournal(
    context.claimState.ownerCorporationID,
    { accountKey: CORPORATION_WALLET_KEY_START },
  ).some((entry) => String(entry && entry.description || "") === description);
  const grossISK = roundIsk(perHour.grossISK * dueIntervals);
  const expenseISK = roundIsk(perHour.expenseISK * dueIntervals);
  const netISK = roundIsk(perHour.netISK * dueIntervals);
  if (!alreadyCredited && Math.abs(netISK) > 0.0001) {
    const walletResult = adjustCorporationWalletDivisionBalance(
      context.claimState.ownerCorporationID,
      CORPORATION_WALLET_KEY_START,
      netISK,
      {
        description,
        ownerID1: context.claimState.ownerCorporationID,
        ownerID2: context.claimState.ownerCorporationID,
        referenceID: context.structure.structureID,
      },
    );
    if (!walletResult.success) {
      log.warn(`[FamilyEstateProjects] Commercial settlement failed: ${walletResult.errorMsg || "UNKNOWN"}`);
      return state;
    }
  }
  const writeResult = updateState((next) => {
    next.commercial.lastSettledAtMs = throughMs;
    next.commercial.totalGrossISK = roundIsk(next.commercial.totalGrossISK + grossISK);
    next.commercial.totalExpenseISK = roundIsk(next.commercial.totalExpenseISK + expenseISK);
    next.commercial.totalNetISK = roundIsk(next.commercial.totalNetISK + netISK);
    next.commercial.settlements += dueIntervals;
    appendLedger(next, {
      id: settlementID,
      atMs: throughMs,
      kind: "commercial_settlement",
      corporationID: context.claimState.ownerCorporationID,
      grossISK,
      expenseISK,
      netISK,
      note: `${dueIntervals}h | residents ${perHour.residents} | conduits ${perHour.permanentConnections + perHour.randomConnections}`,
    });
    return next;
  }, nowMs);
  return writeResult.success ? writeResult.data : state;
}

function reconcileEstateProjects(nowMs = Date.now(), options = {}) {
  let state = ensureState(nowMs);
  state = reconcileCommissionedProjects(state, nowMs, options);
  state = completeDueProjects(state, nowMs, options);
  if (options.settleCommercial !== false) {
    state = settleCommercialIncome(state, nowMs, options);
  }
  return state;
}

function forceCompleteProject(projectKey, options = {}) {
  const key = String(projectKey || "").trim().toLowerCase();
  if (!PROJECT_DEFINITIONS[key]) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_INVALID" };
  }
  const nowMs = options.nowMs || Date.now();
  const before = readState(nowMs);
  if (!before.projects[key] || before.projects[key].status !== "in_progress") {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_NOT_IN_PROGRESS" };
  }
  const after = completeDueProjects(before, nowMs, { ...options, forceProjectKey: key });
  return after.projects[key].status === "completed"
    ? { success: true, data: after }
    : { success: false, errorMsg: "FAMILY_ESTATE_PROJECT_COMPLETION_FAILED" };
}

function getEstateProjectStatus(options = {}) {
  const nowMs = options.nowMs || Date.now();
  const context = getContext(options);
  const state = options.reconcile === false
    ? readState(nowMs)
    : reconcileEstateProjects(nowMs, options);
  return {
    state,
    projects: buildProjectViews(state),
    corporationWalletBalance: context.claimState.ownerCorporationID
      ? getCorporationWalletBalance(
        context.claimState.ownerCorporationID,
        CORPORATION_WALLET_KEY_START,
      )
      : 0,
    nextSettlementAtMs: state.commercial.lastSettledAtMs + SETTLEMENT_INTERVAL_MS,
  };
}

function startFamilyEstateProjectScheduler() {
  if (scheduler) return scheduler;
  scheduler = setInterval(() => {
    try {
      reconcileEstateProjects(Date.now());
    } catch (error) {
      log.warn(`[FamilyEstateProjects] Scheduler failed: ${error.message}`);
    }
  }, SCHEDULER_INTERVAL_MS);
  if (typeof scheduler.unref === "function") scheduler.unref();
  return scheduler;
}

function stopFamilyEstateProjectSchedulerForTests() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
}

module.exports = {
  MAX_CATCHUP_INTERVALS,
  PROJECT_DEFINITIONS,
  SETTLEMENT_INTERVAL_MS,
  buildProjectViews,
  buildFamilyEstateFreightOpportunities,
  calculateHourlyCommercialSettlement,
  closeFamilyEstateNpcDelivery,
  commissionProject,
  contributeToProject,
  forceCompleteProject,
  getEstateProjectStatus,
  getCommissionedMaterialRequirements,
  getFamilyEstateNpcDelivery,
  ensureFamilyEstateDeliveryEscrow,
  listActiveFamilyEstateNpcDeliveries,
  markFamilyEstateNpcDeliveryArrived,
  reconcileEstateProjects,
  quarantineFamilyEstateNpcDelivery,
  reserveFamilyEstateNpcDelivery,
  settleFamilyEstateNpcDelivery,
  settleCommercialIncome,
  startFamilyEstateProjectScheduler,
  startProject,
  stopFamilyEstateProjectSchedulerForTests,
  validateFamilyEstateNpcDeliveryDestination,
};
