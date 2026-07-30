/**
 * SQLITE PERSISTENCE BACKEND (proof-of-concept):
 *
 * A thin key/value-blob store used as the on-disk backend for selected
 * runtime tables, in place of one big data.json file per table.
 *
 * Each logical table maps to one SQL table with the shape:
 *     "<table>"(key TEXT PRIMARY KEY, json TEXT NOT NULL)
 * i.e. one row per top-level entity, with the entity record stored as a
 * JSON blob. This keeps the existing nested-object cache semantics in
 * server/src/gameStore/index.js completely intact — SQLite is only the
 * durable container — while giving us:
 *   - ACID writes (no more whole-file-rewrite corruption window), and
 *   - per-row upserts (a change to one character no longer rewrites the
 *     entire table file).
 *
 * The store is intentionally tiny and synchronous (better-sqlite3) so it
 * slots in behind the existing synchronous read/write/remove API without
 * forcing any consumer to become async.
 */

const fs = require("fs");
const path = require("path");

let Database = null;
let db = null;
let dbPath = null;

// SQL identifiers are interpolated into DDL/DML, so hard-fail on anything
// that is not a plain table name. Every real table name is camelCase ascii.
const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/;
const INTERNAL_TABLE_NAMES = new Set(["_migrations", "_persistence_outbox"]);

const ensuredTables = new Set();
const upsertStatements = new Map();
const deleteStatements = new Map();

function assertSafeTableName(table) {
  if (!SAFE_TABLE_NAME.test(String(table || ""))) {
    throw new Error(`unsafe sqlite table name: ${JSON.stringify(table)}`);
  }
  return table;
}

// ── Nested-row ("wrapper") tables ───────────────────────────────────
// Most tables are flat: each top-level key is an entity, stored one row per
// key. A few tables nest their entities one level under a named group (e.g.
// notifications.boxes[characterID], wormholeRuntimeState.pairsByID[pairID]).
// For those, storing the whole group as one row means a change to a single
// entity rewrites the entire group blob. Opt a table in here and its entities
// are stored one row per entity (key "group\u001fentityID"), so one change is
// one small row. Everything not listed is unchanged (flat).
const ROW_GROUPS = {
  notifications: ["boxes"],
  miningRuntimeState: ["systems"],
  npcRuntimeState: [
    "livingUniverseActorsV2",
    "livingUniverseFlightsV2",
    "livingUniverseEncountersV2",
  ],
  industrialHirelingContracts: ["contracts", "archive"],
  liveEventRuntime: ["events", "transactions", "archive"],
  livingEconomyEventJournal: ["eventsByID"],
  xEveRuntime: [
    "accountsByID",
    "transactionsByID",
    "inboxByID",
    "outboxByID",
    "workOrdersByID",
    "receiptsByOperationID",
    "sourceEventsByID",
  ],
  wormholeRuntimeState: ["pairsByID", "staticSlotsByKey", "polarizationByCharacter"],
  alliances: ["records"],
  bookmarkFolders: ["records"],
  bookmarkGroups: ["records"],
  bookmarkKnownFolders: ["recordsByCharacterID"],
  bookmarks: ["records"],
  calendarEvents: ["events"],
  calendarResponses: ["responses"],
  characterEnergyState: ["characters"],
  corporationBills: ["bills", "automaticPaySettingsByOwner"],
  corporationGoals: ["goalsByID"],
  corporationRuntime: [
    "corporations", "alliances", "wars", "warNegotiations",
    "mutualWarInvites", "mutualWarInviteBlocks", "peaceTreaties",
  ],
  dungeonRuntimeState: ["instancesByID"],
  industryBlueprintState: ["records"],
  industryJobs: ["jobs"],
  industryRuntime: ["monitors"],
  insuranceContracts: ["contractsByShipID", "contractHistoryByID", "payoutLedgerByLossID"],
  lpWallets: ["characterWallets", "corporationWallets"],
  miningLedger: ["characters", "observers"],
  killRights: ["rights", "activations"],
  killmails: ["records"],
  mail: ["messages", "mailboxes", "mailingLists"],
  mapTelemetry: ["visitsByCharacterID"],
  missionRuntimeState: ["charactersByID"],
  moduleGroupingState: ["ships"],
  moonExtractions: ["resourcesByStructureID", "extractions"],
  npcEntities: ["entities"],
  npcModules: ["modules"],
  npcRuntimeControllers: ["controllers"],
  overviewSharedPresets: ["entries"],
  planetOrbitalState: ["orbitalsByID"],
  planetRuntimeState: [
    "resourcesByPlanetID", "coloniesByKey", "launchesByID", "acceptedNetworkEditsByKey",
  ],
  playerBounties: ["pools", "contributions", "hunterStats"],
  rafflesRuntime: ["reservations"],
  savedFittings: ["owners"],
  sharedSettings: ["entries"],
  shipCosmetics: ["characters", "ships"],
  shipDirt: ["ships"],
  shipKillCounters: ["ships"],
  solarSystemInterferenceState: ["systems"],
  sovereignty: ["alliances", "systems", "hubs", "skyhooks", "mercenaryDens", "resources"],
  structurePaintwork: ["catalogueByTypeID", "licensesByID", "structureAssignments"],
  structureProfiles: ["profilesByID"],
  structureTetherRestrictions: ["restrictions"],
  // Empty today; wrapper shapes confirmed from each owning service's defaults.
  bookmarkSubfolders: ["records", "recordsByCharacterID"],
  corporationVotes: ["corporations"],
  evermarkEntitlements: ["characters"],
  pendingNpcBounties: ["npcTypes"],
  probeRuntimeState: ["probesByID"],
  shipLogoFittings: ["ships"],
  chatState: ["channels", "privateChannelByPair"],
  chatStaticContracts: ["observations"],
  chatBacklog: ["entriesByRoomName"],
};
const ROW_KEY_SEP = "\u001f";

