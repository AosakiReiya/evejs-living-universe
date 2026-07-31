"use strict";

/**
 * Phase 0 / 0.C — ownership-aware repository (state-mediation seam).
 *
 * A thin wrapper over the gameStore API that consults the table ownership map
 * and enforces that a domain only MUTATES (write/remove/ensureTable) tables it
 * owns. This is the seam that, in a later phase, becomes "route the mutation
 * to the owning node" instead of "touch the shared cache" — so introducing it
 * now, and migrating call sites onto it domain-by-domain, is what makes the
 * eventual partitioning mechanical.
 *
 * Scope of enforcement (deliberately conservative for Phase 0):
 *   - WRITES (write/remove/ensureTable): a repository bound to domain D may
 *     mutate a table only if the ownership map assigns that table to D.
 *   - SHARED seams (domain "shared"): a DORMANT capability, not a current
 *     policy. The map classifies NO table as "shared" today —
 *     characters/items/skills/accounts were rerouted to single-writer owners
 *     (tableOwnership.js), so isSharedSeam()/onSharedWrite are unexercised.
 *     Classifying a table "shared" is a deliberate opt-in to multi-writer
 *     access (any domain may mutate it); the wrapper surfaces such writes via
 *     onSharedWrite so a genuine cross-domain seam — the kind Phase 3 must
 *     make an explicit transaction — can be audited if one is reintroduced.
 *   - READS: unrestricted and pass straight through (the open 0.B read-
 *     mediation gap). Cross-domain reads are a separate, later concern;
 *     restricting them now would break everything.
 *
 * Adopted by ~33 domain owner modules (Phase 0 / 0.C) and shipped with a pure
 * policy test (server/tests/tableRepository.test.js). The gameStore dependency
 * is injectable (`options.store`) so the policy is testable without opening the
 * database.
 */

const ownership = require("./tableOwnership");

class OwnershipViolationError extends Error {
  constructor(domain, table, ownerDomain) {
    super(
      `domain "${domain}" may not mutate table "${table}" ` +
        `(owned by ${ownerDomain || "no classified owner"}). ` +
        `Use the owning domain's repository, or reclassify in tableOwnership.js.`,
    );
    this.name = "OwnershipViolationError";
    this.domain = domain;
    this.table = table;
    this.ownerDomain = ownerDomain || null;
  }
}

/** True if `domain` is the classified owner of `table`. */
function domainOwns(domain, table) {
  const entry = ownership.getTableOwnership(table);
  return entry !== null && entry.domain === domain;
}

/** True if `table` is a cross-domain shared seam. */
function isSharedSeam(table) {
  const entry = ownership.getTableOwnership(table);
  return entry !== null && entry.domain === "shared";
}

/**
 * Decide whether `domain` may mutate `table`.
 * Returns { allowed, shared, ownerDomain }. Pure — no gameStore access.
 */
function evaluateWrite(domain, table) {
  const entry = ownership.getTableOwnership(table);
  const ownerDomain = entry ? entry.domain : null;
  if (isSharedSeam(table)) {
    return { allowed: true, shared: true, ownerDomain };
  }
  return { allowed: domainOwns(domain, table), shared: false, ownerDomain };
}

/**
 * Create a repository bound to an ownership domain (e.g. "service:mail",
 * "in-space"). Options:
 *   - strict (default true): throw OwnershipViolationError on a disallowed
 *     mutation. When false, the violation is reported via onViolation (if
 *     given) and the mutation is allowed through — useful while migrating.
 *   - allowSharedWrites (default true): permit writes to shared seams (no table
 *     is classified "shared" today — dormant; see header).
 *   - onSharedWrite(table, op): called when a shared seam is mutated.
 *   - onViolation(domain, table, op, ownerDomain): called on a disallowed
 *     mutation (before throwing, or instead of throwing in non-strict mode).
 *   - store: gameStore-shaped backend (defaults to the real gameStore). Lazily
 *     required so tests that inject a fake never open the database.
 */
function createTableRepository(domain, options = {}) {
  if (typeof domain !== "string" || domain.trim() === "") {
    throw new Error("createTableRepository requires a non-empty domain string");
  }
  const strict = options.strict !== false;
  const allowSharedWrites = options.allowSharedWrites !== false;
  const onSharedWrite = typeof options.onSharedWrite === "function" ? options.onSharedWrite : null;
  const onViolation = typeof options.onViolation === "function" ? options.onViolation : null;
  const store = options.store || require("./index");

  function guard(table, op) {
    const { allowed, shared, ownerDomain } = evaluateWrite(domain, table);
    if (shared) {
      if (!allowSharedWrites) {
        if (onViolation) onViolation(domain, table, op, ownerDomain);
        if (strict) throw new OwnershipViolationError(domain, table, ownerDomain);
        return;
      }
      if (onSharedWrite) onSharedWrite(table, op);
      return;
    }
    if (!allowed) {
      if (onViolation) onViolation(domain, table, op, ownerDomain);
      if (strict) throw new OwnershipViolationError(domain, table, ownerDomain);
    }
  }

  return {
    domain,
    // Reads pass through unrestricted.
    read: (table, pathArg) => store.read(table, pathArg),
    tableExists: (table) => store.tableExists(table),
    // Mutations are guarded by ownership.
    write: (table, pathArg, value, opts) => {
      guard(table, "write");
      return store.write(table, pathArg, value, opts);
    },
    remove: (table, pathArg) => {
      guard(table, "remove");
      return store.remove(table, pathArg);
    },
    ensureTable: (table) => {
      guard(table, "ensureTable");
      return store.ensureTable(table);
    },
    // Persistence/lifecycle passthroughs — NOT ownership-gated. Flushing
    // persists already-written cache to disk; it is not a data mutation, so a
    // domain may flush without owning the table. Lets the repo be a complete
    // drop-in for the raw gameStore in owner modules.
    flushTableAsync: (table) => store.flushTableAsync(table),
    flushTableSync: (table) => store.flushTableSync(table),
    flushTablesSync: (tables) => store.flushTablesSync(tables),
    flushAllSync: () => store.flushAllSync(),
    registerTableFlushPrerequisite: (table, key, callback) =>
      typeof store.registerTableFlushPrerequisite === "function"
        ? store.registerTableFlushPrerequisite(table, key, callback)
        : { success: false, errorMsg: "FLUSH_PREREQUISITE_UNSUPPORTED" },
    unregisterTableFlushPrerequisite: (table, key) =>
      typeof store.unregisterTableFlushPrerequisite === "function"
        ? store.unregisterTableFlushPrerequisite(table, key)
        : { success: true, unsupported: true },
    setTableAutoFlush: (table, enabled) =>
      typeof store.setTableAutoFlush === "function"
        ? store.setTableAutoFlush(table, enabled)
        : { success: true, unsupported: true },
    suspendTableFlush: (table, reason) => store.suspendTableFlush(table, reason),
    resumeTableFlush: (table) => store.resumeTableFlush(table),
    // Transient-path marking is the dual of flushing: it selects which already
    // -written cache paths are EXCLUDED from the disk snapshot. Like flush, it
    // is a persistence-policy hint rather than a data mutation, so it shares the
    // same non-gated lifecycle bucket (and the gameStore applies it internally
    // for `write(..., { transient: true })`).
    setTransientPath: (table, pathArg, enabled) =>
      store.setTransientPath(table, pathArg, enabled),
  };
}

module.exports = {
  OwnershipViolationError,
  domainOwns,
  isSharedSeam,
  evaluateWrite,
  createTableRepository,
};
