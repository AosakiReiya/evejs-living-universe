const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const sessionRegistry = require(path.join(
  __dirname,
  "../chat/sessionRegistry",
));
const { currentFileTime } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const {
  CORPORATION_RUNTIME_TABLE,
  getCorporationRuntime,
  updateCorporationRuntime,
} = require(path.join(__dirname, "./corporationRuntimeState"));

const CORPORATION_WALLET_KEY_START = 1000;
const CORPORATION_WALLET_KEY_END = 1006;
const MAX_JOURNAL_ENTRIES = 100;
const MAX_TRANSACTION_ENTRIES = 2000;
const MAX_MARKET_TRANSACTION_ENTRIES = 2000;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const LAST_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric * 100) / 100;
}

function buildMarshalRealMoney(value, fallback = 0) {
  return {
    type: "real",
    value: normalizeMoney(value, fallback),
  };
}

function normalizeCorporationWalletKey(rawValue) {
  const numeric = Number(rawValue);
  if (Number.isInteger(numeric)) {
    if (numeric >= CORPORATION_WALLET_KEY_START && numeric <= CORPORATION_WALLET_KEY_END) {
      return numeric;
    }
  }

  const text = String(rawValue || "").trim().toLowerCase();
  if (text === "cash") {
    return CORPORATION_WALLET_KEY_START;
  }
  const match = /^cash([2-7])$/.exec(text);
  if (match) {
    return CORPORATION_WALLET_KEY_START + Number(match[1]) - 1;
  }

  return CORPORATION_WALLET_KEY_START;
}

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(numeric));
}

function getCorporationWalletKeyName(accountKey) {
  const normalizedKey = normalizeCorporationWalletKey(accountKey);
  const offset = normalizedKey - CORPORATION_WALLET_KEY_START;
  return offset <= 0 ? "cash" : `cash${offset + 1}`;
}

function buildLedgerEntry(corporationID, accountKey, amount, balance, options = {}) {
  const timestamp = currentFileTime().toString();
  const transactionID = Number(Date.now()) * 100 + Math.floor(Math.random() * 100);
  const description =
    Object.prototype.hasOwnProperty.call(options, "description") &&
    typeof options.description === "string"
      ? options.description
      : "Corporation wallet balance change";
  return {
    transactionID,
    transactionDate: timestamp,
    referenceID: Number(options.referenceID || transactionID) || transactionID,
    entryTypeID: Number(options.entryTypeID || 10) || 10,
    ownerID1: Number(options.ownerID1 || corporationID) || corporationID,
    ownerID2: Number(options.ownerID2 || 0) || 0,
    accountKey,
    amount: normalizeMoney(amount, 0),
    balance: normalizeMoney(balance, 0),
    description,
    currency: Number(options.currency || 1) || 1,
    sortValue: Number(options.sortValue || 1) || 1,
  };
}

function normalizeMarketTransactionEntry(entry = {}, accountKey = CORPORATION_WALLET_KEY_START) {
  const normalizedAccountKey = normalizeCorporationWalletKey(
    entry.keyID ?? entry.accountKey ?? entry.accountID ?? accountKey,
  );
  return {
    transactionID: normalizePositiveInteger(entry.transactionID, 0),
    transactionDate:
      typeof entry.transactionDate === "bigint"
        ? entry.transactionDate.toString()
        : String(entry.transactionDate || "0"),
    typeID: normalizePositiveInteger(entry.typeID, 0),
    quantity: normalizePositiveInteger(entry.quantity, 0),
    price: normalizeMoney(entry.price, 0),
    stationID: normalizePositiveInteger(entry.stationID, 0),
    locationID: normalizePositiveInteger(entry.locationID ?? entry.stationID, 0),
    buyerID: normalizePositiveInteger(entry.buyerID, 0),
    sellerID: normalizePositiveInteger(entry.sellerID, 0),
    clientID: normalizePositiveInteger(entry.clientID, 0),
    accountID: normalizeCorporationWalletKey(entry.accountID ?? normalizedAccountKey),
    buyerAccountID: normalizeCorporationWalletKey(entry.buyerAccountID ?? normalizedAccountKey),
    sellerAccountID: normalizeCorporationWalletKey(entry.sellerAccountID ?? normalizedAccountKey),
    keyID: normalizedAccountKey,
    journalRefID: Math.trunc(Number(entry.journalRefID ?? entry.journal_ref_id) || -1),
  };
}

