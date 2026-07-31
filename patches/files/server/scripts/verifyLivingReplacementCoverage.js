"use strict";

const assert = require("assert/strict");

const config = require("../src/config");
const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const economyIndustry = require(
  "../src/space/npc/ambientTraffic/livingEconomyIndustry",
);
const economyCatalog = require(
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
);
const universeState = require(
  "../src/space/npc/ambientTraffic/livingUniverseState",
);

function runVerification() {
  const state = universeState.readState();
  const actors = Object.values(state.actors || {});
  assert.ok(
    actors.length > 0,
    "the selected gameStore does not contain living-universe actors",
  );

  const audit = economyRuntime.auditReplacementCoverage(actors);
  assert.equal(
    audit.actorsWithGaps,
    0,
    `replacement catalog gaps: ${JSON.stringify(audit.missing)}`,
  );
  assert.equal(audit.actorsWithHullGaps, 0);
  assert.equal(audit.missingTypeCount, 0);

  const requiredTypeIDs = new Set();
  for (const actor of actors) {
    const replacementPackage =
      economyRuntime._testing.buildReplacementRequirementPackage(actor);
    assert.equal(
      replacementPackage.hullCovered,
      true,
      `actor ${actor.actorID} has no replacement hull ${actor.shipTypeID}`,
    );
    assert.equal(
      replacementPackage.complete,
      true,
      `actor ${actor.actorID} has an incomplete replacement package`,
    );
    assert.equal(
      replacementPackage.requirements.some(
        (item) => Number(item.typeID) === Number(actor.shipTypeID),
      ),
      true,
      `actor ${actor.actorID} replacement package omitted its hull`,
    );
    for (const requirement of replacementPackage.requirements) {
      requiredTypeIDs.add(Number(requirement.typeID));
    }
  }

  const missingSupplyPaths = [];
  for (const typeID of requiredTypeIDs) {
    const good = economyCatalog.getGood(typeID);
    const recipe = good && economyIndustry.getRecipe(good);
    if (recipe) continue;
    // A pirate faction hull without a recipe is still supplied when faction
    // shipyards are enabled AND the owning faction has at least one shipyard
    // station; a faction with no shipyard would be a genuine coverage gap.
    if (
      config.livingEconomyFactionShipyardEnabled === true &&
      economyCatalog.isPirateFactionHull(typeID) &&
      economyCatalog.getFactionShipyardStations(
        economyCatalog.getPirateFactionID(typeID),
      ).length > 0
    ) {
      continue;
    }
    missingSupplyPaths.push({
      typeID,
      typeName: good && good.name || `type ${typeID}`,
    });
  }
  assert.deepEqual(
    missingSupplyPaths,
    [],
    `replacement requirements lack production paths: ` +
      `${JSON.stringify(missingSupplyPaths)}`,
  );

  return {
    success: true,
    actorCount: actors.length,
    coveragePercent: audit.coveragePercent,
    hullCoveragePercent: audit.hullCoveragePercent,
    missingTypeCount: audit.missingTypeCount,
    replacementRequirementTypeCount: requiredTypeIDs.size,
    missingSupplyPathCount: missingSupplyPaths.length,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runVerification(), null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { runVerification };
