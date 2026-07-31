/**
 * EVE.js — Main Entry Point
 *
 * Initializes the service manager, registers core game services,
 * and starts the TCP server.
 */

const fs = require("fs");
const path = require("path");
const log = require(path.join(__dirname, "./src/utils/logger"));
const {
  installProcessLifecycleLogging,
} = require(path.join(__dirname, "./src/utils/processLifecycle"));
const config = require(path.join(__dirname, "./src/config"));
const {
  installSharedOverviewMotd,
} = require(path.join(__dirname, "./src/services/overview/overviewMotdBootstrap"));
const presenceReconciler = require(path.join(
  __dirname,
  "./src/services/_shared/presenceReconciler",
));

// Service framework
const ServiceManager = require(
  path.join(__dirname, "./src/services/serviceManager"),
);
const {
  createRuntimeContext,
} = require(path.join(__dirname, "./src/runtimeContext"));
const {
  createEvejsWebGatewayRuntime,
} = require(path.join(
  __dirname,
  "./src/_secondary/express/evejsWebGatewayRuntime",
));
const {
  loadSecondaryServices,
} = require(path.join(__dirname, "./src/secondaryServiceLoader"));

// network
const startTCPServer = require(path.join(__dirname, "./src/network/tcp"));

// database
const database = require(path.join(__dirname, "./src/gameStore"));

// main startup

installProcessLifecycleLogging({ appName: "eve.js server" });

log.logAsciiLogo();
log.spacer();
log.info("starting eve.js...");
log.spacer();

// Display version info
log.debug(`Project: ${config.projectVersion}`);
log.debug(`Client Version: ${config.clientVersion}`);
log.debug(`Client Build: ${config.clientBuild}`);
log.debug(`MachoNet Version: ${config.machoVersion}`);
log.line();

// Preload database into memory before services initialize
database.preloadAll();
log.line();

// Recreate any canonical fixtures (bootstrap characters, the player
// corporation 98000000 and its alliance 99000000) that a pruned or
// regenerated local database may be missing. Idempotent.
try {
  const {
    ensureCoreFixtures,
  } = require(path.join(__dirname, "./src/services/corporation/coreFixtureSeeder"));
  const fixtureSummary = ensureCoreFixtures();
  const seededCount =
    fixtureSummary.charactersCreated.length +
    (fixtureSummary.corporationCreated ? 1 : 0) +
    (fixtureSummary.allianceCreated ? 1 : 0);
  if (seededCount > 0) {
    log.info(
      `[CoreFixtures] Seeded missing fixtures: ${fixtureSummary.charactersCreated.length} character(s)` +
        `${fixtureSummary.corporationCreated ? ", player corporation" : ""}` +
        `${fixtureSummary.allianceCreated ? ", player alliance" : ""}.`,
    );
  }
  log.line();
} catch (err) {
  log.err(`[CoreFixtures] Failed startup fixture seeding: ${err.message}`);
  log.line();
}

// Recreate the canonical recurring global calendar events ("Make a wish") that
// a pruned/regenerated calendar table may be missing. Idempotent.
try {
  const calendarRuntime = require(path.join(
    __dirname,
    "./src/services/calendar/calendarRuntimeState",
  ));
  const calendarSeed = calendarRuntime.ensureSeededGlobalEvents();
  if (calendarSeed.created > 0) {
    log.info(`[CalendarSeed] Seeded ${calendarSeed.created} global calendar event(s).`);
  }
  log.line();
} catch (err) {
  log.err(`[CalendarSeed] Failed startup calendar seeding: ${err.message}`);
  log.line();
}