function appendLimited(list, entry, maxEntries) {
  list.push(entry);
  if (list.length > maxEntries) {
    list.splice(0, list.length - maxEntries);
  }
}

function fileTimeToDate(value) {
  try {
    const filetime = BigInt(String(value || "0"));
    if (filetime <= 0n) {
      return new Date(NaN);
    }
    return new Date(Number((filetime - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS));
  } catch (_error) {
    return new Date(NaN);
  }
}

function isLedgerEntryInMonth(entry, year, month) {
  const date = fileTimeToDate(entry && entry.transactionDate);
  if (Number.isNaN(date.valueOf())) {
    return false;
  }
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month;
}

function isLedgerEntryWithinLast30Days(entry) {
  const date = fileTimeToDate(entry && entry.transactionDate);
  if (Number.isNaN(date.valueOf())) {
    return false;
  }
  return date.getTime() >= Date.now() - LAST_30_DAYS_MS;
}

function filterLedgerEntries(entries = [], options = {}) {
  const year = Number(options.year);
  const month = Number(options.month);
  const hasMonthFilter = Number.isFinite(year) && Number.isFinite(month);
  return entries
    .filter((entry) => {
      if (hasMonthFilter) {
        return isLedgerEntryInMonth(entry, year, month);
      }
      if (options.last30DaysDefault) {
        return isLedgerEntryWithinLast30Days(entry);
      }
      return true;
    })
    .map((entry) => cloneValue(entry));
}

function getCorporationWallet(corporationID) {
  const runtime = getCorporationRuntime(corporationID);
  if (!runtime || !runtime.wallet) {
    return null;
  }
  return cloneValue(runtime.wallet);
}

function getCorporationWalletDivision(corporationID, accountKey = CORPORATION_WALLET_KEY_START) {
  const wallet = getCorporationWallet(corporationID);
  const normalizedKey = normalizeCorporationWalletKey(accountKey);
  if (!wallet || !wallet.divisions || !wallet.divisions[String(normalizedKey)]) {
    return null;
  }
  return cloneValue(wallet.divisions[String(normalizedKey)]);
}

function getCorporationWalletBalance(corporationID, accountKey = CORPORATION_WALLET_KEY_START) {
  const division = getCorporationWalletDivision(corporationID, accountKey);
  return division ? normalizeMoney(division.balance, 0) : 0;
}

function normalizeWalletOperationID(value) {
  return String(value || "").trim().slice(0, 180);
}

function normalizeWalletOperationFingerprint(value) {
  return String(value || "").trim().slice(0, 512);
}

function getCorporationWalletOperation(corporationID, operationID) {
  const normalizedOperationID = normalizeWalletOperationID(operationID);
  if (!normalizedOperationID) {
    return null;
  }
  const wallet = getCorporationWallet(corporationID);
  const operation =
    wallet &&
    wallet.operationsByID &&
    wallet.operationsByID[normalizedOperationID];
  return operation ? cloneValue(operation) : null;
}

function applyCorporationWalletOperation(details = {}, options = {}) {
  const operationID = normalizeWalletOperationID(details.operationID);
  const fingerprint = normalizeWalletOperationFingerprint(details.fingerprint);
  const corporationID = Number(details.corporationID) || 0;
  const accountKey = normalizeCorporationWalletKey(
    details.accountKey || CORPORATION_WALLET_KEY_START,
  );
  const delta = normalizeMoney(details.delta, Number.NaN);
  if (
    !operationID ||
    !fingerprint ||
    !corporationID ||
    !Number.isFinite(delta)
  ) {
    return {
      success: false,
      errorMsg: "CORPORATION_WALLET_OPERATION_INVALID",
    };
  }

  let result = null;
  const writeResult = updateCorporationRuntime(corporationID, (runtime) => {
    runtime.wallet =
      runtime.wallet && typeof runtime.wallet === "object"
        ? runtime.wallet
        : { divisions: {}, operationsByID: {} };
    runtime.wallet.divisions =
      runtime.wallet.divisions &&
      typeof runtime.wallet.divisions === "object"
        ? runtime.wallet.divisions
        : {};
    runtime.wallet.operationsByID =
      runtime.wallet.operationsByID &&
      typeof runtime.wallet.operationsByID === "object" &&
      !Array.isArray(runtime.wallet.operationsByID)
        ? runtime.wallet.operationsByID
        : {};

    const existing = runtime.wallet.operationsByID[operationID];
    if (existing) {
      const matches =
        String(existing.fingerprint || "") === fingerprint &&
        Number(existing.corporationID) === corporationID &&
        Number(existing.accountKey) === accountKey &&
        Math.abs(normalizeMoney(existing.delta, 0) - delta) < 0.0001;
      result = matches
        ? { success: true, replayed: true, data: cloneValue(existing) }
        : {
            success: false,
            errorMsg: "CORPORATION_WALLET_OPERATION_CONFLICT",
            data: cloneValue(existing),
          };
      return runtime;
    }

    const divisionKey = String(accountKey);
    const division =
      runtime.wallet.divisions[divisionKey] &&
      typeof runtime.wallet.divisions[divisionKey] === "object"
        ? runtime.wallet.divisions[divisionKey]
        : {
            key: accountKey,
            balance: 0,
            journal: [],
            transactions: [],
            marketTransactions: [],
          };
    const previousBalance = normalizeMoney(division.balance, 0);
    const nextBalance = normalizeMoney(previousBalance + delta, previousBalance);
    if (nextBalance < -0.0001) {
      result = {
        success: false,
        errorMsg: "INSUFFICIENT_FUNDS",
        data: {
          corporationID,
          accountKey,
          balance: previousBalance,
        },
      };
      return runtime;
    }

    division.key = accountKey;
    division.balance = nextBalance;
    division.journal = Array.isArray(division.journal)
      ? division.journal
      : [];
    division.transactions = Array.isArray(division.transactions)
      ? division.transactions
      : [];
    division.marketTransactions = Array.isArray(division.marketTransactions)
      ? division.marketTransactions
      : [];
    const ledgerEntry = Math.abs(delta) > 0.0001
      ? buildLedgerEntry(
          corporationID,
          accountKey,
          delta,
          nextBalance,
          details,
        )
      : null;
    if (ledgerEntry) {
      appendLimited(division.journal, ledgerEntry, MAX_JOURNAL_ENTRIES);
      appendLimited(
        division.transactions,
        ledgerEntry,
        MAX_TRANSACTION_ENTRIES,
      );
    }
    runtime.wallet.divisions[divisionKey] = division;

    const operation = {
      operationID,
      fingerprint,
      kind: String(details.kind || "adjustment").slice(0, 80),
      corporationID,
      accountKey,
      delta,
      balanceBefore: previousBalance,
      balanceAfter: nextBalance,
      status: "applied",
      appliedAtMs: Math.max(
        0,
        Math.trunc(Number(details.nowMs) || Date.now()),
      ),
      referenceID: Number(details.referenceID || 0) || null,
      counterpartyID:
        Number(details.counterpartyID || details.ownerID2 || 0) || null,
      description: String(
        details.description || "Corporation wallet operation",
      ).slice(0, 240),
      journalTransactionID: ledgerEntry
        ? ledgerEntry.transactionID
        : null,
    };
    runtime.wallet.operationsByID[operationID] = operation;
    result = {
      success: true,
      replayed: false,
      data: cloneValue(operation),
    };
    return runtime;
  });

  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg:
        writeResult && writeResult.errorMsg ||
        "CORPORATION_WALLET_OPERATION_WRITE_FAILED",
    };
  }
  if (!result) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }
  if (result.success && options.durable !== false) {
    const flush = database.flushTableSync(CORPORATION_RUNTIME_TABLE);
    if (!flush || flush.success !== true) {
      return {
        success: false,
        errorMsg:
          flush && flush.errorMsg ||
          "CORPORATION_WALLET_OPERATION_FLUSH_FAILED",
        uncertain: true,
        data: result.data,
      };
    }
  }
  if (result.success && !result.replayed) {
    notifyCorporationWalletChange(
      corporationID,
      accountKey,
      result.data.balanceAfter,
    );
  }
  return result;
}

