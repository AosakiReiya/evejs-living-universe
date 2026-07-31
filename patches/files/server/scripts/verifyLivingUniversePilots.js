"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert");
const path = require("path");

const livingState = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniverseState",
));
const pilotDirectory = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniversePilotDirectory",
));
const npcData = require(path.join(__dirname, "../src/space/npc/npcData"));
const chatRuntime = require(path.join(
  __dirname,
  "../src/_secondary/chat/chatRuntime",
));
const characterState = require(path.join(
  __dirname,
  "../src/services/character/characterState",
));
const ConfigService = require(path.join(
  __dirname,
  "../src/services/config/configService",
));
const BountyProxyService = require(path.join(
  __dirname,
  "../src/services/bounty/bountyProxyService",
));
const { resolveImageRequest } = require(path.join(
  __dirname,
  "../src/_secondary/image/imageRequestResolver",
));
const { buildSlimItemDict } = require(path.join(
  __dirname,
  "../src/space/destiny",
));
const {
  getLocalChatRoomNameForSolarSystemID,
  isDelayedLocalChatRoomName,
} = require(path.join(__dirname, "../src/services/chat/channelRules"));

function dictValue(dict, key) {
  const entries = dict && dict.type === "dict" && Array.isArray(dict.entries)
    ? dict.entries
    : [];
  const pair = entries.find((entry) => Array.isArray(entry) && entry[0] === key);
  return pair ? pair[1] : undefined;
}

