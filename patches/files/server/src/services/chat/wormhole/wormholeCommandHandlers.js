const path = require("path");

const worldData = require(path.join(__dirname, "../../../space/worldData"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));
const {
  resolveSolarSystemByName,
} = require(path.join(__dirname, "../solarSystemRegistry"));
const wormholeRuntime = require(path.join(
  __dirname,
  "../../exploration/wormholes/wormholeRuntime",
));
const familyEstateRuntime = require(path.join(
  __dirname,
  "../../estate/familyEstateRuntime",
));
const familyEstatePrologueRuntime = require(path.join(
  __dirname,
  "../../estate/familyEstatePrologueRuntime",
));
const familyEstateProjectsRuntime = require(path.join(
  __dirname,
  "../../estate/familyEstateProjectsRuntime",
));
const {
  ROLE_CONTENT,
  ROLE_GML,
  ROLE_PROGRAMMER,
  normalizeRoleValue,
} = require(path.join(__dirname, "../../account/accountRoleProfiles"));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getCurrentSystemID(session) {
  return Number(
    session &&
    (
      session.solarsystemid2 ||
      session.solarsystemid ||
      (session._space && session._space.systemID) ||
      0
    ),
  ) || 0;
}

function formatSystemName(systemID) {
  const system = worldData.getSolarSystemByID(systemID);
  return system && system.solarSystemName
    ? system.solarSystemName
    : `System ${systemID}`;
}

function formatMass(value) {
  const numeric = Math.max(0, Number(value) || 0);
  if (numeric >= 1_000_000_000) {
    return `${(numeric / 1_000_000_000).toFixed(2)}B`;
  }
  if (numeric >= 1_000_000) {
    return `${(numeric / 1_000_000).toFixed(2)}M`;
  }
  return `${numeric}`;
}

function formatLifetimeRemaining(expiresAtMs) {
  const remainingMs = Math.max(0, toInt(expiresAtMs, 0) - Date.now());
  const totalMinutes = Math.round(remainingMs / 60000);
  if (totalMinutes >= 120) {
    return `${Math.round(totalMinutes / 60)}h`;
  }
  return `${totalMinutes}m`;
}

function resolveSystemID(session, token, allowAll = false) {
  const trimmed = String(token || "").trim();
  if (!trimmed || trimmed.toLowerCase() === "here" || trimmed.toLowerCase() === "current") {
    const currentSystemID = getCurrentSystemID(session);
    return currentSystemID > 0
      ? { success: true, systemID: currentSystemID }
      : { success: false, errorMsg: "SYSTEM_NOT_SELECTED" };
  }
  if (allowAll && trimmed.toLowerCase() === "all") {
    return { success: true, systemID: 0, all: true };
  }
  const resolved = resolveSolarSystemByName(trimmed);
  if (!resolved.success || !resolved.match) {
    return {
      success: false,
      errorMsg: resolved.errorMsg || "SOLAR_SYSTEM_NOT_FOUND",
      suggestions: resolved.suggestions || [],
    };
  }
  return {
    success: true,
    systemID: Number(resolved.match.solarSystemID) || 0,
  };
}

function renderPairLine(entry) {
  return [
    `${entry.sourceSystemName} [${entry.sourceEndpointID}] ${entry.sourceCode}`,
    `-> ${entry.destinationSystemName} [${entry.destinationEndpointID}] ${entry.destinationCode}`,
    `class ${entry.destinationClassLabel || entry.destinationClassID}`,
    `env ${entry.destinationEnvironmentFamily || "-"}`,
    `life ${entry.persistent ? "permanent" : `${formatLifetimeRemaining(entry.expiresAtMs)} (${entry.ageLabel || "New"})`}`,
    `mass ${entry.unlimitedMass ? "unlimited" : `${formatMass(entry.remainingMass)}/${formatMass(entry.totalMass)}`}`,
    `stability ${entry.stabilityLabel || "-"}`,
    `jump ${entry.unrestrictedShipMass ? "unrestricted" : (entry.maxShipJumpMassLabel || "-")}`,
    `regen ${formatMass(entry.massRegeneration)}/day`,
    `dest ${entry.destinationVisibilityState || (entry.destinationDiscovered ? "revealed" : "hidden")}`,
    `${entry.kind}/${entry.state}`,
  ].join(" | ");
}

function hasEstateOperatorRole(session) {
  const role = normalizeRoleValue(session && (session.accountRole ?? session.role), 0n);
  return (role & (ROLE_GML | ROLE_CONTENT | ROLE_PROGRAMMER)) !== 0n;
}