function rowGroupsFor(table) {
  return ROW_GROUPS[table] || null;
}

/**
 * Flatten a nested table object into the `{ rowKey: value }` map actually
 * stored as SQLite rows. For a configured group it emits one row per entity
 * (`group\u001fentityID`) plus a skeleton `group` row, so a group that is
 * present but empty still round-trips. Flat tables pass through unchanged.
 */
function explodeToRows(table, object = {}) {
  const groups = rowGroupsFor(table);
  const rows = {};
  for (const key of Object.keys(object || {})) {
    const value = object[key];
    const isGroup =
      groups &&
      groups.includes(key) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value);
    if (isGroup) {
      rows[key] = {}; // skeleton: records that the group exists (even if empty)
      for (const entityKey of Object.keys(value)) {
        if (String(entityKey).includes(ROW_KEY_SEP)) {
          throw new Error(
            `entity key contains reserved separator: ${table}.${key}.${entityKey}`,
          );
        }
        rows[`${key}${ROW_KEY_SEP}${entityKey}`] = value[entityKey];
      }
    } else {
      rows[key] = value;
    }
  }
  return rows;
}

/**
 * Inverse of explodeToRows: rebuild the nested table object from the flat
 * `{ rowKey: value }` row map. Order-independent and lossless.
 */
function assembleFromRows(table, rows = {}) {
  const groups = new Set(rowGroupsFor(table) || []);
  const object = {};
  for (const rowKey of Object.keys(rows)) {
    const sepIndex = rowKey.indexOf(ROW_KEY_SEP);
    if (sepIndex >= 0) {
      const group = rowKey.slice(0, sepIndex);
      const entityKey = rowKey.slice(sepIndex + 1);
      if (!object[group] || typeof object[group] !== "object") {
        object[group] = {};
      }
      object[group][entityKey] = rows[rowKey];
    } else if (groups.has(rowKey)) {
      // Group container row. In the per-entity format this is an empty skeleton.
      // A not-yet-reconverted install may still hold the whole group blob here
      // (from before the split) — merge it in without clobbering per-entity rows,
      // so the first flush cleanly converts it.
      const blob =
        rows[rowKey] && typeof rows[rowKey] === "object" && !Array.isArray(rows[rowKey])
          ? rows[rowKey]
          : {};
      object[rowKey] = { ...blob, ...(object[rowKey] || {}) };
    } else {
      object[rowKey] = rows[rowKey];
    }
  }
  return object;
}

