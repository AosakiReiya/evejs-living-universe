"use strict";

const assert = require("node:assert/strict");
const path = require("path");

const {
  MANAGED_SOURCE,
  OPERATIONS_FOLDER_NAME,
  createIndustrialHirelingBookmarkService,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingBookmarks",
));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeBookmarkRuntime(options = {}) {
  let nextFolderID = 500001;
  let nextBookmarkID = 900000001;
  const folders = [];
  const bookmarks = [];
  const calls = {
    addFolder: 0,
    createBookmark: 0,
    deleteBookmarks: 0,
    updateBookmark: 0,
    order: [],
  };
  const folderCapacity = Number.isFinite(Number(options.folderCapacity))
    ? Number(options.folderCapacity)
    : Number.POSITIVE_INFINITY;

  function view(folder) {
    return {
      folder: clone(folder),
      accessLevel: 1,
      isActive: folder.isActive === true,
    };
  }

  return {
    calls,
    folders,
    bookmarks,
    listFolderViews(characterID) {
      return folders
        .filter((folder) => folder.creatorID === characterID)
        .map(view);
    },
    addFolder(characterID, options) {
      calls.addFolder += 1;
      calls.order.push("addFolder");
      const folder = {
        folderID: nextFolderID++,
        folderName: options.folderName,
        description: options.description,
        creatorID: characterID,
        isPersonal: options.isPersonal !== false,
        isActive: true,
      };
      folders.push(folder);
      return view(folder);
    },
    updateKnownFolderState(characterID, folderID, active) {
      calls.order.push("updateKnownFolderState");
      const folder = folders.find(
        (candidate) =>
          candidate.creatorID === characterID &&
          candidate.folderID === folderID,
      );
      folder.isActive = active === true;
      return { folder: view(folder), bookmarks: [], subfolders: [] };
    },
    getMyActiveBookmarks(characterID) {
      const activeFolderIDs = new Set(
        folders
          .filter(
            (folder) =>
              folder.creatorID === characterID && folder.isActive === true,
          )
          .map((folder) => folder.folderID),
      );
      return {
        folders: this.listFolderViews(characterID),
        bookmarks: clone(
          bookmarks.filter((bookmark) => activeFolderIDs.has(bookmark.folderID)),
        ),
        subfolders: [],
      };
    },
    listBookmarksInFolder(characterID, folderID) {
      return clone(
        bookmarks.filter(
          (bookmark) =>
            bookmark.creatorID === characterID &&
            bookmark.folderID === folderID,
        ),
      );
    },
    createBookmark(characterID, data) {
      calls.createBookmark += 1;
      calls.order.push("createBookmark");
      const countInFolder = bookmarks.filter(
        (bookmark) => bookmark.folderID === data.folderID,
      ).length;
      if (countInFolder >= folderCapacity) {
        const error = new Error("FolderCapacityExceeded");
        error.bookmarkError = "FolderCapacityExceeded";
        throw error;
      }
      const bookmark = {
        ...clone(data),
        bookmarkID: nextBookmarkID++,
        creatorID: characterID,
      };
      bookmarks.push(bookmark);
      return { bookmark: clone(bookmark) };
    },
    updateBookmark(
      characterID,
      bookmarkID,
      oldFolderID,
      memo,
      note,
      subfolderID,
      newFolderID,
    ) {
      calls.updateBookmark += 1;
      calls.order.push("updateBookmark");
      const bookmark = bookmarks.find(
        (candidate) =>
          candidate.creatorID === characterID &&
          candidate.bookmarkID === bookmarkID &&
          candidate.folderID === oldFolderID,
      );
      bookmark.memo = memo;
      bookmark.note = note;
      bookmark.subfolderID = subfolderID || null;
      bookmark.folderID = newFolderID;
      return {
        bookmark: clone(bookmark),
        oldFolderID,
        newFolderID,
      };
    },
    deleteBookmarks(characterID, folderID, bookmarkIDs) {
      calls.deleteBookmarks += 1;
      calls.order.push("deleteBookmarks");
      const wanted = new Set(bookmarkIDs);
      const deleted = [];
      for (let index = bookmarks.length - 1; index >= 0; index -= 1) {
        const bookmark = bookmarks[index];
        if (
          bookmark.creatorID === characterID &&
          bookmark.folderID === folderID &&
          wanted.has(bookmark.bookmarkID)
        ) {
          deleted.push(bookmark.bookmarkID);
          bookmarks.splice(index, 1);
        }
      }
      return deleted.sort((left, right) => left - right);
    },
  };
}

