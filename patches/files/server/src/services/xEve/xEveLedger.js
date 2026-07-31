"use strict";

const crypto = require("crypto");

const { getDefaultStateStore } = require("./xEveState");

const CURRENCY = "ISK";
const LEDGER_SCHEMA_VERSION = 1;
const SYSTEM_ACCOUNTS = Object.freeze({
  OPENING_EQUITY: "system:opening-equity",
  EXTERNAL_ISSUANCE: "system:external-issuance",
  EXTERNAL_RETIREMENT: "system:external-retirement",
});
const SYSTEM_ACCOUNT_DEFINITIONS = Object.freeze([
  {
    accountID: SYSTEM_ACCOUNTS.OPENING_EQUITY,
    name: "Opening balance equity",
    category: "equity",
    ownerType: "system",
    ownerID: "x-eve",
    allowNegative: true,
    countsTowardMoneySupply: false,
  },
  {
    accountID: SYSTEM_ACCOUNTS.EXTERNAL_ISSUANCE,
    name: "Named ISK issuance boundary",
    category: "issuance",
    ownerType: "system",
    ownerID: "x-eve",
    allowNegative: true,
    countsTowardMoneySupply: false,
  },
  {
    accountID: SYSTEM_ACCOUNTS.EXTERNAL_RETIREMENT,
    name: "Named ISK retirement boundary",
    category: "retirement",
    ownerType: "system",
    ownerID: "x-eve",
    allowNegative: true,
    countsTowardMoneySupply: false,
  },
]);
const SYSTEM_ACCOUNT_IDS = new Set(SYSTEM_ACCOUNT_DEFINITIONS.map(({ accountID }) => accountID));