function renderEstateCapabilities(claimState) {
  return Object.entries(familyEstateRuntime.ESTATE_CAPABILITIES || {})
    .map(([key, definition]) => (
      `${claimState.capabilities[key] === true ? "[online]" : "[locked]"} ` +
      `${key}: ${definition.label}`
    ));
}

function formatEstateError(errorMsg, dependency = null) {
  const messages = {
    FAMILY_ESTATE_ALREADY_CLAIMED: "The family estate already belongs to another corporation.",
    FAMILY_ESTATE_CAPSULEER_CORPORATION_REQUIRED: "Create or join a capsuleer corporation before claiming the estate.",
    FAMILY_ESTATE_CHARACTER_CORPORATION_REQUIRED: "Select a character in a corporation before claiming the estate.",
    FAMILY_ESTATE_CORPORATION_LEADERSHIP_REQUIRED: "Only the corporation CEO or a director may claim the estate.",
    FAMILY_ESTATE_DOCKING_REQUIRED: "You must be docked in The Family Holding to claim it.",
    FAMILY_ESTATE_DESTROYED: "The family estate has been destroyed.",
    FAMILY_ESTATE_FOUNDER_ROLE_FIXED: "The estate founder cannot be demoted.",
    FAMILY_ESTATE_NOT_CLAIMABLE: "The estate is not currently claimable.",
    FAMILY_ESTATE_ROLE_INVALID: "Estate roles are steward or resident.",
    FAMILY_ESTATE_STEWARD_REQUIRED: "Only the founder, a steward, the corporation CEO, or a director may do that.",
    FAMILY_ESTATE_TARGET_NOT_RESIDENT: "That character is not a member of the estate corporation.",
    FAMILY_ESTATE_UNCLAIMED: "The family estate has not been claimed yet.",
    FAMILY_ESTATE_CAPABILITY_INVALID: "That estate capability does not exist.",
    FAMILY_ESTATE_CAPABILITY_DEPENDENCY_REQUIRED:
      `Unlock ${dependency || "the required earlier capability"} first.`,
    FAMILY_ESTATE_RESIDENT_REQUIRED: "Only members of the estate corporation may contribute.",
    FAMILY_ESTATE_PROJECT_INVALID: "That restoration project does not exist.",
    FAMILY_ESTATE_PROJECT_ALREADY_STARTED: "That restoration project is already underway.",
    FAMILY_ESTATE_PROJECT_NOT_IN_PROGRESS: "That restoration project is not underway.",
    FAMILY_ESTATE_PROJECT_DEPENDENCY_REQUIRED: "Complete the earlier restoration project first.",
    FAMILY_ESTATE_PROJECT_MATERIALS_REQUIRED: "The project still needs delivered materials.",
    FAMILY_ESTATE_PROJECT_ISK_REQUIRED: "The corporation master wallet cannot cover the project cost.",
    FAMILY_ESTATE_NO_PROJECT_MATERIALS: "Your item hangar contains none of this project's missing materials.",
    FAMILY_ESTATE_PROJECT_COMPLETION_FAILED: "The project could not be completed.",
    FAMILY_ESTATE_LOGISTICS_DISABLED: "Estate hauling requires the Living Universe and Living Economy to be enabled.",
    FAMILY_ESTATE_DELIVERY_CREDIT_REQUIRED: "The corporation master wallet cannot cover the next cargo contract while preserving the project's labor budget.",
    FAMILY_ESTATE_DELIVERY_ESCROW_REQUIRED: "The cargo contract has not finished reserving its corporation funds.",
    FAMILY_ESTATE_DELIVERY_IDENTITY_MISMATCH: "The cargo contract no longer matches the estate owner or destination.",
    FAMILY_ESTATE_DELIVERY_DESTINATION_UNAVAILABLE: "The estate destination is unavailable; the shipment will be quarantined and refunded.",
    FAMILY_ESTATE_DELIVERY_PAYMENT_REQUIRED: "A contracted hauler is waiting at the estate, but the corporation wallet cannot cover its cargo and freight invoice.",
  };
  return messages[errorMsg] || `Family estate action failed: ${errorMsg || "UNKNOWN"}.`;
}