function main() {
  const state = livingState.readState();
  const actors = Object.values(state.actors || {});
  assert(actors.length > 0, "persistent living-universe actors are required");

  const syncResult = pilotDirectory.syncActors(actors, {
    getProfile: (profileID) => npcData.getNpcProfile(profileID),
  });
  assert.strictEqual(syncResult.pilots.length, actors.length);
  assert.strictEqual(
    new Set(syncResult.pilots.map((pilot) => pilot.characterID)).size,
    actors.length,
    "pilot character IDs must be unique",
  );
  assert.strictEqual(
    new Set(syncResult.pilots.map((pilot) => pilot.characterName)).size,
    actors.length,
    "pilot names must be unique",
  );
  const firstNameCounts = syncResult.pilots.reduce((counts, pilot) => {
    const firstName = String(pilot.characterName || "").split(/\s+/)[0];
    counts[firstName] = (counts[firstName] || 0) + 1;
    return counts;
  }, {});
  assert.strictEqual(
    Object.keys(firstNameCounts).length,
    actors.length,
    "the test population must not repeat first names",
  );
  assert.strictEqual(
    Math.max(...Object.values(firstNameCounts)),
    1,
    "no first name may repeat in the 400-pilot test population",
  );
  assert(
    syncResult.pilots.every((pilot) => (
      pilot.characterID >= 2_100_000_000 && pilot.characterID <= 2_129_999_999
    )),
    "pilot IDs must remain inside the generation-3 client owner range",
  );
  assert.strictEqual(
    new Set(syncResult.pilots.map((pilot) => pilot.portraitSourceCharacterID)).size,
    actors.length,
    "the test population should have unique portraits",
  );

  const sample = syncResult.pilots[0];
  const characterRecord = characterState.getCharacterRecord(sample.characterID);
  assert(characterRecord && characterRecord.syntheticNpcPilot === true);
  assert.strictEqual(characterRecord.loginDisabled, true);
  assert.strictEqual(characterRecord.accountID, 0);
  assert.strictEqual(characterRecord.characterName, sample.characterName);
  assert.strictEqual(
    characterState.updateCharacterRecord(sample.characterID, { hacked: true }).errorMsg,
    "SYNTHETIC_PILOT_READ_ONLY",
  );

  const ownerRows = new ConfigService().Handle_GetMultiOwnersEx([
    { type: "list", items: [sample.characterID] },
  ]);
  assert.strictEqual(ownerRows[1][0][0], sample.characterID);
  assert.strictEqual(ownerRows[1][0][1], sample.characterName);
  assert.strictEqual(ownerRows[1][0][2], sample.typeID);

  const bountyResult = new BountyProxyService().Handle_GetBounties([
    { type: "list", items: [sample.characterID] },
  ]);
  assert.strictEqual(bountyResult.type, "dict");
  assert(
    bountyResult.entries.some((entry) => entry[0] === sample.characterID),
    "character bounty lookup must return a zero-valued owner entry",
  );

  chatRuntime._testing.resetRuntimeState({ resetStore: false });
  const firstSync = chatRuntime.syncSyntheticLocalMembers(syncResult.pilots);
  assert.strictEqual(firstSync.members, actors.length);
  const visiblePilots = syncResult.pilots.filter((pilot) => (
    Number(pilot.solarSystemID || 0) > 0 &&
    pilot.localVisible !== false &&
    !isDelayedLocalChatRoomName(
      getLocalChatRoomNameForSolarSystemID(pilot.solarSystemID),
    )
  ));
  const bySystemTotal = [...new Set(visiblePilots.map((pilot) => pilot.solarSystemID))]
    .reduce((total, systemID) => (
      total + chatRuntime.getSyntheticLocalMembers(systemID).length
    ), 0);
  assert.strictEqual(bySystemTotal, visiblePilots.length);

  const movingPilot = visiblePilots.find((pilot) => pilot.solarSystemID === 30000142)
    || visiblePilots[0];
  const oldSystemID = movingPilot.solarSystemID;
  const newSystemID = oldSystemID === 30000144 ? 30000142 : 30000144;
  const movingActor = actors.find((actor) => actor.actorID === movingPilot.actorID);
  movingActor.currentSystemID = newSystemID;
  const movedDirectory = pilotDirectory.syncActorChanges([movingActor], {
    getProfile: (profileID) => npcData.getNpcProfile(profileID),
  });
  assert.strictEqual(movedDirectory.pilots.length, 1);
  const movedChat = chatRuntime.upsertSyntheticLocalMembers(movedDirectory.pilots);
  assert.strictEqual(movedChat.joins, 1);
  assert.strictEqual(movedChat.leaves, 1);
  assert(
    !chatRuntime.getSyntheticLocalMembers(oldSystemID)
      .some((pilot) => pilot.characterID === movingPilot.characterID),
  );
  assert(
    chatRuntime.getSyntheticLocalMembers(newSystemID)
      .some((pilot) => pilot.characterID === movingPilot.characterID),
  );

  const offlineDirectory = pilotDirectory.syncActorChanges([movingActor], {
    getProfile: (profileID) => npcData.getNpcProfile(profileID),
    resolvePresence: () => ({
      solarSystemID: newSystemID,
      stationID: 60003760,
      state: "docked_offline",
      localVisible: false,
      assignment: "available",
    }),
  });
  assert.strictEqual(offlineDirectory.pilots.length, 1);
  assert.strictEqual(offlineDirectory.pilots[0].stationID, 60003760);
  assert.strictEqual(offlineDirectory.pilots[0].localVisible, false);
  assert(offlineDirectory.pilots[0].capabilities.length >= 1);
  const offlineChat = chatRuntime.upsertSyntheticLocalMembers(offlineDirectory.pilots);
  assert.strictEqual(offlineChat.leaves, 1);
  assert(
    !chatRuntime.getSyntheticLocalMembers(newSystemID)
      .some((pilot) => pilot.characterID === movingPilot.characterID),
    "a docked-offline persistent pilot must leave Local",
  );

  const onlineDirectory = pilotDirectory.syncActorChanges([movingActor], {
    getProfile: (profileID) => npcData.getNpcProfile(profileID),
    resolvePresence: () => ({
      solarSystemID: newSystemID,
      stationID: null,
      state: "in_space_virtual",
      localVisible: true,
      assignment: "courier",
    }),
  });
  const onlineChat = chatRuntime.upsertSyntheticLocalMembers(onlineDirectory.pilots);
  assert.strictEqual(onlineChat.joins, 1);
  assert(
    chatRuntime.getSyntheticLocalMembers(newSystemID)
      .some((pilot) => pilot.characterID === movingPilot.characterID),
    "the same persistent pilot must return to Local when assigned in space",
  );

  const imageResult = resolveImageRequest(
    `/Character/${sample.characterID}_64.jpg`,
  );
  assert(
    imageResult.filePath.includes(String(sample.portraitSourceCharacterID)) ||
      /[\\/]images[\\/]hi\.jpg$/i.test(imageResult.filePath),
    `synthetic portrait should alias its stable source or use the clean-install fallback: ${imageResult.filePath}`,
  );

  const slim = buildSlimItemDict({
    kind: "ship",
    itemID: 9_999_999,
    typeID: 672,
    groupID: 31,
    categoryID: 6,
    ownerID: sample.characterID,
    npcPilotCharacterID: sample.characterID,
    corporationID: sample.corporationID,
    allianceID: 0,
    warFactionID: 0,
    securityStatus: sample.securityStatus,
    bounty: 0,
    modules: [],
  });
  assert.strictEqual(dictValue(slim, "charID"), sample.characterID);
  assert.strictEqual(dictValue(slim, "ownerID"), sample.characterID);

  process.stdout.write(
    `${JSON.stringify({
      actors: actors.length,
      uniqueNames: actors.length,
      uniqueFirstNames: Object.keys(firstNameCounts).length,
      maximumFirstNameReuse: Math.max(...Object.values(firstNameCounts)),
      uniquePortraits: actors.length,
      systems: new Set(syncResult.pilots.map((pilot) => pilot.solarSystemID)).size,
      sample: {
        characterID: sample.characterID,
        characterName: sample.characterName,
        portraitSourceCharacterID: sample.portraitSourceCharacterID,
      },
    }, null, 2)}\n`,
  );
}

main();