function createFakeNotifications() {
  const events = [];
  return {
    events,
    notifyFolderUpdated(folderID, folder) {
      events.push({ type: "folderUpdated", folderID, name: folder.folderName });
    },
    notifyBookmarksAdded(folderID, bookmarks) {
      events.push({ type: "added", folderID, ids: bookmarks.map((entry) => entry.bookmarkID) });
    },
    notifyBookmarksUpdated(folderID, bookmarks) {
      events.push({ type: "updated", folderID, ids: bookmarks.map((entry) => entry.bookmarkID) });
    },
    notifyBookmarksRemoved(folderID, bookmarkIDs) {
      events.push({ type: "removed", folderID, ids: [...bookmarkIDs] });
    },
  };
}

function makeService(options = {}) {
  const runtime = createFakeBookmarkRuntime(options.runtimeOptions);
  const notifications = createFakeNotifications();
  const fakeWorldData = {
    getAsteroidBeltByID(itemID) {
      if (Number(itemID) !== 40342603) {
        return null;
      }
      return {
        itemID: 40342603,
        typeID: 15,
        solarSystemID: 30030141,
        itemName: "Uitra I - Asteroid Belt 1",
        position: { x: -37717647360, y: 849715200, z: -55091896320 },
      };
    },
    getCelestialByID() {
      return null;
    },
    getSolarSystemByID(systemID) {
      return Number(systemID) === 30030141
        ? { solarSystemID: 30030141, solarSystemName: "Uitra" }
        : null;
    },
  };
  return {
    runtime,
    notifications,
    service: createIndustrialHirelingBookmarkService({
      bookmarkRuntime: runtime,
      bookmarkNotifications: notifications,
      worldData: fakeWorldData,
    }),
  };
}

function verifyCreateAndIdempotence() {
  const { runtime, notifications, service } = makeService();
  const request = {
    characterID: 9001,
    contractID: "industrial-hireling-00000001",
    siteID: 40342603,
  };
  const first = service.syncOperationBookmark(request);
  assert.equal(first.success, true);
  assert.equal(first.data.action, "created");
  assert.equal(runtime.folders.length, 1);
  assert.equal(runtime.folders[0].folderName, OPERATIONS_FOLDER_NAME);
  assert.equal(runtime.bookmarks.length, 1);
  assert.equal(runtime.bookmarks[0].locationID, 30030141);
  assert.deepEqual(
    { x: runtime.bookmarks[0].x, y: runtime.bookmarks[0].y, z: runtime.bookmarks[0].z },
    { x: -37717647360, y: 849715200, z: -55091896320 },
  );
  assert.equal(runtime.bookmarks[0].metadata.source, MANAGED_SOURCE);
  assert.equal(runtime.bookmarks[0].metadata.contractID, request.contractID);
  assert.equal(runtime.bookmarks[0].metadata.siteID, request.siteID);
  assert.deepEqual(
    notifications.events.map((event) => event.type),
    ["folderUpdated", "added"],
  );
  assert.equal(first.data.requiresClientFolderRefresh, true);

  const second = service.syncOperationBookmark(request);
  assert.equal(second.success, true);
  assert.equal(second.data.action, "unchanged");
  assert.equal(second.data.bookmark.bookmarkID, first.data.bookmark.bookmarkID);
  assert.equal(runtime.calls.addFolder, 1);
  assert.equal(runtime.calls.createBookmark, 1);
  assert.equal(runtime.bookmarks.length, 1);
  assert.equal(notifications.events.length, 2);
}

function verifyDirectContractAliases() {
  const { runtime, service } = makeService();
  const realContractShape = {
    ownerCharacterID: 9101,
    contractID: "industrial-hireling-00000017",
    assignedSiteID: 40342603,
    assignedSystemID: 30030141,
  };
  const result = service.syncOperationBookmark(realContractShape);
  assert.equal(result.success, true);
  assert.equal(result.data.action, "created");
  assert.equal(result.data.siteID, realContractShape.assignedSiteID);
  assert.equal(result.data.bookmark.creatorID, realContractShape.ownerCharacterID);
  assert.equal(result.data.bookmark.locationID, realContractShape.assignedSystemID);
  assert.equal(result.data.bookmark.metadata.contractID, realContractShape.contractID);
  assert.equal(result.data.bookmark.metadata.siteID, realContractShape.assignedSiteID);
  assert.equal(runtime.folders[0].creatorID, realContractShape.ownerCharacterID);
}

