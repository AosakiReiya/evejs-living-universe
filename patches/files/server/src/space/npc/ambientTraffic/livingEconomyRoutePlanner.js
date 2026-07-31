"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const worldData = require(path.join(__dirname, "../../worldData"));
const marketTopology = require(path.join(__dirname, "../../../services/market/marketTopology"));
const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));

const MAX_SOURCES_PER_GOOD = 4;
const MAX_DESTINATIONS_PER_GOOD = 4;
const MAX_PRIORITY_SOURCE_POOL = 32;
const MAX_PRIORITY_REGIONAL_SOURCES = 24;
const MAX_PRIORITY_GLOBAL_SOURCES = 8;
const MAX_ROUTE_CACHE_ROWS = 50_000;
const routeSpecCache = new Map();

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function getRouteClass(jumps, riskBand) {
  if (riskBand === "lowsec" || riskBand === "nullsec") return "frontier";
  if (jumps <= 2) return "feeder";
  if (jumps <= 6) return "regional";
  if (jumps <= 12) return "bulk";
  return "trunk";
}

function getAllowedLogisticsClasses(routeClass) {
  if (routeClass === "frontier") return ["secure"];
  if (routeClass === "feeder") return ["feeder", "regional", "bulk", "trunk", "secure"];
  if (routeClass === "regional") return ["regional", "bulk", "trunk", "secure"];
  return ["bulk", "trunk", "secure"];
}

function getRiskBand(systemIDs) {
  const securities = systemIDs.map((systemID) => {
    const system = worldData.getSolarSystemByID(systemID);
    return toFiniteNumber(system && system.security, 0);
  });
  if (securities.some((security) => security <= 0)) return "nullsec";
  return securities.some((security) => security < 0.5) ? "lowsec" : "highsec";
}

function getEstimatedTravelMinutes(jumps) {
  const gateSeconds = Math.max(1, toFiniteNumber(config.livingUniverseVirtualTransitSeconds, 18));
  const systemSeconds = Math.max(1, toFiniteNumber(config.livingUniverseVirtualSystemDwellSeconds, 25));
  const stationSeconds = Math.max(1, toFiniteNumber(config.livingUniverseDockedDwellSeconds, 180));
  return Math.max(1, ((jumps * (gateSeconds + systemSeconds)) + stationSeconds) / 60);
}