/**
 * Resolve the value of a SINGLE stored row directly from a nested table object,
 * without exploding the whole table. This is the per-row counterpart to
 * explodeToRows used by the gameStore dirty-row flush fast path, and it MUST
 * mirror explodeToRows exactly:
 *   - `groupentity`  -> object[group][entity]   (the entity record)
 *   - bare group key       -> {}                       (the empty skeleton row)
 *   - flat / scalar key    -> object[key]
 *   - any absent key       -> undefined                (signals a deleted row)
 * The equivalence to explodeToRows()[rowKey] is pinned by a guard test.
 */
function rowValueForKey(table, object, rowKey) {
  const source = object && typeof object === "object" ? object : {};
  const sepIndex = String(rowKey).indexOf(ROW_KEY_SEP);
  if (sepIndex >= 0) {
    const group = rowKey.slice(0, sepIndex);
    const entityKey = rowKey.slice(sepIndex + 1);
    const groupValue = source[group];
    if (
      groupValue &&
      typeof groupValue === "object" &&
      !Array.isArray(groupValue) &&
      Object.prototype.hasOwnProperty.call(groupValue, entityKey)
    ) {
      return groupValue[entityKey];
    }
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(source, rowKey)) {
    return undefined;
  }
  const value = source[rowKey];
  const groups = rowGroupsFor(table);
  const isGroup =
    groups &&
    groups.includes(rowKey) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value);
  return isGroup ? {} : value;
}

/**
 * Open (or create) the backing SQLite database. Idempotent: calling it
 * again with the same path is a no-op. WAL mode lets the running server
 * keep writing while a tool (DB Browser, DBeaver) reads the file.
 */