// Repopulate mined-out asteroid belts. Belt fields regenerate deterministically
// whenever a scene is built, so this only has to drop the persisted depletion
// state that would otherwise delete each rock again on spawn. Must run before
// any scene exists. Ice sites respawn on their own lifecycle and are left alone.
if (config.asteroidBeltStartupReset === true) {
  try {
    const miningRuntimeState = require(path.join(
      __dirname,
      "./src/services/mining/miningRuntimeState",
    ));
    const beltResetStartedAtMs = Date.now();
    const beltReset = miningRuntimeState.resetPersistedBeltAsteroidState();
    const beltResetTookMs = Date.now() - beltResetStartedAtMs;
    if (beltReset.entitiesCleared > 0) {
      log.info(
        `[BeltReset] Repopulated ${beltReset.entitiesCleared} mined belt asteroid(s) across ` +
          `${beltReset.systemsTouched} system(s) in ${beltResetTookMs}ms.`,
      );
    }
    log.line();
  } catch (err) {
    log.err(`[BeltReset] Failed startup belt asteroid reset: ${err.message}`);
    log.line();
  }
}

// create and populate service manager
const serviceManager = new ServiceManager();
const gatewayRuntime = createEvejsWebGatewayRuntime({ serviceManager });
const runtimeContext = createRuntimeContext({ serviceManager, gatewayRuntime });

// register services
const servicesDir = path.join(__dirname, "./src/services");

function loadServices(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      loadServices(fullPath);
    } else if (
      file.isFile() &&
      file.name.endsWith("Service.js") &&
      file.name !== "baseService.js" &&
      file.name !== "serviceManager.js"
    ) {
      try {
        const exported = require(fullPath);
        if (typeof exported === "function") {
          serviceManager.register(new exported());
        } else if (typeof exported === "object" && exported !== null) {
          for (const key in exported) {
            if (typeof exported[key] === "function") {
              serviceManager.register(new exported[key]());
            }
          }
        }
      } catch (err) {
        log.err(`failed to load service from ${fullPath}: ${err.message}`);
      }
    }
  }
}

loadServices(servicesDir);

if (serviceManager.lookup("trademgr") && !serviceManager.lookup("tradeMgr")) {
  serviceManager.registerAlias("tradeMgr", "trademgr");
}

log.success(`registered ${serviceManager.count} services`);
log.line();

// register secondary services
const secondaryServicesDir = path.join(__dirname, "./src/_secondary");
loadSecondaryServices(secondaryServicesDir, runtimeContext);

if (config.wormholesEnabled === true) {
  try {
    const seedStart = process.hrtime.bigint();
    const wormholeRuntime = require(path.join(
      __dirname,
      "./src/services/exploration/wormholes/wormholeRuntime",
    ));
    const seedResult = wormholeRuntime.ensureUniverseStatics(Date.now());
    const seedDurationMs = Number(process.hrtime.bigint() - seedStart) / 1e6;
    if (seedResult && seedResult.success === true) {
      const summary = wormholeRuntime.buildUniverseSummary({
        includeCollapsed: false,
        includeUndiscovered: true,
      });
      log.info(
        `[Wormholes] Startup ready: ${summary.activePairCount} pair(s) | static ${summary.staticPairCount} | random ${summary.randomPairCount} | systems ${summary.systemCount} | env ${summary.environmentSystemCount} | revealed ${summary.revealedExitCount} | hidden ${summary.hiddenExitCount} | ${seedDurationMs.toFixed(1)} ms`,
      );
    } else {
      log.warn(
        `[Wormholes] Universe static seeding reported failure after ${seedDurationMs.toFixed(1)} ms`,
      );
    }
    log.spacer();
  } catch (err) {
    log.err(`[Wormholes] Failed startup seeding: ${err.message}`);
    log.spacer();
  }
}

try {
  installSharedOverviewMotd(serviceManager);
  log.spacer();
} catch (err) {
  log.err(`[OverviewPresetMgr] Failed startup MOTD bootstrap: ${err.message}`);
  log.spacer();
}

