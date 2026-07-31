"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert");
const path = require("path");

const chatRuntime = require(path.join(
  __dirname,
  "../src/_secondary/chat/chatRuntime",
));
const webChatGatewayService = require(path.join(
  __dirname,
  "../src/_secondary/express/gatewayServices/webChatGatewayService",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../src/services/chat/sessionRegistry",
));
const xmppStubServer = require(path.join(
  __dirname,
  "../src/services/chat/xmppStubServer",
));

const SOURCE = "industrial_hirelings";
const CORPORATION_ID = 1000044;
const OTHER_CORPORATION_ID = 1000169;
const SYSTEM_ID = 30000142;
const OTHER_SYSTEM_ID = 30000144;

const crew = {
  characterID: 2_127_999_901,
  characterName: "Synthetic Crew Verifier",
  corporationID: CORPORATION_ID,
  allianceID: 0,
  warFactionID: 0,
  solarSystemID: SYSTEM_ID,
  localVisible: true,
  corporationVisible: true,
};

const ambient = {
  characterID: 2_127_999_902,
  characterName: "Synthetic Ambient Verifier",
  corporationID: OTHER_CORPORATION_ID,
  allianceID: 0,
  warFactionID: 0,
  solarSystemID: SYSTEM_ID,
  localVisible: true,
  corporationVisible: true,
};