function init(targetPath) {
  if (db && dbPath === targetPath) {
    return db;
  }
  if (db && dbPath !== targetPath) {
    close();
  }
  if (!Database) {
    Database = require("better-sqlite3");
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  db = new Database(targetPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // The persistence worker (when enabled) opens a SECOND connection to this same
  // WAL database for off-loop writes, while the main thread keeps a connection
  // for reads/preload. WAL serializes writers across connections; a non-zero
  // busy_timeout makes a momentarily-locked connection wait instead of erroring
  // with SQLITE_BUSY. Harmless for the single-connection (worker-disabled) case.
  db.pragma("busy_timeout = 5000");
  // Large page cache keeps the working set in SQLite's own memory instead of
  // relying on the OS page cache, which matters on FUSE-backed volumes (Docker
  // Desktop on WSL2) where every page miss costs ~100-500 us through the
  // translation layer. Default -2000 (8 MB) is far too small for the combined
  // SDE static data + X-Eve + Living Universe runtime state (~200-800 MB).
  db.pragma("cache_size = -200000");
  // Memory-mapped I/O lets the kernel map database pages directly into the
  // process address space. Hot-page access bypasses the read() syscall and
  // avoids the FUSE round-trip entirely for pages that are already faulted in.
  // 256 MB covers the frequently-read SDE reference tables and active runtime
  // state without risking swap on memory-constrained Docker nodes.
  db.pragma("mmap_size = 268435456");
  // The WAL checkpoint threshold is raised from the default 1000 pages (~4 MB)
  // to 10 000 pages (~40 MB). The patch adds multiple continuous-write loops
  // (Living Universe persist 5-30 s, Living Economy 15 s, X-Eve 2 s). With the
  // default threshold every ~4 MB of writes triggers a full checkpoint scan,
  // which on a FUSE-backed volume can take seconds and never catch up, creating
  // a permanent I/O storm of 2 GB/s+ sustained reads.
  db.pragma("wal_autocheckpoint = 10000");
  // Hard cap on the WAL file so a checkpoint backlog never consumes the volume.
  db.pragma("journal_size_limit = 67108864");
  // Tracks which tables have already been seeded from their legacy data.json so
  // a lazy re-seed never resurrects rows that were intentionally deleted.
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (table_name TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)",
  );
  // Durable handoff journal for asynchronous persistence writes. The
  // AUTOINCREMENT sequence is intentionally never reset: operation identities
  // must not be reused after an acknowledged row is deleted or the process is
  // restarted. Only one unresolved operation may exist for a logical table, so
  // same-table writes cannot be applied out of order.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _persistence_outbox (
      operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL UNIQUE,
      upserts_json TEXT NOT NULL,
      deletes_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'applied')),
      created_at TEXT NOT NULL,
      applied_at TEXT
    )
  `);
  dbPath = targetPath;
  return db;
}

function isMigrated(table) {
  assertSafeTableName(table);
  return Boolean(
    requireDb().prepare("SELECT 1 FROM _migrations WHERE table_name = ?").get(table),
  );
}

function markMigrated(table) {
  assertSafeTableName(table);
  requireDb()
    .prepare(
      `INSERT INTO _migrations(table_name, migrated_at) VALUES (?, ?)
       ON CONFLICT(table_name) DO NOTHING`,
    )
    .run(table, new Date().toISOString());
}

function requireDb() {
  if (!db) {
    throw new Error("sqliteStore.init(dbPath) must be called before use");
  }
  return db;
}

function ensureSqlTable(table) {
  assertSafeTableName(table);
  if (ensuredTables.has(table)) {
    return;
  }
  requireDb().exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  );
  ensuredTables.add(table);
}

function getUpsertStatement(table) {
  if (!upsertStatements.has(table)) {
    upsertStatements.set(
      table,
      requireDb().prepare(
        `INSERT INTO "${table}"(key, json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
      ),
    );
  }
  return upsertStatements.get(table);
}

function getDeleteStatement(table) {
  if (!deleteStatements.has(table)) {
    deleteStatements.set(
      table,
      requireDb().prepare(`DELETE FROM "${table}" WHERE key = ?`),
    );
  }
  return deleteStatements.get(table);
}

function normalizePersistenceOperationId(operationId) {
  if (!Number.isSafeInteger(operationId) || operationId <= 0) {
    throw new Error(
      `invalid persistence operation ID: ${JSON.stringify(operationId)}`,
    );
  }
  return operationId;
}

function normalizePersistenceTable(table, label = "persistence table") {
  if (typeof table !== "string") {
    throw new Error(`${label} must be a string`);
  }
  assertSafeTableName(table);
  if (INTERNAL_TABLE_NAMES.has(table.toLowerCase()) || /^sqlite_/i.test(table)) {
    throw new Error(`${label} may not name an internal SQLite table`);
  }
  return table;
}

