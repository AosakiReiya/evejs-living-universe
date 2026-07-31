"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryDataDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "evejs-estate-logistics-"),
);
const sourceSqlitePath = process.env.EVEJS_TEST_SOURCE_GAMESTORE_SQLITE || path.resolve(
  __dirname,
  "../../_local/gameStore/gamestore.sqlite",
);
const sourceDataDirectory = path.join(path.dirname(sourceSqlitePath), "data");
if (!fs.existsSync(sourceSqlitePath)) {
  throw new Error(
    `Family estate logistics verification requires a seeded gameStore: ${sourceSqlitePath}`,
  );
}
fs.copyFileSync(sourceSqlitePath, path.join(temporaryDataDirectory, "gamestore.sqlite"));
for (const tableName of [
  "asteroidBelts",
  "celestials",
  "explorationAuthority",
  "itemTypes",
  "movementAttributes",
  "shipDogmaAttributes",
  "solarSystems",
  "stargates",
  "stargateTypes",
  "stations",
  "stationTypes",
  "typeDogma",
]) {
  const source = path.join(sourceDataDirectory, tableName);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(temporaryDataDirectory, "data", tableName), {
      recursive: true,
    });
  }
}

process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(temporaryDataDirectory, "data");
// The logistics verifier isolates the native wallet/market/flight adapter.
// X-Eve's source-journal circuit has its own fault-injection suite.
process.env.EVEJS_X_EVE_ENABLED = "false";
process.env.EVEJS_FAMILY_ESTATE_ENABLED = "true";
process.env.EVEJS_FAMILY_ESTATE_LOGISTICS_ENABLED = "true";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "true";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "true";
process.env.EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER = "10";
process.env.EVEJS_LIVING_ECONOMY_INDUSTRY_TIME_SCALE = "0.1";
process.env.EVEJS_LIVE_EVENTS_ENABLED = "false";
process.env.EVEJS_AI_NARRATIVE_ENABLED = "false";

const database = require("../src/gameStore");
const {
  ensureCoreFixtures,
  PLAYER_CEO_CHARACTER_ID,
  PLAYER_CORPORATION_ID,
} = require("../src/services/corporation/coreFixtureSeeder");
const {
  applyCorporationWalletOperation,
  getCorporationWalletBalance,
  getCorporationWalletOperation,
  setCorporationWalletDivisionBalance,
} = require("../src/services/corporation/corpWalletState");
const familyEstateRuntime = require("../src/services/estate/familyEstateRuntime");
const projectState = require("../src/services/estate/familyEstateProjectState");
const projectsRuntime = require("../src/services/estate/familyEstateProjectsRuntime");
const catalog = require("../src/space/npc/ambientTraffic/livingEconomyCatalog");
const livingEconomyState = require(
  "../src/space/npc/ambientTraffic/livingEconomyState",
);
const livingEconomyIndustry = require(
  "../src/space/npc/ambientTraffic/livingEconomyIndustry",
);
const livingEconomyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const livingUniverseRuntime = require(
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
);

const ACCOUNT_KEY = 1000;

function setWallet(balance, description) {
  const result = setCorporationWalletDivisionBalance(
    PLAYER_CORPORATION_ID,
    ACCOUNT_KEY,
    balance,
    { description },
  );
  assert.equal(result.success, true, result.errorMsg);
}

function reserveDelivery(projectKey, material, suffix, nowMs) {
  const good = catalog.getGood(material.typeID);
  assert.ok(good, `Missing catalog good for ${material.typeID}`);
  const result = projectsRuntime.reserveFamilyEstateNpcDelivery({
    reservationID: `estate-logistics-${suffix}`,
    projectKey,
    typeID: material.typeID,
    quantity: material.quantity,
    sourceStationID: 60003760,
    assignedFlightID: `flight-${suffix}`,
    goodsISK: good.priceAnchor * material.quantity,
  }, nowMs);
  assert.equal(result.success, true, result.errorMsg);
  return result.data;
}