function getCorporationWalletDivisionsInfo(corporationID) {
  const wallet = getCorporationWallet(corporationID);
  const divisions = wallet && wallet.divisions && typeof wallet.divisions === "object"
    ? wallet.divisions
    : {};

  return Array.from({ length: 7 }, (_value, index) => {
    const key = CORPORATION_WALLET_KEY_START + index;
    const division = divisions[String(key)] || {};
    return {
      key,
      balance: normalizeMoney(division.balance, 0),
    };
  });
}

function notifyCorporationWalletChange(corporationID, accountKey, balance) {
  const accountKeyName = getCorporationWalletKeyName(accountKey);
  for (const session of sessionRegistry.getSessions()) {
    if (
      Number(session && (session.corporationID || session.corpid)) !== Number(corporationID) ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    session.sendNotification("OnAccountChange", "*corpid&corpAccountKey", [
      accountKeyName,
      Number(corporationID),
      buildMarshalRealMoney(balance, 0),
    ]);
  }
}

function setCorporationWalletDivisionBalance(corporationID, accountKey, nextBalance, options = {}) {
  const normalizedCorporationID = Number(corporationID) || 0;
  const normalizedAccountKey = normalizeCorporationWalletKey(accountKey);
  let result = null;

  updateCorporationRuntime(normalizedCorporationID, (runtime) => {
    runtime.wallet =
      runtime.wallet && typeof runtime.wallet === "object"
        ? runtime.wallet
        : { divisions: {} };
    runtime.wallet.divisions =
      runtime.wallet.divisions && typeof runtime.wallet.divisions === "object"
        ? runtime.wallet.divisions
        : {};

    const divisionKey = String(normalizedAccountKey);
    const currentDivision =
      runtime.wallet.divisions[divisionKey] &&
      typeof runtime.wallet.divisions[divisionKey] === "object"
        ? runtime.wallet.divisions[divisionKey]
        : {
            key: normalizedAccountKey,
            balance: 0,
            journal: [],
            transactions: [],
          };

    const previousBalance = normalizeMoney(currentDivision.balance, 0);
    const balance = normalizeMoney(nextBalance, previousBalance);
    const delta = normalizeMoney(balance - previousBalance, 0);
    let ledgerEntry = null;

    currentDivision.key = normalizedAccountKey;
    currentDivision.balance = balance;
    currentDivision.journal = Array.isArray(currentDivision.journal)
      ? currentDivision.journal
      : [];
    currentDivision.transactions = Array.isArray(currentDivision.transactions)
      ? currentDivision.transactions
      : [];

    if (Math.abs(delta) > 0.0001) {
      ledgerEntry = buildLedgerEntry(
        normalizedCorporationID,
        normalizedAccountKey,
        delta,
        balance,
        options,
      );
      appendLimited(currentDivision.journal, ledgerEntry, MAX_JOURNAL_ENTRIES);
      appendLimited(
        currentDivision.transactions,
        ledgerEntry,
        MAX_TRANSACTION_ENTRIES,
      );
    }

    runtime.wallet.divisions[divisionKey] = currentDivision;
    result = {
      success: true,
      data: {
        corporationID: normalizedCorporationID,
        accountKey: normalizedAccountKey,
        balance,
        delta,
        journalEntry: ledgerEntry ? cloneValue(ledgerEntry) : null,
      },
    };
    return runtime;
  });

  if (!result) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }

  notifyCorporationWalletChange(
    normalizedCorporationID,
    normalizedAccountKey,
    result.data.balance,
  );
  return result;
}

