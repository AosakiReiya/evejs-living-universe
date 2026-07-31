"use strict";

const path = require("path");

const bookmarkRuntime = require(path.join(
  __dirname,
  "../bookmark/bookmarkRuntimeState",
));
const bookmarkNotifications = require(path.join(
  __dirname,
  "../bookmark/bookmarkNotifications",
));
const bookmarkConstants = require(path.join(
  __dirname,
  "../bookmark/bookmarkConstants",
));
const worldData = require(path.join(__dirname, "../../space/worldData"));

const OPERATIONS_FOLDER_NAME = "Industrial Operations";
const OPERATIONS_FOLDER_DESCRIPTION =
  "Warpable locations maintained by your industrial hireling contracts.";
const MANAGED_SOURCE = "industrial_hirelings";
const COORDINATE_TOLERANCE_METERS = 1;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.trunc(numeric)
    : fallback;
}

function toOptionalInt(value) {
  const numeric = toPositiveInt(value, 0);
  return numeric > 0 ? numeric : null;
}

function firstPositiveInt(...values) {
  for (const value of values) {
    const numeric = toPositiveInt(value, 0);
    if (numeric > 0) {
      return numeric;
    }
  }
  return 0;
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeSiteID(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const numeric = Math.trunc(value);
    return numeric > 0 ? numeric : null;
  }
  const text = firstText(value);
  if (!text) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric > 0 ? numeric : null;
  }
  return text.slice(0, 160);
}

function industrialBookmarkError(code) {
  const error = new Error(String(code || "INDUSTRIAL_BOOKMARK_ERROR"));
  error.industrialBookmarkError = String(
    code || "INDUSTRIAL_BOOKMARK_ERROR",
  );
  return error;
}

function errorCode(error) {
  return String(
    (error &&
      (error.industrialBookmarkError ||
        error.bookmarkError ||
        error.errorMsg ||
        error.message)) ||
      "INDUSTRIAL_BOOKMARK_ERROR",
  );
}

function success(data) {
  return { success: true, data };
}

function failure(error) {
  return { success: false, errorMsg: errorCode(error) };
}

function readPosition(source) {
  if (!isPlainObject(source)) {
    return null;
  }
  const nestedKeys = [
    "position",
    "actualPosition",
    "coordinates",
    "center",
    "assignmentPosition",
    "targetPosition",
  ];
  const candidates = [source];
  for (const key of nestedKeys) {
    if (isPlainObject(source[key])) {
      candidates.push(source[key]);
    }
  }
  for (const candidate of candidates) {
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const z = Number(candidate.z);
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z) &&
      !(x === 0 && y === 0 && z === 0)
    ) {
      return { x, y, z };
    }
  }
  return null;
}

function resolveWorldSite(siteID, sources, world) {
  const lookupIDs = [];
  for (const value of [
    siteID,
    ...sources.map((source) =>
      firstPositiveInt(
        source && source.itemID,
        source && source.siteID,
        source && source.assignedSiteID,
        source && source.assignedTargetID,
      )),
  ]) {
    const numeric = toPositiveInt(value, 0);
    if (numeric > 0 && !lookupIDs.includes(numeric)) {
      lookupIDs.push(numeric);
    }
  }

  for (const itemID of lookupIDs) {
    if (world && typeof world.getAsteroidBeltByID === "function") {
      const belt = world.getAsteroidBeltByID(itemID);
      if (belt) {
        return belt;
      }
    }
    if (world && typeof world.getCelestialByID === "function") {
      const celestial = world.getCelestialByID(itemID);
      if (celestial) {
        return celestial;
      }
    }
  }
  return null;
}