class XEveLedgerError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "XEveLedgerError";
    this.code = code;
    this.details = details;
  }
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeID(value, code) {
  const normalized = normalizeText(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)) {
    throw new XEveLedgerError(code, `${code}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizeCents(value, code = "X_EVE_AMOUNT_INVALID") {
  const raw = typeof value === "bigint" ? value.toString() : String(value == null ? "" : value).trim();
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new XEveLedgerError(code, `${code}: amounts must be integer cents encoded as decimal strings`);
  }
  return BigInt(raw).toString();
}

function normalizeNowMs(value = Date.now()) {
  const numeric = Number(value);
  return Math.max(0, Math.trunc(Number.isFinite(numeric) ? numeric : Date.now()));
}

function mustSucceed(result, code) {
  if (!result || result.success !== true) {
    throw new XEveLedgerError(code, result && result.errorMsg || code);
  }
  return result;
}

function errorResult(error) {
  return {
    success: false,
    errorMsg: error && error.code || "X_EVE_LEDGER_ERROR",
    details: cloneValue(error && error.details || null),
  };
}

function validateSystemBoundaryPostings(transaction) {
  const rules = new Map([
    [SYSTEM_ACCOUNTS.OPENING_EQUITY, { kind: "opening_balance", sign: -1 }],
    [SYSTEM_ACCOUNTS.EXTERNAL_ISSUANCE, { kind: "issuance", sign: -1 }],
    [SYSTEM_ACCOUNTS.EXTERNAL_RETIREMENT, { kind: "retirement", sign: 1 }],
  ]);
  const boundaryPostings = transaction.postings.filter((posting) => rules.has(posting.accountID));
  if (boundaryPostings.length > 1) {
    throw new XEveLedgerError("X_EVE_MULTIPLE_BOUNDARIES_FORBIDDEN");
  }
  if (boundaryPostings.length === 0) {
    if (["opening_balance", "issuance", "retirement"].includes(transaction.kind)) {
      throw new XEveLedgerError("X_EVE_REQUIRED_BOUNDARY_MISSING");
    }
    return;
  }
  const posting = boundaryPostings[0];
  const rule = rules.get(posting.accountID);
  const amount = BigInt(posting.amountCents);
  if (transaction.kind !== rule.kind) {
    throw new XEveLedgerError(
      "X_EVE_BOUNDARY_KIND_FORBIDDEN",
      `${posting.accountID} may only be used by ${rule.kind} transactions`,
    );
  }
  if ((rule.sign < 0 && amount >= 0n) || (rule.sign > 0 && amount <= 0n)) {
    throw new XEveLedgerError("X_EVE_BOUNDARY_DIRECTION_FORBIDDEN");
  }
}

function validateMoneySupplyChange(transaction, moneySupplyDelta) {
  const delta = BigInt(moneySupplyDelta);
  if (transaction.kind === "opening_balance" || transaction.kind === "issuance") {
    if (delta <= 0n) {
      throw new XEveLedgerError("X_EVE_MONEY_SUPPLY_DIRECTION_INVALID");
    }
    return;
  }
  if (transaction.kind === "retirement") {
    if (delta >= 0n) {
      throw new XEveLedgerError("X_EVE_MONEY_SUPPLY_DIRECTION_INVALID");
    }
    return;
  }
  if (delta !== 0n) {
    throw new XEveLedgerError(
      "X_EVE_UNNAMED_MONEY_SUPPLY_CHANGE",
      "Ordinary transfers cannot change tracked ISK supply",
      { moneySupplyDeltaCents: delta.toString() },
    );
  }
}

function createLedger(options = {}) {
  const stateStore = options.stateStore || getDefaultStateStore();
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  let commitInProgress = false;
  let healthy = true;
  let lastIntegrityError = null;
  const systemBootstrapToken = Symbol("x-eve-system-bootstrap");

  function poisonLedger(error) {
    healthy = false;
    lastIntegrityError = error && (error.code || error.message) || "X_EVE_LEDGER_UNCERTAIN";
    try {
      if (typeof stateStore.suspendPersistence === "function") {
        stateStore.suspendPersistence(lastIntegrityError);
      }
    } catch (_suspensionError) {
      // The unhealthy latch still blocks commits if the persistence quarantine
      // itself is unavailable. The original integrity error remains primary.
    }
  }

  function assertLedgerHealthy() {
    if (!healthy) {
      throw new XEveLedgerError(
        "X_EVE_LEDGER_UNHEALTHY",
        "Ledger commits are blocked until a clean audit/recovery succeeds",
        { lastIntegrityError },
      );
    }
  }

  function ensureInitialized(nowMs = clock(), initializeOptions = {}) {
    try {
      mustSucceed(stateStore.ensureInitialized(nowMs), "X_EVE_STATE_INIT_FAILED");
      for (const definition of SYSTEM_ACCOUNT_DEFINITIONS) {
        const result = createAccount(definition, {
          nowMs,
          durable: false,
          systemBootstrapToken,
        });
        if (!result.success) return result;
      }
      if (initializeOptions.durable === true) {
        mustSucceed(stateStore.flushDurably(), "X_EVE_LEDGER_FLUSH_FAILED");
      }
      return { success: true, data: getStatus() };
    } catch (error) {
      if (error && error.code === "X_EVE_STATE_READ_FAILED") poisonLedger(error);
      return errorResult(error);
    }
  }

  function normalizeAccountDefinition(raw = {}, nowMs = clock()) {
    const accountID = normalizeID(raw.accountID, "X_EVE_ACCOUNT_ID_INVALID");
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      accountID,
      currency: CURRENCY,
      name: normalizeText(raw.name, accountID),
      category: normalizeText(raw.category, "cash").toLowerCase(),
      ownerType: normalizeText(raw.ownerType, "aggregate").toLowerCase(),
      ownerID: normalizeText(raw.ownerID, accountID),
      allowNegative: raw.allowNegative === true,
      countsTowardMoneySupply: raw.countsTowardMoneySupply !== false,
      balanceCents: "0",
      createdAtMs: normalizeNowMs(nowMs),
      updatedAtMs: normalizeNowMs(nowMs),
      metadata: cloneValue(raw.metadata || {}),
    };
  }

  function accountDefinitionFingerprint(account) {
    return fingerprint({
      accountID: account.accountID,
      currency: account.currency,
      name: account.name,
      category: account.category,
      ownerType: account.ownerType,
      ownerID: account.ownerID,
      allowNegative: account.allowNegative,
      countsTowardMoneySupply: account.countsTowardMoneySupply,
      metadata: account.metadata,
    });
  }

  function createAccount(raw = {}, createOptions = {}) {
    let createdAccountID = null;
    let originalMeta = null;
    try {
      assertLedgerHealthy();
      const nowMs = normalizeNowMs(createOptions.nowMs == null ? clock() : createOptions.nowMs);
      mustSucceed(stateStore.ensureInitialized(nowMs), "X_EVE_STATE_INIT_FAILED");
      const account = normalizeAccountDefinition(raw, nowMs);
      if (
        SYSTEM_ACCOUNT_IDS.has(account.accountID) &&
        createOptions.systemBootstrapToken !== systemBootstrapToken
      ) {
        throw new XEveLedgerError(
          "X_EVE_SYSTEM_ACCOUNT_RESERVED",
          `${account.accountID} can only be created by ledger bootstrap`,
        );
      }
      const existing = stateStore.getAccount(account.accountID);
      if (existing) {
        const sameDefinition = accountDefinitionFingerprint(existing) === accountDefinitionFingerprint(account);
        if (!sameDefinition) {
          throw new XEveLedgerError("X_EVE_ACCOUNT_CONFLICT", "Account ID already has a different definition");
        }
        if (createOptions.durable !== false) {
          mustSucceed(stateStore.flushDurably(), "X_EVE_LEDGER_FLUSH_FAILED");
        }
        return { success: true, replayed: true, data: cloneValue(existing) };
      }
      originalMeta = stateStore.getMeta() || {};
      mustSucceed(stateStore.saveAccount(account), "X_EVE_ACCOUNT_WRITE_FAILED");
      createdAccountID = account.accountID;
      const meta = originalMeta;
      mustSucceed(stateStore.saveMeta({
        ...meta,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        createdAtMs: normalizeNowMs(meta.createdAtMs == null ? nowMs : meta.createdAtMs),
        updatedAtMs: nowMs,
        accountCount: Math.max(0, Math.trunc(Number(meta.accountCount) || 0)) + 1,
        committedTransactionCount: Math.max(0, Math.trunc(Number(meta.committedTransactionCount) || 0)),
        postingCount: Math.max(0, Math.trunc(Number(meta.postingCount) || 0)),
        moneySupplyCents: normalizeCents(meta.moneySupplyCents == null ? "0" : meta.moneySupplyCents),
        ledgerImbalanceCents: normalizeCents(meta.ledgerImbalanceCents == null ? "0" : meta.ledgerImbalanceCents),
      }), "X_EVE_META_WRITE_FAILED");
      if (createOptions.durable !== false) {
        mustSucceed(stateStore.flushDurably(), "X_EVE_LEDGER_FLUSH_FAILED");
      }
      return { success: true, replayed: false, data: cloneValue(account) };
    } catch (error) {
      if (createdAccountID && typeof stateStore.removeAccount === "function") {
        try {
          mustSucceed(stateStore.removeAccount(createdAccountID), "X_EVE_ACCOUNT_RESTORE_FAILED");
          if (originalMeta) {
            mustSucceed(stateStore.saveMeta(originalMeta), "X_EVE_META_RESTORE_FAILED");
          }
          if (createOptions.durable !== false) {
            mustSucceed(stateStore.flushDurably(), "X_EVE_ACCOUNT_RESTORE_FLUSH_FAILED");
          }
        } catch (restoreError) {
          poisonLedger(restoreError);
          return errorResult(new XEveLedgerError(
            "X_EVE_LEDGER_UNCERTAIN",
            "Account creation failed and its rollback could not be proven",
            { cause: error && error.code, restoreError: restoreError && restoreError.code },
          ));
        }
      }
      if (error && error.code === "X_EVE_STATE_READ_FAILED") poisonLedger(error);
      return errorResult(error);
    }
  }

  function normalizeTransaction(raw = {}, nowMs = clock()) {
    const transactionID = normalizeID(raw.transactionID, "X_EVE_TRANSACTION_ID_INVALID");
    if (!Array.isArray(raw.postings) || raw.postings.length < 2) {
      throw new XEveLedgerError("X_EVE_POSTINGS_REQUIRED", "A transaction needs at least two postings");
    }
    const postings = raw.postings.map((posting, index) => {
      const amountCents = normalizeCents(posting && posting.amountCents);
      if (amountCents === "0") {
        throw new XEveLedgerError("X_EVE_ZERO_POSTING", `Posting ${index} has a zero amount`);
      }
      return {
        accountID: normalizeID(posting && posting.accountID, "X_EVE_ACCOUNT_ID_INVALID"),
        amountCents,
        memo: normalizeText(posting && posting.memo),
      };
    });
    if (new Set(postings.map((posting) => posting.accountID)).size < 2) {
      throw new XEveLedgerError("X_EVE_DISTINCT_ACCOUNTS_REQUIRED");
    }
    const sum = postings.reduce((total, posting) => total + BigInt(posting.amountCents), 0n);
    if (sum !== 0n) {
      throw new XEveLedgerError("X_EVE_UNBALANCED_TRANSACTION", "ISK postings must sum exactly to zero", {
        imbalanceCents: sum.toString(),
      });
    }
    const effectiveAtMs = normalizeNowMs(raw.effectiveAtMs == null ? nowMs : raw.effectiveAtMs);
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      transactionID,
      kind: normalizeText(raw.kind, "transfer").toLowerCase(),
      currency: CURRENCY,
      sourceEventID: raw.sourceEventID
        ? normalizeID(raw.sourceEventID, "X_EVE_SOURCE_EVENT_ID_INVALID")
        : null,
      effectiveAtMs,
      postings,
      metadata: cloneValue(raw.metadata || {}),
    };
  }

  function transactionFingerprint(transaction) {
    return fingerprint({
      transactionID: transaction.transactionID,
      kind: transaction.kind,
      currency: transaction.currency,
      sourceEventID: transaction.sourceEventID,
      effectiveAtMs: transaction.effectiveAtMs,
      postings: transaction.postings,
      metadata: transaction.metadata,
    });
  }

  function commit(raw = {}, commitOptions = {}) {
    let originals = [];
    let originalMeta = null;
    let prepared = null;
    let sourceIndexCreated = false;
    try {
      assertLedgerHealthy();
      if (commitInProgress) {
        throw new XEveLedgerError("X_EVE_LEDGER_BUSY", "A re-entrant ledger commit was rejected");
      }
      const nowMs = normalizeNowMs(commitOptions.nowMs == null ? clock() : commitOptions.nowMs);
      mustSucceed(stateStore.ensureInitialized(nowMs), "X_EVE_STATE_INIT_FAILED");
      const requestedTransactionID = normalizeID(
        raw.transactionID,
        "X_EVE_TRANSACTION_ID_INVALID",
      );
      const prior = stateStore.getTransaction(requestedTransactionID);
      const normalized = normalizeTransaction({
        ...raw,
        effectiveAtMs: raw.effectiveAtMs == null && prior
          ? prior.effectiveAtMs
          : raw.effectiveAtMs,
      }, nowMs);
      validateSystemBoundaryPostings(normalized);
      const requestFingerprint = transactionFingerprint(normalized);
      const sourceIndex = normalized.sourceEventID
        ? stateStore.getSourceEvent(normalized.sourceEventID)
        : null;
      if (sourceIndex) {
        if (
          sourceIndex.transactionID !== normalized.transactionID ||
          sourceIndex.requestFingerprint !== requestFingerprint
        ) {
          throw new XEveLedgerError(
            "X_EVE_SOURCE_EVENT_CONFLICT",
            "The authoritative source event is already mapped to another transaction",
            {
              sourceEventID: normalized.sourceEventID,
              transactionID: sourceIndex.transactionID,
            },
          );
        }
      }
      const existing = prior;
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new XEveLedgerError(
            "X_EVE_TRANSACTION_CONFLICT",
            "The transaction ID was already used with a different payload",
          );
        }
        if (existing.status === "committed" && normalized.sourceEventID && !sourceIndex) {
          const integrityError = new XEveLedgerError(
            "X_EVE_SOURCE_INDEX_MISSING",
            "A committed source transaction is missing its durable source-event index",
            { sourceEventID: normalized.sourceEventID, transactionID: normalized.transactionID },
          );
          poisonLedger(integrityError);
          throw integrityError;
        }
        if (commitOptions.durable !== false) {
          mustSucceed(stateStore.flushDurably(), "X_EVE_LEDGER_FLUSH_FAILED");
        }
        return {
          success: existing.status === "committed",
          errorMsg: existing.status === "committed" ? null : "X_EVE_TRANSACTION_PREVIOUSLY_FAILED",
          replayed: true,
          data: cloneValue(existing),
        };
      }

      const deltas = new Map();
      const accounts = new Map();
      for (const posting of normalized.postings) {
        const account = accounts.get(posting.accountID) || stateStore.getAccount(posting.accountID);
        if (!account) {
          throw new XEveLedgerError("X_EVE_ACCOUNT_NOT_FOUND", `Unknown account ${posting.accountID}`);
        }
        accounts.set(posting.accountID, account);
        deltas.set(
          posting.accountID,
          (deltas.get(posting.accountID) || 0n) + BigInt(posting.amountCents),
        );
      }

      const updatedAccounts = [];
      let moneySupplyDelta = 0n;
      for (const [accountID, delta] of deltas) {
        const account = accounts.get(accountID);
        const oldBalance = BigInt(normalizeCents(account.balanceCents));
        const nextBalance = oldBalance + delta;
        if (nextBalance < 0n && account.allowNegative !== true) {
          throw new XEveLedgerError("X_EVE_INSUFFICIENT_FUNDS", `Account ${accountID} cannot become negative`, {
            accountID,
            balanceCents: oldBalance.toString(),
            attemptedDeltaCents: delta.toString(),
          });
        }
        if (account.countsTowardMoneySupply === true) moneySupplyDelta += delta;
        updatedAccounts.push({
          ...account,
          balanceCents: nextBalance.toString(),
          updatedAtMs: nowMs,
        });
      }
      validateMoneySupplyChange(normalized, moneySupplyDelta);

      const meta = stateStore.getMeta() || {};
      originalMeta = cloneValue(meta);
      prepared = {
        ...normalized,
        requestFingerprint,
        status: "prepared",
        createdAtMs: nowMs,
        committedAtMs: 0,
        failure: null,
      };

      commitInProgress = true;
      originals = [...accounts.values()].map(cloneValue);
      mustSucceed(stateStore.saveTransaction(prepared), "X_EVE_TRANSACTION_WRITE_FAILED");
      for (const account of updatedAccounts) {
        mustSucceed(stateStore.saveAccount(account), "X_EVE_ACCOUNT_WRITE_FAILED");
      }
      const committed = {
        ...prepared,
        status: "committed",
        committedAtMs: nowMs,
      };
      mustSucceed(stateStore.saveTransaction(committed), "X_EVE_TRANSACTION_WRITE_FAILED");
      mustSucceed(stateStore.saveMeta({
        ...meta,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        createdAtMs: normalizeNowMs(meta.createdAtMs == null ? nowMs : meta.createdAtMs),
        updatedAtMs: nowMs,
        committedTransactionCount: Math.max(0, Math.trunc(Number(meta.committedTransactionCount) || 0)) + 1,
        postingCount: Math.max(0, Math.trunc(Number(meta.postingCount) || 0)) + normalized.postings.length,
        moneySupplyCents: (BigInt(normalizeCents(meta.moneySupplyCents == null ? "0" : meta.moneySupplyCents)) + moneySupplyDelta).toString(),
        ledgerImbalanceCents: "0",
        lastCommittedTransactionID: normalized.transactionID,
        lastCommittedAtMs: nowMs,
      }), "X_EVE_META_WRITE_FAILED");
      if (normalized.sourceEventID) {
        mustSucceed(stateStore.saveSourceEvent({
          sourceEventID: normalized.sourceEventID,
          transactionID: normalized.transactionID,
          requestFingerprint,
          committedAtMs: nowMs,
        }), "X_EVE_SOURCE_INDEX_WRITE_FAILED");
        sourceIndexCreated = true;
      }
      if (commitOptions.durable !== false) {
        mustSucceed(stateStore.flushDurably(), "X_EVE_LEDGER_FLUSH_FAILED");
      }
      return { success: true, replayed: false, data: cloneValue(committed) };
    } catch (error) {
      if (commitInProgress && prepared) {
        try {
          for (const account of originals) {
            mustSucceed(stateStore.saveAccount(account), "X_EVE_ACCOUNT_RESTORE_FAILED");
          }
          if (originalMeta) {
            mustSucceed(stateStore.saveMeta(originalMeta), "X_EVE_META_RESTORE_FAILED");
          }
          if (sourceIndexCreated && prepared.sourceEventID) {
            mustSucceed(
              stateStore.removeSourceEvent(prepared.sourceEventID),
              "X_EVE_SOURCE_INDEX_RESTORE_FAILED",
            );
          }
          mustSucceed(stateStore.saveTransaction({
            ...prepared,
            status: "failed",
            failedAtMs: normalizeNowMs(clock()),
            failure: error && error.code || "X_EVE_LEDGER_ERROR",
          }), "X_EVE_FAILED_TRANSACTION_WRITE_FAILED");
          if (commitOptions.durable !== false) {
            mustSucceed(stateStore.flushDurably(), "X_EVE_RESTORE_FLUSH_FAILED");
          }
        } catch (restoreError) {
          poisonLedger(restoreError);
          return errorResult(new XEveLedgerError(
            "X_EVE_LEDGER_UNCERTAIN",
            "A transaction failed after preparation and rollback could not be proven",
            { cause: error && error.code, restoreError: restoreError && restoreError.code },
          ));
        }
      }
      if (error && error.code === "X_EVE_STATE_READ_FAILED") poisonLedger(error);
      return errorResult(error);
    } finally {
      commitInProgress = false;
    }
  }

  function openBalance(raw = {}, operationOptions = {}) {
    try {
      const initialized = ensureInitialized(
        operationOptions.nowMs == null ? clock() : operationOptions.nowMs,
        { durable: false },
      );
      if (!initialized.success) return initialized;
      const accountID = normalizeID(raw.accountID, "X_EVE_ACCOUNT_ID_INVALID");
      const amountCents = normalizeCents(raw.amountCents);
      if (BigInt(amountCents) <= 0n) throw new XEveLedgerError("X_EVE_AMOUNT_MUST_BE_POSITIVE");
      return commit({
        transactionID: raw.transactionID,
        kind: "opening_balance",
        sourceEventID: raw.sourceEventID,
        effectiveAtMs: raw.effectiveAtMs,
        postings: [
          { accountID, amountCents, memo: raw.memo || "Opening balance" },
          {
            accountID: SYSTEM_ACCOUNTS.OPENING_EQUITY,
            amountCents: (-BigInt(amountCents)).toString(),
            memo: raw.memo || "Opening balance boundary",
          },
        ],
        metadata: { boundary: "opening-equity", ...cloneValue(raw.metadata || {}) },
      }, operationOptions);
    } catch (error) {
      return errorResult(error);
    }
  }

  function transfer(raw = {}, operationOptions = {}) {
    try {
      const amountCents = normalizeCents(raw.amountCents);
      if (BigInt(amountCents) <= 0n) throw new XEveLedgerError("X_EVE_AMOUNT_MUST_BE_POSITIVE");
      return commit({
        transactionID: raw.transactionID,
        kind: raw.kind || "transfer",
        sourceEventID: raw.sourceEventID,
        effectiveAtMs: raw.effectiveAtMs,
        postings: [
          { accountID: raw.fromAccountID, amountCents: (-BigInt(amountCents)).toString(), memo: raw.memo },
          { accountID: raw.toAccountID, amountCents, memo: raw.memo },
        ],
        metadata: cloneValue(raw.metadata || {}),
      }, operationOptions);
    } catch (error) {
      return errorResult(error);
    }
  }

  function issue(raw = {}, operationOptions = {}) {
    const initialized = ensureInitialized(
      operationOptions.nowMs == null ? clock() : operationOptions.nowMs,
      { durable: false },
    );
    if (!initialized.success) return initialized;
    return transfer({
      ...raw,
      kind: "issuance",
      fromAccountID: SYSTEM_ACCOUNTS.EXTERNAL_ISSUANCE,
      toAccountID: raw.toAccountID,
      metadata: { boundary: "external-issuance", ...cloneValue(raw.metadata || {}) },
    }, operationOptions);
  }

  function retire(raw = {}, operationOptions = {}) {
    const initialized = ensureInitialized(
      operationOptions.nowMs == null ? clock() : operationOptions.nowMs,
      { durable: false },
    );
    if (!initialized.success) return initialized;
    return transfer({
      ...raw,
      kind: "retirement",
      fromAccountID: raw.fromAccountID,
      toAccountID: SYSTEM_ACCOUNTS.EXTERNAL_RETIREMENT,
      metadata: { boundary: "external-retirement", ...cloneValue(raw.metadata || {}) },
    }, operationOptions);
  }

  function audit() {
    try {
      const accounts = stateStore.listAccounts();
      const transactions = stateStore.listTransactions();
      const sourceEvents = stateStore.listSourceEvents();
      const meta = stateStore.getMeta() || {};
      const accountIDs = new Set(accounts.map((account) => account.accountID));
      const accountsByID = new Map(accounts.map((account) => [account.accountID, account]));
      const expectedBalances = new Map(accounts.map((account) => [account.accountID, 0n]));
      let ledgerImbalance = 0n;
      let committedTransactionCount = 0;
      let postingCount = 0;
      const unbalancedTransactionIDs = [];
      const interruptedTransactionIDs = [];
      const invalidTransactionIDs = [];
      const invalidMoneySupplyTransactionIDs = [];
      const duplicateSourceEventIDs = [];
      const committedTransactionsByID = new Map();
      const committedTransactionsBySourceEventID = new Map();
      for (const transaction of transactions) {
        if (!transaction) continue;
        if (!["committed", "failed"].includes(transaction.status)) {
          interruptedTransactionIDs.push(transaction.transactionID || "UNKNOWN");
          continue;
        }
        if (transaction.status !== "committed") continue;
        committedTransactionCount += 1;
        let normalized = null;
        try {
          normalized = normalizeTransaction(
            transaction,
            transaction.createdAtMs == null ? transaction.effectiveAtMs : transaction.createdAtMs,
          );
          if (transaction.requestFingerprint !== transactionFingerprint(normalized)) {
            throw new XEveLedgerError("X_EVE_TRANSACTION_FINGERPRINT_INVALID");
          }
        } catch (_error) {
          invalidTransactionIDs.push(transaction.transactionID || "UNKNOWN");
          continue;
        }
        committedTransactionsByID.set(normalized.transactionID, {
          ...normalized,
          requestFingerprint: transaction.requestFingerprint,
        });
        if (normalized.sourceEventID) {
          if (committedTransactionsBySourceEventID.has(normalized.sourceEventID)) {
            duplicateSourceEventIDs.push(normalized.sourceEventID);
          } else {
            committedTransactionsBySourceEventID.set(normalized.sourceEventID, normalized.transactionID);
          }
        }
        let transactionSum = 0n;
        let transactionMoneySupplyDelta = 0n;
        for (const posting of normalized.postings) {
          const amount = BigInt(normalizeCents(posting.amountCents));
          transactionSum += amount;
          const account = accountsByID.get(posting.accountID);
          if (account && account.countsTowardMoneySupply === true) {
            transactionMoneySupplyDelta += amount;
          }
          postingCount += 1;
          expectedBalances.set(
            posting.accountID,
            (expectedBalances.get(posting.accountID) || 0n) + amount,
          );
        }
        if (transactionSum !== 0n) {
          unbalancedTransactionIDs.push(transaction.transactionID || "UNKNOWN");
        }
        try {
          validateSystemBoundaryPostings(normalized);
          validateMoneySupplyChange(normalized, transactionMoneySupplyDelta);
        } catch (_error) {
          invalidMoneySupplyTransactionIDs.push(transaction.transactionID || "UNKNOWN");
        }
        ledgerImbalance += transactionSum;
      }
      const balanceMismatches = [];
      const missingAccountIDs = [...expectedBalances.keys()]
        .filter((accountID) => !accountIDs.has(accountID))
        .sort();
      const negativeBoundedAccounts = [];
      let moneySupply = 0n;
      for (const account of accounts) {
        const actual = BigInt(normalizeCents(account.balanceCents));
        const expected = expectedBalances.get(account.accountID) || 0n;
        if (actual !== expected) {
          balanceMismatches.push({
            accountID: account.accountID,
            expectedCents: expected.toString(),
            actualCents: actual.toString(),
          });
        }
        if (actual < 0n && account.allowNegative !== true) {
          negativeBoundedAccounts.push({
            accountID: account.accountID,
            balanceCents: actual.toString(),
          });
        }
        if (account.countsTowardMoneySupply === true) moneySupply += actual;
      }
      const sourceEventIndexMismatches = [];
      const sourceEventIndexByID = new Map(sourceEvents.map((entry) => [entry.sourceEventID, entry]));
      for (const [sourceEventID, transactionID] of committedTransactionsBySourceEventID) {
        const transaction = committedTransactionsByID.get(transactionID);
        const indexed = sourceEventIndexByID.get(sourceEventID);
        if (
          !indexed ||
          indexed.transactionID !== transactionID ||
          indexed.requestFingerprint !== transaction.requestFingerprint
        ) {
          sourceEventIndexMismatches.push({ sourceEventID, transactionID, problem: "missing_or_mismatched" });
        }
      }
      for (const indexed of sourceEvents) {
        const transaction = committedTransactionsByID.get(indexed.transactionID);
        if (
          !transaction ||
          transaction.sourceEventID !== indexed.sourceEventID ||
          transaction.requestFingerprint !== indexed.requestFingerprint
        ) {
          sourceEventIndexMismatches.push({
            sourceEventID: indexed.sourceEventID,
            transactionID: indexed.transactionID,
            problem: "orphaned_or_mismatched",
          });
        }
      }
      const systemAccountMismatches = [];
      for (const definition of SYSTEM_ACCOUNT_DEFINITIONS) {
        const account = accounts.find(({ accountID }) => accountID === definition.accountID);
        if (!account) {
          systemAccountMismatches.push({
            accountID: definition.accountID,
            problem: "missing",
          });
          continue;
        }
        const expectedDefinition = normalizeAccountDefinition(definition, account.createdAtMs);
        if (accountDefinitionFingerprint(account) !== accountDefinitionFingerprint(expectedDefinition)) {
          systemAccountMismatches.push({
            accountID: definition.accountID,
            problem: "definition_mismatch",
          });
        }
      }
      const metadataMismatches = [];
      const expectedMetadata = {
        accountCount: accounts.length,
        committedTransactionCount,
        postingCount,
        moneySupplyCents: moneySupply.toString(),
        ledgerImbalanceCents: ledgerImbalance.toString(),
      };
      for (const [field, expected] of Object.entries(expectedMetadata)) {
        const actual = field.endsWith("Cents")
          ? normalizeCents(meta[field] == null ? "0" : meta[field])
          : Math.max(0, Math.trunc(Number(meta[field]) || 0));
        if (String(actual) !== String(expected)) {
          metadataMismatches.push({ field, expected: String(expected), actual: String(actual) });
        }
      }
      return {
        success:
          ledgerImbalance === 0n &&
          unbalancedTransactionIDs.length === 0 &&
          interruptedTransactionIDs.length === 0 &&
          invalidTransactionIDs.length === 0 &&
          invalidMoneySupplyTransactionIDs.length === 0 &&
          duplicateSourceEventIDs.length === 0 &&
          sourceEventIndexMismatches.length === 0 &&
          balanceMismatches.length === 0 &&
          missingAccountIDs.length === 0 &&
          negativeBoundedAccounts.length === 0 &&
          systemAccountMismatches.length === 0 &&
          metadataMismatches.length === 0,
        data: {
          accountCount: accounts.length,
          committedTransactionCount,
          postingCount,
          moneySupplyCents: moneySupply.toString(),
          ledgerImbalanceCents: ledgerImbalance.toString(),
          unbalancedTransactionIDs,
          interruptedTransactionIDs,
          invalidTransactionIDs,
          invalidMoneySupplyTransactionIDs,
          duplicateSourceEventIDs: [...new Set(duplicateSourceEventIDs)].sort(),
          sourceEventIndexMismatches,
          balanceMismatches,
          missingAccountIDs,
          negativeBoundedAccounts,
          systemAccountMismatches,
          metadataMismatches,
        },
      };
    } catch (error) {
      if (error && error.code === "X_EVE_STATE_READ_FAILED") poisonLedger(error);
      return errorResult(error);
    }
  }

  function getStatus() {
    const meta = stateStore.getMeta() || {};
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      currency: CURRENCY,
      healthy,
      lastIntegrityError,
      accountCount: Math.max(0, Math.trunc(Number(meta.accountCount) || 0)),
      transactionCount: Math.max(0, Math.trunc(Number(meta.committedTransactionCount) || 0)),
      postingCount: Math.max(0, Math.trunc(Number(meta.postingCount) || 0)),
      moneySupplyCents: normalizeCents(meta.moneySupplyCents == null ? "0" : meta.moneySupplyCents),
      ledgerImbalanceCents: normalizeCents(meta.ledgerImbalanceCents == null ? "0" : meta.ledgerImbalanceCents),
      lastCommittedTransactionID: meta.lastCommittedTransactionID || null,
      lastCommittedAtMs: normalizeNowMs(meta.lastCommittedAtMs || 0),
    };
  }

  function recover() {
    try {
      const result = audit();
      if (!result || result.success !== true) {
        poisonLedger(new XEveLedgerError("X_EVE_RECOVERY_AUDIT_FAILED"));
        return {
          success: false,
          errorMsg: "X_EVE_RECOVERY_AUDIT_FAILED",
          data: result && result.data || null,
        };
      }
      if (typeof stateStore.resumePersistence === "function") {
        mustSucceed(stateStore.resumePersistence(), "X_EVE_RECOVERY_RESUME_FAILED");
      }
      mustSucceed(stateStore.flushDurably(), "X_EVE_RECOVERY_FLUSH_FAILED");
      healthy = true;
      lastIntegrityError = null;
      return { success: true, data: result.data };
    } catch (error) {
      poisonLedger(error);
      return errorResult(error);
    }
  }

  return Object.freeze({
    audit,
    commit,
    createAccount,
    ensureInitialized,
    getAccount: (accountID) => stateStore.getAccount(accountID),
    getStatus,
    getTransaction: (transactionID) => stateStore.getTransaction(transactionID),
    issue,
    openBalance,
    recover,
    retire,
    transfer,
  });
}

module.exports = {
  CURRENCY,
  LEDGER_SCHEMA_VERSION,
  SYSTEM_ACCOUNTS,
  SYSTEM_ACCOUNT_DEFINITIONS,
  XEveLedgerError,
  createLedger,
  fingerprint,
  normalizeCents,
  validateSystemBoundaryPostings,
  validateMoneySupplyChange,
};