function verifyUpdateRetargetAndRemove() {
  const { runtime, notifications, service } = makeService();
  const base = {
    characterID: 9001,
    contractID: "industrial-hireling-00000002",
    siteID: 40342603,
  };
  const created = service.syncOperationBookmark(base);
  const updated = service.syncOperationBookmark({
    ...base,
    memo: "Quiet Resolve - Uitra Belt",
    note: "Miner is operating normally.",
  });
  assert.equal(updated.success, true);
  assert.equal(updated.data.action, "updated");
  assert.equal(updated.data.bookmark.bookmarkID, created.data.bookmark.bookmarkID);
  assert.equal(runtime.calls.updateBookmark, 1);
  assert.equal(notifications.events.at(-1).type, "updated");

  const retargeted = service.syncOperationBookmark({
    ...base,
    siteID: "uitra-anomaly-01",
    site: {
      siteID: "uitra-anomaly-01",
      siteName: "Uitra Dense Ore Pocket",
      solarSystemID: 30030141,
      actualPosition: { x: 101, y: 202, z: 303 },
    },
  });
  assert.equal(retargeted.success, true);
  assert.equal(retargeted.data.action, "retargeted");
  assert.deepEqual(
    runtime.calls.order.slice(-2),
    ["createBookmark", "deleteBookmarks"],
  );
  assert.equal(runtime.bookmarks.length, 1);
  assert.notEqual(retargeted.data.bookmark.bookmarkID, created.data.bookmark.bookmarkID);
  assert.equal(retargeted.data.deletedBookmarkIDs.length, 1);
  assert.deepEqual(
    { x: runtime.bookmarks[0].x, y: runtime.bookmarks[0].y, z: runtime.bookmarks[0].z },
    { x: 101, y: 202, z: 303 },
  );

  const removed = service.removeOperationBookmark({
    characterID: 9001,
    contractID: base.contractID,
  });
  assert.equal(removed.success, true);
  assert.equal(removed.data.action, "removed");
  assert.equal(runtime.bookmarks.length, 0);
  assert.equal(notifications.events.at(-1).type, "removed");
  const removedAgain = service.removeOperationBookmark({
    characterID: 9001,
    contractID: base.contractID,
  });
  assert.equal(removedAgain.success, true);
  assert.equal(removedAgain.data.action, "not_found");
}

function verifyDeduplicationAndIsolation() {
  const { runtime, service } = makeService();
  const first = service.syncOperationBookmark({
    characterID: 9001,
    contractID: "contract-a",
    siteID: 40342603,
  });
  service.syncOperationBookmark({
    characterID: 9001,
    contractID: "contract-b",
    siteID: 40342603,
  });
  runtime.bookmarks.push({
    ...clone(first.data.bookmark),
    bookmarkID: 999999999,
  });
  const deduplicated = service.syncOperationBookmark({
    characterID: 9001,
    contractID: "contract-a",
    siteID: 40342603,
  });
  assert.equal(deduplicated.success, true);
  assert.equal(deduplicated.data.action, "deduplicated");
  assert.equal(
    runtime.bookmarks.filter((bookmark) => bookmark.metadata.contractID === "contract-a").length,
    1,
  );
  assert.equal(
    runtime.bookmarks.filter((bookmark) => bookmark.metadata.contractID === "contract-b").length,
    1,
  );
}

function verifyValidationDoesNotCreateFolder() {
  const { runtime, service } = makeService();
  const invalid = service.syncOperationBookmark({
    characterID: 9001,
    contractID: "contract-missing-coordinates",
    siteID: "unknown-site",
    solarSystemID: 30030141,
  });
  assert.equal(invalid.success, false);
  assert.equal(invalid.errorMsg, "INDUSTRIAL_BOOKMARK_COORDINATES_REQUIRED");
  assert.equal(runtime.folders.length, 0);
  assert.equal(runtime.bookmarks.length, 0);
}

function verifyRemovalFromInactiveFolder() {
  const { runtime, service } = makeService();
  const request = {
    characterID: 9001,
    contractID: "contract-inactive-folder",
    siteID: 40342603,
  };
  assert.equal(service.syncOperationBookmark(request).success, true);
  runtime.folders[0].isActive = false;
  const removed = service.removeOperationBookmark(request);
  assert.equal(removed.success, true);
  assert.equal(removed.data.action, "removed");
  assert.equal(runtime.bookmarks.length, 0);
}

