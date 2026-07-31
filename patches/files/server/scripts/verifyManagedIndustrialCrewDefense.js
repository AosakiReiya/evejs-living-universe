"use strict";

const assert = require("assert");
const path = require("path");

const miningOperations = require(path.join(
  __dirname,
  "../src/services/mining/miningNpcOperations",
));
const npcService = require(path.join(
  __dirname,
  "../src/space/npc",
));
const {
  resolveIndustrialMiningCrewPackage,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialMiningCrewCatalog",
));

const testing = miningOperations._testing;
const originalGetControllerByEntityID =
  npcService.getControllerByEntityID;

function pristineCrewEntity(itemID, position) {
  return {
    itemID,
    typeID: 22544,
    kind: "ship",
    nativeNpc: true,
    mode: "STOP",
    bubbleID: 1,
    position,
    conditionState: {
      shieldCharge: 1,
      armorDamage: 0,
      damage: 0,
    },
  };
}

function defenseController() {
  return {
    definitionSnapshot: {
      loadout: {
        droneBay: [
          {
            droneTypeID: 2454,
            quantity: 5,
          },
        ],
        defenseFlights: [
          {
            droneTypeID: 2454,
            launchCount: 5,
            targetSizeClasses: ["frigate"],
          },
        ],
      },
    },
  };
}

function createFleet(scene, options) {
  return testing.createMiningFleetRecord({
    scene,
    source: "industrial_mining_crew",
    operatorKind: "industrial_hireling",
    operatorID: options.operatorID,
    createdByCharacterID: options.ownerCharacterID,
    cargoOwnerID: options.ownerCharacterID,
    systemID: scene.systemID,
    targetShipID: options.siteID,
    minerEntityIDs: options.entityIDs,
    miningWorkerEntityIDs: options.entityIDs,
    state: "mining",
    threatDoctrine: options.threatDoctrine,
  });
}

function main() {
  testing.clearState();

  const entities = new Map();
  const controllers = new Map();
  const scene = {
    systemID: 30000140,
    getEntityByID(entityID) {
      return entities.get(Number(entityID)) || null;
    },
  };
  const direGuristas = {
    itemID: 99_001,
    typeID: 23334,
    groupID: 562,
    categoryID: 11,
    itemName: "Dire Guristas Destructor",
    kind: "ship",
    nativeNpc: true,
    mode: "STOP",
    bubbleID: 1,
    bounty: 36_000,
    radius: 40,
    position: { x: 2_000, y: 0, z: 0 },
    conditionState: {
      shieldCharge: 1,
      armorDamage: 0,
      damage: 0,
    },
  };
  entities.set(direGuristas.itemID, direGuristas);
  controllers.set(direGuristas.itemID, {
    definitionSnapshot: {
      profile: {
        name: "Dire Guristas Destructor",
        profileID: "retail_asteroid_guristas_frigate_23334",
      },
      loadout: {},
    },
  });

  const firstCrewEntityIDs = [71_001, 71_002, 71_003, 71_004];
  const secondCrewEntityIDs = [72_001, 72_002, 72_003, 72_004];
  for (const [index, entityID] of [
    ...firstCrewEntityIDs,
    ...secondCrewEntityIDs,
  ].entries()) {
    entities.set(
      entityID,
      pristineCrewEntity(entityID, {
        x: index * 250,
        y: 0,
        z: 0,
      }),
    );
    controllers.set(entityID, defenseController());
  }

  npcService.getControllerByEntityID = (entityID) =>
    controllers.get(Number(entityID)) || null;

  const orcaPackage =
    resolveIndustrialMiningCrewPackage(
      "orca_extraction_company",
    );
  const rorqualPackage =
    resolveIndustrialMiningCrewPackage(
      "rorqual_industrial_division",
    );
  assert.equal(
    orcaPackage.threatDoctrine.requiredCrewOvermatch,
    2,
  );
  assert.equal(
    orcaPackage.threatDoctrine.maximumThreatBountyISK,
    75_000,
  );
  assert.equal(
    rorqualPackage.threatDoctrine.requiredCrewOvermatch,
    1.75,
  );
  assert.equal(
    rorqualPackage.threatDoctrine.maximumThreatBountyISK,
    120_000,
  );

  const firstFleet = createFleet(scene, {
    operatorID: "industrial-hireling-test-1",
    ownerCharacterID: 140000006,
    siteID: 40008922,
    entityIDs: firstCrewEntityIDs,
    threatDoctrine: orcaPackage.threatDoctrine,
  });
  const singleCrewAssessment =
    testing.assessManagedIndustrialThreat(
      scene,
      firstFleet,
      direGuristas,
    );
  assert.equal(singleCrewAssessment.engage, true);
  assert.equal(
    singleCrewAssessment.reason,
    "KNOWN_NPC_OVERMATCH",
  );
  assert.equal(singleCrewAssessment.requiredOvermatch, 2);
  assert.equal(
    singleCrewAssessment.participatingFleets.length,
    1,
  );

  const secondFleet = createFleet(scene, {
    operatorID: "industrial-hireling-test-2",
    ownerCharacterID: 140000006,
    siteID: 40008922,
    entityIDs: secondCrewEntityIDs,
    threatDoctrine: rorqualPackage.threatDoctrine,
  });
  const combinedAssessment =
    testing.assessManagedIndustrialThreat(
      scene,
      firstFleet,
      direGuristas,
    );
  assert.equal(combinedAssessment.engage, true);
  assert.equal(
    combinedAssessment.participatingFleets.length,
    2,
  );
  assert.equal(
    combinedAssessment.plannedDroneCount,
    40,
  );
  assert.equal(
    combinedAssessment.defensePower,
    singleCrewAssessment.defensePower * 2,
  );
  assert.deepEqual(
    combinedAssessment.participatingFleets.map(
      (fleet) => fleet.fleetID,
    ),
    [firstFleet.fleetID, secondFleet.fleetID],
  );

  const unrelatedFleet = createFleet(scene, {
    operatorID: "industrial-hireling-test-other-owner",
    ownerCharacterID: 140000007,
    siteID: 40008922,
    entityIDs: [],
    threatDoctrine: rorqualPackage.threatDoctrine,
  });
  assert.equal(
    testing.listCoLocatedManagedIndustrialFleets(
      scene,
      firstFleet,
    ).includes(unrelatedFleet),
    false,
  );

  testing.clearState();
  const legacyFleet = createFleet(scene, {
    operatorID: "industrial-hireling-test-legacy",
    ownerCharacterID: 140000006,
    siteID: 40008923,
    entityIDs: firstCrewEntityIDs,
    threatDoctrine: null,
  });
  const legacyAssessment =
    testing.assessManagedIndustrialThreat(
      scene,
      legacyFleet,
      direGuristas,
    );
  assert.equal(legacyAssessment.engage, false);
  assert.equal(
    legacyAssessment.reason,
    "THREAT_BOUNTY_OUT_OF_POLICY",
  );

  console.log(
    "Managed industrial crew defense verification passed.",
  );
}

try {
  main();
} finally {
  npcService.getControllerByEntityID =
    originalGetControllerByEntityID;
  testing.clearState();
}