function arriveAndSettle(reservationID, nowMs) {
  const arrived = projectsRuntime.markFamilyEstateNpcDeliveryArrived(
    reservationID,
    nowMs,
  );
  assert.equal(arrived.success, true, arrived.errorMsg);
  return projectsRuntime.settleFamilyEstateNpcDelivery(reservationID, nowMs + 1);
}

(async () => {
  try {
    ensureCoreFixtures();
    const ensured = familyEstateRuntime.ensureFamilyEstate({ emitLive: false });
    assert.equal(ensured.success, true, ensured.errorMsg);
    const structureID = ensured.data.structure.structureID;
    database.write("familyEstateClaimState", "/", {});
    database.write(projectState.TABLE_NAME, "/", {});

    const nowMs = 1_900_000_000_000;
    const session = {
      characterID: PLAYER_CEO_CHARACTER_ID,
      corporationID: PLAYER_CORPORATION_ID,
      structureID,
    };
    const claim = familyEstateRuntime.claimFamilyEstate(session, {
      emitLive: false,
      nowMs,
      bypassAuthority: true,
    });
    assert.equal(claim.success, true, claim.errorMsg);

    setWallet(10_000, "Estate logistics wallet receipt seed");
    const walletDetails = {
      operationID: "estate-logistics-wallet-idempotency",
      fingerprint: "estate-logistics-wallet-idempotency-v1",
      kind: "verification",
      corporationID: PLAYER_CORPORATION_ID,
      accountKey: ACCOUNT_KEY,
      delta: -1_000,
      nowMs: nowMs + 1,
      description: "Estate logistics idempotency verification",
    };
    const firstWallet = applyCorporationWalletOperation(walletDetails);
    assert.equal(firstWallet.success, true, firstWallet.errorMsg);
    assert.equal(firstWallet.replayed, false);
    const replayedWallet = applyCorporationWalletOperation(walletDetails);
    assert.equal(replayedWallet.success, true, replayedWallet.errorMsg);
    assert.equal(replayedWallet.replayed, true);
    assert.equal(getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY), 9_000);
    const walletConflict = applyCorporationWalletOperation({
      ...walletDetails,
      fingerprint: "estate-logistics-wallet-idempotency-conflict",
    });
    assert.equal(walletConflict.success, false);
    assert.equal(walletConflict.errorMsg, "CORPORATION_WALLET_OPERATION_CONFLICT");
    assert.ok(
      getCorporationWalletOperation(
        PLAYER_CORPORATION_ID,
        walletDetails.operationID,
      ),
      "Durable wallet operation receipt was not readable",
    );

    const commission = projectsRuntime.startProject(session, "stabilization", {
      nowMs: nowMs + 2,
      commissionIfMissing: true,
    });
    assert.equal(commission.success, true, commission.errorMsg);
    assert.equal(commission.data.project.status, "available");
    assert.equal(commission.data.project.procurement.status, "commissioned");

    const requirements = projectsRuntime.getCommissionedMaterialRequirements({
      nowMs: nowMs + 3,
    });
    assert.equal(requirements.length, projectState.PROJECT_DEFINITIONS.stabilization.materials.length);

    const jita = catalog.getStation(60003760);
    assert.ok(jita, "Jita station is absent from the Living Economy catalog");
    for (const typeID of [21947, 35899]) {
      const recipe = livingEconomyIndustry.getRecipe(catalog.getGood(typeID));
      assert.ok(recipe && recipe.foundationAssembly, `${typeID} lacks a production bridge`);
      assert.ok(recipe.materials.length > 0);
      assert.ok(recipe.materials.every((entry) => catalog.isMineralGood(
        catalog.getGood(entry.typeID),
      )));
    }
    assert.equal(livingEconomyIndustry._testing.getTimeScale(), 0.1);
    const stockMap = new Map();
    for (const requirement of requirements) {
      const good = catalog.getGood(requirement.typeID);
      stockMap.set(`${jita.stationID}:${good.typeID}`, {
        stationID: jita.stationID,
        typeID: good.typeID,
        quantity: Math.max(requirement.remainingQuantity, good.targetQuantity * 2),
        price: good.priceAnchor,
      });
    }
    const opportunities = await projectsRuntime.buildFamilyEstateFreightOpportunities(
      stockMap,
      (rows, stationID, typeID) => rows.get(`${stationID}:${typeID}`) || {
        stationID,
        typeID,
        quantity: 0,
        price: catalog.getGood(typeID) && catalog.getGood(typeID).priceAnchor || 0,
      },
      nowMs + 4,
    );
    const jitaOpportunity = opportunities.find(
      (entry) => Number(entry.sourceStation.stationID) === jita.stationID,
    );
    assert.ok(jitaOpportunity, "No Jita-to-estate freight opportunity was built");
    assert.equal(jitaOpportunity.routeSpec.familyEstate, true);
    assert.equal(
      jitaOpportunity.routeSpec.endpointStationIDs[1],
      structureID,
    );
    assert.equal(
      jitaOpportunity.routeSpec.typedEdges.at(-1).kind,
      "wormhole",
    );
    livingUniverseRuntime._testing.buildRouteDefinitions();
    const dynamicRoute = livingUniverseRuntime._testing.registerDynamicFreightRoute(
      jitaOpportunity.routeSpec,
    );
    assert.ok(dynamicRoute, "The estate's mixed stargate/wormhole route did not register");
    assert.equal(dynamicRoute.edges.at(-1).edgeKind, "wormhole");
    assert.equal(dynamicRoute.stations[1].structureID, structureID);
    const forwardTrip = livingUniverseRuntime._testing.estimateNetworkTrip(
      dynamicRoute,
      { direction: 1, actorIDs: [] },
    );
    const reverseTrip = livingUniverseRuntime._testing.estimateNetworkTrip(
      dynamicRoute,
      { direction: -1, actorIDs: [] },
    );
    for (const trip of [forwardTrip, reverseTrip]) {
      assert.ok(trip.totalMs > 18_000, "Wormhole route collapsed to gate-session time only");
      assert.ok(trip.legs.some((leg) => leg.kind === "station_departure"));
      assert.ok(trip.legs.some((leg) => leg.kind === "station_approach"));
    }

    const recoveryNodeIndex = Math.min(1, dynamicRoute.systemIDs.length - 1);
    const recoveredMidRouteFlight = {
      flightID: "estate-route-recovery-flight",
      actorIDs: [],
      phase: "virtual_crossing",
      materialized: false,
      routeID: "stale-route",
      dynamicRouteSpec: null,
      currentSystemID: dynamicRoute.systemIDs[recoveryNodeIndex],
      currentNodeIndex: recoveryNodeIndex,
      direction: 1,
      nextTransitionAtMs: nowMs + 123_456,
    };
    const recoveryDeadline = recoveredMidRouteFlight.nextTransitionAtMs;
    assert.equal(
      livingUniverseRuntime._testing.assignFreightRoute(
        recoveredMidRouteFlight,
        jitaOpportunity.routeSpec,
        nowMs + 4,
        { preserveProgress: true },
      ),
      true,
      "A persisted estate route could not be restored in the middle of a trip",
    );
    assert.equal(recoveredMidRouteFlight.routeID, dynamicRoute.routeID);
    assert.equal(recoveredMidRouteFlight.phase, "virtual_crossing");
    assert.equal(
      recoveredMidRouteFlight.currentSystemID,
      dynamicRoute.systemIDs[recoveryNodeIndex],
    );
    assert.equal(recoveredMidRouteFlight.currentNodeIndex, recoveryNodeIndex);
    assert.equal(recoveredMidRouteFlight.nextTransitionAtMs, recoveryDeadline);
    assert.equal(recoveredMidRouteFlight.dynamicRouteSpec.familyEstate, true);

    const acceleratedFlight = { currentSystemID: jita.systemID, materialized: false };
    const acceleratedTravel = livingUniverseRuntime._testing.setVirtualTravelPhase(
      acceleratedFlight,
      "verification",
      { totalMs: 100_000 },
      nowMs + 5,
      "off-grid-verification",
      { scenes: new Map() },
    );
    assert.equal(acceleratedTravel.baseDurationMs, 100_000);
    assert.equal(acceleratedTravel.durationMs, 10_000);
    assert.equal(acceleratedTravel.appliedTimeMultiplier, 10);

    const observedRuntime = {
      scenes: new Map([[
        jita.systemID,
        { sessions: new Map([["player", {}]]) },
      ]]),
    };
    const observedTravel = livingUniverseRuntime._testing.setVirtualTravelPhase(
      { currentSystemID: jita.systemID, materialized: false },
      "verification",
      { totalMs: 100_000 },
      nowMs + 6,
      "observed-verification",
      observedRuntime,
    );
    assert.equal(observedTravel.durationMs, 100_000);
    assert.equal(observedTravel.appliedTimeMultiplier, 1);
    const materializedTravel = livingUniverseRuntime._testing.setVirtualTravelPhase(
      { currentSystemID: jita.systemID, materialized: true },
      "verification",
      { totalMs: 100_000 },
      nowMs + 7,
      "materialized-verification",
      { scenes: new Map() },
    );
    assert.equal(materializedTravel.durationMs, 100_000);
    assert.equal(materializedTravel.appliedTimeMultiplier, 1);
    const midLegFlight = { currentSystemID: jita.systemID, materialized: false };
    const midLegTravel = livingUniverseRuntime._testing.setVirtualTravelPhase(
      midLegFlight,
      "verification",
      { totalMs: 100_000 },
      nowMs + 8,
      "mid-leg-observer-verification",
      { scenes: new Map() },
    );
    const acceleratedDeadline = midLegFlight.nextTransitionAtMs;
    assert.equal(midLegTravel.appliedTimeMultiplier, 10);
    const rebaseAtMs = nowMs + 8 + 4_000;
    const rebased = livingUniverseRuntime._testing
      .rebaseAcceleratedVirtualTravelForObservation(midLegFlight, rebaseAtMs);
    assert.equal(rebased, true);
    assert.equal(midLegFlight.virtualTravel.appliedTimeMultiplier, 1);
    assert.equal(midLegFlight.virtualTravel.rebasedProgress, 0.4);
    assert.equal(midLegFlight.nextTransitionAtMs, rebaseAtMs + 60_000);
    assert.ok(midLegFlight.nextTransitionAtMs > acceleratedDeadline);
    const rebasedDeadline = midLegFlight.nextTransitionAtMs;
    assert.equal(
      livingUniverseRuntime._testing.rebaseAcceleratedVirtualTravelForObservation(
        midLegFlight,
        rebaseAtMs + 1_000,
      ),
      false,
    );
    assert.equal(midLegFlight.nextTransitionAtMs, rebasedDeadline);

    const stabilization = projectState.PROJECT_DEFINITIONS.stabilization;
    const nanite = stabilization.materials.find((entry) => entry.typeID === 28668);
    setWallet(0, "Estate logistics insufficient-funds verification");
    const unfunded = projectsRuntime.reserveFamilyEstateNpcDelivery({
      reservationID: "estate-logistics-unfunded",
      projectKey: "stabilization",
      typeID: nanite.typeID,
      quantity: nanite.quantity,
      sourceStationID: 60003760,
      assignedFlightID: "flight-unfunded",
      goodsISK: catalog.getGood(nanite.typeID).priceAnchor * nanite.quantity,
    }, nowMs + 10);
    assert.equal(unfunded.success, false);
    assert.equal(unfunded.errorMsg, "FAMILY_ESTATE_DELIVERY_CREDIT_REQUIRED");
    assert.equal(
      projectState.readState(nowMs + 12).projects.stabilization.contributed["28668"],
      0,
    );

    setWallet(1_000_000_000, "Estate logistics delivery verification seed");
    const naniteReservation = reserveDelivery(
      "stabilization",
      nanite,
      "nanite",
      nowMs + 13,
    );
    let expectedSpend = naniteReservation.totalISK;
    const balanceAfterNaniteEscrow = getCorporationWalletBalance(
      PLAYER_CORPORATION_ID,
      ACCOUNT_KEY,
    );
    assert.equal(balanceAfterNaniteEscrow, 1_000_000_000 - naniteReservation.totalISK);

    const economyState = livingEconomyState.buildDefaultState();
    economyState.catalogRevision = livingEconomyRuntime.CATALOG_REVISION;
    const naniteFlight = {
      flightID: "flight-nanite",
      family: "hauler",
      freightJobID: naniteReservation.reservationID,
      phase: "docked",
      materialized: false,
      currentSystemID: ensured.data.profile.homeSystemID,
    };
    const livingState = {
      flights: { [naniteFlight.flightID]: naniteFlight },
    };
    const naniteJob = {
      jobID: naniteReservation.reservationID,
      kind: "estate_delivery",
      status: "in_transit",
      assignedFlightID: naniteFlight.flightID,
      sourceStationID: 60003760,
      destinationStationID: structureID,
      typeID: nanite.typeID,
      typeName: nanite.name,
      quantity: nanite.quantity,
      cargoVolume: nanite.quantity,
      logisticsClass: "secure",
      purchaseValue: naniteReservation.goodsISK,
      estimatedValue: naniteReservation.goodsISK,
      estateDelivery: {
        projectKey: "stabilization",
        reservationID: naniteReservation.reservationID,
      },
      createdAtMs: nowMs + 13,
      lastUpdatedAtMs: nowMs + 13,
    };
    economyState.jobs[naniteJob.jobID] = naniteJob;
    livingEconomyRuntime._testing.setRuntimeStateForTest(economyState);

    const assertResetBlocked = (atMs, label) => {
      const walletBefore = getCorporationWalletBalance(
        PLAYER_CORPORATION_ID,
        ACCOUNT_KEY,
      );
      const estateBefore = projectState.readState(atMs);
      assert.throws(
        () => livingEconomyRuntime.prepareReset(atMs),
        (error) => error && error.code === "LIVING_ECONOMY_ESTATE_DELIVERIES_ACTIVE",
        `${label} did not block a destructive economy reset`,
      );
      assert.equal(
        getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
        walletBefore,
      );
      assert.deepEqual(projectState.readState(atMs), estateBefore);
    };
    assertResetBlocked(nowMs + 13, "Reserved estate cargo");

    const prematureSettlement = projectsRuntime.settleFamilyEstateNpcDelivery(
      naniteReservation.reservationID,
      nowMs + 14,
    );
    assert.equal(prematureSettlement.success, false);
    assert.equal(
      prematureSettlement.errorMsg,
      "FAMILY_ESTATE_DELIVERY_NOT_SETTLEABLE",
    );
    assert.equal(
      projectState.readState(nowMs + 14).projects.stabilization.contributed["28668"],
      0,
      "Cargo was credited before the hauler physically arrived",
    );
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      balanceAfterNaniteEscrow,
      "A premature settlement changed the corporation wallet",
    );

    assert.equal(
      livingEconomyRuntime.notifyStationArrival(
        naniteFlight,
        structureID,
        nowMs + 15,
      ),
      true,
    );
    assert.equal(naniteJob.status, "delivery_pending");

    const naniteArrived = projectsRuntime.markFamilyEstateNpcDeliveryArrived(
      naniteReservation.reservationID,
      nowMs + 15,
    );
    assert.equal(naniteArrived.success, true, naniteArrived.errorMsg);
    assertResetBlocked(nowMs + 15, "Arrived estate cargo");
    const closeAfterArrival = projectsRuntime.closeFamilyEstateNpcDelivery(
      naniteReservation.reservationID,
      "lost",
      "late-loss-report-verification",
      nowMs + 16,
    );
    assert.equal(closeAfterArrival.success, false);
    assert.equal(
      closeAfterArrival.errorMsg,
      "FAMILY_ESTATE_DELIVERY_ALREADY_ARRIVED",
    );
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      balanceAfterNaniteEscrow,
      "An invalid loss report refunded cargo that had already arrived",
    );
    assert.equal(
      livingEconomyRuntime.notifyFlightLoss(
        naniteFlight,
        ["late-loss-verification"],
        nowMs + 17,
      ),
      false,
      "A late loss notification overrode an accepted station arrival",
    );
    assert.equal(naniteJob.status, "delivery_pending");
    await livingEconomyRuntime._testing.processPendingDeliveries(
      livingState,
      new Map(),
      nowMs + 18,
    );
    assert.equal(naniteJob.status, "delivered");
    assert.ok(naniteJob.estateCloseConfirmedAtMs);
    assert.equal(naniteFlight.freightJobID, null);
    assert.equal(naniteFlight.estateReturnPending, true);
    assert.equal(economyState.metrics.jobsDelivered, 1);
    assert.equal(economyState.metrics.unitsDelivered, nanite.quantity);
    assert.ok(naniteJob.saleAccountingAtMs);
    assert.ok(naniteJob.cargoDeliveryAccountingAtMs);
    assert.equal(
      livingEconomyRuntime._testing.isUnresolvedEstateJob(naniteJob),
      false,
    );
    naniteFlight.estateReturnPending = false;
    naniteFlight.lastTransitionReason = "source-return-complete";
    naniteFlight.freightJobID = "newer-unrelated-job";
    const deliveredMetricsBeforeReplay = {
      jobs: economyState.metrics.jobsDelivered,
      units: economyState.metrics.unitsDelivered,
      revenue: economyState.metrics.traderRevenue,
    };
    await livingEconomyRuntime._testing.reconcileEstateDeliveryReceipts(
      livingState,
      new Map(),
      nowMs + 19,
    );
    assert.equal(naniteFlight.freightJobID, "newer-unrelated-job");
    assert.equal(naniteFlight.estateReturnPending, false);
    assert.equal(naniteFlight.lastTransitionReason, "source-return-complete");
    assert.deepEqual(
      {
        jobs: economyState.metrics.jobsDelivered,
        units: economyState.metrics.unitsDelivered,
        revenue: economyState.metrics.traderRevenue,
      },
      deliveredMetricsBeforeReplay,
      "A completed delivery receipt was accounted more than once",
    );
    naniteFlight.freightJobID = null;
    const paidNanite = projectsRuntime.settleFamilyEstateNpcDelivery(
      naniteReservation.reservationID,
      nowMs + 20,
    );
    assert.equal(paidNanite.success, true, paidNanite.errorMsg);
    assert.equal(paidNanite.replayed, true);
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      balanceAfterNaniteEscrow,
      "Arrival settlement charged an already-escrowed delivery twice",
    );

    const constructionPart = stabilization.materials.find((entry) => entry.typeID === 21947);
    const partReservation = reserveDelivery(
      "stabilization",
      constructionPart,
      "construction-part",
      nowMs + 20,
    );
    expectedSpend += partReservation.totalISK;
    const replayedReservation = projectsRuntime.reserveFamilyEstateNpcDelivery({
      reservationID: partReservation.reservationID,
      projectKey: "stabilization",
      typeID: constructionPart.typeID,
      quantity: constructionPart.quantity,
      sourceStationID: 60003760,
      assignedFlightID: "flight-construction-part",
      goodsISK: catalog.getGood(constructionPart.typeID).priceAnchor,
    }, nowMs + 21);
    assert.equal(replayedReservation.success, true, replayedReservation.errorMsg);
    assert.equal(replayedReservation.replayed, true);
    const paidPart = arriveAndSettle(partReservation.reservationID, nowMs + 22);
    assert.equal(paidPart.success, true, paidPart.errorMsg);
    const walletAfterPart = getCorporationWalletBalance(
      PLAYER_CORPORATION_ID,
      ACCOUNT_KEY,
    );
    const replayedPart = projectsRuntime.settleFamilyEstateNpcDelivery(
      partReservation.reservationID,
      nowMs + 23,
    );
    assert.equal(replayedPart.success, true, replayedPart.errorMsg);
    assert.equal(replayedPart.replayed, true);
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      walletAfterPart,
      "Replaying an estate delivery charged the corporation twice",
    );

    const pyerite = stabilization.materials.find((entry) => entry.typeID === 35);
    const balanceBeforeLostHauler = getCorporationWalletBalance(
      PLAYER_CORPORATION_ID,
      ACCOUNT_KEY,
    );
    const lostReservation = reserveDelivery(
      "stabilization",
      pyerite,
      "lost-hauler",
      nowMs + 30,
    );
    const closed = projectsRuntime.closeFamilyEstateNpcDelivery(
      lostReservation.reservationID,
      "lost",
      "verification-hauler-loss",
      nowMs + 31,
    );
    assert.equal(closed.success, true, closed.errorMsg);
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      balanceBeforeLostHauler,
      "A lost hauler did not release the corporation's freight escrow",
    );
    const replayedClose = projectsRuntime.closeFamilyEstateNpcDelivery(
      lostReservation.reservationID,
      "lost",
      "verification-hauler-loss-replay",
      nowMs + 32,
    );
    assert.equal(replayedClose.success, true, replayedClose.errorMsg);
    assert.equal(replayedClose.replayed, true);
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      balanceBeforeLostHauler,
      "Replaying a hauler-loss receipt refunded the escrow twice",
    );
    const reopenedPyerite = projectsRuntime.getCommissionedMaterialRequirements({
      nowMs: nowMs + 33,
    }).find((entry) => entry.typeID === pyerite.typeID);
    assert.ok(reopenedPyerite, "A lost cargo reservation did not reopen demand");
    assert.equal(reopenedPyerite.remainingQuantity, pyerite.quantity);
    assert.equal(reopenedPyerite.reserved, 0);

    for (const material of stabilization.materials.filter(
      (entry) => ![28668, 21947].includes(entry.typeID),
    )) {
      const reservation = reserveDelivery(
        "stabilization",
        material,
        `material-${material.typeID}`,
        nowMs + 40 + material.typeID,
      );
      expectedSpend += reservation.totalISK;
      const settled = arriveAndSettle(
        reservation.reservationID,
        nowMs + 50 + material.typeID,
      );
      assert.equal(settled.success, true, settled.errorMsg);
    }

    const finalStatus = projectsRuntime.getEstateProjectStatus({
      nowMs: nowMs + 100_000,
      settleCommercial: false,
    });
    assert.equal(finalStatus.state.projects.stabilization.status, "in_progress");
    assert.equal(finalStatus.state.projects.stabilization.funding.status, "applied");
    const expectedBalance = Math.round(
      (1_000_000_000 - expectedSpend - stabilization.iskCost) * 100,
    ) / 100;
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      expectedBalance,
    );
    const balanceBeforeReconcile = getCorporationWalletBalance(
      PLAYER_CORPORATION_ID,
      ACCOUNT_KEY,
    );
    projectsRuntime.reconcileEstateProjects(nowMs + 100_001, {
      settleCommercial: false,
    });
    assert.equal(
      getCorporationWalletBalance(PLAYER_CORPORATION_ID, ACCOUNT_KEY),
      balanceBeforeReconcile,
      "Project auto-start reconciliation charged labor twice",
    );

    database.flushAllSync();
    console.log(
      "Family estate logistics verification passed: real demand, mixed gate/wormhole route, " +
      "freight escrow, loss recovery, idempotent receipts, auto-start, and safe 10x off-grid travel.",
    );
  } finally {
    projectsRuntime.stopFamilyEstateProjectSchedulerForTests();
    database.flushAllSync();
    database._shutdownPersistenceWorkerForTests();
    database._closeSqliteForTests();
    fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
