"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_CATALOG_PATH = path.join(
  __dirname,
  "../../gameStore/data/liveEventDefinitions/data.json",
);
const ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;
const EVENT_TYPES = new Set([
  "noop",
  "industrial_mining",
  "battle_aftermath",
  "simulated_battle",
]);

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function validateDefinition(rawDefinition, index = 0) {
  const definition = cloneValue(rawDefinition || {});
  const errors = [];
  const definitionID = normalizeText(definition.definitionID);
  const eventType = normalizeText(definition.eventType).toLowerCase();
  const revision = toPositiveInt(definition.revision, 0);

  if (!ID_PATTERN.test(definitionID)) {
    errors.push(`definition[${index}].definitionID must match ${ID_PATTERN}`);
  }
  if (!EVENT_TYPES.has(eventType)) {
    errors.push(`definition[${index}].eventType is unsupported: ${eventType || "<empty>"}`);
  }
  if (revision <= 0) {
    errors.push(`definition[${index}].revision must be a positive integer`);
  }
  if (!normalizeText(definition.name)) {
    errors.push(`definition[${index}].name is required`);
  }

  const lifecycle = definition.lifecycle && typeof definition.lifecycle === "object"
    ? definition.lifecycle
    : {};
  for (const [key, value] of Object.entries(lifecycle)) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0) {
      errors.push(`definition[${index}].lifecycle.${key} must be non-negative`);
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    definition: Object.freeze({
      ...definition,
      definitionID,
      eventType,
      revision,
      enabled: definition.enabled === true,
      name: normalizeText(definition.name),
      lifecycle: Object.freeze({ ...lifecycle }),
      limits: Object.freeze({
        ...(definition.limits && typeof definition.limits === "object"
          ? definition.limits
          : {}),
      }),
      discovery: Object.freeze({
        ...(definition.discovery && typeof definition.discovery === "object"
          ? definition.discovery
          : {}),
      }),
    }),
  };
}

function createCatalog(rawCatalog = {}) {
  const schemaVersion = toPositiveInt(rawCatalog.schemaVersion, 0);
  const rawDefinitions = Array.isArray(rawCatalog.definitions)
    ? rawCatalog.definitions
    : [];
  const errors = [];
  const definitionsByID = new Map();

  if (schemaVersion <= 0) {
    errors.push("catalog.schemaVersion must be a positive integer");
  }
  for (let index = 0; index < rawDefinitions.length; index += 1) {
    const result = validateDefinition(rawDefinitions[index], index);
    if (!result.success) {
      errors.push(...result.errors);
      continue;
    }
    if (definitionsByID.has(result.definition.definitionID)) {
      errors.push(`duplicate definitionID: ${result.definition.definitionID}`);
      continue;
    }
    definitionsByID.set(result.definition.definitionID, result.definition);
  }
  if (definitionsByID.size === 0) {
    errors.push("catalog must contain at least one valid definition");
  }
  if (errors.length > 0) {
    const error = new Error(`Invalid live-event catalog:\n- ${errors.join("\n- ")}`);
    error.validationErrors = errors;
    throw error;
  }

  return Object.freeze({
    schemaVersion,
    sourceRevision: toPositiveInt(rawCatalog.sourceRevision, 1),
    getDefinition(definitionID) {
      return definitionsByID.get(normalizeText(definitionID)) || null;
    },
    listDefinitions(options = {}) {
      return [...definitionsByID.values()]
        .filter((definition) => options.includeDisabled === true || definition.enabled)
        .sort((left, right) => left.definitionID.localeCompare(right.definitionID));
    },
    hasDefinition(definitionID) {
      return definitionsByID.has(normalizeText(definitionID));
    },
  });
}

function loadCatalogFromFile(filePath = DEFAULT_CATALOG_PATH) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return createCatalog(raw);
}

let defaultCatalog = null;
function getDefaultCatalog() {
  if (!defaultCatalog) {
    defaultCatalog = loadCatalogFromFile();
  }
  return defaultCatalog;
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  EVENT_TYPES,
  createCatalog,
  getDefaultCatalog,
  loadCatalogFromFile,
  validateDefinition,
};


