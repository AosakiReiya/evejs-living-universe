"use strict";

// NPC "entity" EWAR — driven by SDE dogma ATTRIBUTES on the rat hull, not by fitted modules
// or hull dogma effects. Classic mission rats (e.g. Blood/Sansha/Serpentis/Angel/Guristas
// frigates) carry EWAR as `entity*Chance` attributes with companion range/duration/strength
// attributes, but NO corresponding dogma *effect* — so the existing fitted-module and
// hull-effect synthesis paths (npcEquipment.getNpcHostileModules) find nothing.
//
// This catalog maps each entity-EWAR attribute family to (a) the activation-chance attribute,
// (b) the range/duration attributes, and (c) an NPC effect name the hostile/jammer runtimes
// already understand (hostileModuleRuntime.HOSTILE_EFFECT_DEFINITIONS_BY_NAME /
// jammerModuleRuntime). The synthesizer builds a hull-effect module item per present family and
// stamps the effective range + activation chance + effect duration directly onto it, so the
// existing dogma runtimes resolve the actual strength off the entity's own attributes (e.g. web
// speedFactor -75, scram strength 2) at their SDE-authored magnitude.
//
// Attribute IDs verified against tools/DataSync/source_json/eve-online-static-data-3396210-jsonl
// (dogmaAttributes.jsonl) and cross-checked against the golden logs (e.g. type 17061 scram 0.25 /
// web 0.35; type 24941 tracking-disruptor 0.12). No synthetic data: every value comes from the
// SDE hull attributes at runtime via getTypeAttributeMap.

// Numeric dogma attributeIDs (SDE 3396210).
const ATTR = Object.freeze({
  // web (stasis) — target-speed reduction
  modifyTargetSpeedChance: 512,
  modifyTargetSpeedDuration: 513,
  modifyTargetSpeedRange: 514,
  speedFactor: 20, // strength attribute the web hostile definition reads
  // warp scramble
  entityWarpScrambleChance: 504,
  warpScrambleDuration: 505,
  warpScrambleRange: 103,
  warpScrambleStrength: 105,
  // energy neutralizer
  energyNeutralizerEntityChance: 931,
  entityCapacitorDrainAmount: 946,
  entityCapacitorDrainMaxRange: 937,
  // tracking disruptor
  npcTrackingDisruptorActivationChance: 933,
  npcTrackingDisruptorDuration: 2515,
  npcTrackingDisruptorRange: 2516,
  // sensor dampener
  entitySensorDampenChance: 932, // paired with entitySensorDampen* companions
  entitySensorDampenDuration: 943,
  entitySensorDampenMaxRange: 938,
  // target painter — chance follows the "...DurationChance" convention (935), NOT 940.
  // Verified against the golden logs: type 24787 paints (effects.TargetPaint) and carries
  // entityTargetPaintDurationChance=0.15 + range/duration, but no attribute 940.
  entityTargetPaintChance: 935,
  entityTargetPaintDuration: 945,
  entityTargetPaintMaxRange: 941,
  // ECM (jam)
  ecmEntityChance: 930,
  entityRemoteECMChanceOfActivation: 1664,
  entityRemoteECMDuration: 1658,
});

// One entry per EWAR family the entity attributes can express. `effectName` MUST be a key the
// hostile/jammer runtime already maps (see hostileModuleRuntime.js:263+, jammerModuleRuntime.js).
// `chanceAttrIDs` are tried in order (families with two chance conventions). `rangeAttrIDs` give
// the effective range; `durationAttrID` gives the effect duration.
const ENTITY_EWAR_FAMILIES = Object.freeze([
  Object.freeze({
    family: "web",
    effectName: "remotewebifierentity",
    chanceAttrIDs: [ATTR.modifyTargetSpeedChance],
    rangeAttrIDs: [ATTR.modifyTargetSpeedRange],
    durationAttrID: ATTR.modifyTargetSpeedDuration,
  }),
  Object.freeze({
    family: "scram",
    effectName: "warpscrambleforentity",
    chanceAttrIDs: [ATTR.entityWarpScrambleChance],
    rangeAttrIDs: [ATTR.warpScrambleRange],
    durationAttrID: ATTR.warpScrambleDuration,
  }),
  Object.freeze({
    family: "neut",
    effectName: "entityenergyneutralizerfalloff",
    chanceAttrIDs: [ATTR.energyNeutralizerEntityChance],
    rangeAttrIDs: [ATTR.entityCapacitorDrainMaxRange],
    durationAttrID: null,
  }),
  Object.freeze({
    family: "trackingDisrupt",
    effectName: "npcentitytrackingdisruptor",
    chanceAttrIDs: [ATTR.npcTrackingDisruptorActivationChance],
    rangeAttrIDs: [ATTR.npcTrackingDisruptorRange],
    durationAttrID: ATTR.npcTrackingDisruptorDuration,
  }),
  Object.freeze({
    family: "sensorDamp",
    effectName: "entitysensordampen",
    chanceAttrIDs: [ATTR.entitySensorDampenChance],
    rangeAttrIDs: [ATTR.entitySensorDampenMaxRange],
    durationAttrID: ATTR.entitySensorDampenDuration,
  }),
  Object.freeze({
    family: "paint",
    effectName: "entitytargetpaint",
    chanceAttrIDs: [ATTR.entityTargetPaintChance],
    rangeAttrIDs: [ATTR.entityTargetPaintMaxRange],
    durationAttrID: ATTR.entityTargetPaintDuration,
  }),
  Object.freeze({
    family: "ecm",
    effectName: "entityecmfalloff",
    chanceAttrIDs: [ATTR.entityRemoteECMChanceOfActivation, ATTR.ecmEntityChance],
    rangeAttrIDs: [], // ECM range resolves from the entity's ecm range/falloff attributes
    durationAttrID: ATTR.entityRemoteECMDuration,
  }),
]);

function readAttr(attributeMap, attributeID) {
  if (!attributeMap || !attributeID) {
    return 0;
  }
  const value = Number(attributeMap[attributeID]);
  return Number.isFinite(value) ? value : 0;
}

function readFirstAttr(attributeMap, attributeIDs = []) {
  for (const attributeID of attributeIDs) {
    const value = readAttr(attributeMap, attributeID);
    if (value > 0) {
      return value;
    }
  }
  return 0;
}

// Given a rat hull's attribute map, return the list of active entity-EWAR family specs it carries
// (activation chance > 0). Each result: { family, effectName, activationChance, rangeMeters,
// durationMs }. `rangeMeters === 0` means "let the runtime resolve range from module attributes".
function resolveEntityEwarSpecs(attributeMap) {
  if (!attributeMap || typeof attributeMap !== "object") {
    return [];
  }
  const specs = [];
  for (const familySpec of ENTITY_EWAR_FAMILIES) {
    const chance = readFirstAttr(attributeMap, familySpec.chanceAttrIDs);
    if (!(chance > 0)) {
      continue;
    }
    specs.push({
      family: familySpec.family,
      effectName: familySpec.effectName,
      activationChance: Math.min(1, Math.max(0, chance)),
      rangeMeters: readFirstAttr(attributeMap, familySpec.rangeAttrIDs),
      durationMs: familySpec.durationAttrID ? readAttr(attributeMap, familySpec.durationAttrID) : 0,
    });
  }
  return specs;
}

module.exports = {
  ATTR,
  ENTITY_EWAR_FAMILIES,
  resolveEntityEwarSpecs,
};
