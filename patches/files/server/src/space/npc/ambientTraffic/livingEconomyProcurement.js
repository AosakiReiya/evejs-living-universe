"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const worldData = require(path.join(__dirname, "../../worldData"));
const { marketDaemonClient } = require(path.join(
  __dirname,
  "../../../services/market/marketDaemonClient",
));
const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));

const ORDER_SOURCE = "living_economy";
const ORDER_DURATION_DAYS = 3_650;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round(toFiniteNumber(value, 0) * 100) / 100;
}

function orderKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function ensureProcurementState(economyState) {
  if (!economyState.procurement || typeof economyState.procurement !== "object") {
    economyState.procurement = {};
  }
  if (!economyState.procurement.corporations || typeof economyState.procurement.corporations !== "object") {
    economyState.procurement.corporations = {};
  }
  if (!economyState.procurement.orders || typeof economyState.procurement.orders !== "object") {
    economyState.procurement.orders = {};
  }
  economyState.procurement.lastReviewAtMs = Math.max(
    0,
    toFiniteNumber(economyState.procurement.lastReviewAtMs, 0),
  );
  if (
    !economyState.procurement.lastReviewAtMsByRegion ||
    typeof economyState.procurement.lastReviewAtMsByRegion !== "object"
  ) {
    economyState.procurement.lastReviewAtMsByRegion = {};
  }
  return economyState.procurement;
}

function getStationCorporationID(station) {
  const authored = toPositiveInt(station && station.corporationID, 0);
  if (authored > 0) return authored;
  const row = worldData.getStationByID(station && station.stationID);
  return toPositiveInt(row && (row.corporationID || row.ownerID), 0);
}

function getStartingCapital(station) {
  if (String(station && station.hubTier || "") === "regional") return 20_000_000_000;
  if (["satellite", "border", "resource"].includes(String(station && station.hubTier || ""))) {
    return 5_000_000_000;
  }
  return 2_000_000_000;
}

