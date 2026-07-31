"use strict";

const {
  normalizeEntityID,
} = require("../identity/entityID");
const {
  buildCloakBallPayload,
  buildOnDamageStateChangePayload,
  buildOnDbuffUpdatedPayload,
  buildOnSlimItemChangePayload,
  buildOnSpecialFXPayload,
  buildSetBallMassPayload,
  buildSetMaxSpeedPayload,
  buildUncloakBallPayload,
} = require("../stream/actions");

function buildPresentationUpdate(stamp, payload) {
  return { stamp, payload };
}

function buildSingleSpecialFxPresentationUpdates(options = {}) {
  return [buildPresentationUpdate(
    options.stamp,
    buildOnSpecialFXPayload(
      options.entityID,
      options.guid,
      options.specialFxOptions,
    ),
  )];
}

function buildDbuffPresentationUpdates(options = {}) {
  return [buildPresentationUpdate(
    options.stamp,
    buildOnDbuffUpdatedPayload(options.entityID, options.dbuffState),
  )];
}

function buildDamageStatePresentationUpdates(options = {}) {
  return [buildPresentationUpdate(
    options.stamp,
    buildOnDamageStateChangePayload(options.entityID, options.damageState),
  )];
}

function buildSlimItemPresentationUpdates(options = {}) {
  return [buildPresentationUpdate(
    options.stamp,
    buildOnSlimItemChangePayload(options.entityID, options.slimItem),
  )];
}

function buildStructureLifecyclePresentationUpdates(options = {}) {
  const updates = [];
  if (options.includeRepairCompleteFx === true) {
    updates.push(
      buildPresentationUpdate(
        options.stamp,
        buildOnSpecialFXPayload(
          options.entityID,
          options.repairCompleteFxGuid,
          { active: false },
        ),
      ),
      buildPresentationUpdate(
        options.stamp,
        buildOnSpecialFXPayload(
          options.entityID,
          options.ecmBurstFxGuid,
          { active: false },
        ),
      ),
    );
  }
  updates.push(
    buildPresentationUpdate(
      options.stamp,
      buildOnDamageStateChangePayload(options.entityID, options.damageState),
    ),
    buildPresentationUpdate(
      options.stamp,
      buildOnSlimItemChangePayload(options.entityID, options.slimItem),
    ),
  );
  return updates;
}

function buildCloakBallPresentationUpdates(options = {}) {
  return [buildPresentationUpdate(
    options.stamp,
    buildCloakBallPayload(
      options.entityID,
      options.cloakMode,
      options.uncloakRange,
    ),
  )];
}

function buildOwnerCloakActivationPresentationUpdates(options = {}) {
  const updates = [];
  if (options.includeRenderFx !== false) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildOnSpecialFXPayload(
        options.entityID,
        options.renderFxGuid,
        options.renderFxOptions,
      ),
    ));
  }
  updates.push(
    buildPresentationUpdate(
      options.stamp,
      buildOnSpecialFXPayload(
        options.entityID,
        options.moduleFxGuid,
        options.moduleFxOptions,
      ),
    ),
    buildPresentationUpdate(
      options.stamp,
      buildSetMaxSpeedPayload(options.entityID, options.maxSpeed),
    ),
  );
  return updates;
}

function buildOwnerUncloakPresentationUpdates(options = {}) {
  const updates = [];
  if (options.includeRenderFx !== false) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildOnSpecialFXPayload(
        options.entityID,
        options.renderFxGuid,
        options.renderFxOptions,
      ),
    ));
  }
  if (options.includeMaxSpeed !== false) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildSetMaxSpeedPayload(options.entityID, options.maxSpeed),
    ));
  }
  return updates;
}

function buildCloakDeliveryPresentationUpdates(options = {}) {
  const updates = [];
  if (options.includeCloakBall !== false) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildCloakBallPayload(
        options.entityID,
        options.cloakMode,
        options.uncloakRange,
      ),
    ));
  }
  if (options.includeRenderFx === true) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildOnSpecialFXPayload(
        options.entityID,
        options.renderFxGuid,
        options.renderFxOptions,
      ),
    ));
  }
  if (options.includeMaxSpeed === true) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildSetMaxSpeedPayload(options.entityID, options.maxSpeed),
    ));
  }
  return updates;
}

function buildUncloakDeliveryPresentationUpdates(options = {}) {
  const updates = [buildPresentationUpdate(
    options.stamp,
    buildUncloakBallPayload(options.entityID),
  )];
  if (options.includeRenderFx !== false) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildOnSpecialFXPayload(
        options.entityID,
        options.renderFxGuid,
        options.renderFxOptions,
      ),
    ));
  }
  if (options.includeMaxSpeed === true) {
    updates.push(buildPresentationUpdate(
      options.stamp,
      buildSetMaxSpeedPayload(options.entityID, options.maxSpeed),
    ));
  }
  return updates;
}

function buildTetherPresentationUpdates(options = {}) {
  return [
    buildPresentationUpdate(
      options.stamp,
      buildOnSpecialFXPayload(
        options.entityID,
        options.tetherFxGuid,
        options.tetherFxOptions,
      ),
    ),
    buildPresentationUpdate(
      options.stamp,
      buildSetBallMassPayload(options.entityID, options.mass),
    ),
  ];
}

function normalizeOptionalEntityIDSentinel(value) {
  if (
    value === 0 ||
    value === 0n ||
    (typeof value === "string" && value.trim() === "0")
  ) {
    return null;
  }
  return value;
}

