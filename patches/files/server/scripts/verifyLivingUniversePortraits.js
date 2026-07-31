"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert/strict");
const fs = require("fs");

const imageRequestResolver = require("../src/_secondary/image/imageRequestResolver");
const portraitImageStore = require("../src/services/character/portraitImageStore");
const npcData = require("../src/space/npc/npcData");
const livingUniverseRuntime = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");
const pilotDirectory = require("../src/space/npc/ambientTraffic/livingUniversePilotDirectory");

function runVerification(count = 4000) {
  const required = Math.max(1, Math.trunc(Number(count) || 4000));
  const state = livingUniverseRuntime._testing.buildPopulationPlan(required, 1_700_000_000_000);
  const sync = pilotDirectory.syncActors(Object.values(state.actors), {
    getProfile: (profileID) => npcData.getNpcProfile(profileID),
  });
  const pilots = sync.pilots;
  assert.equal(pilots.length, required);
  assert.equal(new Set(pilots.map((pilot) => pilot.characterID)).size, required);
  assert.equal(
    new Set(pilots.map((pilot) => pilot.portraitSourceCharacterID)).size,
    required,
    "every pilot must have a distinct portrait source",
  );

  let totalBytes = 0;
  let syntheticDirectCollisions = 0;
  for (const pilot of pilots) {
    const sourcePath = portraitImageStore.findCharacterPortraitPath(
      pilot.portraitSourceCharacterID,
      256,
    );
    assert.ok(sourcePath, `portrait source ${pilot.portraitSourceCharacterID} is missing`);
    const stat = fs.statSync(sourcePath);
    assert.ok(stat.size > 1000, `portrait source ${pilot.portraitSourceCharacterID} is invalid`);
    totalBytes += stat.size;
    const resolved = imageRequestResolver.resolveImageRequest(
      `/Character/${pilot.characterID}_256.jpg`,
    );
    assert.equal(resolved.filePath, sourcePath);
    const staleDirectPath = portraitImageStore.findCharacterPortraitPath(
      pilot.characterID,
      256,
    );
    if (staleDirectPath && staleDirectPath !== sourcePath) {
      syntheticDirectCollisions += 1;
      assert.equal(
        resolved.filePath,
        sourcePath,
        "a recognized synthetic pilot must prefer its mapped portrait source",
      );
    }
  }

  if (required >= 5000) {
    assert.ok(
      syntheticDirectCollisions > 0,
      "the 5,000-pilot plan must exercise stale direct-file precedence",
    );
  }

  const realCharacterID = 140000005;
  const realPortraitPath = portraitImageStore.findCharacterPortraitPath(
    realCharacterID,
    256,
  );
  assert.ok(realPortraitPath, "real-character portrait fixture is missing");
  assert.equal(pilotDirectory.getPortraitSourceCharacterID(realCharacterID), 0);
  assert.equal(
    imageRequestResolver.resolveImageRequest(
      `/Character/${realCharacterID}_256.jpg`,
    ).filePath,
    realPortraitPath,
    "a real character must retain its direct stored portrait",
  );

  const unknownCharacterID = 140000006;
  const unknownPortraitPath = portraitImageStore.findCharacterPortraitPath(
    unknownCharacterID,
    64,
  );
  assert.ok(unknownPortraitPath, "unknown-character direct portrait fixture is missing");
  assert.equal(pilotDirectory.getPortraitSourceCharacterID(unknownCharacterID), 0);
  assert.equal(
    imageRequestResolver.resolveImageRequest(
      `/Character/${unknownCharacterID}_64.jpg`,
    ).filePath,
    unknownPortraitPath,
    "an unknown character with a direct portrait must retain that portrait",
  );

  const missingCharacterID = 2_147_483_646;
  assert.equal(pilotDirectory.getPortraitSourceCharacterID(missingCharacterID), 0);
  assert.equal(
    portraitImageStore.findCharacterPortraitPath(missingCharacterID, 256),
    null,
  );
  assert.equal(
    imageRequestResolver.resolveImageRequest(
      `/Character/${missingCharacterID}_256.jpg`,
    ).filePath,
    portraitImageStore.DEFAULT_CHARACTER_PORTRAIT_PATH,
    "an unknown character without a local portrait must use the default",
  );

  return {
    success: true,
    pilots: required,
    uniqueCharacterIDs: required,
    uniquePortraitSources: required,
    cachedPortraits: required,
    syntheticDirectCollisions,
    totalMiB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
  };
}

if (require.main === module) {
  console.log(JSON.stringify(runVerification(process.argv[2]), null, 2));
}

module.exports = { runVerification };