function ensureCorporation(economyState, station, nowMs) {
  const procurement = ensureProcurementState(economyState);
  const corporationID = getStationCorporationID(station);
  if (!corporationID) return null;
  const key = String(corporationID);
  if (!procurement.corporations[key]) {
    const startingCapitalISK = getStartingCapital(station);
    procurement.corporations[key] = {
      corporationID,
      corporationName: `NPC industrial corporation ${corporationID}`,
      startingCapitalISK,
      cashISK: startingCapitalISK,
      escrowISK: 0,
      spentISK: 0,
      unitsBought: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }
  return procurement.corporations[key];
}

function listOpenOrders(economyState) {
  const procurement = ensureProcurementState(economyState);
  return Object.values(procurement.orders).filter((order) => (
    String(order && order.state || "") === "open" &&
    toPositiveInt(order && order.remainingQuantity, 0) > 0
  ));
}

function getReviewIntervalMs() {
  return Math.max(
    60_000,
    toFiniteNumber(config.livingEconomyProcurementReviewSeconds, 600) * 1_000,
  );
}

function getMaxOrders() {
  return Math.max(1, Math.min(250, toPositiveInt(config.livingEconomyMaxProcurementOrders, 48)));
}

function getMaxChanges() {
  return Math.max(
    1,
    Math.min(50, toPositiveInt(config.livingEconomyMaxProcurementChangesPerReview, 8)),
  );
}

function marketCall(method, params, workBudget) {
  const call = () => marketDaemonClient.call(method, params);
  return workBudget && typeof workBudget.waitFor === "function"
    ? workBudget.waitFor(`market.${method}`, call)
    : call();
}

async function reconcileOrder(economyState, order, nowMs, workBudget = null) {
  let remote = null;
  try {
    remote = await marketCall("GetOrder", { order_id: String(order.orderID) }, workBudget);
  } catch (_error) {
    remote = null;
  }
  const corporation = ensureProcurementState(economyState)
    .corporations[String(order.corporationID)] || null;
  if (!remote) {
    if (corporation && order.escrowISK > 0) {
      corporation.cashISK = roundMoney(corporation.cashISK + order.escrowISK);
      corporation.escrowISK = roundMoney(Math.max(0, corporation.escrowISK - order.escrowISK));
    }
    order.escrowISK = 0;
    order.state = "missing";
    order.updatedAtMs = nowMs;
    return;
  }

  const row = remote.row || {};
  const remoteRemaining = toPositiveInt(row.vol_remaining, 0);
  const recordedRemaining = toPositiveInt(order.remainingQuantity, 0);
  const unaccountedFilled = Math.max(0, recordedRemaining - remoteRemaining);
  if (unaccountedFilled > 0) {
    const spent = roundMoney(Math.min(
      toFiniteNumber(order.escrowISK, 0),
      unaccountedFilled * toFiniteNumber(order.price, 0),
    ));
    order.escrowISK = roundMoney(Math.max(0, toFiniteNumber(order.escrowISK, 0) - spent));
    if (corporation) {
      corporation.escrowISK = roundMoney(Math.max(0, corporation.escrowISK - spent));
      corporation.spentISK = roundMoney(corporation.spentISK + spent);
      corporation.unitsBought += unaccountedFilled;
    }
    economyState.metrics.procurementUnitsBought += unaccountedFilled;
    economyState.metrics.procurementIskSpent = roundMoney(
      economyState.metrics.procurementIskSpent + spent,
    );
  }
  order.remainingQuantity = remoteRemaining;
  order.state = String(remote.state || (remoteRemaining > 0 ? "open" : "filled"));
  order.updatedAtMs = nowMs;
  if (order.state !== "open" && order.escrowISK > 0) {
    const refund = roundMoney(order.escrowISK);
    order.escrowISK = 0;
    if (corporation) {
      corporation.escrowISK = roundMoney(Math.max(0, corporation.escrowISK - refund));
      corporation.cashISK = roundMoney(corporation.cashISK + refund);
    }
  }
}

function buildCandidates(stockMap, getStockRow, options = {}) {
  const candidates = [];
  const stations = Array.isArray(options.stations) && options.stations.length > 0
    ? options.stations
    : catalog.STATIONS;
  const priorityByKey = new Map();
  const priorityOldestByKey = new Map();
  for (const requirement of Array.isArray(options.priorityRequirements)
    ? options.priorityRequirements
    : []) {
    const stationID = toPositiveInt(requirement && requirement.stationID, 0);
    const typeID = toPositiveInt(requirement && requirement.typeID, 0);
    const quantity = toPositiveInt(requirement && requirement.remainingQuantity, 0);
    const good = catalog.getGood(typeID);
    if (!stationID || !quantity || !catalog.isProcurementGood(good)) continue;
    const key = orderKey(stationID, typeID);
    priorityByKey.set(key, toPositiveInt(priorityByKey.get(key), 0) + quantity);
    const createdAtMs = toPositiveInt(requirement.demandCreatedAtMs, 0);
    if (
      createdAtMs > 0 &&
      (
        !priorityOldestByKey.has(key) ||
        createdAtMs < priorityOldestByKey.get(key)
      )
    ) {
      priorityOldestByKey.set(key, createdAtMs);
    }
  }
  for (const station of stations) {
    const corporationID = getStationCorporationID(station);
    if (!corporationID) continue;
    for (const good of catalog.PROCUREMENT_INPUT_GOODS) {
      const target = catalog.getTargetQuantity(station, good);
      const priorityDemandUnits = toPositiveInt(
        priorityByKey.get(orderKey(station.stationID, good.typeID)),
        0,
      );
      if (target <= 0 && priorityDemandUnits <= 0) continue;
      const row = getStockRow(stockMap, station.stationID, good.typeID);
      const current = toPositiveInt(row && row.quantity, 0);
      const normalShortage = Math.max(0, target - current);
      const priorityShortage = Math.max(0, priorityDemandUnits - current);
      const shortage = Math.max(normalShortage, priorityShortage);
      const shortageRatio = shortage / Math.max(1, target, priorityDemandUnits);
      if (
        shortage <= 0 ||
        (priorityShortage <= 0 && shortageRatio < 0.15)
      ) continue;
      candidates.push({
        station,
        corporationID,
        good,
        current,
        target,
        shortage,
        shortageRatio,
        priorityDemandUnits,
        priorityShortage,
        priorityOldestAtMs: toPositiveInt(
          priorityOldestByKey.get(orderKey(station.stationID, good.typeID)),
          0,
        ),
        score:
          (priorityShortage > 0 ? 1_000_000_000 : 0) +
          (shortageRatio * 100) +
          (String(station.hubTier || "") === "regional" ? 20 : 0) +
          (String(station.archetype || "").includes("assembly") ? 10 : 0),
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const byStationID = new Map();
  for (const candidate of candidates) {
    const key = String(candidate.station.stationID);
    if (!byStationID.has(key)) byStationID.set(key, []);
    byStationID.get(key).push(candidate);
  }
  const stationQueues = [...byStationID.values()].sort((left, right) => (
    toFiniteNumber(right[0] && right[0].score, 0) -
    toFiniteNumber(left[0] && left[0].score, 0)
  ));
  const interleaved = [];
  let remaining = candidates.length;
  while (remaining > 0) {
    for (const queue of stationQueues) {
      if (queue.length <= 0) continue;
      interleaved.push(queue.shift());
      remaining -= 1;
    }
  }
  return interleaved;
}

function getWarPremiumMaxMultiplier() {
  return Math.max(
    1,
    Math.min(
      3,
      toFiniteNumber(
        config.livingEconomyProcurementWarPremiumMaxPercent,
        150,
      ) / 100,
    ),
  );
}

function getBestAskPrice(book) {
  const sells = (Array.isArray(book && book.sells) ? book.sells : [])
    .map((row) => toFiniteNumber(row && row.price, 0))
    .filter((price) => price > 0);
  return sells.length > 0 ? Math.min(...sells) : 0;
}

function applyWarPremium(competitivePrice, candidate, book, nowMs) {
  // Replacement-priority input shortages bid loudly: the longer the demand
  // has waited, the closer the bid climbs toward the capped premium over the
  // anchor price. This is deliberately player-visible — supplying the war
  // effort should pay. The bid never undercuts the competitive book price,
  // and never crosses the best ask: paying more than the good can be bought
  // for locally would be a riskless same-station arbitrage faucet.
  const maxMultiplier = getWarPremiumMaxMultiplier();
  if (
    maxMultiplier <= 1 ||
    toPositiveInt(candidate && candidate.priorityShortage, 0) <= 0
  ) {
    return competitivePrice;
  }
  const anchor = toFiniteNumber(
    candidate.good && candidate.good.priceAnchor,
    0,
  );
  if (anchor <= 0) return competitivePrice;
  const oldestAtMs = toPositiveInt(candidate.priorityOldestAtMs, 0);
  const ageHours = oldestAtMs > 0
    ? Math.max(0, (nowMs - oldestAtMs) / 3_600_000)
    : 0;
  // Linear ramp: reaches the full premium after 48 wall-clock hours of
  // unmet demand.
  const rampRatio = Math.min(1, ageHours / 48);
  const premium = 1 + ((maxMultiplier - 1) * rampRatio);
  let premiumPrice = Math.round(anchor * premium * 100) / 100;
  const bestAsk = getBestAskPrice(book);
  if (bestAsk > 0) {
    premiumPrice = Math.min(
      premiumPrice,
      Math.round(bestAsk * 0.98 * 100) / 100,
    );
  }
  return Math.max(competitivePrice, premiumPrice);
}

function computeCompetitivePrice(book, good) {
  const buys = (Array.isArray(book && book.buys) ? book.buys : [])
    .filter((row) => String(row && row.source || "").toLowerCase() !== ORDER_SOURCE)
    .map((row) => toFiniteNumber(row && row.price, 0))
    .filter((price) => price > 0);
  const sells = (Array.isArray(book && book.sells) ? book.sells : [])
    .map((row) => toFiniteNumber(row && row.price, 0))
    .filter((price) => price > 0);
  const bestBuy = buys.length > 0 ? Math.max(...buys) : 0;
  const bestAsk = sells.length > 0 ? Math.min(...sells) : 0;
  let desired = bestBuy > 0
    ? bestBuy * 1.0025
    : bestAsk > 0
      ? bestAsk * 0.82
      : toFiniteNumber(good && good.priceAnchor, 1);
  if (bestAsk > 0) {
    desired = Math.min(desired, bestAsk * 0.98);
  }
  return Math.max(0.01, Math.round(desired * 100) / 100);
}

async function cancelOrder(economyState, order, nowMs, workBudget = null) {
  await marketCall("CancelOrder", { order_id: String(order.orderID) }, workBudget);
  const corporation = ensureProcurementState(economyState)
    .corporations[String(order.corporationID)] || null;
  const refund = roundMoney(order.escrowISK);
  if (corporation && refund > 0) {
    corporation.escrowISK = roundMoney(Math.max(0, corporation.escrowISK - refund));
    corporation.cashISK = roundMoney(corporation.cashISK + refund);
    corporation.updatedAtMs = nowMs;
  }
  order.escrowISK = 0;
  order.state = "cancelled";
  order.updatedAtMs = nowMs;
  economyState.metrics.procurementOrdersCancelled += 1;
}

function applyWarSubsidy(economyState, corporation, requiredISK, nowMs) {
  // Replacement-priority procurement must never die for lack of simulated
  // corporate cash: the faction treasury covers the difference. The subsidy
  // is tracked, not reconciled — NPC corporation wallets are local fiction
  // (accepted design decision, 2026-07-26).
  const shortfall = roundMoney(
    Math.max(0, requiredISK - toFiniteNumber(corporation.cashISK, 0)),
  );
  if (shortfall <= 0) return 0;
  corporation.cashISK = roundMoney(corporation.cashISK + shortfall);
  corporation.warSubsidyISK = roundMoney(
    toFiniteNumber(corporation.warSubsidyISK, 0) + shortfall,
  );
  corporation.updatedAtMs = nowMs;
  economyState.metrics.procurementWarSubsidyISK = roundMoney(
    toFiniteNumber(economyState.metrics.procurementWarSubsidyISK, 0) +
      shortfall,
  );
  return shortfall;
}

async function placeOrder(economyState, candidate, price, nowMs, workBudget = null) {
  const corporation = ensureCorporation(economyState, candidate.station, nowMs);
  if (!corporation) return null;
  const warOrder = toPositiveInt(candidate.priorityShortage, 0) > 0;
  const maxOrderValue = (String(candidate.station.hubTier || "") === "regional"
    ? 100_000_000
    : 25_000_000) * (warOrder ? 4 : 1);
  // War orders are sized at the priority shortage only: premium pricing must
  // not spill onto routine restock volume, which the ordinary path buys at
  // competitive prices on later reviews.
  const targetQuantity = warOrder
    ? toPositiveInt(candidate.priorityShortage, 0)
    : candidate.shortage;
  if (warOrder) {
    const desiredQuantity = Math.max(
      1,
      Math.min(
        targetQuantity,
        Math.floor(maxOrderValue / Math.max(0.01, price)),
      ),
    );
    applyWarSubsidy(
      economyState,
      corporation,
      roundMoney(price * desiredQuantity),
      nowMs,
    );
  }
  const maximumByBudget = Math.floor(
    Math.min(
      maxOrderValue,
      corporation.cashISK * (warOrder ? 1 : 0.2),
    ) / Math.max(0.01, price),
  );
  const quantity = Math.max(0, Math.min(targetQuantity, maximumByBudget));
  if (quantity <= 0) return null;
  const escrowISK = roundMoney(price * quantity);
  if (escrowISK > corporation.cashISK) return null;
  const placed = await marketCall("PlaceOrder", {
    owner_id: corporation.corporationID,
    is_corp: true,
    wallet_division: 1000,
    station_id: candidate.station.stationID,
    type_id: candidate.good.typeID,
    price,
    quantity,
    min_volume: 1,
    duration_days: ORDER_DURATION_DAYS,
    range_value: -1,
    bid: true,
    source: ORDER_SOURCE,
  }, workBudget);
  const orderID = String(placed.order_id);
  corporation.cashISK = roundMoney(corporation.cashISK - escrowISK);
  corporation.escrowISK = roundMoney(corporation.escrowISK + escrowISK);
  corporation.updatedAtMs = nowMs;
  const order = {
    orderID,
    corporationID: corporation.corporationID,
    stationID: candidate.station.stationID,
    systemID: candidate.station.systemID,
    typeID: candidate.good.typeID,
    typeName: candidate.good.name,
    price,
    enteredQuantity: quantity,
    remainingQuantity: quantity,
    escrowISK,
    state: "open",
    source: ORDER_SOURCE,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  ensureProcurementState(economyState).orders[orderID] = order;
  economyState.metrics.procurementOrdersPlaced += 1;
  return order;
}

async function repriceOrder(
  economyState,
  order,
  desiredPrice,
  nowMs,
  workBudget = null,
  options = {},
) {
  const oldPrice = toFiniteNumber(order.price, 0);
  const remaining = toPositiveInt(order.remainingQuantity, 0);
  if (oldPrice <= 0 || remaining <= 0) return false;
  const changeRatio = Math.abs(desiredPrice - oldPrice) / oldPrice;
  if (changeRatio < 0.025) return false;
  const corporation = ensureProcurementState(economyState)
    .corporations[String(order.corporationID)] || null;
  if (!corporation) return false;
  const escrowDelta = roundMoney((desiredPrice - oldPrice) * remaining);
  if (escrowDelta > 0 && options.allowWarSubsidy === true) {
    // An upward war reprice may not push the order's committed value past
    // the same ceiling placement used; the premium then simply waits.
    const warMaxOrderValue = toFiniteNumber(options.maxOrderValueISK, 0);
    if (
      warMaxOrderValue > 0 &&
      desiredPrice * remaining > warMaxOrderValue
    ) {
      return false;
    }
  }
  if (escrowDelta > corporation.cashISK && options.allowWarSubsidy === true) {
    applyWarSubsidy(economyState, corporation, escrowDelta, nowMs);
  }
  if (escrowDelta > corporation.cashISK) return false;
  await marketCall("ModifyOrder", {
    order_id: String(order.orderID),
    new_price: desiredPrice,
  }, workBudget);
  corporation.cashISK = roundMoney(corporation.cashISK - escrowDelta);
  corporation.escrowISK = roundMoney(corporation.escrowISK + escrowDelta);
  corporation.updatedAtMs = nowMs;
  order.escrowISK = roundMoney(order.escrowISK + escrowDelta);
  order.price = desiredPrice;
  order.updatedAtMs = nowMs;
  economyState.metrics.procurementOrdersRepriced += 1;
  return true;
}

async function review(
  economyState,
  stockMap,
  getStockRow,
  addEvent,
  nowMs = Date.now(),
  options = {},
) {
  if (config.livingEconomyProcurementEnabled !== true) {
    return { reviewed: false, reason: "disabled", changes: 0 };
  }
  const procurement = ensureProcurementState(economyState);
  const stations = Array.isArray(options.stations) && options.stations.length > 0
    ? options.stations
    : catalog.STATIONS;
  const stationIDs = new Set(stations.map((station) => Number(station.stationID)));
  const isSettlementInFlight = (order) => (
    toFiniteNumber(order && order.settlementInFlightAtMs, 0) > 0 &&
    nowMs - toFiniteNumber(order.settlementInFlightAtMs, 0) < 120_000
  );
  const regionKey = options.regionID === undefined || options.regionID === null
    ? "all"
    : String(Number(options.regionID));
  const previousReviewAtMs = toFiniteNumber(
    procurement.lastReviewAtMsByRegion[regionKey],
    regionKey === "all" ? procurement.lastReviewAtMs : 0,
  );
  if (options.forceReview !== true && nowMs - previousReviewAtMs < getReviewIntervalMs()) {
    return { reviewed: false, reason: "not-due", changes: 0 };
  }
  procurement.lastReviewAtMsByRegion[regionKey] = nowMs;
  procurement.lastReviewAtMs = nowMs;
  const workBudget = options.workBudget;
  for (const order of Object.values(procurement.orders)) {
    if (
      String(order.state || "") !== "open" ||
      !stationIDs.has(Number(order.stationID)) ||
      isSettlementInFlight(order)
    ) {
      continue;
    }
    await reconcileOrder(economyState, order, nowMs, workBudget);
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
  }

  const candidates = buildCandidates(stockMap, getStockRow, {
    stations,
    priorityRequirements: options.priorityRequirements,
  });
  const existingByKey = new Map(listOpenOrders(economyState).map(
    (order) => [orderKey(order.stationID, order.typeID), order],
  ));
  const candidateByKey = new Map(candidates.map(
    (candidate) => [orderKey(candidate.station.stationID, candidate.good.typeID), candidate],
  ));
  let changes = 0;
  for (const order of listOpenOrders(economyState)) {
    if (changes >= getMaxChanges()) break;
    if (!stationIDs.has(Number(order.stationID))) continue;
    if (!candidateByKey.has(orderKey(order.stationID, order.typeID))) {
      await cancelOrder(economyState, order, nowMs, workBudget);
      changes += 1;
      if (workBudget && typeof workBudget.checkpoint === "function") {
        await workBudget.checkpoint();
      }
    }
  }

  const slots = Math.max(0, getMaxOrders() - listOpenOrders(economyState).length);
  // Candidates with an existing open order are always reviewed so stale
  // war-premium prices are walked back down once the priority demand clears;
  // only NEW placements compete for the bounded slice. Candidates whose
  // priority demand has CLEARED sort first: walking a premium back down must
  // not starve behind active war repricing inside the change budget.
  const existingOrderCandidates = candidates
    .filter((candidate) => (
      existingByKey.has(orderKey(candidate.station.stationID, candidate.good.typeID))
    ))
    .sort((left, right) => (
      Number(toPositiveInt(left.priorityShortage, 0) > 0) -
      Number(toPositiveInt(right.priorityShortage, 0) > 0)
    ));
  const newOrderCandidates = slots > 0
    ? candidates
        .filter((candidate) => (
          !existingByKey.has(orderKey(candidate.station.stationID, candidate.good.typeID))
        ))
        .slice(0, Math.max(getMaxChanges() * 2, 16))
    : [];
  const reviewCandidates = [...existingOrderCandidates, ...newOrderCandidates];
  const books = [];
  for (const candidate of reviewCandidates) {
    books.push({
      candidate,
      book: await marketCall("GetOrders", {
        region_id: toPositiveInt(candidate.station.regionID, catalog.PILOT_REGION_ID),
        type_id: candidate.good.typeID,
      }, workBudget),
    });
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
  }

  let openCount = listOpenOrders(economyState).length;
  for (const { candidate, book } of books) {
    if (changes >= getMaxChanges()) break;
    const key = orderKey(candidate.station.stationID, candidate.good.typeID);
    const desiredPrice = applyWarPremium(
      computeCompetitivePrice(book, candidate.good),
      candidate,
      book,
      nowMs,
    );
    const existing = existingByKey.get(key);
    if (existing) {
      if (await repriceOrder(
        economyState,
        existing,
        desiredPrice,
        nowMs,
        workBudget,
        {
          allowWarSubsidy: toPositiveInt(candidate.priorityShortage, 0) > 0,
          maxOrderValueISK:
            (String(candidate.station.hubTier || "") === "regional"
              ? 100_000_000
              : 25_000_000) * 4,
        },
      )) changes += 1;
      continue;
    }
    if (openCount >= getMaxOrders()) continue;
    const placed = await placeOrder(economyState, candidate, desiredPrice, nowMs, workBudget);
    if (!placed) continue;
    existingByKey.set(key, placed);
    openCount += 1;
    changes += 1;
    if (typeof addEvent === "function") {
      addEvent("procurement_order_placed", null, {
        orderID: placed.orderID,
        corporationID: placed.corporationID,
        stationID: placed.stationID,
        typeID: placed.typeID,
        quantity: placed.enteredQuantity,
        price: placed.price,
      }, nowMs);
    }
  }
  return { reviewed: true, changes, openOrders: listOpenOrders(economyState).length };
}

function previewFill(economyState, details = {}) {
  const procurement = ensureProcurementState(economyState);
  const orderID = String(details.orderID || "");
  const order = procurement.orders[orderID] || null;
  if (!order || String(order.state || "") !== "open") {
    return { success: false, errorMsg: "PROCUREMENT_ORDER_NOT_TRACKED" };
  }
  const quantity = Math.min(
    toPositiveInt(details.quantity, 0),
    toPositiveInt(order.remainingQuantity, 0),
  );
  if (quantity <= 0) {
    return { success: false, errorMsg: "PROCUREMENT_FILL_QUANTITY_INVALID" };
  }
  const price = Math.max(0.01, toFiniteNumber(details.price, order.price));
  const gross = roundMoney(price * quantity);
  const availableEscrow = roundMoney(toFiniteNumber(order.escrowISK, 0));
  if (gross > availableEscrow + 0.001) {
    return { success: false, errorMsg: "PROCUREMENT_ESCROW_INSUFFICIENT" };
  }
  return { success: true, order, quantity, price, gross, spent: gross };
}

function settleFill(economyState, details = {}, nowMs = Date.now()) {
  const preview = previewFill(economyState, details);
  if (!preview.success) return preview;
  const procurement = ensureProcurementState(economyState);
  const { order, quantity, spent } = preview;
  const corporation = procurement.corporations[String(order.corporationID)] || null;
  order.remainingQuantity = Math.max(0, toPositiveInt(order.remainingQuantity, 0) - quantity);
  order.escrowISK = roundMoney(Math.max(0, toFiniteNumber(order.escrowISK, 0) - spent));
  order.updatedAtMs = nowMs;
  order.filledQuantity = toPositiveInt(order.filledQuantity, 0) + quantity;
  order.spentISK = roundMoney(toFiniteNumber(order.spentISK, 0) + spent);
  if (order.remainingQuantity <= 0) order.state = "filled";
  if (corporation) {
    corporation.escrowISK = roundMoney(Math.max(0, corporation.escrowISK - spent));
    corporation.spentISK = roundMoney(corporation.spentISK + spent);
    corporation.unitsBought += quantity;
    corporation.updatedAtMs = nowMs;
  }
  economyState.metrics.procurementUnitsBought += quantity;
  economyState.metrics.procurementIskSpent = roundMoney(
    economyState.metrics.procurementIskSpent + spent,
  );
  if (String(details.sellerKind || "player") === "player") {
    economyState.metrics.procurementPlayerUnitsBought += quantity;
    economyState.metrics.procurementPlayerIskSpent = roundMoney(
      economyState.metrics.procurementPlayerIskSpent + spent,
    );
  }
  return { success: true, order, quantity, spent };
}

function getStatus(economyState) {
  const procurement = ensureProcurementState(economyState);
  const corporations = Object.values(procurement.corporations);
  return {
    enabled: config.livingEconomyProcurementEnabled === true,
    openOrders: listOpenOrders(economyState).length,
    corporations: corporations.length,
    cashISK: roundMoney(corporations.reduce((sum, corp) => sum + toFiniteNumber(corp.cashISK, 0), 0)),
    escrowISK: roundMoney(corporations.reduce((sum, corp) => sum + toFiniteNumber(corp.escrowISK, 0), 0)),
    spentISK: roundMoney(corporations.reduce((sum, corp) => sum + toFiniteNumber(corp.spentISK, 0), 0)),
    lastReviewAtMs: procurement.lastReviewAtMs,
  };
}

module.exports = {
  ORDER_SOURCE,
  getReviewIntervalMs,
  getStatus,
  listOpenOrders,
  previewFill,
  review,
  settleFill,
  _testing: {
    buildCandidates,
    computeCompetitivePrice,
    ensureCorporation,
    ensureProcurementState,
  },
};
