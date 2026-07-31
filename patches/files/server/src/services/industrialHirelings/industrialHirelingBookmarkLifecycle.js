"use strict";

const path = require("path");

function getDefaultConfig() {
  return require(path.join(__dirname, "../../config"));
}

function getDefaultBookmarkService() {
  const bookmarks = require("./industrialHirelingBookmarks");
  return {
    removeOperationBookmark: bookmarks.removeIndustrialOperationBookmark,
    syncOperationBookmark: bookmarks.syncIndustrialOperationBookmark,
  };
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function isEnabled(options = {}) {
  const config = options.config || getDefaultConfig();
  return config.industrialHirelingsOperationBookmarksEnabled === true;
}

function skipped(reason) {
  return { success: true, data: { skipped: true, reason } };
}

function syncContractBookmark(contract, options = {}) {
  if (!isEnabled(options)) return skipped("disabled");
  const ownerCharacterID = toPositiveInt(
    contract && (contract.ownerCharacterID || contract.characterID),
    0,
  );
  const contractID = String(contract && contract.contractID || "").trim();
  const assignedSiteID = toPositiveInt(contract && contract.assignedSiteID, 0);
  if (!ownerCharacterID || !contractID || !assignedSiteID) {
    return skipped("no_site_assignment");
  }
  try {
    const service = options.bookmarkService || getDefaultBookmarkService();
    return service.syncOperationBookmark({
      ...contract,
      characterID: ownerCharacterID,
      contractID,
      siteID: assignedSiteID,
    });
  } catch (error) {
    return {
      success: false,
      errorMsg: String(error && error.code || "INDUSTRIAL_BOOKMARK_SYNC_FAILED"),
    };
  }
}

function removeContractBookmark(contract, options = {}) {
  if (!isEnabled(options)) return skipped("disabled");
  const ownerCharacterID = toPositiveInt(
    contract && (contract.ownerCharacterID || contract.characterID),
    0,
  );
  const contractID = String(contract && contract.contractID || "").trim();
  if (!ownerCharacterID || !contractID) {
    return skipped("contract_identity_missing");
  }
  try {
    const service = options.bookmarkService || getDefaultBookmarkService();
    return service.removeOperationBookmark({
      characterID: ownerCharacterID,
      contractID,
    });
  } catch (error) {
    return {
      success: false,
      errorMsg: String(error && error.code || "INDUSTRIAL_BOOKMARK_REMOVE_FAILED"),
    };
  }
}

function formatBookmarkMessage(result) {
  if (!result || result.success !== true) {
    return "The operation is active, but its native bookmark could not be updated.";
  }
  const data = result.data || {};
  if (data.skipped === true || data.action === "unchanged" || data.action === "not_found") {
    return "";
  }
  if (data.fallbackFolder === true) {
    return "Its native operation bookmark was saved in an active personal folder.";
  }
  if (data.requiresClientFolderRefresh === true) {
    return "Its native bookmark is in Industrial Operations; reopen Locations once if the new folder is not visible yet.";
  }
  if (["created", "retargeted", "updated", "deduplicated"].includes(String(data.action || ""))) {
    return "Its native Industrial Operations bookmark is up to date.";
  }
  return "";
}

module.exports = {
  formatBookmarkMessage,
  isEnabled,
  removeContractBookmark,
  syncContractBookmark,
};