function validatePersistenceUpserts(upserts, label = "persistence upserts") {
  if (!Array.isArray(upserts)) {
    throw new Error(`${label} must be an array`);
  }
  return upserts.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${label}[${index}] must be a [key, json] pair`);
    }
    const [key, json] = entry;
    if (typeof key !== "string") {
      throw new Error(`${label}[${index}][0] must be a string key`);
    }
    if (typeof json !== "string") {
      throw new Error(`${label}[${index}][1] must be a JSON string`);
    }
    try {
      JSON.parse(json);
    } catch (error) {
      throw new Error(
        `${label}[${index}][1] is not valid JSON: ${error.message}`,
      );
    }
    return [key, json];
  });
}

function validatePersistenceDeletes(deletes, label = "persistence deletes") {
  if (!Array.isArray(deletes)) {
    throw new Error(`${label} must be an array`);
  }
  return deletes.map((key, index) => {
    if (typeof key !== "string") {
      throw new Error(`${label}[${index}] must be a string key`);
    }
    return key;
  });
}

function parsePersistencePayload(raw, label, operationId) {
  if (typeof raw !== "string") {
    throw new Error(
      `persistence operation ${operationId} has a non-string ${label} payload`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `persistence operation ${operationId} has malformed ${label} JSON: ${error.message}`,
    );
  }
}

function parsePersistenceOperationRow(row) {
  if (!row) {
    return null;
  }
  const operationId = normalizePersistenceOperationId(row.operation_id);
  const table = normalizePersistenceTable(
    row.table_name,
    `persistence operation ${operationId} table`,
  );
  const upserts = validatePersistenceUpserts(
    parsePersistencePayload(row.upserts_json, "upserts", operationId),
    `persistence operation ${operationId} upserts`,
  );
  const deletes = validatePersistenceDeletes(
    parsePersistencePayload(row.deletes_json, "deletes", operationId),
    `persistence operation ${operationId} deletes`,
  );
  if (row.state !== "pending" && row.state !== "applied") {
    throw new Error(
      `persistence operation ${operationId} has invalid state: ${JSON.stringify(row.state)}`,
    );
  }
  if (typeof row.created_at !== "string" || row.created_at.length === 0) {
    throw new Error(`persistence operation ${operationId} has invalid created_at`);
  }
  if (row.state === "pending" && row.applied_at !== null) {
    throw new Error(
      `pending persistence operation ${operationId} unexpectedly has applied_at`,
    );
  }
  if (
    row.state === "applied" &&
    (typeof row.applied_at !== "string" || row.applied_at.length === 0)
  ) {
    throw new Error(
      `applied persistence operation ${operationId} is missing applied_at`,
    );
  }
  return {
    operationId,
    table,
    upserts,
    deletes,
    state: row.state,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

function persistenceOperationSelectSql(whereClause = "") {
  return `SELECT operation_id, table_name, upserts_json, deletes_json,
                 state, created_at, applied_at
          FROM _persistence_outbox ${whereClause}`;
}

function getPersistenceOperation(operationId) {
  const normalizedId = normalizePersistenceOperationId(operationId);
  const row = requireDb()
    .prepare(persistenceOperationSelectSql("WHERE operation_id = ?"))
    .get(normalizedId);
  return parsePersistenceOperationRow(row);
}

function listPersistenceOperations() {
  return requireDb()
    .prepare(persistenceOperationSelectSql("ORDER BY operation_id ASC"))
    .all()
    .map(parsePersistenceOperationRow);
}

function assertExpectedPersistenceTable(operation, expectedTable) {
  const normalizedTable = normalizePersistenceTable(
    expectedTable,
    "expected persistence table",
  );
  if (operation.table !== normalizedTable) {
    throw new Error(
      `persistence operation ${operation.operationId} targets ${operation.table}, not ${normalizedTable}`,
    );
  }
  return normalizedTable;
}

function enqueuePersistenceOperation(table, upserts = [], deletes = []) {
  const normalizedTable = normalizePersistenceTable(table);
  const normalizedUpserts = validatePersistenceUpserts(upserts);
  const normalizedDeletes = validatePersistenceDeletes(deletes);
  const createdAt = new Date().toISOString();

  // Make creation of the target table precede journal insertion. A durable
  // outbox row must always name a table that exact replay can write.
  ensureSqlTable(normalizedTable);
  const result = requireDb()
    .prepare(
      `INSERT INTO _persistence_outbox(
         table_name, upserts_json, deletes_json, state, created_at, applied_at
       ) VALUES (?, ?, ?, 'pending', ?, NULL)`,
    )
    .run(
      normalizedTable,
      JSON.stringify(normalizedUpserts),
      JSON.stringify(normalizedDeletes),
      createdAt,
    );
  const operationId = normalizePersistenceOperationId(result.lastInsertRowid);
  return {
    operationId,
    table: normalizedTable,
    upserts: normalizedUpserts,
    deletes: normalizedDeletes,
    state: "pending",
    createdAt,
    appliedAt: null,
  };
}

function applyChangeStatements(table, upserts, deletes) {
  const upsert = getUpsertStatement(table);
  const remove = getDeleteStatement(table);
  for (const [key, json] of upserts) {
    upsert.run(String(key), json);
  }
  for (const key of deletes) {
    remove.run(String(key));
  }
  return upserts.length + deletes.length;
}

function applyPersistenceOperation(operationId, expectedTable) {
  const normalizedId = normalizePersistenceOperationId(operationId);
  const normalizedExpectedTable =
    expectedTable === undefined
      ? undefined
      : normalizePersistenceTable(
        expectedTable,
        "expected persistence table",
      );
  const txn = requireDb().transaction(() => {
    const operation = getPersistenceOperation(normalizedId);
    if (!operation) {
      // A stale worker may begin after synchronous reconciliation removed the
      // row. Treat the already-reconciled operation as a harmless no-op.
      return null;
    }
    if (normalizedExpectedTable !== undefined) {
      assertExpectedPersistenceTable(operation, normalizedExpectedTable);
    }
    applyChangeStatements(
      operation.table,
      operation.upserts,
      operation.deletes,
    );
    const appliedAt = operation.appliedAt || new Date().toISOString();
    const updated = requireDb()
      .prepare(
        `UPDATE _persistence_outbox
         SET state = 'applied', applied_at = ?
         WHERE operation_id = ? AND table_name = ?`,
      )
      .run(appliedAt, operation.operationId, operation.table);
    if (updated.changes !== 1) {
      throw new Error(
        `failed to mark persistence operation ${operation.operationId} applied`,
      );
    }
    return {
      ...operation,
      state: "applied",
      appliedAt,
    };
  });
  return txn.immediate();
}

function acknowledgePersistenceOperation(operationId, expectedTable) {
  const normalizedId = normalizePersistenceOperationId(operationId);
  normalizePersistenceTable(expectedTable, "expected persistence table");
  const txn = requireDb().transaction(() => {
    const operation = getPersistenceOperation(normalizedId);
    if (!operation) {
      throw new Error(`persistence operation ${normalizedId} does not exist`);
    }
    assertExpectedPersistenceTable(operation, expectedTable);
    if (operation.state !== "applied") {
      throw new Error(
        `persistence operation ${normalizedId} cannot be acknowledged from state ${operation.state}`,
      );
    }
    const removed = requireDb()
      .prepare(
        `DELETE FROM _persistence_outbox
         WHERE operation_id = ? AND table_name = ? AND state = 'applied'`,
      )
      .run(operation.operationId, operation.table);
    if (removed.changes !== 1) {
      throw new Error(
        `failed to acknowledge persistence operation ${operation.operationId}`,
      );
    }
    return operation;
  });
  return txn.immediate();
}

function reconcilePersistenceOperation(operationId, expectedTable) {
  const normalizedId = normalizePersistenceOperationId(operationId);
  normalizePersistenceTable(expectedTable, "expected persistence table");
  const txn = requireDb().transaction(() => {
    const operation = getPersistenceOperation(normalizedId);
    if (!operation) {
      return null;
    }
    assertExpectedPersistenceTable(operation, expectedTable);
    applyChangeStatements(
      operation.table,
      operation.upserts,
      operation.deletes,
    );
    const removed = requireDb()
      .prepare(
        "DELETE FROM _persistence_outbox WHERE operation_id = ? AND table_name = ?",
      )
      .run(operation.operationId, operation.table);
    if (removed.changes !== 1) {
      throw new Error(
        `failed to reconcile persistence operation ${operation.operationId}`,
      );
    }
    return {
      ...operation,
      state: "applied",
      appliedAt: operation.appliedAt || new Date().toISOString(),
    };
  });
  return txn.immediate();
}

function recoverPersistenceOperations() {
  // Read, validate, replay, and remove the entire journal in one transaction.
  // Any malformed record or failed table write rolls back every change and
  // leaves every recovery record intact.
  const txn = requireDb().transaction(() => {
    const operations = listPersistenceOperations();
    const recovered = [];
    for (const operation of operations) {
      applyChangeStatements(
        operation.table,
        operation.upserts,
        operation.deletes,
      );
      const removed = requireDb()
        .prepare(
          "DELETE FROM _persistence_outbox WHERE operation_id = ? AND table_name = ?",
        )
        .run(operation.operationId, operation.table);
      if (removed.changes !== 1) {
        throw new Error(
          `failed to recover persistence operation ${operation.operationId}`,
        );
      }
      recovered.push({
        ...operation,
        state: "applied",
        appliedAt: operation.appliedAt || new Date().toISOString(),
      });
    }
    return recovered;
  });
  return txn.immediate();
}

// Raw `[{ key, json }]` rows as stored — index.js uses these to build both the
// in-memory cache (assembled) and its per-row flush baseline.
function loadRows(table) {
  ensureSqlTable(table);
  return requireDb().prepare(`SELECT key, json FROM "${table}"`).all();
}

/**
 * Load an entire table into the nested object index.js caches in memory —
 * assembling wrapper tables back from their per-entity rows.
 */
function loadTableObject(table) {
  const parsed = {};
  for (const row of loadRows(table)) {
    parsed[row.key] = JSON.parse(row.json);
  }
  return assembleFromRows(table, parsed);
}

/**
 * Apply a batch of row changes in a single transaction.
 * @param {Array<[string, string]>} upserts  [key, jsonString] pairs to write.
 * @param {Array<string>} deletes            keys to remove.
 * @returns {number} number of rows touched.
 */
function applyChanges(table, upserts = [], deletes = []) {
  if (upserts.length === 0 && deletes.length === 0) {
    return 0;
  }
  ensureSqlTable(table);
  const txn = requireDb().transaction(() =>
    applyChangeStatements(table, upserts, deletes),
  );
  return txn();
}

/**
 * Replace the full contents of a table from a plain object (used by the
 * one-shot JSON → SQLite importer).
 */
function replaceAll(table, object = {}) {
  ensureSqlTable(table);
  const rows = explodeToRows(table, object);
  const rowKeys = Object.keys(rows);
  const upsert = getUpsertStatement(table);
  const txn = requireDb().transaction(() => {
    requireDb().exec(`DELETE FROM "${table}"`);
    for (const rowKey of rowKeys) {
      upsert.run(String(rowKey), JSON.stringify(rows[rowKey]));
    }
  });
  txn();
  return rowKeys.length;
}

function rowCount(table) {
  ensureSqlTable(table);
  return requireDb().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
}

function getDatabasePath() {
  return dbPath;
}

function close() {
  if (db) {
    db.close();
  }
  db = null;
  dbPath = null;
  ensuredTables.clear();
  upsertStatements.clear();
  deleteStatements.clear();
}

module.exports = {
  init,
  ensureSqlTable,
  isMigrated,
  markMigrated,
  loadRows,
  loadTableObject,
  explodeToRows,
  assembleFromRows,
  rowValueForKey,
  rowGroupsFor,
  ROW_KEY_SEP,
  enqueuePersistenceOperation,
  getPersistenceOperation,
  listPersistenceOperations,
  applyPersistenceOperation,
  acknowledgePersistenceOperation,
  reconcilePersistenceOperation,
  recoverPersistenceOperations,
  applyChanges,
  replaceAll,
  rowCount,
  getDatabasePath,
  close,
};