function resolveAssignmentTarget(input = {}, world = worldData) {
  if (!isPlainObject(input)) {
    throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_ASSIGNMENT_REQUIRED");
  }
  const assignment = isPlainObject(input.assignment) ? input.assignment : {};
  const site = isPlainObject(input.site) ? input.site : {};
  const siteID = normalizeSiteID(
    input.siteID ??
      input.assignedSiteID ??
      site.siteID ??
      site.itemID ??
      assignment.siteID ??
      assignment.assignedSiteID ??
      assignment.assignedTargetID,
  );
  if (siteID === null) {
    throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_SITE_REQUIRED");
  }

  const explicitSources = [input, site, assignment];
  const staticSite = resolveWorldSite(siteID, explicitSources, world);
  const sources = staticSite
    ? [...explicitSources, staticSite]
    : explicitSources;
  const position = sources.map(readPosition).find(Boolean) || null;
  if (!position) {
    throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_COORDINATES_REQUIRED");
  }

  const solarSystemID = firstPositiveInt(
    input.solarSystemID,
    input.systemID,
    input.assignedSystemID,
    input.locationID,
    site.solarSystemID,
    site.systemID,
    site.locationID,
    assignment.solarSystemID,
    assignment.systemID,
    assignment.assignedSystemID,
    assignment.locationID,
    staticSite && staticSite.solarSystemID,
    staticSite && staticSite.systemID,
    staticSite && staticSite.locationID,
  );
  if (solarSystemID <= 0) {
    throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_SYSTEM_REQUIRED");
  }

  const staticItemID = firstPositiveInt(
    input.bookmarkItemID,
    site.itemID,
    staticSite && staticSite.itemID,
  );
  const typeID = firstPositiveInt(
    input.typeID,
    site.typeID,
    staticSite && staticSite.typeID,
    bookmarkConstants.TYPE_SOLAR_SYSTEM,
  );
  const solarSystem =
    world && typeof world.getSolarSystemByID === "function"
      ? world.getSolarSystemByID(solarSystemID)
      : null;
  const siteName = firstText(
    input.siteName,
    input.assignedSiteName,
    input.label,
    site.siteName,
    site.itemName,
    site.name,
    staticSite && staticSite.itemName,
    staticSite && staticSite.name,
    `Site ${String(siteID)}`,
  );
  const systemName = firstText(
    input.systemName,
    input.assignedSystemName,
    site.systemName,
    solarSystem && solarSystem.solarSystemName,
  );

  return {
    siteID,
    siteName,
    systemName,
    itemID: staticItemID || null,
    typeID,
    locationID: solarSystemID,
    x: position.x,
    y: position.y,
    z: position.z,
  };
}

function unwrapFolderView(value) {
  if (!value) {
    return null;
  }
  if (value.folder && value.folder.folderID) {
    return value;
  }
  if (value.folder && value.folder.folder && value.folder.folder.folderID) {
    return value.folder;
  }
  return null;
}

function isOperationsFolderView(view, characterID) {
  const folder = view && view.folder;
  return Boolean(
    folder &&
      folder.isPersonal !== false &&
      toPositiveInt(folder.creatorID, 0) === characterID &&
      String(folder.folderName || "") === OPERATIONS_FOLDER_NAME,
  );
}

function metadataFor(input, target, contractID) {
  const customMetadata = isPlainObject(input.metadata)
    ? clone(input.metadata)
    : {};
  return {
    ...customMetadata,
    source: MANAGED_SOURCE,
    industrialOperation: true,
    contractID,
    siteID: target.siteID,
    solarSystemID: target.locationID,
  };
}

function isManagedBookmark(bookmark) {
  const metadata = bookmark && bookmark.metadata;
  return Boolean(
    isPlainObject(metadata) &&
      metadata.source === MANAGED_SOURCE &&
      metadata.industrialOperation === true &&
      firstText(metadata.contractID),
  );
}

function tagEquals(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function numbersNear(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return (
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber) &&
    Math.abs(leftNumber - rightNumber) <= COORDINATE_TOLERANCE_METERS
  );
}

function bookmarkTargetMatches(bookmark, desired) {
  return Boolean(
    bookmark &&
      toPositiveInt(bookmark.locationID, 0) === desired.locationID &&
      toOptionalInt(bookmark.itemID) === toOptionalInt(desired.itemID) &&
      toPositiveInt(bookmark.typeID, bookmarkConstants.TYPE_SOLAR_SYSTEM) ===
        desired.typeID &&
      numbersNear(bookmark.x, desired.x) &&
      numbersNear(bookmark.y, desired.y) &&
      numbersNear(bookmark.z, desired.z) &&
      stableSerialize(bookmark.metadata || {}) ===
        stableSerialize(desired.metadata || {}),
  );
}