try {
  const {
    runStartupBillingMaintenance,
  } = require(path.join(__dirname, "./src/services/account/billingMaintenance"));
  const billingSummary = runStartupBillingMaintenance({
    reason: "startup-downtime",
  });
  const officeRental = billingSummary.officeRental || {};
  const actionCounts = officeRental.actionCounts || {};
  if (Number(officeRental.processedCount) > 0 || officeRental.capped === true) {
    const actionSummary = Object.entries(actionCounts)
      .map(([action, count]) => `${action}=${count}`)
      .join(" ");
    const message =
      `[Billing] Startup office rental processing complete: ` +
      `processed=${Number(officeRental.processedCount) || 0} ` +
      `cycles=${Number(officeRental.cycleCount) || 0}/${Number(officeRental.maxCycles) || 0} ` +
      `${actionSummary || "actions=0"} ` +
      `elapsed=${Number(billingSummary.elapsedMs) || 0}ms`;
    if (officeRental.capped === true) {
      log.warn(`${message} capped=true`);
    } else {
      log.info(message);
    }
  }
  log.spacer();
} catch (err) {
  log.err(`[Billing] Failed startup bill processing: ${err.message}`);
  log.spacer();
}

// Start the presence reconciler (safety net that re-converges local-chat and
// station/structure guest visibility for missed fire-and-forget deltas).
try {
  presenceReconciler.start();
  log.spacer();
} catch (err) {
  log.err(`[PresenceReconcile] Failed to start: ${err.message}`);
  log.spacer();
}

// Live events use their own bounded, deadline-driven scheduler. They are not
// registered in the 100 ms space tick; observed content receives the shared
// space-runtime reference only when the feature is enabled.
try {
  const liveEventRuntime = require(path.join(
    __dirname,
    "./src/space/liveEvents/liveEventRuntime",
  ));
  const liveEventStartOptions = config.liveEventsEnabled === true
    ? { spaceRuntime: require(path.join(__dirname, "./src/space/runtime")) }
    : {};
  const startResult = liveEventRuntime.start(liveEventStartOptions);
  if (
    startResult &&
    startResult.success === true &&
    startResult.data &&
    startResult.data.enabled === true
  ) {
    log.info(
      `[LiveEvents] Scheduler ready: queued=${Number(startResult.data.queueSize) || 0}.`,
    );
    log.spacer();
  }
} catch (err) {
  log.err(`[LiveEvents] Failed startup: ${err.message}`);
  log.spacer();
}

// X-Eve runs outside the 100 ms space tick. Its admission governor reads
// recent tick summaries and preserves queued economic work whenever gameplay
// latency is under pressure.
try {
  const xEveRuntime = require(path.join(
    __dirname,
    "./src/services/xEve/xEveRuntime",
  ));
  const xEveStartOptions = config.xEveEnabled === true
    ? { spaceRuntime: require(path.join(__dirname, "./src/space/runtime")) }
    : {};
  const startResult = xEveRuntime.start(xEveStartOptions);
  if (
    config.xEveEnabled === true &&
    (
      !startResult ||
      startResult.success !== true ||
      !startResult.data ||
      startResult.data.started !== true
    )
  ) {
    throw new Error(startResult && startResult.errorMsg || "X_EVE_RUNTIME_NOT_READY");
  }
  if (
    startResult &&
    startResult.success === true &&
    startResult.data &&
    startResult.data.enabled === true
  ) {
    const reconcileResult = require(path.join(
      __dirname,
      "./src/services/xEve/xEveEventBridge",
    )).reconcileRecentLivingEconomyEvents();
    if (!reconcileResult || reconcileResult.success !== true) {
      xEveRuntime.stop();
      throw new Error(
        `Living Economy journal reconciliation failed: ` +
        `${reconcileResult && reconcileResult.errorMsg || "UNKNOWN"}`,
      );
    }
    log.info(
      `[X-Eve] Economic kernel ready: queued=${Number(startResult.data.scheduler.backlogTotal) || 0}.`,
    );
    log.spacer();
  }
} catch (err) {
  log.err(`[X-Eve] Failed startup: ${err.message}`);
  log.spacer();
  if (config.xEveEnabled === true) {
    throw err;
  }
}

// Start the TCP server with the service manager
startTCPServer(serviceManager);