function adjustCorporationWalletDivisionBalance(corporationID, accountKey, delta, options = {}) {
  const normalizedCorporationID = Number(corporationID) || 0;
  const normalizedAccountKey = normalizeCorporationWalletKey(accountKey);
  const currentBalance = getCorporationWalletBalance(
    normalizedCorporationID,
    normalizedAccountKey,
  );
  const nextBalance = normalizeMoney(currentBalance + normalizeMoney(delta, 0), currentBalance);
  if (nextBalance < -0.0001) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_FUNDS",
      data: {
        corporationID: normalizedCorporationID,
        accountKey: normalizedAccountKey,
        balance: currentBalance,
      },
    };
  }

  return setCorporationWalletDivisionBalance(
    normalizedCorporationID,
    normalizedAccountKey,
    nextBalance,
    options,
  );
}

function getCorporationWalletJournal(corporationID, options = {}) {
  const division = getCorporationWalletDivision(
    corporationID,
    options.accountKey || CORPORATION_WALLET_KEY_START,
  );
  if (!division) {
    return [];
  }
  return filterLedgerEntries(division.journal || [], options);
}

function getCorporationWalletTransactions(corporationID, options = {}) {
  const division = getCorporationWalletDivision(
    corporationID,
    options.accountKey || CORPORATION_WALLET_KEY_START,
  );
  if (!division) {
    return [];
  }
  return filterLedgerEntries(division.transactions || [], {
    ...options,
    last30DaysDefault: true,
  });
}

