"use strict";

const net = require("net");
const path = require("path");

let database = null;

function parseArguments(argv) {
  const options = {
    apply: false,
    contractID: "",
  };
  for (const argument of argv) {
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument.startsWith("--contract=")) {
      options.contractID = argument.slice("--contract=".length).trim();
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(350);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function describePlan(result) {
  const contract = result.data;
  return {
    contractID: contract.contractID,
    serial: contract.serial,
    ownerCharacterID: contract.ownerCharacterID,
    from: "legacy miner",
    to: contract.packageName,
    crewTypeID: contract.crewTypeID,
    hulls: contract.members.map((member) => member.shipTypeName),
    preservedPilot: contract.members[0] && contract.members[0].pilotName,
    assignedSystemID: contract.assignedSystemID,
    assignedSiteID: contract.assignedSiteID,
    destinationStationID: contract.destinationStationID,
    runtimeCleared: contract.runtimeFleetID === 0 &&
      contract.runtimeEntityIDs.length === 0,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const serverPortsOpen = await Promise.all([
    isPortOpen(26000),
    isPortOpen(26001),
    isPortOpen(5222),
  ]);
  if (serverPortsOpen.some(Boolean)) {
    throw new Error(
      "EveJS is still running. Stop the game server before reading or applying this offline migration.",
    );
  }

  database = require(path.join(__dirname, "../src/gameStore"));
  const {
    TABLE_NAME,
    getDefaultStateStore,
  } = require(path.join(
    __dirname,
    "../src/services/industrialHirelings/industrialHirelingState",
  ));
  const {
    convertLegacyMinerContractToVentureCrew,
  } = require(path.join(
    __dirname,
    "../src/services/industrialHirelings/industrialHirelingContracts",
  ));
  const stateStore = getDefaultStateStore();
  const allContracts = stateStore.listContracts();
  const selectedContracts = allContracts.filter((contract) => (
    (!options.contractID || contract.contractID === options.contractID) &&
    String(contract.contractKind || "") !== "mining_crew" &&
    String(contract.role || "") === "miner"
  ));
  const nowMs = Date.now();
  const conversions = selectedContracts.map((contract) => (
    convertLegacyMinerContractToVentureCrew(contract, nowMs)
  ));
  const failed = conversions.find((result) => !result || result.success !== true);
  if (failed) {
    throw new Error(
      `Crew conversion failed: ${String(failed && failed.errorMsg || "unknown error")}`,
    );
  }

  const plans = conversions.map(describePlan);
  console.log(JSON.stringify({
    mode: options.apply ? "apply" : "dry-run",
    database: database._sqliteDbPath,
    selectedContractID: options.contractID || null,
    scannedContracts: allContracts.length,
    conversionCount: plans.length,
    conversions: plans,
  }, null, 2));

  if (!options.apply) {
    console.log("Dry run only. Re-run with --apply while EveJS remains stopped.");
    return;
  }

  for (const conversion of conversions) {
    const saved = stateStore.saveContract(conversion.data);
    if (!saved || saved.success !== true) {
      throw new Error(
        `Could not persist ${conversion.data.contractID}: ${String(saved && saved.errorMsg || "unknown error")}`,
      );
    }
  }
  const flushed = database.flushTableSync(TABLE_NAME);
  if (!flushed || flushed.success !== true) {
    throw new Error(
      `SQLite flush failed: ${String(flushed && flushed.errorMsg || "unknown error")}`,
    );
  }

  for (const conversion of conversions) {
    const persisted = stateStore.getContract(conversion.data.contractID);
    if (
      !persisted ||
      persisted.contractKind !== "mining_crew" ||
      persisted.crewTypeID !== "venture_crew" ||
      !Array.isArray(persisted.members) ||
      persisted.members.length !== 4 ||
      Number(persisted.runtimeFleetID) !== 0 ||
      (persisted.runtimeEntityIDs || []).length !== 0
    ) {
      throw new Error(
        `Post-write verification failed for ${conversion.data.contractID}.`,
      );
    }
  }
  console.log(`Applied and verified ${conversions.length} crew conversion(s).`);
}

main()
  .catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (
      database &&
      typeof database._shutdownPersistenceWorkerForTests === "function"
    ) {
      return database._shutdownPersistenceWorkerForTests();
    }
    return undefined;
  });