function createSpecialFxPayloadPresentation(deps = {}) {
  const {
    destiny,
    splitSpecialFxGuids,
  } = deps;
  const isEntityUsingNpcShipHardpointPresentation =
    typeof deps.isEntityUsingNpcShipHardpointPresentation === "function"
      ? deps.isEntityUsingNpcShipHardpointPresentation
      : () => false;
  const isOffensiveWeaponFamily =
    typeof deps.isOffensiveWeaponFamily === "function"
      ? deps.isOffensiveWeaponFamily
      : () => false;
  const shouldUseShipKeyedSpecialFxModuleBinding =
    typeof deps.shouldUseShipKeyedSpecialFxModuleBinding === "function"
      ? deps.shouldUseShipKeyedSpecialFxModuleBinding
      : null;
  const resolveShipKeyedSpecialFxOptions =
    typeof deps.resolveShipKeyedSpecialFxOptions === "function"
      ? deps.resolveShipKeyedSpecialFxOptions
      : null;
  if (!destiny || typeof destiny.buildOnSpecialFXPayload !== "function") {
    throw new TypeError(
      "special FX presentation requires buildOnSpecialFXPayload",
    );
  }
  if (typeof splitSpecialFxGuids !== "function") {
    throw new TypeError("special FX presentation requires splitSpecialFxGuids");
  }

  function usesShipKeyedSpecialFxModuleBinding(visibilityEntity, options = {}) {
    if (!visibilityEntity || visibilityEntity.kind !== "ship") {
      return false;
    }
    if (shouldUseShipKeyedSpecialFxModuleBinding) {
      return shouldUseShipKeyedSpecialFxModuleBinding(
        visibilityEntity,
        options,
      ) === true;
    }

    return (
      isEntityUsingNpcShipHardpointPresentation(visibilityEntity) &&
      (
        options.npcShipHardpointBinding === true ||
        options.shipKeyedModuleBinding === true ||
        options.isOffensive === true ||
        isOffensiveWeaponFamily(options.weaponFamily)
      )
    );
  }

  function resolveSpecialFxOptionsForEntity(
    shipID,
    options = {},
    visibilityEntity = null,
    guid = null,
  ) {
    const normalizedOptions = {
      ...options,
      moduleID: normalizeOptionalEntityIDSentinel(options.moduleID),
      targetID: normalizeOptionalEntityIDSentinel(options.targetID),
    };
    if (!usesShipKeyedSpecialFxModuleBinding(visibilityEntity, options)) {
      return normalizedOptions;
    }

    const moduleID = normalizeEntityID(normalizedOptions.moduleID);
    if (shouldUseShipKeyedSpecialFxModuleBinding) {
      // Current NPC/entity-ship presentation replaces positive internal module
      // keys before they reach the exact int64 wire boundary. Some generated
      // superweapon module keys are intentionally unsafe Numbers; only the
      // authoritative ship identity is serialized for this presentation mode.
      const numericModuleID = Number(normalizedOptions.moduleID);
      if (!Number.isFinite(numericModuleID) || Math.trunc(numericModuleID) <= 0) {
        return normalizedOptions;
      }
    } else if (moduleID === null) {
      return normalizedOptions;
    }

    const shipKeyedOptions = {
      ...normalizedOptions,
      // CCP EntityShip hardpoints are keyed by shipID for NPC/entity
      // presentation, not by the underlying fitted module itemID.
      moduleID:
        normalizeEntityID(shipID) ||
        normalizeEntityID(visibilityEntity.itemID) ||
        moduleID,
    };
    if (!resolveShipKeyedSpecialFxOptions) {
      return shipKeyedOptions;
    }

    const resolvedOverrides = resolveShipKeyedSpecialFxOptions(
      visibilityEntity,
      shipKeyedOptions,
      normalizedOptions,
      guid,
    );
    return resolvedOverrides && typeof resolvedOverrides === "object"
      ? {
        ...shipKeyedOptions,
        ...resolvedOverrides,
      }
      : shipKeyedOptions;
  }

  function buildSpecialFxPayloadsForEntity(
    shipID,
    guid,
    options = {},
    visibilityEntity = null,
  ) {
    const resolvedOptions = resolveSpecialFxOptionsForEntity(
      shipID,
      options,
      visibilityEntity,
      guid,
    );
    const guidEntries = splitSpecialFxGuids(guid);
    if (!Array.isArray(guidEntries)) {
      throw new TypeError("splitSpecialFxGuids must return an array");
    }
    const payloads = guidEntries.map((guidEntry) => (
      destiny.buildOnSpecialFXPayload(shipID, guidEntry, resolvedOptions)
    ));
    return {
      resolvedOptions,
      payloads,
    };
  }

  return {
    buildSpecialFxPayloadsForEntity,
    resolveSpecialFxOptionsForEntity,
    usesShipKeyedSpecialFxModuleBinding,
  };
}

module.exports = {
  buildCloakBallPresentationUpdates,
  buildCloakDeliveryPresentationUpdates,
  buildDamageStatePresentationUpdates,
  buildDbuffPresentationUpdates,
  buildOwnerCloakActivationPresentationUpdates,
  buildOwnerUncloakPresentationUpdates,
  buildSingleSpecialFxPresentationUpdates,
  buildSlimItemPresentationUpdates,
  buildStructureLifecyclePresentationUpdates,
  buildTetherPresentationUpdates,
  buildUncloakDeliveryPresentationUpdates,
  createSpecialFxPayloadPresentation,
  normalizeOptionalEntityIDSentinel,
};