function getCorporationMarketTransactions(corporationID, options = {}) {
  const hasAccountKey = options.accountKey !== undefined && options.accountKey !== null;
  const divisions = [];
  if (hasAccountKey) {
    const division = getCorporationWalletDivision(corporationID, options.accountKey);
    if (division) {
      divisions.push(division);
    }
  } else {
    const wallet = getCorporationWallet(corporationID);
    if (wallet && wallet.divisions && typeof wallet.divisions === "object") {
      divisions.push(...Object.values(wallet.divisions));
    }
  }

  if (divisions.length === 0) {
    return [];
  }
  return divisions
    .flatMap((division) => {
      const accountKey = normalizeCorporationWalletKey(division && division.key);
      return (Array.isArray(division && division.marketTransactions)
        ? division.marketTransactions
        : []
      ).map((entry) => normalizeMarketTransactionEntry(cloneValue(entry), accountKey));
    })
    .sort((left, right) => right.transactionID - left.transactionID);
}

function appendCorporationMarketTransaction(corporationID, accountKey, entry = {}) {
  const normalizedCorporationID = Number(corporationID) || 0;
  const normalizedAccountKey = normalizeCorporationWalletKey(accountKey);
  const normalizedEntry = normalizeMarketTransactionEntry(
    {
      transactionID: Number(Date.now()) * 100 + Math.floor(Math.random() * 100),
      transactionDate: currentFileTime().toString(),
      ...entry,
    },
    normalizedAccountKey,
  );
  let result = null;

  updateCorporationRuntime(normalizedCorporationID, (runtime) => {
    runtime.wallet =
      runtime.wallet && typeof runtime.wallet === "object"
        ? runtime.wallet
        : { divisions: {} };
    runtime.wallet.divisions =
      runtime.wallet.divisions && typeof runtime.wallet.divisions === "object"
        ? runtime.wallet.divisions
        : {};
    const divisionKey = String(normalizedAccountKey);
    const division =
      runtime.wallet.divisions[divisionKey] &&
      typeof runtime.wallet.divisions[divisionKey] === "object"
        ? runtime.wallet.divisions[divisionKey]
        : {
            key: normalizedAccountKey,
            balance: 0,
            journal: [],
            transactions: [],
            marketTransactions: [],
          };

    division.marketTransactions = Array.isArray(division.marketTransactions)
      ? division.marketTransactions
      : [];
    appendLimited(
      division.marketTransactions,
      normalizedEntry,
      MAX_MARKET_TRANSACTION_ENTRIES,
    );
    runtime.wallet.divisions[divisionKey] = division;
    result = {
      success: true,
      data: cloneValue(normalizedEntry),
    };
    return runtime;
  });

  return result || {
    success: false,
    errorMsg: "CORPORATION_NOT_FOUND",
  };
}

module.exports = {
  CORPORATION_WALLET_KEY_START,
  CORPORATION_WALLET_KEY_END,
  appendCorporationMarketTransaction,
  applyCorporationWalletOperation,
  adjustCorporationWalletDivisionBalance,
  getCorporationWallet,
  getCorporationWalletBalance,
  getCorporationWalletDivision,
  getCorporationWalletDivisionsInfo,
  getCorporationWalletJournal,
  getCorporationWalletKeyName,
  getCorporationWalletOperation,
  getCorporationWalletTransactions,
  getCorporationMarketTransactions,
  normalizeCorporationWalletKey,
  setCorporationWalletDivisionBalance,
};