function main() {
  chatRuntime._testing.resetRuntimeState({ resetStore: false });
  const sessionCountBefore = sessionRegistry.getSessions().length;
  const events = [];
  const listeners = [
    ["corp-join", (event) => events.push(["join", event])],
    ["corp-leave", (event) => events.push(["leave", event])],
    ["corp-membership-refresh", (event) => events.push(["refresh", event])],
  ];
  for (const [eventName, listener] of listeners) {
    chatRuntime.on(eventName, listener);
  }
  const xmppWrites = [];
  const xmppRecipient = {
    userName: "2127999999",
    boundJid: "2127999999@localhost/eveclient",
    rooms: new Set(),
    socket: {
      destroyed: false,
      write(xml) {
        xmppWrites.push(String(xml));
      },
    },
  };
  const corporationRoomJid = xmppStubServer.__test__.normalizeRoomJid(
    `corp_${CORPORATION_ID}`,
    xmppRecipient,
  );
  xmppStubServer.__test__.registerClient(xmppRecipient);
  xmppStubServer.__test__.addRoomMember(corporationRoomJid, xmppRecipient);

  try {
    const legacyLocal = chatRuntime.syncSyntheticLocalMembers([ambient]);
    assert.strictEqual(legacyLocal.source, "legacy");
    assert.strictEqual(legacyLocal.members, 1);

    const crewLocal = chatRuntime.syncSyntheticLocalMembers(
      [crew],
      { sourceID: SOURCE },
    );
    assert.strictEqual(crewLocal.sourceMembers, 1);
    assert.strictEqual(crewLocal.members, 2);

    const ambientClear = chatRuntime.syncSyntheticLocalMembers([]);
    assert.strictEqual(ambientClear.source, "legacy");
    assert.strictEqual(ambientClear.members, 1);
    assert.deepStrictEqual(
      chatRuntime.getSyntheticLocalMembers(SYSTEM_ID).map(
        (member) => member.characterID,
      ),
      [crew.characterID],
      "a legacy/ambient full refresh must not erase another source",
    );

    const movedLocal = chatRuntime.upsertSyntheticLocalMembers(SOURCE, [{
      ...crew,
      solarSystemID: OTHER_SYSTEM_ID,
    }]);
    assert.strictEqual(movedLocal.leaves, 1);
    assert.strictEqual(movedLocal.joins, 1);
    assert.strictEqual(
      chatRuntime.getSyntheticLocalMembers(OTHER_SYSTEM_ID)[0].characterID,
      crew.characterID,
    );

    const corporationJoin = chatRuntime.syncSyntheticCorporationMembers(
      [crew],
      { sourceID: SOURCE },
    );
    assert.strictEqual(corporationJoin.joins, 1);
    assert.strictEqual(corporationJoin.members, 1);
    assert.strictEqual(
      chatRuntime.getSyntheticCorporationMembers(CORPORATION_ID)[0].characterID,
      crew.characterID,
    );
    assert(
      xmppWrites.some((xml) => (
        xml.includes(`<presence from='${corporationRoomJid}/${crew.characterID}'`) &&
        !xml.includes("type='unavailable'") &&
        xml.includes(`corpid='${CORPORATION_ID}'`) &&
        xml.includes(crew.characterName)
      )),
      "chatRuntime Corp joins must carry the crew name and corporation into retail XMPP",
    );

    const corporationRefresh = chatRuntime.upsertSyntheticCorporationMembers(
      SOURCE,
      [{ ...crew, characterName: `${crew.characterName} II` }],
    );
    assert.strictEqual(corporationRefresh.refreshes, 1);

    const corporationMove = chatRuntime.upsertSyntheticCorporationMembers(
      SOURCE,
      [{ ...crew, corporationID: OTHER_CORPORATION_ID }],
    );
    assert.strictEqual(corporationMove.leaves, 1);
    assert.strictEqual(corporationMove.joins, 1);
    assert.strictEqual(
      chatRuntime.getSyntheticCorporationMembers(CORPORATION_ID).length,
      0,
    );

    chatRuntime.upsertSyntheticCorporationMembers(SOURCE, [crew]);
    chatRuntime.syncSyntheticCorporationMembers([ambient]);
    const ambientCorporationClear = chatRuntime.syncSyntheticCorporationMembers([]);
    assert.strictEqual(ambientCorporationClear.members, 1);
    assert.strictEqual(
      chatRuntime.getSyntheticCorporationMembers(CORPORATION_ID)[0].characterID,
      crew.characterID,
      "a legacy corporation refresh must not erase industrial members",
    );

    assert.throws(
      () => chatRuntime.syncSyntheticCorporationMembers(
        "conflicting_source",
        [crew],
      ),
      (error) => (
        error &&
        error.code === "SYNTHETIC_CHAT_CHARACTER_SOURCE_COLLISION"
      ),
    );

    const webRoster = webChatGatewayService.getCorpRoster({
      corporationID: CORPORATION_ID,
    });
    assert(
      webRoster.some((member) => member.characterID === crew.characterID),
      "the web Corp roster must include synthetic corporation members",
    );

    const xmppRoster = xmppStubServer.__test__
      .getSocketlessRoomMemberCharacterIDs({
        kind: "corp",
        roomID: CORPORATION_ID,
      });
    assert(
      xmppRoster.includes(crew.characterID),
      "the retail XMPP Corp initial roster must include synthetic members",
    );

    const removal = chatRuntime.removeSyntheticPilotMembers(
      [crew.characterID],
      { sourceID: SOURCE },
    );
    assert.deepStrictEqual(removal.removedCharacterIDs, [crew.characterID]);
    assert.strictEqual(
      chatRuntime.getSyntheticLocalMembers(OTHER_SYSTEM_ID).length,
      0,
    );
    assert.strictEqual(
      chatRuntime.getSyntheticCorporationMembers(CORPORATION_ID).length,
      0,
    );

    assert.strictEqual(
      sessionRegistry.getSessions().length,
      sessionCountBefore,
      "synthetic presence must not create authenticated sessions",
    );
    assert(events.some(([kind]) => kind === "join"));
    assert(events.some(([kind]) => kind === "leave"));
    assert(events.some(([kind]) => kind === "refresh"));

    process.stdout.write(`${JSON.stringify({
      sourceOwnedLocal: true,
      sourceOwnedCorporation: true,
      corporationEvents: events.length,
      webRoster: true,
      xmppInitialRoster: true,
      xmppLiveBridge: true,
      authenticatedSessionsCreated: 0,
    }, null, 2)}\n`);
  } finally {
    for (const [eventName, listener] of listeners) {
      chatRuntime.off(eventName, listener);
    }
    chatRuntime._testing.resetRuntimeState({ resetStore: false });
  }
}

main();