function createIndustrialHirelingBookmarkService(options = {}) {
  const runtime = options.bookmarkRuntime || bookmarkRuntime;
  const notifications =
    options.bookmarkNotifications || bookmarkNotifications;
  const world = options.worldData || worldData;

  function listFolderViews(characterID) {
    if (typeof runtime.listFolderViews !== "function") {
      throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_RUNTIME_UNAVAILABLE");
    }
    return runtime.listFolderViews(characterID) || [];
  }

  function findOperationsFolders(characterID) {
    return listFolderViews(characterID)
      .filter((view) => isOperationsFolderView(view, characterID))
      .sort((left, right) => {
        if (left.isActive !== right.isActive) {
          return left.isActive ? -1 : 1;
        }
        return left.folder.folderID - right.folder.folderID;
      });
  }

  function ensureOperationsFolder(characterIDInput) {
    try {
      const characterID = toPositiveInt(characterIDInput, 0);
      if (characterID <= 0) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CHARACTER_REQUIRED");
      }
      const ownedPersonalViews = listFolderViews(characterID).filter((candidate) => (
        candidate &&
        candidate.folder &&
        candidate.folder.isPersonal !== false &&
        toPositiveInt(candidate.folder.creatorID, 0) === characterID
      ));
      let view = findOperationsFolders(characterID)[0] || null;
      let created = false;
      let fallbackFolder = false;
      if (!view) {
        if (typeof runtime.addFolder !== "function") {
          throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_RUNTIME_UNAVAILABLE");
        }
        view = unwrapFolderView(
          runtime.addFolder(characterID, {
            isPersonal: true,
            folderName: OPERATIONS_FOLDER_NAME,
            description: OPERATIONS_FOLDER_DESCRIPTION,
          }),
        );
        created = true;
      }
      if (!view) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_FOLDER_CREATE_FAILED");
      }

      if (view.isActive !== true) {
        try {
          if (typeof runtime.updateKnownFolderState === "function") {
            const activated = runtime.updateKnownFolderState(
              characterID,
              view.folder.folderID,
              true,
            );
            view = unwrapFolderView(activated) || view;
          }
        } catch (_) {
          // Reaching the native active-folder limit is recoverable: place the
          // managed bookmark in an already-active personal folder instead.
        }
      }
      if (view.isActive !== true) {
        const activeFallback = ownedPersonalViews.find((candidate) => candidate.isActive === true) || null;
        if (!activeFallback) {
          throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_FOLDER_INACTIVE");
        }
        view = activeFallback;
        fallbackFolder = true;
      }
      return success({
        characterID,
        created,
        fallbackFolder,
        folder: clone(view.folder),
        view: clone(view),
      });
    } catch (error) {
      return failure(error);
    }
  }

  function listManagedBookmarks(characterID, filters = {}) {
    const ownedFolderViews = listFolderViews(characterID).filter((view) => (
      view &&
      view.folder &&
      view.folder.isPersonal !== false &&
      toPositiveInt(view.folder.creatorID, 0) === characterID
    ));
    if (ownedFolderViews.length <= 0) return { folderViews: [], bookmarks: [] };
    const folderIDs = new Set(
      ownedFolderViews.map((view) => toPositiveInt(view.folder.folderID, 0)),
    );
    let allBookmarks = [];
    if (typeof runtime.listBookmarksInFolder === "function") {
      allBookmarks = ownedFolderViews.flatMap((view) =>
        runtime.listBookmarksInFolder(characterID, view.folder.folderID) || [],
      );
    } else if (typeof runtime.getMyActiveBookmarks === "function") {
      const state = runtime.getMyActiveBookmarks(characterID) || {};
      allBookmarks = Array.isArray(state.bookmarks) ? state.bookmarks : [];
    } else {
      throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_RUNTIME_UNAVAILABLE");
    }
    const bookmarks = allBookmarks
      .filter((bookmark) => folderIDs.has(toPositiveInt(bookmark.folderID, 0)))
      .filter(isManagedBookmark)
      .filter((bookmark) =>
        filters.contractID === undefined
          ? true
          : tagEquals(bookmark.metadata.contractID, filters.contractID),
      )
      .filter((bookmark) =>
        filters.siteID === undefined
          ? true
          : tagEquals(bookmark.metadata.siteID, filters.siteID),
      )
      .sort((left, right) => left.bookmarkID - right.bookmarkID);
    const managedFolderIDs = new Set(
      bookmarks.map((bookmark) => toPositiveInt(bookmark.folderID, 0)),
    );
    const folderViews = ownedFolderViews.filter((view) => (
      isOperationsFolderView(view, characterID) ||
      managedFolderIDs.has(toPositiveInt(view.folder.folderID, 0))
    ));
    return { folderViews, bookmarks };
  }

  function notify(method, ...args) {
    try {
      if (notifications && typeof notifications[method] === "function") {
        notifications[method](...args);
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  function deleteBookmarks(characterID, bookmarks) {
    const byFolderID = new Map();
    for (const bookmark of bookmarks) {
      const folderID = toPositiveInt(bookmark && bookmark.folderID, 0);
      const bookmarkID = toPositiveInt(bookmark && bookmark.bookmarkID, 0);
      if (folderID <= 0 || bookmarkID <= 0) {
        continue;
      }
      if (!byFolderID.has(folderID)) {
        byFolderID.set(folderID, []);
      }
      byFolderID.get(folderID).push(bookmarkID);
    }

    const deletedBookmarkIDs = [];
    for (const [folderID, bookmarkIDs] of byFolderID) {
      const deleted = runtime.deleteBookmarks(
        characterID,
        folderID,
        bookmarkIDs,
      );
      const actualDeleted = Array.isArray(deleted) ? deleted : [];
      if (actualDeleted.length > 0) {
        deletedBookmarkIDs.push(...actualDeleted);
        notify("notifyBookmarksRemoved", folderID, actualDeleted);
      }
    }
    return deletedBookmarkIDs;
  }

  function syncOperationBookmark(input = {}) {
    try {
      const characterID = firstPositiveInt(
        input.characterID,
        input.ownerCharacterID,
        input.assignment && input.assignment.ownerCharacterID,
      );
      const contractID = firstText(input.contractID).slice(0, 160);
      if (characterID <= 0) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CHARACTER_REQUIRED");
      }
      if (!contractID) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CONTRACT_REQUIRED");
      }
      const target = resolveAssignmentTarget(input, world);
      const folderResult = ensureOperationsFolder(characterID);
      if (!folderResult.success) {
        return folderResult;
      }
      const folder = folderResult.data.folder;
      if (folderResult.data.created && folderResult.data.fallbackFolder !== true) {
        notify("notifyFolderUpdated", folder.folderID, folder);
      }
      const metadata = metadataFor(input, target, contractID);
      const memo = firstText(
        input.memo,
        input.bookmarkName,
        `Industrial: ${target.siteName}`,
      ).slice(0, 100);
      const note = firstText(
        input.note,
        input.description,
        [
          `Industrial hireling contract ${contractID}.`,
          target.systemName ? `System: ${target.systemName}.` : "",
          `Site: ${target.siteName}.`,
        ]
          .filter(Boolean)
          .join(" "),
      ).slice(0, 3900);
      const desired = {
        folderID: folder.folderID,
        itemID: target.itemID,
        typeID: target.typeID,
        memo,
        note,
        x: target.x,
        y: target.y,
        z: target.z,
        locationID: target.locationID,
        subfolderID: null,
        metadata,
      };
      const managed = listManagedBookmarks(characterID, { contractID }).bookmarks;
      const hadManagedBookmark = managed.length > 0;
      const sameSite = managed.filter((bookmark) =>
        tagEquals(bookmark.metadata.siteID, target.siteID),
      );
      let canonical = sameSite[0] || null;
      let action = "unchanged";
      const deletedBookmarkIDs = [];

      if (!canonical || !bookmarkTargetMatches(canonical, desired)) {
        // Keep the previous warp target intact until its replacement exists.
        // A full folder therefore rejects the retarget instead of losing the
        // only managed bookmark for this contract.
        const created = runtime.createBookmark(characterID, desired);
        canonical = created && created.bookmark;
        if (!canonical) {
          throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CREATE_FAILED");
        }
        notify("notifyBookmarksAdded", folder.folderID, [canonical]);
        action = hadManagedBookmark ? "retargeted" : "created";
      } else if (canonical.memo !== memo || canonical.note !== note) {
        const updated = runtime.updateBookmark(
          characterID,
          canonical.bookmarkID,
          canonical.folderID,
          memo,
          note,
          canonical.subfolderID,
          canonical.folderID,
          false,
        );
        canonical = updated && updated.bookmark;
        if (!canonical) {
          throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_UPDATE_FAILED");
        }
        notify("notifyBookmarksUpdated", canonical.folderID, [canonical]);
        action = "updated";
      }

      const stale = managed.filter(
        (bookmark) => bookmark.bookmarkID !== canonical.bookmarkID,
      );
      deletedBookmarkIDs.push(...deleteBookmarks(characterID, stale));
      if (action === "unchanged" && deletedBookmarkIDs.length > 0) {
        action = "deduplicated";
      }
      return success({
        action,
        bookmark: clone(canonical),
        contractID,
        siteID: target.siteID,
        folder: clone(folder),
        folderCreated: folderResult.data.created,
        fallbackFolder: folderResult.data.fallbackFolder === true,
        requiresClientFolderRefresh:
          folderResult.data.created === true && folderResult.data.fallbackFolder !== true,
        deletedBookmarkIDs,
      });
    } catch (error) {
      return failure(error);
    }
  }

  function removeOperationBookmark(input = {}) {
    try {
      const characterID = firstPositiveInt(
        input.characterID,
        input.ownerCharacterID,
        input.assignment && input.assignment.ownerCharacterID,
      );
      const contractID = firstText(input.contractID).slice(0, 160);
      if (characterID <= 0) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CHARACTER_REQUIRED");
      }
      if (!contractID) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CONTRACT_REQUIRED");
      }
      const siteID =
        input.siteID === undefined || input.siteID === null
          ? undefined
          : normalizeSiteID(input.siteID);
      if (siteID === null) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_SITE_REQUIRED");
      }
      const matches = listManagedBookmarks(characterID, {
        contractID,
        siteID,
      }).bookmarks;
      const deletedBookmarkIDs = deleteBookmarks(characterID, matches);
      return success({
        action: deletedBookmarkIDs.length > 0 ? "removed" : "not_found",
        characterID,
        contractID,
        siteID: siteID === undefined ? null : siteID,
        deletedBookmarkIDs,
      });
    } catch (error) {
      return failure(error);
    }
  }

  function findOperationBookmarks(input = {}) {
    try {
      const characterID = firstPositiveInt(
        input.characterID,
        input.ownerCharacterID,
        input.assignment && input.assignment.ownerCharacterID,
      );
      if (characterID <= 0) {
        throw industrialBookmarkError("INDUSTRIAL_BOOKMARK_CHARACTER_REQUIRED");
      }
      const filters = {};
      if (firstText(input.contractID)) {
        filters.contractID = firstText(input.contractID);
      }
      if (input.siteID !== undefined && input.siteID !== null) {
        filters.siteID = normalizeSiteID(input.siteID);
      }
      const found = listManagedBookmarks(characterID, filters);
      return success({
        folders: clone(found.folderViews.map((view) => view.folder)),
        bookmarks: clone(found.bookmarks),
      });
    } catch (error) {
      return failure(error);
    }
  }

  return Object.freeze({
    ensureOperationsFolder,
    findOperationBookmarks,
    removeOperationBookmark,
    syncOperationBookmark,
  });
}

const defaultService = createIndustrialHirelingBookmarkService();

module.exports = {
  MANAGED_SOURCE,
  OPERATIONS_FOLDER_DESCRIPTION,
  OPERATIONS_FOLDER_NAME,
  createIndustrialHirelingBookmarkService,
  ensureIndustrialOperationsFolder: defaultService.ensureOperationsFolder,
  findIndustrialOperationBookmarks: defaultService.findOperationBookmarks,
  removeIndustrialOperationBookmark: defaultService.removeOperationBookmark,
  resolveAssignmentTarget,
  syncIndustrialOperationBookmark: defaultService.syncOperationBookmark,
};