function formatEstateIsk(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("en-US")} ISK`;
}

function formatEstateDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function buildEstateProjectsMessage(projectStatus, nowMs = Date.now()) {
  const lines = [
    `Estate treasury: ${formatEstateIsk(projectStatus.corporationWalletBalance)}`,
    `Commercial operations: gross ${formatEstateIsk(projectStatus.state.commercial.totalGrossISK)}, ` +
      `expenses ${formatEstateIsk(projectStatus.state.commercial.totalExpenseISK)}, ` +
      `net ${formatEstateIsk(projectStatus.state.commercial.totalNetISK)}`,
  ];
  for (const project of projectStatus.projects) {
    const remainingTime = project.status === "in_progress"
      ? ` | remaining ${formatEstateDuration(Math.max(0, project.completesAtMs - nowMs))}`
      : "";
    lines.push(`[${project.status}] ${project.key}: ${project.label} | ${formatEstateIsk(project.iskCost)}${remainingTime}`);
    if (project.procurement && project.procurement.status !== "inactive") {
      lines.push(
        `  logistics: ${project.procurement.status} | ${project.procurement.deliveries} delivered | ` +
        `${project.procurement.activeDeliveries} active, ${formatEstateIsk(project.procurement.activeCommittedISK)} escrowed | ` +
        `${formatEstateIsk(project.procurement.goodsSpentISK)} goods + ` +
        `${formatEstateIsk(project.procurement.freightSpentISK)} freight`,
      );
      if (project.procurement.estimatedOutstandingInvoiceISK > 0) {
        lines.push(
          `  planning estimate: ${formatEstateIsk(project.procurement.estimatedOutstandingInvoiceISK)} ` +
          `for about ${project.procurement.estimatedOutstandingShipments} remaining shipment(s), ` +
          `plus ${formatEstateIsk(project.iskCost)} project labor`,
        );
      }
      if (project.procurement.arrivedAwaitingPayment > 0) {
        lines.push(
          `  attention: ${project.procurement.arrivedAwaitingPayment} shipment(s) at the estate ` +
          `awaiting settlement (${formatEstateIsk(project.procurement.arrivedAwaitingPaymentISK)})`,
        );
      }
      if (project.procurement.lastError) {
        lines.push(
          `  logistics alert: ${formatEstateError(project.procurement.lastError)} ` +
          `(wallet ${formatEstateIsk(project.procurement.lastBalanceISK)}, ` +
          `required ${formatEstateIsk(project.procurement.lastRequiredISK)})`,
        );
      }
    }
    if (project.funding && project.funding.lastError) {
      lines.push(`  project funding alert: ${formatEstateError(project.funding.lastError)}`);
    }
    for (const material of project.materials) {
      lines.push(
        `  ${material.name}: ${material.contributed.toLocaleString("en-US")}/` +
        `${material.quantity.toLocaleString("en-US")}` +
        (material.reserved > 0 ? ` (${material.reserved.toLocaleString("en-US")} in transit)` : ""),
      );
    }
  }
  lines.push("Contribute from your personal item hangar while docked: /estate contribute <project>");
  lines.push("Founder, steward, CEO, or director starts or commissions restoration: /estate start <project>");
  return lines.join("\n");
}

function buildEstateLedgerMessage(projectStatus) {
  const entries = [...(projectStatus.state.ledger || [])].slice(-12).reverse();
  return [
    `Estate treasury: ${formatEstateIsk(projectStatus.corporationWalletBalance)}`,
    "Recent estate ledger:",
    ...(entries.length > 0 ? entries.map((entry) => {
      const value = entry.netISK ? ` | net ${formatEstateIsk(entry.netISK)}` : "";
      const material = entry.typeID ? ` | type ${entry.typeID} x${entry.quantity}` : "";
      return `${new Date(entry.atMs).toISOString()} | ${entry.kind}${entry.projectKey ? ` | ${entry.projectKey}` : ""}${value}${material}${entry.note ? ` | ${entry.note}` : ""}`;
    }) : ["No estate transactions recorded yet."]),
    "Native reprocessing taxes appear directly in the corporation wallet journal.",
  ].join("\n");
}

function syncEstateScenes(status) {
  if (!spaceRuntime || !(spaceRuntime.scenes instanceof Map) || !status) {
    return;
  }
  const systemIDs = new Set([
    status.profile.homeSystemID,
    status.profile.highSecSystemID,
    status.profile.lowSecSystemID,
    ...status.connections.flatMap((entry) => [
      entry.sourceSystemID,
      entry.destinationSystemID,
    ]),
  ].map((entry) => toInt(entry, 0)).filter((entry) => entry > 0));
  for (const systemID of systemIDs) {
    const scene = spaceRuntime.scenes.get(systemID);
    if (scene) {
      wormholeRuntime.syncSceneEntities(scene, Date.now());
    }
  }
}

function buildEstateStatusMessage(status) {
  if (!status.enabled) {
    return "Family estate is disabled. Enable familyEstateEnabled in evejs.config.local.json.";
  }
  if (!status.success) {
    return `Family estate configuration is invalid: ${status.errorMsg || "UNKNOWN"}.`;
  }
  const structure = status.structure;
  const claimState = status.claimState || {};
  const ownerName = status.ownerCorporation && status.ownerCorporation.corporationName;
  const connectionLines = status.connections.map(renderPairLine);
  return [
    `Family estate: ${status.systems.home.solarSystemName} (${status.profile.homeSystemID}), class 2, effect-free`,
    `Athanor: ${structure ? `${structure.itemName} [${structure.structureID}] state=${structure.devFlags && structure.devFlags.estateState || structure.state} owner=${structure.ownerCorpID} moon=${structure.moonID || status.profile.moonID}` : "not seeded"}`,
    `Claim: ${claimState.status === "claimed" ? `${ownerName || `Corporation ${claimState.ownerCorporationID}`} | founder ${claimState.claimantCharacterID} | residents ${status.residents.length} | stage ${claimState.progressStage}` : "unclaimed"}`,
    `High-sec conduit: ${status.systems.highSec.solarSystemName} (${status.profile.highSecSystemID})`,
    `Low-sec conduit: ${status.systems.lowSec.solarSystemName} (${status.profile.lowSecSystemID})`,
    `Connections: permanent ${status.activePermanentConnectionCount}/2 | random ${status.activeRandomConnectionCount}/${status.profile.randomConnectionCount}`,
    ...connectionLines,
  ].join("\n");
}

function executeEstateCommand(session, parts) {
  const verb = String(parts[0] || "status").trim().toLowerCase();
  if (verb === "ensure" || verb === "repair") {
    if (!hasEstateOperatorRole(session)) {
      return {
        success: false,
        message: "The estate ensure command requires a GM, content, or programmer role.",
      };
    }
    const result = familyEstateRuntime.ensureFamilyEstate({ nowMs: Date.now() });
    if (!result.success) {
      return {
        success: false,
        message: `Family estate ensure failed: ${result.errorMsg || "UNKNOWN"}.`,
      };
    }
    syncEstateScenes(result.data.status);
    return {
      success: true,
      message: buildEstateStatusMessage(result.data.status),
    };
  }
  if (verb === "claim") {
    const result = familyEstateRuntime.claimFamilyEstate(session, { nowMs: Date.now() });
    if (!result.success) {
      return { success: false, message: formatEstateError(result.errorMsg, result.dependency) };
    }
    const status = familyEstateRuntime.getFamilyEstateStatus();
    syncEstateScenes(status);
    return {
      success: true,
      message: result.unchanged
        ? `Your corporation already owns ${status.structure.itemName}.`
        : `${status.ownerCorporation.corporationName} has claimed ${status.structure.itemName}. Corporation members are now estate residents.`,
    };
  }
  if (verb === "members" || verb === "residents") {
    const status = familyEstateRuntime.getFamilyEstateStatus();
    if (status.claimState.status !== "claimed") {
      return { success: false, message: formatEstateError("FAMILY_ESTATE_UNCLAIMED") };
    }
    const lines = status.residents.map((entry) => (
      `${entry.characterName} [${entry.characterID}] | ${entry.role}`
    ));
    return {
      success: true,
      message: [`Estate residents (${lines.length}):`, ...lines].join("\n"),
    };
  }
  if (verb === "role") {
    const targetCharacterID = toInt(parts[1], 0);
    const role = String(parts[2] || "").trim().toLowerCase();
    if (!targetCharacterID || !role) {
      return { success: false, message: "Usage: /estate role <characterID> <steward|resident>" };
    }
    const result = familyEstateRuntime.setFamilyEstateMemberRole(
      session,
      targetCharacterID,
      role,
      { nowMs: Date.now() },
    );
    if (!result.success) {
      return { success: false, message: formatEstateError(result.errorMsg, result.dependency) };
    }
    return { success: true, message: `Estate role for character ${targetCharacterID} is now ${role}.` };
  }
  if (verb === "services" || verb === "progress") {
    const status = familyEstateRuntime.getFamilyEstateStatus();
    return {
      success: true,
      message: [
        `Estate progression: ${status.claimState.progressStage}`,
        ...renderEstateCapabilities(status.claimState),
      ].join("\n"),
    };
  }
  if (verb === "projects" || verb === "project" || verb === "economy" || verb === "treasury") {
    return {
      success: true,
      message: buildEstateProjectsMessage(
        familyEstateProjectsRuntime.getEstateProjectStatus({ nowMs: Date.now() }),
      ),
    };
  }
  if (verb === "ledger") {
    return {
      success: true,
      message: buildEstateLedgerMessage(
        familyEstateProjectsRuntime.getEstateProjectStatus({ nowMs: Date.now() }),
      ),
    };
  }
  if (verb === "contribute" || verb === "deliver") {
    const projectKey = String(parts[1] || "").trim().toLowerCase();
    if (!projectKey) {
      return { success: false, message: "Usage: /estate contribute <project>" };
    }
    const result = familyEstateProjectsRuntime.contributeToProject(session, projectKey, {
      nowMs: Date.now(),
    });
    if (!result.success) {
      return { success: false, message: formatEstateError(result.errorMsg, result.dependency) };
    }
    const summary = (result.data.contributions || []).map(
      (entry) => `${entry.name} x${entry.quantity.toLocaleString("en-US")}`,
    ).join(", ");
    return {
      success: true,
      message: result.unchanged
        ? `${projectKey} is already complete.`
        : `Contributed to ${projectKey}: ${summary}.`,
    };
  }
  if (verb === "start" || verb === "begin") {
    const projectKey = String(parts[1] || "").trim().toLowerCase();
    if (!projectKey) return { success: false, message: "Usage: /estate start <project>" };
    const result = familyEstateProjectsRuntime.startProject(session, projectKey, {
      nowMs: Date.now(),
      commissionIfMissing: true,
    });
    if (!result.success) {
      const balanceText = result.balance !== undefined
        ? ` Balance ${formatEstateIsk(result.balance)}; required ${formatEstateIsk(result.requiredISK)}.`
        : "";
      return {
        success: false,
        message: `${formatEstateError(result.errorMsg, result.dependency)}${balanceText}`,
      };
    }
    const project = result.data.project;
    if (
      project.status === "available" &&
      project.procurement &&
      ["commissioned", "fulfilled"].includes(project.procurement.status)
    ) {
      const projectView = familyEstateProjectsRuntime.getEstateProjectStatus({
        nowMs: Date.now(),
        settleCommercial: false,
      }).projects.find((entry) => entry.key === projectKey);
      const estimate = projectView && projectView.procurement
        ? projectView.procurement.estimatedOutstandingInvoiceISK
        : 0;
      return {
        success: true,
        message:
          `${projectKey} restoration commissioned. Independent haulers will source the missing ` +
          `materials and fly them through the permanent high-security conduit. Each contract ` +
          `reserves its cargo and freight cost before departure, pays out only after delivery, ` +
          `and starts the work automatically when the bill of materials is complete.` +
          (estimate > 0 ? ` Current planning estimate: ${formatEstateIsk(estimate)}, plus project labor.` : ""),
      };
    }
    return {
      success: true,
      message: result.unchanged
        ? `${projectKey} is already ${project.status}.`
        : `${projectKey} has begun and will complete in ${formatEstateDuration(project.completesAtMs - Date.now())}.`,
    };
  }
  if (verb === "complete") {
    if (!hasEstateOperatorRole(session)) {
      return { success: false, message: "Manual project completion requires a GM, content, or programmer role." };
    }
    const projectKey = String(parts[1] || "").trim().toLowerCase();
    if (!projectKey) return { success: false, message: "Usage: /estate complete <project>" };
    const result = familyEstateProjectsRuntime.forceCompleteProject(projectKey, {
      nowMs: Date.now(),
    });
    return result.success
      ? { success: true, message: `Estate project completed: ${projectKey}.` }
      : { success: false, message: formatEstateError(result.errorMsg, result.dependency) };
  }
  if (verb === "unlock") {
    if (!hasEstateOperatorRole(session)) {
      return { success: false, message: "Manual estate unlocks require a GM, content, or programmer role." };
    }
    const capability = String(parts[1] || "").trim().toLowerCase();
    if (!capability) {
      return { success: false, message: "Usage: /estate unlock <capability>" };
    }
    const result = familyEstateRuntime.unlockFamilyEstateCapability(capability, {
      session,
      bypassAuthority: true,
      nowMs: Date.now(),
      reason: "Manual operator progression unlock.",
    });
    if (!result.success) {
      return { success: false, message: formatEstateError(result.errorMsg, result.dependency) };
    }
    return { success: true, message: `Estate capability unlocked: ${capability}.` };
  }
  if (verb === "status" || verb === "connections" || verb === "list") {
    return {
      success: true,
      message: buildEstateStatusMessage(familyEstateRuntime.getFamilyEstateStatus()),
    };
  }
  return {
    success: false,
    message: "Usage: /estate [status|claim|members|role|services|projects|contribute|start|ledger|connections|ensure|unlock]",
  };
}

function formatEstatePrologueError(errorMsg) {
  const messages = {
    FAMILY_ESTATE_PROLOGUE_CHARACTER_REQUIRED: "Select a character first.",
    FAMILY_ESTATE_PROLOGUE_START_DOCKED_REQUIRED: "Dock at a station before beginning the family prologue.",
    FAMILY_ESTATE_PROLOGUE_RECOVERY_DOCKED_REQUIRED: "Dock before recovering the Sunesis reward.",
    FAMILY_ESTATE_PROLOGUE_RECOVERY_ESTATE_SPACE_REQUIRED: "Enter J164417 before recovering the Guristas encounter.",
    FAMILY_ESTATE_PROLOGUE_ESTATE_DOCKING_REQUIRED: "Dock in The Family Holding before collecting the Gnosis.",
    FAMILY_ESTATE_PROLOGUE_NOT_READY: "Finish the active prologue objective first.",
  };
  return messages[errorMsg] || `Family prologue action failed: ${errorMsg || "UNKNOWN"}.`;
}

function executeEstatePrologueCommand(session, parts) {
  const verb = String(parts[0] || "status").trim().toLowerCase();
  let result = null;
  if (verb === "start" || verb === "begin") {
    result = familyEstatePrologueRuntime.startPrologue(session, { nowMs: Date.now() });
  } else if (verb === "recover" || verb === "repair") {
    result = familyEstatePrologueRuntime.recoverPrologue(session, { nowMs: Date.now() });
  } else if (verb === "status" || verb === "list") {
    return {
      success: true,
      message: familyEstatePrologueRuntime.describePrologue(
        familyEstatePrologueRuntime.getPrologueStatus(session && session.characterID),
      ),
    };
  } else {
    return { success: false, message: "Usage: /estateprologue [start|status|recover]" };
  }
  if (!result || !result.success) {
    return { success: false, message: formatEstatePrologueError(result && result.errorMsg) };
  }
  return {
    success: true,
    message: familyEstatePrologueRuntime.describePrologue(
      result.data && result.data.record ? result.data.record : result.data,
    ),
  };
}

function buildSystemSummaryEntries(entries) {
  const summariesBySystemID = new Map();
  for (const entry of entries) {
    const touchpoints = [
      {
        systemID: entry.sourceSystemID,
        systemName: entry.sourceSystemName,
        code: entry.sourceCode,
        discovered: entry.sourceDiscovered === true,
      },
      {
        systemID: entry.destinationSystemID,
        systemName: entry.destinationSystemName,
        code: entry.destinationCode,
        discovered: entry.destinationDiscovered === true,
      },
    ];
    for (const touchpoint of touchpoints) {
      const systemID = toInt(touchpoint.systemID, 0);
      if (systemID <= 0) {
        continue;
      }
      const existing = summariesBySystemID.get(systemID) || {
        systemID,
        systemName: touchpoint.systemName || formatSystemName(systemID),
        activePairCount: 0,
        staticPairCount: 0,
        randomPairCount: 0,
        discoveredEndpointCount: 0,
        hiddenEndpointCount: 0,
        environmentFamily:
          (wormholeRuntime.buildSystemSummaryViews({
            systemID,
            includeCollapsed: false,
            includeUndiscovered: true,
          })[0] || {}).environmentFamily || null,
        environmentEffectTypeName:
          (wormholeRuntime.buildSystemSummaryViews({
            systemID,
            includeCollapsed: false,
            includeUndiscovered: true,
          })[0] || {}).environmentEffectTypeName || null,
        codes: new Set(),
        pairIDs: new Set(),
      };
      if (!existing.pairIDs.has(entry.pairID)) {
        existing.pairIDs.add(entry.pairID);
        existing.activePairCount += 1;
        if (entry.kind === "static") {
          existing.staticPairCount += 1;
        } else if (entry.kind === "random") {
          existing.randomPairCount += 1;
        }
      }
      if (touchpoint.code) {
        existing.codes.add(String(touchpoint.code).trim().toUpperCase());
      }
      if (touchpoint.discovered === true) {
        existing.discoveredEndpointCount += 1;
      } else {
        existing.hiddenEndpointCount += 1;
      }
      summariesBySystemID.set(systemID, existing);
    }
  }

  return [...summariesBySystemID.values()]
    .map((entry) => ({
      ...entry,
      codes: [...entry.codes].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.systemName.localeCompare(right.systemName));
}

function renderSystemSummaryLine(entry) {
  return [
    `${entry.systemName} (${entry.systemID})`,
    `${entry.activePairCount} pair${entry.activePairCount === 1 ? "" : "s"}`,
    `static ${entry.staticPairCount}`,
    `random ${entry.randomPairCount}`,
    `discovered ${entry.discoveredEndpointCount}`,
    `hidden ${entry.hiddenEndpointCount}`,
    `env ${entry.environmentFamily || "-"}`,
    `codes ${entry.codes.join(",") || "-"}`,
  ].join(" | ");
}

function buildStatusMessage(session, token) {
  const target = resolveSystemID(session, token, true);
  if (!target.success) {
    return {
      success: false,
      message: "Solar system not found.",
    };
  }
  if (target.all) {
    wormholeRuntime.ensureUniverseStatics(Date.now());
  } else if (target.systemID > 0) {
    wormholeRuntime.ensureSystemStatics(target.systemID, Date.now());
  }
  const entries = wormholeRuntime.listPairViews({
    systemID: target.systemID,
    includeCollapsed: false,
    includeUndiscovered: true,
  });
  if (entries.length <= 0) {
    return {
      success: true,
      message: target.all
        ? "No active wormholes are currently tracked."
        : `No active wormholes are currently tracked for ${formatSystemName(target.systemID)}.`,
    };
  }
  const header = target.all
    ? `Tracked wormholes (${entries.length}):`
    : `Tracked wormholes for ${formatSystemName(target.systemID)} (${entries.length}):`;
  return {
    success: true,
    message: [header, ...entries.map(renderPairLine)].join("\n"),
  };
}

function buildSystemsMessage(session, token) {
  const target = resolveSystemID(session, token, true);
  if (!target.success) {
    return {
      success: false,
      message: "Solar system not found.",
    };
  }
  if (target.all) {
    wormholeRuntime.ensureUniverseStatics(Date.now());
  } else if (target.systemID > 0) {
    wormholeRuntime.ensureSystemStatics(target.systemID, Date.now());
  }
  const entries = wormholeRuntime.listPairViews({
    systemID: target.systemID,
    includeCollapsed: false,
    includeUndiscovered: true,
  });
  const summaries = wormholeRuntime.buildSystemSummaryViews({
    systemID: target.systemID,
    includeCollapsed: false,
    includeUndiscovered: true,
  });
  if (summaries.length <= 0) {
    return {
      success: true,
      message: target.all
        ? "No systems currently have tracked wormholes."
        : `No tracked wormholes are currently present for ${formatSystemName(target.systemID)}.`,
    };
  }
  const header = target.all
    ? `Systems with tracked wormholes (${summaries.length}):`
    : `Tracked wormhole system summary for ${formatSystemName(target.systemID)}:`;
  return {
    success: true,
    message: [header, ...summaries.map(renderSystemSummaryLine)].join("\n"),
  };
}

function executeWormholeCommand(session, commandName, argumentText = "") {
  const command = String(commandName || "").trim().toLowerCase();
  const trimmed = String(argumentText || "").trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];

  if (command === "estate") {
    return executeEstateCommand(session, parts);
  }
  if (command === "estateprologue" || command === "prologue") {
    return executeEstatePrologueCommand(session, parts);
  }

  if (parts[0] === "systems" || parts[0] === "summary") {
    return buildSystemsMessage(session, parts.slice(1).join(" "));
  }

  if (command === "wormholes" || (!parts[0] || parts[0] === "status" || parts[0] === "list")) {
    return buildStatusMessage(session, parts.slice(command === "wormholes" ? 0 : 1).join(" "));
  }

  const verb = String(parts[0] || "").trim().toLowerCase();
  if (verb === "ensure") {
    const resolved = resolveSystemID(session, parts.slice(1).join(" "), true);
    if (!resolved.success || (!resolved.all && resolved.systemID <= 0)) {
      return {
        success: false,
        message: "Usage: /wormhole ensure [system|here|all]",
      };
    }
    if (resolved.all) {
      const ensureAllResult = wormholeRuntime.ensureUniverseStatics(Date.now());
      if (!ensureAllResult.success) {
        return {
          success: false,
          message: "Failed to ensure tracked wormholes for the universe.",
        };
      }
      if (spaceRuntime && spaceRuntime.scenes instanceof Map) {
        for (const scene of spaceRuntime.scenes.values()) {
          wormholeRuntime.syncSceneEntities(scene, Date.now());
        }
      }
      return {
        success: true,
        message: `Ensured wormhole statics across ${wormholeRuntime.listPairViews({
          includeCollapsed: false,
          includeUndiscovered: true,
        }).length} tracked connection(s).`,
      };
    }
    const ensureResult = wormholeRuntime.ensureSystemStatics(resolved.systemID, Date.now());
    if (!ensureResult.success) {
      return {
        success: false,
        message: `Failed to ensure wormholes for ${formatSystemName(resolved.systemID)}.`,
      };
    }
    const scene = spaceRuntime.ensureScene(resolved.systemID);
    if (scene) {
      wormholeRuntime.syncSceneEntities(scene, Date.now());
    }
    return {
      success: true,
      message: `Ensured wormhole statics for ${formatSystemName(resolved.systemID)}.`,
    };
  }

  if (verb === "random") {
    const count = Math.max(1, toInt(parts[1], 1));
    const resolved = resolveSystemID(session, parts.slice(2).join(" "));
    if (!resolved.success || resolved.systemID <= 0) {
      return {
        success: false,
        message: "Usage: /wormhole random [count] [system|here]",
      };
    }
    const created = wormholeRuntime.spawnRandomPairs(resolved.systemID, count, Date.now());
    const scene = spaceRuntime.ensureScene(resolved.systemID);
    if (scene) {
      wormholeRuntime.syncSceneEntities(scene, Date.now());
    }
    return {
      success: true,
      message: created.length > 0
        ? [
            `Spawned ${created.length} random wormhole connection(s) in ${formatSystemName(resolved.systemID)}:`,
            ...created.map((pair) => renderPairLine({
              pairID: pair.pairID,
              sourceSystemName: formatSystemName(pair.source.systemID),
              sourceEndpointID: pair.source.endpointID,
              sourceCode: pair.source.code,
              destinationSystemName: formatSystemName(pair.destination.systemID),
              destinationEndpointID: pair.destination.endpointID,
              destinationCode: pair.destination.code,
              destinationClassID: pair.destination.wormholeClassID,
              expiresAtMs: pair.expiresAtMs,
              remainingMass: pair.remainingMass,
              totalMass: pair.totalMass,
              destinationDiscovered: pair.destination.discovered === true,
              kind: pair.kind,
              state: pair.state,
            })),
          ].join("\n")
        : `No wormholes could be spawned in ${formatSystemName(resolved.systemID)}.`,
    };
  }

  if (verb === "clear") {
    const resolved = resolveSystemID(session, parts.slice(1).join(" "), true);
    if (!resolved.success) {
      return {
        success: false,
        message: "Usage: /wormhole clear [system|here|all]",
      };
    }
    wormholeRuntime.clearPairs(resolved.systemID, Date.now());
    if (resolved.all) {
      if (spaceRuntime && spaceRuntime.scenes instanceof Map) {
        for (const scene of spaceRuntime.scenes.values()) {
          wormholeRuntime.syncSceneEntities(scene, Date.now());
        }
      }
      return {
        success: true,
        message: "Cleared all tracked wormhole connections.",
      };
    }
    const scene = spaceRuntime.ensureScene(resolved.systemID);
    if (scene) {
      wormholeRuntime.syncSceneEntities(scene, Date.now());
    }
    return {
      success: true,
      message: `Cleared tracked wormholes for ${formatSystemName(resolved.systemID)}.`,
    };
  }

  return {
    success: true,
    message: [
      "/wormholes [here|all|system]",
      "/wormholes systems [all|here|system]",
      "/wormhole status [here|all|system]",
      "/wormhole ensure [here|system|all]",
      "/wormhole random [count] [here|system]",
      "/wormhole clear [here|all|system]",
      "/estate [status|projects|contribute|start|ledger|ensure|connections]",
      "/estateprologue [start|status|recover]",
    ].join("\n"),
  };
}

module.exports = {
  executeWormholeCommand,
};
