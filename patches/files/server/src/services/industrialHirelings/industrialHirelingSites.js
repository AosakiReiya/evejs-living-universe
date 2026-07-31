"use strict";

const path = require("path");

function getDefaultWorldData() {
  return require(path.join(__dirname, "../../space/worldData"));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toFiniteNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createIndustrialMiningSiteCatalog(options = {}) {
  const worldData = options.worldData || getDefaultWorldData();

  function getSystem(systemIDArg) {
    const systemID = toPositiveInt(systemIDArg, 0);
    if (!systemID || typeof worldData.getSolarSystemByID !== "function") {
      return null;
    }
    return worldData.getSolarSystemByID(systemID) || null;
  }

  function getSite(siteIDArg) {
    const siteID = toPositiveInt(siteIDArg, 0);
    if (!siteID || typeof worldData.getAsteroidBeltByID !== "function") {
      return null;
    }
    const belt = worldData.getAsteroidBeltByID(siteID) || null;
    const systemID = toPositiveInt(belt && belt.solarSystemID, 0);
    return belt && systemID && getSystem(systemID)
      ? belt
      : null;
  }

  function describeSite(siteArg) {
    const site = siteArg && typeof siteArg === "object" ? siteArg : getSite(siteArg);
    const siteID = toPositiveInt(site && site.itemID, 0);
    const systemID = toPositiveInt(site && site.solarSystemID, 0);
    if (!siteID || !systemID) return null;
    return {
      siteID,
      siteName: String(site.itemName || `Asteroid Belt ${siteID}`),
      siteType: "asteroid_belt",
      systemID,
    };
  }

  function describeSystem(systemArg) {
    const system = systemArg && typeof systemArg === "object" ? systemArg : getSystem(systemArg);
    const systemID = toPositiveInt(system && system.solarSystemID, 0);
    if (!systemID) return null;
    return {
      systemID,
      systemName: String(system.solarSystemName || `System ${systemID}`),
      securityStatus: toFiniteNumberOrNull(system.security ?? system.securityStatus),
      securityClass: String(system.securityClass || "").trim() || null,
    };
  }

  function listSitesForSystem(systemIDArg) {
    const systemID = toPositiveInt(systemIDArg, 0);
    if (
      !systemID ||
      !getSystem(systemID) ||
      typeof worldData.getAsteroidBeltsForSystem !== "function"
    ) {
      return [];
    }
    return worldData.getAsteroidBeltsForSystem(systemID)
      .map(describeSite)
      .filter(Boolean)
      .sort((left, right) => left.siteID - right.siteID);
  }

  function surveySystems(systemIDsArg = [], surveyOptions = {}) {
    const assignedSiteIDs = new Set(
      (Array.isArray(surveyOptions.assignedSiteIDs) ? surveyOptions.assignedSiteIDs : [])
        .map((value) => toPositiveInt(value, 0))
        .filter(Boolean),
    );
    const assignedContractIDsBySiteID = new Map();
    const suppliedAssignments = surveyOptions.assignedContractIDsBySiteID;
    if (suppliedAssignments && typeof suppliedAssignments === "object") {
      const entries = suppliedAssignments instanceof Map
        ? [...suppliedAssignments.entries()]
        : Object.entries(suppliedAssignments);
      for (const [siteIDArg, contractIDsArg] of entries) {
        const siteID = toPositiveInt(siteIDArg, 0);
        if (!siteID) continue;
        const contractIDs = [...new Set(
          (Array.isArray(contractIDsArg) ? contractIDsArg : [contractIDsArg])
            .map((value) => String(value || "").trim())
            .filter(Boolean),
        )].sort();
        if (contractIDs.length > 0) {
          assignedSiteIDs.add(siteID);
          assignedContractIDsBySiteID.set(siteID, contractIDs);
        }
      }
    }
    const systemIDs = [...new Set(
      (Array.isArray(systemIDsArg) ? systemIDsArg : [])
        .map((value) => toPositiveInt(value, 0))
        .filter(Boolean),
    )].sort((left, right) => left - right);
    return systemIDs
      .map((systemID) => {
        const described = describeSystem(systemID);
        if (!described) return null;
        return {
          ...described,
          sites: listSitesForSystem(systemID).map((site) => {
            const assignedContractIDs = assignedContractIDsBySiteID.get(site.siteID) || [];
            const availability = assignedSiteIDs.has(site.siteID) ? "assigned" : "available";
            return {
              ...site,
              status: availability,
              availability,
              assignedContractID: assignedContractIDs[0] || null,
              assignedContractIDs,
            };
          }),
        };
      })
      .filter(Boolean);
  }

  function validateSite(siteIDArg, expectedSystemIDArg = 0) {
    const siteID = toPositiveInt(siteIDArg, 0);
    const expectedSystemID = toPositiveInt(expectedSystemIDArg, 0);
    const site = getSite(siteID);
    if (!site) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_FOUND" };
    }
    const systemID = toPositiveInt(site.solarSystemID, 0);
    if (expectedSystemID > 0 && expectedSystemID !== systemID) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_SITE_SYSTEM_MISMATCH",
      };
    }
    return {
      success: true,
      data: {
        site,
        siteDescription: describeSite(site),
        system: getSystem(systemID),
        systemDescription: describeSystem(systemID),
      },
    };
  }

  function getSystemIDForLocation(locationIDArg) {
    const locationID = toPositiveInt(locationIDArg, 0);
    if (!locationID) return 0;
    const station = typeof worldData.getStationByID === "function"
      ? worldData.getStationByID(locationID) || null
      : null;
    if (station) return toPositiveInt(station.solarSystemID, 0);
    const structure = typeof worldData.getStructureByID === "function"
      ? worldData.getStructureByID(locationID) || null
      : null;
    return toPositiveInt(
      structure && (structure.solarSystemID || structure.systemID),
      0,
    );
  }

  return Object.freeze({
    describeSite,
    describeSystem,
    getSite,
    getSystem,
    getSystemIDForLocation,
    listSitesForSystem,
    surveySystems,
    validateSite,
  });
}

let defaultCatalog = null;
function getDefaultIndustrialMiningSiteCatalog() {
  if (!defaultCatalog) {
    defaultCatalog = createIndustrialMiningSiteCatalog();
  }
  return defaultCatalog;
}

module.exports = {
  createIndustrialMiningSiteCatalog,
  getDefaultIndustrialMiningSiteCatalog,
};