function buildProductionInputPlanRanks(replacementRequirements = []) {
  const plans = new Map();
  for (const requirement of Array.isArray(replacementRequirements)
    ? replacementRequirements
    : []) {
    if (String(requirement && requirement.demandKind || "") !== "production_input") {
      continue;
    }
    const stationID = toPositiveInt(requirement && requirement.stationID, 0);
    const outputTypeID = toPositiveInt(requirement && requirement.outputTypeID, 0);
    if (!stationID || !outputTypeID) continue;
    const key = `${stationID}:${outputTypeID}`;
    const current = plans.get(key) || {
      key,
      stationID,
      outputTypeID,
      hull: false,
      demandCreatedAtMs: Number.MAX_SAFE_INTEGER,
    };
    current.hull = current.hull ||
      String(requirement.outputRequirementKind || "") === "hull";
    current.demandCreatedAtMs = Math.min(
      current.demandCreatedAtMs,
      toPositiveInt(
        requirement.demandCreatedAtMs,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    plans.set(key, current);
  }
  return new Map(
    [...plans.values()]
      .sort((left, right) => (
        Number(right.hull) - Number(left.hull) ||
        left.demandCreatedAtMs - right.demandCreatedAtMs ||
        left.outputTypeID - right.outputTypeID ||
        left.stationID - right.stationID
      ))
      .map((plan, rank) => [plan.key, rank]),
  );
}

function getProductionInputPlanPriorityBonus(rank) {
  const numericRank = Number(rank);
  if (!Number.isInteger(numericRank) || numericRank < 0) return 0;
  return Math.max(0, 500_000_000 - (numericRank * 25_000_000));
}

function buildRouteSpec(sourceStation, destinationStation) {
  const cacheKey = `${Number(sourceStation.stationID)}:${Number(destinationStation.stationID)}`;
  if (routeSpecCache.has(cacheKey)) return routeSpecCache.get(cacheKey);
  const systemIDs = marketTopology.getShortestPath(
    sourceStation.systemID,
    destinationStation.systemID,
  );
  if (systemIDs.length < 2) {
    routeSpecCache.set(cacheKey, null);
    return null;
  }
  const riskBand = getRiskBand(systemIDs);
  const routeClass = getRouteClass(systemIDs.length - 1, riskBand);
  const route = Object.freeze({
    routeID: `living_dynamic_${sourceStation.stationID}_${destinationStation.stationID}`,
    systemIDs,
    endpointStationIDs: [sourceStation.stationID, destinationStation.stationID],
    riskBand,
    routeClass,
    lowSecurity: riskBand !== "highsec",
    allowedLogisticsClasses: getAllowedLogisticsClasses(routeClass),
    dynamic: true,
  });
  if (routeSpecCache.size >= MAX_ROUTE_CACHE_ROWS) routeSpecCache.clear();
  routeSpecCache.set(cacheKey, route);
  return route;
}

async function buildRegionalOpportunities(
  stockMap,
  getStockRow,
  procurementOrders = [],
  replacementRequirements = [],
  options = {},
) {
  const stations = catalog.STATIONS;
  const workBudget = options && options.workBudget;
  const checkpoint = workBudget && typeof workBudget.checkpoint === "function"
    ? workBudget.checkpoint
    : null;
  let scannedRows = 0;
  const activeOrdersByKey = new Map();
  for (const order of Array.isArray(procurementOrders) ? procurementOrders : []) {
    if (String(order && order.state || "open") !== "open") continue;
    const remaining = toPositiveInt(order && order.remainingQuantity, 0);
    if (remaining <= 0) continue;
    activeOrdersByKey.set(
      `${Number(order.stationID)}:${Number(order.typeID)}`,
      order,
    );
    scannedRows += 1;
    if (checkpoint && scannedRows % 16 === 0) await checkpoint();
  }
  const replacementByKey = new Map();
  const priorityKindsByKey = new Map();
  const priorityClassesByKey = new Map();
  const priorityUnitsByClassByKey = new Map();
  const priorityItemKindsByKey = new Map();
  const oldestPriorityDemandByKey = new Map();
  const productionInputUnitsByKey = new Map();
  const productionInputPlanRankByKey = buildProductionInputPlanRanks(
    replacementRequirements,
  );
  const priorityProductionPlanRankByKey = new Map();
  const pendingReplacementTypeIDs = new Set();
  for (const requirement of Array.isArray(replacementRequirements) ? replacementRequirements : []) {
    if (
      String(requirement.demandKind || "") !== "production_input" &&
      toPositiveInt(requirement.remainingQuantity, 0) > 0
    ) {
      pendingReplacementTypeIDs.add(Number(requirement.typeID));
    }
    const key = `${Number(requirement.stationID)}:${Number(requirement.typeID)}`;
    const demandClass = String(
      requirement.demandClass ||
      (String(requirement.demandKind || "") === "campaign_supply"
        ? "campaign"
        : "replacement"),
    );
    const requirementUnits = toPositiveInt(requirement.remainingQuantity, 0);
    replacementByKey.set(
      key,
      toPositiveInt(replacementByKey.get(key), 0) + requirementUnits,
    );
    if (!priorityKindsByKey.has(key)) priorityKindsByKey.set(key, new Set());
    priorityKindsByKey.get(key).add(String(requirement.demandKind || "replacement"));
    if (!priorityClassesByKey.has(key)) priorityClassesByKey.set(key, new Set());
    priorityClassesByKey.get(key).add(demandClass);
    if (!priorityUnitsByClassByKey.has(key)) {
      priorityUnitsByClassByKey.set(key, {});
    }
    const classUnits = priorityUnitsByClassByKey.get(key);
    classUnits[demandClass] =
      toPositiveInt(classUnits[demandClass], 0) + requirementUnits;
    const itemKind = String(
      requirement.requirementKind ||
      requirement.outputRequirementKind ||
      "",
    ).trim();
    if (itemKind) {
      if (!priorityItemKindsByKey.has(key)) {
        priorityItemKindsByKey.set(key, new Set());
      }
      priorityItemKindsByKey.get(key).add(itemKind);
    }
    if (String(requirement.demandKind || "") === "production_input") {
      productionInputUnitsByKey.set(
        key,
        toPositiveInt(productionInputUnitsByKey.get(key), 0) +
          requirementUnits,
      );
      const planKey = `${Number(requirement.stationID)}:` +
        `${Number(requirement.outputTypeID)}`;
      const planRank = productionInputPlanRankByKey.get(planKey);
      if (
        Number.isInteger(planRank) &&
        (
          !priorityProductionPlanRankByKey.has(key) ||
          planRank < priorityProductionPlanRankByKey.get(key)
        )
      ) {
        priorityProductionPlanRankByKey.set(key, planRank);
      }
    }
    const demandCreatedAtMs = toPositiveInt(
      requirement.demandCreatedAtMs,
      0,
    );
    if (
      demandCreatedAtMs > 0 &&
      (
        !oldestPriorityDemandByKey.has(key) ||
        demandCreatedAtMs < oldestPriorityDemandByKey.get(key)
      )
    ) {
      oldestPriorityDemandByKey.set(key, demandCreatedAtMs);
    }
    scannedRows += 1;
    if (checkpoint && scannedRows % 16 === 0) await checkpoint();
  }
  const priorityDemandTypeIDs = new Set();
  for (const [key, quantity] of replacementByKey.entries()) {
    const [stationIDText, typeIDText] = String(key).split(":");
    const stationID = toPositiveInt(stationIDText, 0);
    const typeID = toPositiveInt(typeIDText, 0);
    const localQuantity = stationID && typeID
      ? toPositiveInt(getStockRow(stockMap, stationID, typeID).quantity, 0)
      : 0;
    if (typeID && toPositiveInt(quantity, 0) > localQuantity) {
      priorityDemandTypeIDs.add(typeID);
    }
    scannedRows += 1;
    if (checkpoint && scannedRows % 16 === 0) await checkpoint();
  }
  if (checkpoint) await checkpoint(true);

  const opportunities = [];
  for (const good of catalog.TRADE_GOODS) {
    const sources = [];
    const destinations = [];
    for (const station of stations) {
      const row = getStockRow(stockMap, station.stationID, good.typeID);
      const quantity = toPositiveInt(row.quantity, 0);
      const target = catalog.getTargetQuantity(station, good);
      const producerCeiling = catalog.getProducerCeiling(station, good);
      const normalReserve = producerCeiling > 0
        ? Math.round(Math.max(target, good.shipmentQuantity) * 0.7)
        : Math.round(target * (station.archetype === "regional_hub" ? 0.3 : 0.45));
      const localPriorityDemand = toPositiveInt(
        replacementByKey.get(`${station.stationID}:${good.typeID}`),
        0,
      );
      // A one-at-a-time hull line must be able to dispatch its first hull.
      // Keeping even one "emergency reserve" caused quantity=1/reserve=1:
      // industry saw the regional unit and stopped, while freight could never
      // move it. Explicit package demand may use remote stock down to zero, but
      // stock already staged for a demand at this station remains protected.
      const reserve = priorityDemandTypeIDs.has(good.typeID) ? 0 : normalReserve;
      const productionInputDemand = Math.min(
        localPriorityDemand,
        toPositiveInt(
          productionInputUnitsByKey.get(
            `${station.stationID}:${good.typeID}`,
          ),
          0,
        ),
      );
      const directPriorityDemand = Math.max(
        0,
        localPriorityDemand - productionInputDemand,
      );
      const protectedDirectQuantity = Math.min(
        quantity,
        directPriorityDemand,
      );
      const protectedProductionInputQuantity = Math.min(
        Math.max(0, quantity - protectedDirectQuantity),
        productionInputDemand,
      );
      const available = Math.max(
        0,
        quantity -
          reserve -
          protectedDirectQuantity -
          protectedProductionInputQuantity,
      );
      const price = Math.max(0.01, toFiniteNumber(row.price, good.priceAnchor));
      if (available > 0 || protectedProductionInputQuantity > 0) {
        sources.push({
          station,
          available,
          price,
          quantity,
          target,
          protectedProductionInputQuantity,
          priorityProductionPlanRank:
            priorityProductionPlanRankByKey.has(
              `${station.stationID}:${good.typeID}`,
            )
              ? priorityProductionPlanRankByKey.get(
                  `${station.stationID}:${good.typeID}`,
                )
              : -1,
        });
      }

      const order = activeOrdersByKey.get(`${station.stationID}:${good.typeID}`) || null;
      const reorderPoint = Math.max(1, Math.round(target * 0.72));
      const neededForStock = target > 0 && quantity < reorderPoint
        ? Math.max(0, target - quantity)
        : 0;
      const replacementNeeded = Math.max(
        0,
        toPositiveInt(
          replacementByKey.get(`${station.stationID}:${good.typeID}`),
          0,
        ) - quantity,
      );
      // While a pirate faction hull still has unmet replacement demand
      // anywhere, general hub restock must not siphon shipyard stock: only
      // replacement destinations may pull the type until the demand clears.
      const generalRestockSuppressed =
        replacementNeeded <= 0 &&
        pendingReplacementTypeIDs.has(Number(good.typeID)) &&
        catalog.isPirateFactionHull(good.typeID);
      const needed = generalRestockSuppressed
        ? 0
        : Math.max(
            neededForStock,
            toPositiveInt(order && order.remainingQuantity, 0),
            replacementNeeded,
          );
      if (needed > 0) {
        const grossPriorityUnitsByClass = {
          ...(priorityUnitsByClassByKey.get(
            `${station.stationID}:${good.typeID}`,
          ) || {}),
        };
        const priorityDemandUnitsByClass = {};
        let localUnitsRemaining = quantity;
        const classNames = Object.keys(grossPriorityUnitsByClass).sort(
          (left, right) =>
            Number(right === "replacement") -
              Number(left === "replacement") ||
            left.localeCompare(right),
        );
        for (const className of classNames) {
          const grossUnits = toPositiveInt(
            grossPriorityUnitsByClass[className],
            0,
          );
          const locallyCovered = Math.min(grossUnits, localUnitsRemaining);
          localUnitsRemaining -= locallyCovered;
          priorityDemandUnitsByClass[className] =
            grossUnits - locallyCovered;
        }
        destinations.push({
          station,
          needed,
          price: Math.max(price, toFiniteNumber(order && order.price, 0)),
          quantity,
          target,
          procurementOrder: order,
          replacementNeeded,
          priorityDemandKinds: [...(priorityKindsByKey.get(
            `${station.stationID}:${good.typeID}`,
          ) || [])].sort(),
          priorityDemandClasses: [...(priorityClassesByKey.get(
            `${station.stationID}:${good.typeID}`,
          ) || [])].sort(),
          priorityDemandUnitsByClass,
          priorityItemKinds: [...(priorityItemKindsByKey.get(
            `${station.stationID}:${good.typeID}`,
          ) || [])].sort(),
          oldestPriorityDemandAtMs:
            oldestPriorityDemandByKey.get(
              `${station.stationID}:${good.typeID}`,
            ) || 0,
          priorityProductionPlanRank:
            priorityProductionPlanRankByKey.has(
              `${station.stationID}:${good.typeID}`,
            )
              ? priorityProductionPlanRankByKey.get(
                  `${station.stationID}:${good.typeID}`,
                )
              : -1,
        });
      }
      scannedRows += 1;
      if (checkpoint && scannedRows % 16 === 0) await checkpoint();
    }

    if (checkpoint) await checkpoint(true);
    sources.sort((left, right) => left.price - right.price || right.available - left.available);
    destinations.sort((left, right) => (
      Number(right.replacementNeeded > 0) - Number(left.replacementNeeded > 0) ||
      getProductionInputPlanPriorityBonus(right.priorityProductionPlanRank) -
        getProductionInputPlanPriorityBonus(left.priorityProductionPlanRank) ||
      right.replacementNeeded - left.replacementNeeded ||
      right.price - left.price ||
      right.needed - left.needed
    ));
    for (const destination of destinations.slice(0, MAX_DESTINATIONS_PER_GOOD)) {
      const destinationPlanRank = Number(
        destination.priorityProductionPlanRank,
      );
      const rankedSources = sources
        .map((source) => {
          const sourcePlanRank = Number(source.priorityProductionPlanRank);
          const borrowedPriorityInputUnits =
            Number.isInteger(destinationPlanRank) &&
            destinationPlanRank >= 0 &&
            Number.isInteger(sourcePlanRank) &&
            sourcePlanRank > destinationPlanRank
              ? toPositiveInt(source.protectedProductionInputQuantity, 0)
              : 0;
          const available =
            toPositiveInt(source.available, 0) +
            borrowedPriorityInputUnits;
          return available > 0
            ? {
                ...source,
                available,
                borrowedPriorityInputUnits,
              }
            : null;
        })
        .filter(Boolean)
        .sort((left, right) => (
          left.price - right.price ||
          right.available - left.available
        ));
      const cheapestSources = rankedSources.slice(
        0,
        MAX_SOURCES_PER_GOOD,
      );
      const routedSources = [];
      let sourcePool = cheapestSources;
      if (destination.replacementNeeded > 0) {
        const boundedSources = new Map();
        const addSource = (source) => {
          if (
            source &&
            boundedSources.size < MAX_PRIORITY_SOURCE_POOL
          ) {
            boundedSources.set(source.station.stationID, source);
          }
        };
        for (const source of rankedSources) {
          if (
            Number(source.station.systemID) ===
            Number(destination.station.systemID)
          ) {
            addSource(source);
          }
        }
        for (
          const source of rankedSources
            .filter(
              (entry) =>
                Number(entry.station.regionID) ===
                Number(destination.station.regionID),
            )
            .slice(0, MAX_PRIORITY_REGIONAL_SOURCES)
        ) {
          addSource(source);
        }
        for (
          const source of rankedSources.slice(
            0,
            MAX_PRIORITY_GLOBAL_SOURCES,
          )
        ) {
          addSource(source);
        }
        sourcePool = [...boundedSources.values()];
      }
      for (const source of sourcePool) {
        if (checkpoint) await checkpoint();
        if (source.station.stationID === destination.station.stationID) continue;
        const routeSpec = buildRouteSpec(source.station, destination.station);
        if (!routeSpec) continue;
        const jumps = routeSpec.systemIDs.length - 1;
        routedSources.push({ source, routeSpec, jumps });
      }
      routedSources.sort((left, right) => (
        destination.replacementNeeded > 0
          ? left.jumps - right.jumps ||
            left.source.price - right.source.price ||
            right.source.available - left.source.available
          : left.source.price - right.source.price ||
            right.source.available - left.source.available ||
            left.jumps - right.jumps
      ));
      for (
        const { source, routeSpec, jumps } of
        routedSources.slice(0, MAX_SOURCES_PER_GOOD)
      ) {
        const grossUnitMargin = destination.price - source.price;
        const shortageRatio = destination.needed / Math.max(1, destination.target || destination.needed);
        if (
          destination.replacementNeeded <= 0 &&
          grossUnitMargin <= 0 &&
          shortageRatio < 0.35
        ) continue;
        const indicativeQuantity = Math.max(
          1,
          Math.min(good.shipmentQuantity, source.available, destination.needed),
        );
        const estimatedGrossMargin = grossUnitMargin * indicativeQuantity;
        const travelMinutes = getEstimatedTravelMinutes(jumps);
        opportunities.push({
          good,
          sourceStation: source.station,
          destinationStation: destination.station,
          sourceAvailable: source.available,
          borrowedPriorityInputUnits:
            source.borrowedPriorityInputUnits,
          destinationNeeded: destination.needed,
          sourceUnitPrice: source.price,
          destinationUnitPrice: destination.price,
          procurementOrder: destination.procurementOrder,
          priorityDemandUnits: destination.replacementNeeded,
          priorityDemandKinds: destination.priorityDemandKinds,
          priorityDemandClasses: destination.priorityDemandClasses,
          priorityDemandUnitsByClass:
            destination.priorityDemandUnitsByClass,
          priorityItemKinds: destination.priorityItemKinds,
          oldestPriorityDemandAtMs:
            destination.oldestPriorityDemandAtMs,
          priorityProductionPlanRank:
            destination.priorityProductionPlanRank,
          routeSpec,
          jumps,
          travelMinutes,
          score:
            (estimatedGrossMargin / travelMinutes) +
            (destination.replacementNeeded > 0 ? 1_000_000_000 : 0) +
            (destination.replacementNeeded > 0 ? -(jumps * 1_000_000) : 0) +
            getProductionInputPlanPriorityBonus(
              destination.priorityProductionPlanRank,
            ) +
            (
              toPositiveInt(
                destination.priorityDemandUnitsByClass.replacement,
                0,
              ) > 0 &&
              destination.priorityItemKinds.includes("hull")
                ? 50_000_000
                : 0
            ) +
            (
              destination.oldestPriorityDemandAtMs > 0
                ? Math.min(
                    25_000_000,
                    Math.max(
                      0,
                      (Date.now() - destination.oldestPriorityDemandAtMs) /
                        60_000,
                    ) * 10_000,
                  )
                : 0
            ) +
            (shortageRatio * 10_000) -
            (routeSpec.riskBand === "nullsec" ? 4_000 : routeSpec.riskBand === "lowsec" ? 2_500 : 0),
        });
        if (checkpoint) await checkpoint();
      }
    }
    if (checkpoint) await checkpoint(true);
  }
  if (checkpoint) await checkpoint();
  opportunities.sort((left, right) => right.score - left.score);
  if (checkpoint) await checkpoint();
  return opportunities;
}

function normalizeLogisticsProfile(logisticsProfile) {
  return {
    logisticsClass: String(logisticsProfile && logisticsProfile.logisticsClass || "feeder"),
    lowSecurityAccess: Boolean(logisticsProfile && logisticsProfile.lowSecurityAccess),
    capacityM3: Math.max(
      1,
      toFiniteNumber(logisticsProfile && logisticsProfile.capacityM3, 1),
    ),
    maximumCargoValueISK: Math.max(
      1,
      toFiniteNumber(logisticsProfile && logisticsProfile.maximumCargoValueISK, 1),
    ),
    shipmentMultiplier: Math.max(
      0.1,
      toFiniteNumber(logisticsProfile && logisticsProfile.shipmentMultiplier, 1),
    ),
  };
}

function routeSupportsProfile(routeSpec, logisticsProfile) {
  if (!routeSpec) return false;
  const allowedLogisticsClasses = Array.isArray(
    routeSpec.allowedLogisticsClasses,
  )
    ? routeSpec.allowedLogisticsClasses
    : [];
  return (
    allowedLogisticsClasses.includes(logisticsProfile.logisticsClass) &&
    (routeSpec.riskBand === "highsec" || logisticsProfile.lowSecurityAccess)
  );
}

function buildCandidateForProfile(opportunity, logisticsProfile) {
  if (
    !opportunity ||
    !opportunity.good ||
    !routeSupportsProfile(opportunity.routeSpec, logisticsProfile)
  ) {
    return null;
  }
  const good = opportunity.good;
  const maximumByVolume = Math.floor(
    (logisticsProfile.capacityM3 * 0.9) / Math.max(0.000001, good.volume),
  );
  let maximumByValue = Math.floor(
    logisticsProfile.maximumCargoValueISK /
      Math.max(0.01, opportunity.sourceUnitPrice),
  );
  if (
    maximumByValue < 1 &&
    good.category === catalog.CATEGORY.SHIP &&
    toPositiveInt(opportunity.priorityDemandUnits, 0) > 0
  ) {
    // A replacement-priority hull whose unit value exceeds the profile's
    // cargo-value cap may still travel one at a time; otherwise 900M-ISK
    // faction hulls can never leave their shipyard on ordinary haulers.
    maximumByValue = 1;
  }
  const requested = Math.max(
    1,
    Math.floor(good.shipmentQuantity * logisticsProfile.shipmentMultiplier),
  );
  const quantity = Math.max(0, Math.min(
    requested,
    opportunity.sourceAvailable,
    opportunity.destinationNeeded,
    maximumByVolume,
    maximumByValue,
  ));
  if (quantity <= 0) return null;
  return {
    ...opportunity,
    quantity,
    cargoVolume: quantity * good.volume,
    capacityUtilization:
      (quantity * good.volume) / logisticsProfile.capacityM3,
    logisticsProfile,
    routeClass: opportunity.routeSpec.routeClass,
    riskBand: opportunity.routeSpec.riskBand,
    sourceHubTier: String(opportunity.sourceStation.hubTier || "local"),
    destinationHubTier: String(
      opportunity.destinationStation.hubTier || "local",
    ),
  };
}

// Keep the concrete flight in the public selector signatures even though
// eligibility is currently determined by its normalized logistics profile.
function chooseForFlight(flight, sourceStationID, opportunities, logisticsProfile) {
  const normalizedProfile = normalizeLogisticsProfile(logisticsProfile);
  for (const opportunity of Array.isArray(opportunities) ? opportunities : []) {
    if (Number(opportunity.sourceStation.stationID) !== Number(sourceStationID)) continue;
    const candidate = buildCandidateForProfile(opportunity, normalizedProfile);
    if (candidate) return candidate;
  }
  return null;
}

function chooseRepositionForFlight(
  flight,
  currentStationID,
  opportunities,
  logisticsProfile,
  options = {},
) {
  const currentStation = catalog.getStation(currentStationID);
  if (!currentStation) return null;
  const normalizedProfile = normalizeLogisticsProfile(logisticsProfile);
  const sourceCounts = options.sourceCounts instanceof Map
    ? options.sourceCounts
    : new Map();
  const maximumAtSource = Math.max(
    1,
    toPositiveInt(options.maximumAtSource, 1),
  );
  const maximumJumps = Math.max(1, toPositiveInt(options.maximumJumps, 12));
  const maximumOpportunities = Math.max(
    1,
    toPositiveInt(options.maximumOpportunities, 64),
  );

  for (
    const opportunity of (Array.isArray(opportunities) ? opportunities : [])
      .slice(0, maximumOpportunities)
  ) {
    if (opportunity && opportunity.estateDelivery) continue;
    const targetStationID = toPositiveInt(
      opportunity && opportunity.sourceStation &&
        opportunity.sourceStation.stationID,
      0,
    );
    if (!targetStationID || targetStationID === Number(currentStationID)) continue;
    if (toPositiveInt(sourceCounts.get(targetStationID), 0) >= maximumAtSource) {
      continue;
    }
    const candidate = buildCandidateForProfile(opportunity, normalizedProfile);
    if (!candidate) continue;
    const repositionRouteSpec = buildRouteSpec(
      currentStation,
      opportunity.sourceStation,
    );
    if (!routeSupportsProfile(repositionRouteSpec, normalizedProfile)) continue;
    const repositionJumps = repositionRouteSpec.systemIDs.length - 1;
    if (repositionJumps > maximumJumps) continue;
    return {
      ...candidate,
      repositionRouteSpec,
      repositionJumps,
      repositionTravelMinutes: getEstimatedTravelMinutes(repositionJumps),
    };
  }
  return null;
}

module.exports = {
  buildRouteSpec,
  buildRegionalOpportunities,
  chooseForFlight,
  chooseRepositionForFlight,
  getEstimatedTravelMinutes,
  routeSupportsProfile,
  _testing: {
    buildCandidateForProfile,
    buildProductionInputPlanRanks,
    getProductionInputPlanPriorityBonus,
    normalizeLogisticsProfile,
    routeSpecCache,
    routeSupportsProfile,
  },
};