function verifyRenamedAndMovedManagedCleanup() {
  const { runtime, service } = makeService();
  const renamedRequest = {
    characterID: 9001,
    contractID: "contract-renamed-folder",
    siteID: 40342603,
  };
  assert.equal(service.syncOperationBookmark(renamedRequest).success, true);
  runtime.folders[0].folderName = "My Mining Bookmarks";
  const removedFromRenamed = service.removeOperationBookmark(renamedRequest);
  assert.equal(removedFromRenamed.success, true);
  assert.equal(removedFromRenamed.data.action, "removed");
  assert.equal(runtime.bookmarks.length, 0);

  const movedRequest = {
    characterID: 9001,
    contractID: "contract-moved-bookmark",
    siteID: 40342603,
  };
  const created = service.syncOperationBookmark(movedRequest);
  assert.equal(created.success, true);
  const destinationFolder = {
    folderID: 600001,
    folderName: "Remote Industry",
    description: "Player-managed folder",
    creatorID: 9001,
    isPersonal: true,
    isActive: true,
  };
  runtime.folders.push(destinationFolder);
  const movedBookmark = runtime.bookmarks.find(
    (bookmark) => bookmark.bookmarkID === created.data.bookmark.bookmarkID,
  );
  movedBookmark.folderID = destinationFolder.folderID;
  const removedFromMoved = service.removeOperationBookmark(movedRequest);
  assert.equal(removedFromMoved.success, true);
  assert.equal(removedFromMoved.data.action, "removed");
  assert.deepEqual(
    removedFromMoved.data.deletedBookmarkIDs,
    [created.data.bookmark.bookmarkID],
  );
  assert.equal(runtime.bookmarks.length, 0);
}

function verifyFailedRetargetPreservesExistingBookmark() {
  const { runtime, service } = makeService({
    runtimeOptions: { folderCapacity: 1 },
  });
  const base = {
    characterID: 9001,
    contractID: "contract-capacity-retarget",
    siteID: 40342603,
  };
  const first = service.syncOperationBookmark(base);
  assert.equal(first.success, true);
  runtime.calls.order.length = 0;

  const retargeted = service.syncOperationBookmark({
    ...base,
    assignedSiteID: "uitra-capacity-anomaly",
    siteID: "uitra-capacity-anomaly",
    assignedSystemID: 30030141,
    position: { x: 400, y: 500, z: 600 },
  });
  assert.equal(retargeted.success, false);
  assert.equal(retargeted.errorMsg, "FolderCapacityExceeded");
  assert.deepEqual(runtime.calls.order, ["createBookmark"]);
  assert.equal(runtime.bookmarks.length, 1);
  assert.equal(runtime.bookmarks[0].bookmarkID, first.data.bookmark.bookmarkID);
  assert.equal(runtime.bookmarks[0].metadata.siteID, base.siteID);
}

function verifyInactiveOperationsFolderFallback() {
  const { runtime, notifications, service } = makeService();
  const activeFallback = {
    folderID: 510001,
    folderName: "Personal Locations",
    description: "",
    creatorID: 9001,
    isPersonal: true,
    isActive: true,
  };
  const inactiveOperations = {
    folderID: 510002,
    folderName: OPERATIONS_FOLDER_NAME,
    description: "",
    creatorID: 9001,
    isPersonal: true,
    isActive: false,
  };
  runtime.folders.push(activeFallback, inactiveOperations);
  runtime.updateKnownFolderState = () => {
    const error = new Error("TooManyActivePersonalBookmarkFolders");
    error.bookmarkError = "TooManyActivePersonalBookmarkFolders";
    throw error;
  };

  const result = service.syncOperationBookmark({
    ownerCharacterID: 9001,
    contractID: "contract-folder-fallback",
    assignedSiteID: 40342603,
    assignedSystemID: 30030141,
  });
  assert.equal(result.success, true);
  assert.equal(result.data.fallbackFolder, true);
  assert.equal(result.data.folderCreated, false);
  assert.equal(result.data.requiresClientFolderRefresh, false);
  assert.equal(result.data.folder.folderID, activeFallback.folderID);
  assert.equal(runtime.bookmarks.length, 1);
  assert.equal(runtime.bookmarks[0].folderID, activeFallback.folderID);
  assert.equal(runtime.calls.addFolder, 0);
  assert.equal(
    notifications.events.some((event) => event.type === "folderUpdated"),
    false,
  );
}

verifyCreateAndIdempotence();
verifyDirectContractAliases();
verifyUpdateRetargetAndRemove();
verifyDeduplicationAndIsolation();
verifyValidationDoesNotCreateFolder();
verifyRemovalFromInactiveFolder();
verifyRenamedAndMovedManagedCleanup();
verifyFailedRetargetPreservesExistingBookmark();
verifyInactiveOperationsFolderFallback();

console.log("Industrial hireling bookmark verification passed.");
