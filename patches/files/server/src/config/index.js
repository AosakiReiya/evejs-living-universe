/**
 * EveJS Elysian Server Configuration
 *
 * Default values live here. Optional local overrides can be supplied in
 * evejs.config.local.json at the repository root, the installed X-Eve profile
 * can be customized with evejs.config.x-eve.local.json, and EVEJS_* env vars
 * take final precedence.
 */

const fs = require("fs");
const path = require("path");

let nextBoundId = 1;

const rootDir = path.resolve(__dirname, "../../..");
const localConfigPath = path.join(rootDir, "evejs.config.local.json");
const sharedConfigPath = path.join(rootDir, "evejs.config.json");
const xEveProfilePath = path.join(rootDir, "evejs.config.x-eve.json");
const xEveLocalConfigPath = path.join(
  rootDir,
  "evejs.config.x-eve.local.json",
);
const REMOVED_CONFIG_KEYS = new Set([
  "clientPath",
  "autoLaunch",
  "devMode",
  "dailyLoginRewardTypeID",
  "dailyLoginRewardQuantity",
  // Station/structure guests are no longer reconciled by periodic re-broadcast
  // (the docked guest panel double-renders re-sent joins); they self-heal via the
  // client's GetGuests pull. See presenceReconciler.js.
  "presenceReconcileStationEnabled",
]);

const CONFIG_ENTRY_DEFINITIONS = [
  {
    key: "devAutoCreateAccounts",
    defaultValue: false,
    envVar: "EVEJS_DEV_AUTO_CREATE_ACCOUNTS",
    envType: "boolean",
    description:
      "Automatically creates a missing account record on login using the hash the client just supplied.",
    validValues: "true or false.",
  },
  {
    key: "devSkipPasswordValidation",
    defaultValue: false,
    envVar: "EVEJS_DEV_SKIP_PASSWORD_VALIDATION",
    envType: "boolean",
    description:
      "Skips password-hash validation during login so any password can access an existing non-banned account.",
    validValues: "true or false.",
  },
  {
    key: "devBootstrapPublishedSkills",
    defaultValue: false,
    envVar: "EVEJS_DEV_BOOTSTRAP_PUBLISHED_SKILLS",
    envType: "boolean",
    description:
      "Seeds empty/new characters with all published skills at level V instead of the normal racial starter skill bundle.",
    validValues: "true or false.",
  },
  {
    key: "newCharacterTutorialEnabled",
    defaultValue: false,
    envVar: "EVEJS_NEW_CHARACTER_TUTORIAL_ENABLED",
    envType: "boolean",
    description: [
      "Enables the AIR NPE / new-character tutorial gate for freshly created characters.",
      "When enabled, brand-new characters start with tutorial-active AIR NPE state and character selection respects skipTutorial for those new characters.",
    ],
    validValues: "true or false.",
  },
  {
    key: "newCharacterIntroCinematicEnabled",
    defaultValue: false,
    envVar: "EVEJS_NEW_CHARACTER_INTRO_CINEMATIC_ENABLED",
    envType: "boolean",
    description: [
      "Enables the AIR NPE intro-movie entry path for newly created characters without activating the full tutorial runtime.",
      "Use this when you want the cinematic handoff but still land in the normal station or hangar UI because full tutorial parity is not implemented yet.",
    ],
    validValues: "true or false.",
  },
  {
    key: "characterDeletionDelayMinutes",
    defaultValue: 5,
    envVar: "EVEJS_CHARACTER_DELETION_DELAY_MINUTES",
    envType: "number",
    minValue: 1,
    description: [
      "How long a character must remain queued before biomass can finalize.",
      "Use 600 for retail parity; the default 5-minute value keeps local deletion testing fast.",
    ],
    validValues: "Integer minutes greater than or equal to 1.",
  },
  {
    key: "devHandshakeSeedSkillExtractorAccessToken",
    defaultValue: true,
    envVar: "EVEJS_DEV_HANDSHAKE_SEED_SKILL_EXTRACTOR_ACCESS_TOKEN",
    envType: "boolean",
    description: [
      "Seeds the packaged client connection service with a local access token during the signed login-handshake patch.",
      "This bypasses the client-side launcher-token gate for skill extraction when using EveJS Elysian launch scripts instead of the official CCP launcher.",
    ],
    validValues: "true or false.",
  },
  {
    key: "skillTrainingSpeed",
    defaultValue: 1,
    envVar: "EVEJS_SKILL_TRAINING_SPEED",
    envType: "number",
    minValue: 0,
    exclusiveMinValue: true,
    description: [
      "Global multiplier applied after the official CCP skill-training SP-per-minute formula is calculated.",
      "1 = retail training speed, 2 = 2x speed, 10 = 10x speed.",
      "This scales the authoritative server values: actual SP accrual, the active skill's trainingEndTime, and the character-selection queueEndTime.",
      "To keep the client's locally-computed estimates honest, the learning attributes (Charisma/Intelligence/Memory/Perception/Willpower) reported to the client are scaled by the same factor, so the in-game Skill window's per-skill and Total Training Time estimates match the accelerated rate. As a side effect those attributes are shown multiplied in the Character Sheet; CCP SP thresholds are unchanged.",
    ],
    validValues: "Positive number greater than 0.",
  },
  {
    key: "skillPurchaseEnabled",
    defaultValue: true,
    envVar: "EVEJS_SKILL_PURCHASE_ENABLED",
    envType: "boolean",
    description: [
      "Enables client direct skillbook purchase through skillHandler.PurchaseSkills.",
      "Keep this enabled for TQ-style skill plan Buy Skill / Buy and Train flows.",
    ],
    validValues: "true or false.",
  },
  {
    key: "newCharacterStarterProgressionEnabled",
    defaultValue: false,
    envVar: "EVEJS_NEW_CHARACTER_STARTER_PROGRESSION_ENABLED",
    envType: "boolean",
    description: [
      "Enables the new-character progression package.",
      "When enabled, newly created characters receive the configured starter skill injector and personal racial-cruiser plus mining/industry skill plans.",
      "Existing characters are not backfilled.",
    ],
    validValues: "true or false.",
  },
  {
    key: "newCharacterStarterSkillInjectorTypeID",
    defaultValue: 40520,
    envVar: "EVEJS_NEW_CHARACTER_STARTER_SKILL_INJECTOR_TYPE_ID",
    envType: "number",
    minValue: 1,
    description: [
      "Published inventory type granted by the new-character progression package.",
      "40520 is the standard Large Skill Injector, worth 500,000 SP below the normal diminishing-return threshold.",
    ],
    validValues: "Positive published item type ID.",
  },
  {
    key: "newCharacterStarterSkillInjectorQuantity",
    defaultValue: 1,
    envVar: "EVEJS_NEW_CHARACTER_STARTER_SKILL_INJECTOR_QUANTITY",
    envType: "number",
    minValue: 1,
    description: [
      "Quantity of the configured skill injector granted to each newly created character.",
    ],
    validValues: "Positive integer.",
  },
  {
    key: "expertSystemsEnabled",
    defaultValue: true,
    envVar: "EVEJS_EXPERT_SYSTEMS_ENABLED",
    envType: "boolean",
    description: [
      "Enables Expert System item activation, active Expert System overlays, and the client expert_system_feature_enabled flag.",
      "Disable only when testing no-Expert-System retail edge cases; GM force installs still require explicit command/runtime force options.",
    ],
    validValues: "true or false.",
  },
  {
    key: "localChatAuthorityEnabled",
    defaultValue: true,
    envVar: "EVEJS_LOCAL_CHAT_AUTHORITY_ENABLED",
    envType: "boolean",
    description: [
      "Enables the modern client Local chat authority feature flag (eve-local-chat-authority).",
      "Keep this enabled so the client uses public-gateway Local membership notices and requests instead of falling back to legacy XMPP-only Local.",
    ],
    validValues: "true or false.",
  },
  {
    key: "wormholesEnabled",
    defaultValue: true,
    envVar: "EVEJS_WORMHOLES_ENABLED",
    envType: "boolean",
    description: [
      "Enables the live wormhole runtime, wormholeMgr jump service, and automatic static wormhole seeding for eligible systems.",
      "Disable only when isolating unrelated space-runtime regressions.",
    ],
    validValues: "true or false.",
  },
  {
    key: "wormholeLifetimeScale",
    defaultValue: 1,
    envVar: "EVEJS_WORMHOLE_LIFETIME_SCALE",
    envType: "number",
    minValue: 0,
    exclusiveMinValue: true,
    description: [
      "Global multiplier applied to authoritative wormhole lifetimes after static data is loaded.",
      "1 = retail lifetime, 0.5 = half lifetime, 2 = double lifetime.",
    ],
    validValues: "Positive number greater than 0.",
  },
  {
    key: "wormholeStaticRespawnDelaySeconds",
    defaultValue: 60,
    envVar: "EVEJS_WORMHOLE_STATIC_RESPAWN_DELAY_SECONDS",
    envType: "number",
    minValue: 0,
    description: [
      "Delay before a collapsed static wormhole slot reseeds a fresh connection.",
      "Use 60 for quick dev parity iteration; increase only when calibrating live collapse/respawn behavior.",
    ],
    validValues: "Non-negative number of seconds.",
  },
  {
    key: "wormholeWanderingEnabled",
    defaultValue: true,
    envVar: "EVEJS_WORMHOLE_WANDERING_ENABLED",
    envType: "boolean",
    description: [
      "Enables automatic maintenance of repo-owned wandering wormhole families during startup and runtime reconciliation.",
      "Disable only when isolating static-only wormhole behavior or tuning wandering-family authority.",
    ],
    validValues: "true or false.",
  },
  {
    key: "wormholeWanderingCountScale",
    defaultValue: 1,
    envVar: "EVEJS_WORMHOLE_WANDERING_COUNT_SCALE",
    envType: "number",
    minValue: 0,
    description: [
      "Global multiplier applied to repo-owned wandering wormhole profile counts after authority is loaded.",
      "1 = authored wandering volume, 0 = no automatic wandering connections, 2 = double authored volume.",
    ],
    validValues: "Non-negative number.",
  },
  {
    key: "wormholeWanderingRespawnDelaySeconds",
    defaultValue: 60,
    envVar: "EVEJS_WORMHOLE_WANDERING_RESPAWN_DELAY_SECONDS",
    envType: "number",
    minValue: 0,
    description: [
      "Delay before a collapsed wandering wormhole profile is eligible to replenish its global active count.",
      "Use 60 for quick parity iteration; raise only when calibrating live wandering replacement cadence.",
    ],
    validValues: "Non-negative number of seconds.",
  },
  {
    key: "familyEstateEnabled",
    defaultValue: false,
    envVar: "EVEJS_FAMILY_ESTATE_ENABLED",
    envType: "boolean",
    description: [
      "Enables the shared corporation family estate bootstrap.",
      "The bootstrap maintains one C2 home, two permanent logistics conduits, two rotating wormholes, and one damaged Athanor without creating an estate per character.",
    ],
    validValues: "true or false.",
  },
  {
    key: "familyEstateHomeSystemID",
    defaultValue: 31000355,
    envVar: "EVEJS_FAMILY_ESTATE_HOME_SYSTEM_ID",
    envType: "number",
    minValue: 1,
    description: [
      "Existing effect-free class-2 wormhole solar system used by the shared estate.",
      "The default is J164417.",
    ],
    validValues: "Positive solar-system ID for a class-2 wormhole system.",
  },
  {
    key: "familyEstateHighSecSystemID",
    defaultValue: 30030141,
    envVar: "EVEJS_FAMILY_ESTATE_HIGHSEC_SYSTEM_ID",
    envType: "number",
    minValue: 1,
    description: [
      "Fixed known-space endpoint for the estate's non-expiring high-security conduit.",
      "The default is Uitra, four stargate jumps from Jita.",
    ],
    validValues: "Positive high-security solar-system ID.",
  },
  {
    key: "familyEstateLowSecSystemID",
    defaultValue: 30045347,
    envVar: "EVEJS_FAMILY_ESTATE_LOWSEC_SYSTEM_ID",
    envType: "number",
    minValue: 1,
    description: [
      "Fixed known-space endpoint for the estate's non-expiring low-security conduit.",
      "The default is Oinasiken in Black Rise.",
    ],
    validValues: "Positive low-security solar-system ID.",
  },
  {
    key: "familyEstateRandomConnectionCount",
    defaultValue: 2,
    envVar: "EVEJS_FAMILY_ESTATE_RANDOM_CONNECTION_COUNT",
    envType: "number",
    minValue: 0,
    description:
      "Number of ordinary expiring and mass-limited random wormholes maintained from the estate home.",
    validValues: "Non-negative integer; 2 is the authored estate layout.",
  },
  {
    key: "familyEstateRandomRespawnDelaySeconds",
    defaultValue: 60,
    envVar: "EVEJS_FAMILY_ESTATE_RANDOM_RESPAWN_DELAY_SECONDS",
    envType: "number",
    minValue: 0,
    description:
      "Delay before a collapsed estate random-aperture slot receives a replacement connection.",
    validValues: "Non-negative number of seconds.",
  },
  {
    key: "familyEstateOwnerCorporationID",
    defaultValue: 1000009,
    envVar: "EVEJS_FAMILY_ESTATE_OWNER_CORPORATION_ID",
    envType: "number",
    minValue: 1,
    description: [
      "Initial holding corporation for the estate Athanor before the mission chain transfers ownership to the player corporation.",
      "Changing this value does not silently transfer an already-created estate.",
    ],
    validValues: "Positive corporation owner ID.",
  },
  {
    key: "familyEstateMoonID",
    defaultValue: 40369145,
    envVar: "EVEJS_FAMILY_ESTATE_MOON_ID",
    envType: "number",
    minValue: 1,
    description: [
      "Moon used to place and identify the family Athanor inside the configured home system.",
      "The default is J164417 II - Moon 1.",
    ],
    validValues: "Positive moon celestial item ID in the estate home system.",
  },
  {
    key: "familyEstateStructureName",
    defaultValue: "The Family Holding",
    envVar: "EVEJS_FAMILY_ESTATE_STRUCTURE_NAME",
    envType: "string",
    description:
      "Name assigned to the seeded damaged Athanor. The dev marker, not the display name, is used for idempotent recovery.",
    validValues: "Non-empty structure name.",
  },
  {
    key: "familyEstateLogisticsEnabled",
    defaultValue: true,
    envVar: "EVEJS_FAMILY_ESTATE_LOGISTICS_ENABLED",
    envType: "boolean",
    description: [
      "Lets a claimed estate commission independent Living Universe haulers for restoration materials.",
      "Cargo is reserved from regional economy stock and credited only after the assigned flight physically reaches the Athanor.",
    ],
    validValues: "true or false.",
  },
  {
    key: "devBypassAssetSafetyWrapAccess",
    defaultValue: false,
    envVar: "EVEJS_DEV_BYPASS_ASSET_SAFETY_WRAP_ACCESS",
    envType: "boolean",
    description:
      "Lets any session manage and deliver asset-safety wraps without ownership or corporation access checks.",
    validValues: "true or false.",
  },
  {
    key: "upwellGmBypassRestrictions",
    defaultValue: false,
    envVar: "EVEJS_UPWELL_GM_BYPASS_RESTRICTIONS",
    envType: "boolean",
    description: [
      "Allows GM/dev sessions to bypass Upwell docking, settings, and timer safety restrictions.",
      "Keep this disabled for stricter CCP parity and enable it only when iterating on structure lifecycle tests.",
    ],
    validValues: "true or false.",
  },
  {
    key: "upwellTimerScale",
    defaultValue: 1,
    envVar: "EVEJS_UPWELL_TIMER_SCALE",
    envType: "number",
    description: [
      "Global multiplier applied to structure anchor, repair, and reinforcement timers.",
      "Use values below 1 to shorten GM/dev test cycles without hardcoding timer constants in commands.",
    ],
    validValues: "Positive number such as 1, 0.1, or 0.01.",
  },
  {
    key: "miningCommandShipName",
    defaultValue: "Hulk",
    envVar: "EVEJS_MINING_COMMAND_SHIP_NAME",
    envType: "string",
    description: [
      "Ship hull that /miner spawns in a docked character's hangar.",
      "Keep this aligned with a mining barge or exhumer that the selected mining module can validly fit.",
    ],
    validValues: 'Published ship name such as "Hulk".',
  },
  {
    key: "miningCommandModuleName",
    defaultValue: "Modulated Strip Miner II",
    envVar: "EVEJS_MINING_COMMAND_MODULE_NAME",
    envType: "string",
    description:
      "Mining module name that /miner fits to the spawned hull before it boards the ship.",
    validValues: 'Published module name such as "Modulated Strip Miner II".',
  },
  {
    key: "miningCommandModuleCount",
    defaultValue: 2,
    envVar: "EVEJS_MINING_COMMAND_MODULE_COUNT",
    envType: "number",
    description:
      "How many copies of the configured mining module /miner attempts to fit.",
    validValues: "Positive integer that does not exceed the hull's fitting layout.",
  },
  {
    key: "miningCommandSupportModuleName",
    defaultValue: "Expanded Cargohold II",
    envVar: "EVEJS_MINING_COMMAND_SUPPORT_MODULE_NAME",
    envType: "string",
    description:
      "Optional low-slot support module that /miner fits to create enough cargo room for the full crystal set.",
    validValues: 'Published module name such as "Expanded Cargohold II".',
  },
  {
    key: "miningCommandSupportModuleCount",
    defaultValue: 3,
    envVar: "EVEJS_MINING_COMMAND_SUPPORT_MODULE_COUNT",
    envType: "number",
    description:
      "How many copies of the optional support module /miner attempts to fit.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningCommandRigName",
    defaultValue: "Medium Cargohold Optimization I",
    envVar: "EVEJS_MINING_COMMAND_RIG_NAME",
    envType: "string",
    description:
      "Optional rig that /miner fits to expand cargo capacity while keeping the fitting valid.",
    validValues: 'Published rig name such as "Medium Cargohold Optimization I".',
  },
  {
    key: "miningCommandRigCount",
    defaultValue: 2,
    envVar: "EVEJS_MINING_COMMAND_RIG_COUNT",
    envType: "number",
    description:
      "How many copies of the optional mining-command rig /miner attempts to fit.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningCommandCrystalQuantityPerType",
    defaultValue: 1,
    envVar: "EVEJS_MINING_COMMAND_CRYSTAL_QUANTITY_PER_TYPE",
    envType: "number",
    description:
      "How many copies of each compatible mining crystal /miner places into the ship cargo hold.",
    validValues: "Positive integer.",
  },
  {
    key: "miningNpcFleetProfileOrPool",
    defaultValue: "",
    envVar: "EVEJS_MINING_NPC_FLEET_PROFILE_OR_POOL",
    envType: "string",
    description:
      "Optional NPC profile, pool, or spawn-group query used by /npcminer when it creates the passive mining fleet. Blank falls back to security-band defaults.",
    validValues: 'Blank, or an NPC profile / pool / spawn-group ID such as "npc_mining_ops_highsec".',
  },
  {
    key: "miningNpcFleetHighSecProfileOrPool",
    defaultValue: "npc_mining_ops_highsec",
    envVar: "EVEJS_MINING_NPC_FLEET_HIGHSEC_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile, pool, or spawn-group query used for passive mining fleets in high-security systems when no explicit override is supplied.",
    validValues: 'NPC profile / pool / spawn-group ID such as "npc_mining_ops_highsec".',
  },
  {
    key: "miningNpcFleetLowSecProfileOrPool",
    defaultValue: "npc_mining_ops_lowsec",
    envVar: "EVEJS_MINING_NPC_FLEET_LOWSEC_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile, pool, or spawn-group query used for passive mining fleets in low-security systems when no explicit override is supplied.",
    validValues: 'NPC profile / pool / spawn-group ID such as "npc_mining_ops_lowsec".',
  },
  {
    key: "miningNpcFleetNullSecProfileOrPool",
    defaultValue: "npc_mining_ops_nullsec",
    envVar: "EVEJS_MINING_NPC_FLEET_NULLSEC_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile, pool, or spawn-group query used for passive mining fleets in null-security and wormhole systems when no explicit override is supplied.",
    validValues: 'NPC profile / pool / spawn-group ID such as "npc_mining_ops_nullsec".',
  },
  {
    key: "asteroidBeltNpcRatsEnabled",
    defaultValue: true,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RATS_ENABLED",
    envType: "boolean",
    description:
      "Enables lazy normal pirate rat spawns when a player arrives at an asteroid belt. Disable to remove belt-rat spawning entirely.",
    validValues: "true or false.",
  },
  {
    key: "asteroidBeltNpcRatHighSecChance",
    defaultValue: 0.25,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_HIGHSEC_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible high-security belt arrival creates a normal pirate rat group when the belt has no active rat group.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatLowSecChance",
    defaultValue: 0.35,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_LOWSEC_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible low-security belt arrival creates a normal pirate rat group when the belt has no active rat group.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatNullSecChance",
    defaultValue: 0.45,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_NULLSEC_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible null-security belt arrival creates a normal pirate rat group when the belt has no active rat group.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatRollCooldownMs",
    defaultValue: 120000,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_ROLL_COOLDOWN_MS",
    envType: "number",
    minValue: 0,
    description:
      "Minimum time before the same empty belt can roll for another rat spawn after a player arrival check.",
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "asteroidBeltNpcRatRespawnCooldownMs",
    defaultValue: 1200000,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_RESPAWN_COOLDOWN_MS",
    envType: "number",
    minValue: 0,
    description:
      "Minimum time before the same belt can spawn a replacement normal pirate rat group after its previous group was created.",
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "asteroidBeltNpcRatMaxActiveGroupsPerBelt",
    defaultValue: 1,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_MAX_ACTIVE_GROUPS_PER_BELT",
    envType: "number",
    minValue: 1,
    description:
      "Maximum active lazy normal pirate rat groups allowed at a single asteroid belt.",
    validValues: "Positive integer.",
  },
  {
    key: "asteroidBeltNpcRatLandingRadiusMeters",
    defaultValue: 250000,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_LANDING_RADIUS_METERS",
    envType: "number",
    minValue: 1000,
    description:
      "Maximum distance from an asteroid belt anchor for login/arrival checks to count the player as being at that belt.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "asteroidBeltNpcRatSpawnDistanceMeters",
    defaultValue: 30000,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_SPAWN_DISTANCE_METERS",
    envType: "number",
    minValue: 1000,
    description:
      "Approximate anchor-relative distance used when placing lazy normal pirate rat groups around asteroid belts.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "asteroidBeltNpcRatSpecialsEnabled",
    defaultValue: true,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_SPECIALS_ENABLED",
    envType: "boolean",
    description:
      "Enables rare asteroid-belt special spawns such as hauler, faction commander, and officer-style rats.",
    validValues: "true or false.",
  },
  {
    key: "asteroidBeltNpcRatHaulerChance",
    defaultValue: 0.02,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_HAULER_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible empty-belt arrival creates a rare NPC hauler group instead of a normal pirate group.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatCommanderChance",
    defaultValue: 0.015,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_COMMANDER_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible empty-belt arrival creates a faction commander spawn instead of a normal pirate group.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatOfficerChance",
    defaultValue: 0.0005,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_OFFICER_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible deep nullsec pirate-home belt arrival creates an officer-style rare spawn.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatOfficerMaxSecurity",
    defaultValue: -0.7,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_OFFICER_MAX_SECURITY",
    envType: "number",
    minValue: -1,
    maxValue: 1,
    description:
      "Maximum true security status eligible for non-home-region officer-style asteroid-belt spawns.",
    validValues: "Number from -1.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatOfficerRequireHomeRegion",
    defaultValue: true,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_OFFICER_REQUIRE_HOME_REGION",
    envType: "boolean",
    description:
      "Restricts officer-style asteroid-belt spawns to the matching pirate faction's home region.",
    validValues: "true or false.",
  },
  {
    key: "asteroidBeltNpcRatCapitalEnabled",
    defaultValue: true,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_ENABLED",
    envType: "boolean",
    description:
      "Enables rare null-security asteroid-belt capital NPC spawns such as pirate dreadnoughts.",
    validValues: "true or false.",
  },
  {
    key: "asteroidBeltNpcRatCapitalChance",
    defaultValue: 0.00025,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_CHANCE",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Chance that an eligible empty null-security belt arrival creates a rare pirate capital spawn instead of normal belt rats.",
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatCapitalMaxSecurity",
    defaultValue: 0,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_MAX_SECURITY",
    envType: "number",
    minValue: -1,
    maxValue: 1,
    description:
      "Maximum true security status eligible for rare asteroid-belt capital spawns. Capital spawns are still null-security only.",
    validValues: "Number from -1.0 to 1.0.",
  },
  {
    key: "asteroidBeltNpcRatCapitalClasses",
    defaultValue: "dreadnought",
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_CLASSES",
    envType: "string",
    description:
      "Comma-separated capital classes allowed in rare asteroid-belt capital spawns.",
    validValues: '"dreadnought" for CCP-style belt dreads, or a comma-separated list including dreadnought, titan, and supercarrier.',
  },
  {
    key: "asteroidBeltNpcRatCapitalMaxActiveGroupsPerSystem",
    defaultValue: 1,
    envVar: "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_MAX_ACTIVE_GROUPS_PER_SYSTEM",
    envType: "number",
    minValue: 0,
    description:
      "Maximum active rare asteroid-belt capital groups allowed in one solar-system scene. Use 0 for no system-wide cap.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcFleetDefaultCount",
    defaultValue: 1,
    envVar: "EVEJS_MINING_NPC_FLEET_DEFAULT_COUNT",
    envType: "number",
    description:
      "Default repetition count used by /npcminer when no explicit amount is provided. Pool/profile queries treat this as a hull count, while spawn-group queries repeat the full authored group.",
      validValues: "Positive integer up to the GM command safety cap.",
  },
  {
    key: "miningNpcHaulerProfileOrPool",
    defaultValue: "",
    envVar: "EVEJS_MINING_NPC_HAULER_PROFILE_OR_POOL",
    envType: "string",
    description:
      "Optional NPC profile, pool, or spawn-group query used for the transient hauler wing attached to mining fleets. Blank falls back to security-band defaults.",
    validValues: 'Blank, or an NPC profile / pool / spawn-group ID such as "npc_mining_hauler_highsec".',
  },
  {
    key: "miningNpcHaulerHighSecProfileOrPool",
    defaultValue: "npc_mining_hauler_highsec",
    envVar: "EVEJS_MINING_NPC_HAULER_HIGHSEC_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile, pool, or spawn-group query used for transient mining haulers in high-security systems when no explicit override is supplied.",
    validValues: 'NPC profile / pool / spawn-group ID such as "npc_mining_hauler_highsec".',
  },
  {
    key: "miningNpcHaulerLowSecProfileOrPool",
    defaultValue: "npc_mining_hauler_lowsec",
    envVar: "EVEJS_MINING_NPC_HAULER_LOWSEC_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile, pool, or spawn-group query used for transient mining haulers in low-security systems when no explicit override is supplied.",
    validValues: 'NPC profile / pool / spawn-group ID such as "npc_mining_hauler_lowsec".',
  },
  {
    key: "miningNpcHaulerNullSecProfileOrPool",
    defaultValue: "npc_mining_hauler_nullsec",
    envVar: "EVEJS_MINING_NPC_HAULER_NULLSEC_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile, pool, or spawn-group query used for transient mining haulers in null-security and wormhole systems when no explicit override is supplied.",
    validValues: 'NPC profile / pool / spawn-group ID such as "npc_mining_hauler_nullsec".',
  },
  {
    key: "miningNpcHaulerDefaultCount",
    defaultValue: 1,
    envVar: "EVEJS_MINING_NPC_HAULER_DEFAULT_COUNT",
    envType: "number",
    description:
      "Default hauler hull count attached to /npcminer fleets and startup mining fleets.",
    validValues: "Non-negative integer up to the GM command safety cap.",
  },
  {
    key: "miningNpcFleetLandingRadiusMeters",
    defaultValue: 2500,
    envVar: "EVEJS_MINING_NPC_FLEET_LANDING_RADIUS_METERS",
    envType: "number",
    description:
      "Radius around the target ship used when mining NPCs finish their warp-in.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningNpcResponseProfileOrPool",
    defaultValue: "npc_laser_hostiles",
    envVar: "EVEJS_MINING_NPC_RESPONSE_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile or spawn-pool query used by /npcmineraggro when the response fleet is called.",
    validValues: 'NPC profile or pool ID such as "npc_laser_hostiles".',
  },
  {
    key: "miningNpcResponseDefaultPoolID",
    defaultValue: "npc_laser_hostiles",
    envVar: "EVEJS_MINING_NPC_RESPONSE_DEFAULT_POOL_ID",
    envType: "string",
    description:
      "Fallback spawn-pool ID passed into the mining-response warp command when no query is supplied.",
    validValues: 'NPC pool ID such as "npc_laser_hostiles".',
  },
  {
    key: "miningNpcResponseFallbackProfileID",
    defaultValue: "generic_hostile",
    envVar: "EVEJS_MINING_NPC_RESPONSE_FALLBACK_PROFILE_ID",
    envType: "string",
    description:
      "Fallback profile ID used when the configured mining response pool cannot resolve a direct match.",
    validValues: 'NPC profile ID such as "generic_hostile".',
  },
  {
    key: "miningNpcResponseDefaultCount",
    defaultValue: 8,
    envVar: "EVEJS_MINING_NPC_RESPONSE_DEFAULT_COUNT",
    envType: "number",
    description:
      "Default hull count used by /npcmineraggro when no explicit response amount is supplied.",
    validValues: "Positive integer up to the GM command safety cap.",
  },
  {
    key: "miningNpcStandingsEnabled",
    defaultValue: true,
    envVar: "EVEJS_MINING_NPC_STANDINGS_ENABLED",
    envType: "boolean",
    description:
      "Enables standings-aware response planning for transient mining NPC fleets when they are aggressed.",
    validValues: "true or false.",
  },
  {
    key: "miningNpcHostileStandingThreshold",
    defaultValue: -5,
    envVar: "EVEJS_MINING_NPC_HOSTILE_STANDING_THRESHOLD",
    envType: "number",
    description:
      "Fallback hostile standing threshold used by mining NPC fleets when the NPC profile does not provide explicit response thresholds.",
    validValues: "Number between -10 and 10.",
  },
  {
    key: "miningNpcFriendlyStandingThreshold",
    defaultValue: 5,
    envVar: "EVEJS_MINING_NPC_FRIENDLY_STANDING_THRESHOLD",
    envType: "number",
    description:
      "Fallback friendly standing threshold used by mining NPC fleets when the NPC profile does not provide explicit response thresholds.",
    validValues: "Number between -10 and 10.",
  },
  {
    key: "miningNpcFriendlyResponseProfileOrPool",
    defaultValue: "",
    envVar: "EVEJS_MINING_NPC_FRIENDLY_RESPONSE_PROFILE_OR_POOL",
    envType: "string",
    description:
      "Optional NPC profile or pool used when a mining fleet is aggressed by a character with friendly standings.",
    validValues: 'Blank for no armed response, or an NPC profile/pool ID such as "npc_laser_hostiles".',
  },
  {
    key: "miningNpcFriendlyResponseCount",
    defaultValue: 0,
    envVar: "EVEJS_MINING_NPC_FRIENDLY_RESPONSE_COUNT",
    envType: "number",
    description:
      "Response hull count used for friendly-standing aggressors after a mining fleet retreats.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcNeutralResponseProfileOrPool",
    defaultValue: "npc_laser_hostiles",
    envVar: "EVEJS_MINING_NPC_NEUTRAL_RESPONSE_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile or pool used when a mining fleet is aggressed by a neutral-standing character.",
    validValues: 'NPC profile or pool ID such as "npc_laser_hostiles".',
  },
  {
    key: "miningNpcNeutralResponseCount",
    defaultValue: 8,
    envVar: "EVEJS_MINING_NPC_NEUTRAL_RESPONSE_COUNT",
    envType: "number",
    description:
      "Response hull count used for neutral-standing aggressors after a mining fleet retreats.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcHostileResponseProfileOrPool",
    defaultValue: "npc_laser_hostiles",
    envVar: "EVEJS_MINING_NPC_HOSTILE_RESPONSE_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile or pool used when a mining fleet is aggressed by a hostile-standing character.",
    validValues: 'NPC profile or pool ID such as "npc_laser_hostiles".',
  },
  {
    key: "miningNpcHostileResponseCount",
    defaultValue: 10,
    envVar: "EVEJS_MINING_NPC_HOSTILE_RESPONSE_COUNT",
    envType: "number",
    description:
      "Response hull count used for hostile-standing aggressors after a mining fleet retreats.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcResponseCooldownMs",
    defaultValue: 60000,
    envVar: "EVEJS_MINING_NPC_RESPONSE_COOLDOWN_MS",
    envType: "number",
    description:
      "Minimum delay between mining-fleet response deployments so repeat aggression during a single exchange does not spam extra wings.",
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "miningNpcAggressionMemoryMs",
    defaultValue: 180000,
    envVar: "EVEJS_MINING_NPC_AGGRESSION_MEMORY_MS",
    envType: "number",
    description:
      "How long mining fleets remember aggression on their miner or hauler hulls before the event is considered stale.",
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "miningNpcResponseRetreatDelayMs",
    defaultValue: 120000,
    envVar: "EVEJS_MINING_NPC_RESPONSE_RETREAT_DELAY_MS",
    envType: "number",
    description:
      "How long the transient response wing remains deployed after the last aggression before it retreats or despawns.",
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "miningNpcWarpIngressDurationMs",
    defaultValue: 2500,
    envVar: "EVEJS_MINING_NPC_WARP_INGRESS_DURATION_MS",
    envType: "number",
    description:
      "Warp ingress duration used by the mining NPC warp-in and retreat helpers.",
    validValues: "Positive duration in milliseconds.",
  },
  {
    key: "miningEnabled",
    defaultValue: true,
    envVar: "EVEJS_MINING_ENABLED",
    envType: "boolean",
    description:
      "Enables the mining runtime, asteroid depletion state, and mining scan service.",
    validValues: "true or false.",
  },
  {
    key: "miningSurveyScanDistanceMeters",
    defaultValue: 250000,
    envVar: "EVEJS_MINING_SURVEY_SCAN_DISTANCE_METERS",
    envType: "number",
    description:
      "Maximum range used when the mining scan manager returns asteroid scan tuples to the client.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningBeltQuantityScale",
    defaultValue: 0.08,
    envVar: "EVEJS_MINING_BELT_QUANTITY_SCALE",
    envType: "number",
    description:
      "Radius-to-volume scale used when estimating authoritative asteroid quantities for generated belt rocks.",
    validValues: "Positive number.",
  },
  {
    key: "miningBeltMinimumAsteroidVolumeM3",
    defaultValue: 15000,
    envVar: "EVEJS_MINING_BELT_MIN_ASTEROID_VOLUME_M3",
    envType: "number",
    description:
      "Minimum generated asteroid volume used by the mining runtime for generated belt rocks.",
    validValues: "Positive number of cubic meters.",
  },
  {
    key: "miningBeltMaximumAsteroidVolumeM3",
    defaultValue: 3000000,
    envVar: "EVEJS_MINING_BELT_MAX_ASTEROID_VOLUME_M3",
    envType: "number",
    description:
      "Maximum generated asteroid volume used by the mining runtime for generated belt rocks.",
    validValues: "Positive number of cubic meters.",
  },
  {
    key: "miningGeneratedIceSitesEnabled",
    defaultValue: true,
    envVar: "EVEJS_MINING_GENERATED_ICE_SITES_ENABLED",
    envType: "boolean",
    description:
      "Adds deterministic runtime ice fields to space scenes so ice harvesters and ore-hold routing have live non-moon content to work against.",
    validValues: "true or false.",
  },
  {
    key: "miningGeneratedGasSitesEnabled",
    defaultValue: true,
    envVar: "EVEJS_MINING_GENERATED_GAS_SITES_ENABLED",
    envType: "boolean",
    description:
      "Adds deterministic runtime gas fields to space scenes so gas harvesters have authored-on-startup content without relying on GM commands.",
    validValues: "true or false.",
  },
  {
    key: "miningIceSitesHighSecPerSystem",
    defaultValue: 1,
    envVar: "EVEJS_MINING_ICE_SITES_HIGHSEC_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated ice-field anchors created in each high-security system scene when ice runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceSitesLowSecPerSystem",
    defaultValue: 1,
    envVar: "EVEJS_MINING_ICE_SITES_LOWSEC_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated ice-field anchors created in each low-security system scene when ice runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceSitesNullSecPerSystem",
    defaultValue: 1,
    envVar: "EVEJS_MINING_ICE_SITES_NULLSEC_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated ice-field anchors created in each null-security system scene when ice runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceSitesWormholePerSystem",
    defaultValue: 0,
    envVar: "EVEJS_MINING_ICE_SITES_WORMHOLE_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated ice-field anchors created in each wormhole system scene when ice runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceTargetSystemsHighSec",
    defaultValue: 36,
    envVar: "EVEJS_MINING_ICE_TARGET_SYSTEMS_HIGHSEC",
    envType: "number",
    description:
      "Number of high-security systems that should carry generated ice fields in the universe-seeded Phase 3 mining pool.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceTargetSystemsLowSec",
    defaultValue: 18,
    envVar: "EVEJS_MINING_ICE_TARGET_SYSTEMS_LOWSEC",
    envType: "number",
    description:
      "Number of low-security systems that should carry generated ice fields in the universe-seeded Phase 3 mining pool.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceTargetSystemsNullSec",
    defaultValue: 84,
    envVar: "EVEJS_MINING_ICE_TARGET_SYSTEMS_NULLSEC",
    envType: "number",
    description:
      "Number of null-security systems that should carry generated ice fields in the universe-seeded Phase 3 mining pool.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningIceTargetSystemsWormhole",
    defaultValue: 0,
    envVar: "EVEJS_MINING_ICE_TARGET_SYSTEMS_WORMHOLE",
    envType: "number",
    description:
      "Number of wormhole systems that should carry generated ice fields in the universe-seeded Phase 3 mining pool.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningGeneratedIceSiteLifetimeMinutes",
    defaultValue: 1440,
    envVar: "EVEJS_MINING_GENERATED_ICE_SITE_LIFETIME_MINUTES",
    envType: "number",
    description:
      "Lifetime in minutes for universe-seeded generated ice site slots before they rotate in place to the next deterministic field definition.",
    validValues: "Positive integer minutes.",
  },
  {
    key: "miningGasSitesHighSecPerSystem",
    defaultValue: 0,
    envVar: "EVEJS_MINING_GAS_SITES_HIGHSEC_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated gas-field anchors created in each high-security system scene when gas runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningGasSitesLowSecPerSystem",
    defaultValue: 1,
    envVar: "EVEJS_MINING_GAS_SITES_LOWSEC_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated gas-field anchors created in each low-security system scene when gas runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningGasSitesNullSecPerSystem",
    defaultValue: 1,
    envVar: "EVEJS_MINING_GAS_SITES_NULLSEC_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated gas-field anchors created in each null-security system scene when gas runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningGasSitesWormholePerSystem",
    defaultValue: 2,
    envVar: "EVEJS_MINING_GAS_SITES_WORMHOLE_PER_SYSTEM",
    envType: "number",
    description:
      "Number of generated gas-field anchors created in each wormhole system scene when gas runtime content is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningGeneratedSiteAnchorOffsetMeters",
    defaultValue: 120000,
    envVar: "EVEJS_MINING_GENERATED_SITE_ANCHOR_OFFSET_METERS",
    envType: "number",
    description:
      "Distance applied when deterministic ice/gas site anchors are offset from their source belt or celestial.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningGeneratedSiteRadiusMeters",
    defaultValue: 18000,
    envVar: "EVEJS_MINING_GENERATED_SITE_RADIUS_METERS",
    envType: "number",
    description:
      "Radius of the generated runtime ice and gas fields around each deterministic site anchor.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningIceChunksPerSite",
    defaultValue: 12,
    envVar: "EVEJS_MINING_ICE_CHUNKS_PER_SITE",
    envType: "number",
    description:
      "How many mineable ice chunks each generated ice field contains.",
    validValues: "Positive integer.",
  },
  {
    key: "miningGasCloudsPerSite",
    defaultValue: 14,
    envVar: "EVEJS_MINING_GAS_CLOUDS_PER_SITE",
    envType: "number",
    description:
      "How many mineable gas clouds each generated gas field contains.",
    validValues: "Positive integer.",
  },
  {
    key: "miningDepletedAsteroidRadiusRatio",
    defaultValue: 0.25,
    envVar: "EVEJS_MINING_DEPLETED_ASTEROID_RADIUS_RATIO",
    envType: "number",
    description:
      "Minimum radius ratio preserved while an asteroid is being depleted before it is removed from the scene.",
    validValues: "Positive fraction such as 0.25.",
  },
  {
    key: "miningNpcFleetAutoMineEnabled",
    defaultValue: true,
    envVar: "EVEJS_MINING_NPC_FLEET_AUTO_MINE_ENABLED",
    envType: "boolean",
    description:
      "Lets /npcminer fleets automatically lock asteroids, approach, activate miners, and deplete rocks.",
    validValues: "true or false.",
  },
  {
    key: "miningNpcFleetThinkIntervalMs",
    defaultValue: 1000,
    envVar: "EVEJS_MINING_NPC_FLEET_THINK_INTERVAL_MS",
    envType: "number",
    description:
      "Polling interval for the mining NPC fleet controller.",
    validValues: "Positive duration in milliseconds.",
  },
  {
    key: "miningNpcFleetMiningRangeBufferMeters",
    defaultValue: 500,
    envVar: "EVEJS_MINING_NPC_FLEET_MINING_RANGE_BUFFER_METERS",
    envType: "number",
    description:
      "How much margin NPC miners keep inside mining range before they stop approaching and start mining.",
    validValues: "Non-negative distance in meters.",
  },
  {
    key: "miningNpcFleetOrbitDistanceMeters",
    defaultValue: 1000,
    envVar: "EVEJS_MINING_NPC_FLEET_ORBIT_DISTANCE_METERS",
    envType: "number",
    description:
      "Orbit distance used by NPC miners once they are in range of their asteroid target.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningNpcFleetTargetClaimPenaltyMeters",
    defaultValue: 7500,
    envVar: "EVEJS_MINING_NPC_FLEET_TARGET_CLAIM_PENALTY_METERS",
    envType: "number",
    description: [
      "Distance-equivalent penalty applied when the mining fleet target picker compares an already-claimed asteroid against an unclaimed one.",
      "Higher values spread miners out more aggressively; lower values make them share nearby rocks sooner instead of marching across the belt.",
    ],
    validValues: "Non-negative distance in meters.",
  },
  {
    key: "miningNpcHaulThresholdRatio",
    defaultValue: 0.85,
    envVar: "EVEJS_MINING_NPC_HAUL_THRESHOLD_RATIO",
    envType: "number",
    description:
      "Fraction of miner cargo fill at which the transient NPC hauler choreography triggers.",
    validValues: "Positive fraction between 0 and 1.",
  },
  {
    key: "miningNpcJetcansRequireFullHold",
    defaultValue: true,
    envVar: "EVEJS_MINING_NPC_JETCANS_REQUIRE_FULL_HOLD",
    envType: "boolean",
    description:
      "Requires an NPC miner's dogma-derived mining hold to be operationally full before it jettisons ore for its hauler.",
    validValues: "true or false.",
  },
  {
    key: "miningNpcManagedDefenseEnabled",
    defaultValue: true,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_ENABLED",
    envType: "boolean",
    description:
      "Lets managed industrial crews use only their fitted doctrine drone flights against conservatively classified weak NPC threats.",
    validValues: "true or false. When false, managed crews always retreat from aggression.",
  },
  {
    key: "miningNpcManagedDefenseMaxBountyISK",
    defaultValue: 30000,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_MAX_BOUNTY_ISK",
    envType: "number",
    description:
      "Maximum bounty of a known frigate or destroyer NPC that a managed industrial crew may consider fighting.",
    validValues: "Non-negative ISK amount.",
  },
  {
    key: "miningNpcManagedDefenseRequiredOvermatch",
    defaultValue: 3,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_REQUIRED_OVERMATCH",
    envType: "number",
    description:
      "Minimum projected drone-power overmatch required before a managed industrial crew will defend instead of retreating.",
    validValues: "Number greater than or equal to 1.",
  },
  {
    key: "miningNpcManagedDefenseMaxActiveDrones",
    defaultValue: 20,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_MAX_ACTIVE_DRONES",
    envType: "number",
    description:
      "Crew-wide ceiling for simultaneously launched managed industrial-defense drones across all ships.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcManagedDefenseScanRangeMeters",
    defaultValue: 100000,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_SCAN_RANGE_METERS",
    envType: "number",
    description:
      "Bounded range of the cached proactive pirate scan used by managed industrial crews.",
    validValues: "Non-negative distance in meters.",
  },
  {
    key: "miningNpcManagedDefenseScanIntervalMs",
    defaultValue: 5000,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_SCAN_INTERVAL_MS",
    envType: "number",
    description:
      "Minimum interval between full proactive pirate scans for one managed industrial crew; the cached result is reused between scans.",
    validValues: "Positive duration in milliseconds.",
  },
  {
    key: "miningNpcManagedDefenseRetreatCooldownMs",
    defaultValue: 30000,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_RETREAT_COOLDOWN_MS",
    envType: "number",
    description:
      "Cooldown between assigned-site threat rescans while a managed industrial crew waits safely at its retreat origin.",
    validValues: "Positive duration in milliseconds.",
  },
  {
    key: "miningNpcManagedDefenseRetreatShieldRatio",
    defaultValue: 0.65,
    envVar: "EVEJS_MINING_NPC_MANAGED_DEFENSE_RETREAT_SHIELD_RATIO",
    envType: "number",
    description:
      "Shield ratio at which a defending managed industrial crew abandons the engagement; any armor, hull, or drone loss also forces retreat.",
    validValues: "Fraction between 0 and 1.",
  },
  {
    key: "miningNpcHaulerLandingRadiusMeters",
    defaultValue: 750,
    envVar: "EVEJS_MINING_NPC_HAULER_LANDING_RADIUS_METERS",
    envType: "number",
    description:
      "Landing radius used when mining fleet haulers warp to collect ore from the miner wing.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningNpcHaulerUnloadDurationMs",
    defaultValue: 8000,
    envVar: "EVEJS_MINING_NPC_HAULER_UNLOAD_DURATION_MS",
    envType: "number",
    description:
      "Delay budget used by the transient NPC hauler wing between arrival and hauling completion.",
    validValues: "Positive duration in milliseconds.",
  },
  {
    key: "miningNpcHaulerInitialDelayMs",
    defaultValue: 5400000,
    envVar: "EVEJS_MINING_NPC_HAULER_INITIAL_DELAY_MS",
    envType: "number",
    description: [
      "Minimum time before a newly spawned mining fleet becomes eligible for its first hauler run.",
      "The default is tuned to public player observations of roughly 90 minutes from fleet spawn to first hauler appearance.",
    ],
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "miningNpcHaulerRepeatDelayMs",
    defaultValue: 1800000,
    envVar: "EVEJS_MINING_NPC_HAULER_REPEAT_DELAY_MS",
    envType: "number",
    description: [
      "Minimum time between completed hauler runs for the same mining fleet.",
      "The default is tuned to public player observations of roughly 30-minute repeat windows.",
    ],
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "miningNpcFleetAutoResumeDelayMs",
    defaultValue: 0,
    envVar: "EVEJS_MINING_NPC_FLEET_AUTO_RESUME_DELAY_MS",
    envType: "number",
    description:
      "Optional delay after /npcmineraggro or /npcminerpanic before transient mining fleets auto-resume mining.",
    validValues: "Non-negative duration in milliseconds. Use 0 to require manual /npcminerresume.",
  },
  {
    key: "miningNpcMinerCargoCapacityM3",
    defaultValue: 35000,
    envVar: "EVEJS_MINING_NPC_MINER_CARGO_CAPACITY_M3",
    envType: "number",
    description:
      "Fallback miner capacity used only when the hull's dogma mining-hold and cargo attributes are unavailable.",
    validValues: "Positive cargo capacity in cubic meters.",
  },
  {
    key: "miningNpcHaulerCargoCapacityM3",
    defaultValue: 65000,
    envVar: "EVEJS_MINING_NPC_HAULER_CARGO_CAPACITY_M3",
    envType: "number",
    description:
      "Fallback hauler capacity used only when the hull's dogma mining-hold, fleet-hangar, and cargo attributes are unavailable.",
    validValues: "Positive cargo capacity in cubic meters.",
  },
  {
    key: "miningNpcStartupEnabled",
    defaultValue: false,
    envVar: "EVEJS_MINING_NPC_STARTUP_ENABLED",
    envType: "boolean",
    description:
      "Recreates transient mining fleets from config when matching solar-system scenes are created at startup/runtime.",
    validValues: "true or false.",
  },
  {
    key: "miningNpcStartupSystemIDs",
    defaultValue: "",
    envVar: "EVEJS_MINING_NPC_STARTUP_SYSTEM_IDS",
    envType: "string",
    description:
      "Comma-separated solar system IDs that should receive transient startup mining fleets. Blank means all loaded scenes.",
    validValues: 'Comma-separated IDs such as "30000142,30002510".',
  },
  {
    key: "miningNpcStartupFleetCount",
    defaultValue: 0,
    envVar: "EVEJS_MINING_NPC_STARTUP_FLEET_COUNT",
    envType: "number",
    description:
      "How many transient mining fleets to recreate per matching system scene during startup.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcStartupFleetMinerCount",
    defaultValue: 3,
    envVar: "EVEJS_MINING_NPC_STARTUP_FLEET_MINER_COUNT",
    envType: "number",
    description:
      "Miner hull count per transient startup mining fleet.",
    validValues: "Positive integer.",
  },
  {
    key: "miningNpcStartupFleetHaulerCount",
    defaultValue: 1,
    envVar: "EVEJS_MINING_NPC_STARTUP_FLEET_HAULER_COUNT",
    envType: "number",
    description:
      "Hauler hull count per transient startup mining fleet.",
    validValues: "Non-negative integer.",
  },
  {
    key: "miningNpcStartupFleetProfileOrPool",
    defaultValue: "industrial_crew_venture",
    envVar: "EVEJS_MINING_NPC_STARTUP_FLEET_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile or pool used when config-driven transient startup mining fleets are recreated.",
    validValues: 'NPC profile or pool ID such as "industrial_crew_venture".',
  },
  {
    key: "miningNpcStartupHaulerProfileOrPool",
    defaultValue: "industrial_crew_miasmos",
    envVar: "EVEJS_MINING_NPC_STARTUP_HAULER_PROFILE_OR_POOL",
    envType: "string",
    description:
      "NPC profile or pool used for the transient hauler wing of startup mining fleets.",
    validValues: 'Hauler-only NPC profile or pool ID such as "industrial_crew_miasmos".',
  },
  {
    key: "miningStructureReprocessingEfficiency",
    defaultValue: 0.5,
    envVar: "EVEJS_MINING_STRUCTURE_REPROCESSING_EFFICIENCY",
    envType: "number",
    description:
      "Structure-side base reprocessing efficiency used by the mining industry services until per-structure rig bonuses are modeled.",
    validValues: "Fraction between 0 and 1.",
  },
  {
    key: "miningStructureGasDecompressionEfficiency",
    defaultValue: 0.79,
    envVar: "EVEJS_MINING_STRUCTURE_GAS_DECOMPRESSION_EFFICIENCY",
    envType: "number",
    description:
      "Structure-side base gas decompression efficiency used by structureCompressionMgr.",
    validValues: "Fraction between 0 and 1.",
  },
  {
    key: "miningInSpaceCompressionRangeMeters",
    defaultValue: 250000,
    envVar: "EVEJS_MINING_IN_SPACE_COMPRESSION_RANGE_METERS",
    envType: "number",
    description:
      "Maximum range used by the in-space compression service when validating a compression facility ball.",
    validValues: "Positive distance in meters.",
  },
  {
    key: "miningCharacterLedgerDelayMs",
    defaultValue: 10 * 60 * 1000,
    envVar: "EVEJS_MINING_CHARACTER_LEDGER_DELAY_MS",
    envType: "number",
    description: [
      "Visibility delay applied to personal mining-ledger entries before characterMiningLedger returns them.",
      "This keeps delayed-ledger parity configurable without adding expensive per-cycle database work.",
    ],
    validValues: "Non-negative duration in milliseconds. 600000 = 10 minutes.",
  },
  {
    key: "miningObserverLedgerDelayMs",
    defaultValue: 60 * 60 * 1000,
    envVar: "EVEJS_MINING_OBSERVER_LEDGER_DELAY_MS",
    envType: "number",
    description: [
      "Visibility delay applied to observer/corporation mining-ledger entries before corpMiningLedger exposes them.",
      "Use this to model CCP-style delayed observer data while keeping reads cache-first.",
    ],
    validValues: "Non-negative duration in milliseconds. 3600000 = 1 hour.",
  },
  {
    key: "industrySystemCostIndex",
    defaultValue: 0.04,
    envVar: "EVEJS_INDUSTRY_SYSTEM_COST_INDEX",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description: [
      "Flat system cost index applied to industry job install costs across manufacturing, research, copying, invention, and reactions.",
      "Live EVE derives this value per solar system and activity from rolling industry job volume; this emulator does not track that telemetry yet, so one static index stands in for the whole cluster.",
      "Job gross cost = estimated item value x this index x facility cost modifier. Facility tax and the SCC surcharge are still charged on the full estimated item value, matching the client industry cost breakdown.",
      "0 reproduces the previous zero-index behavior (install cost equals the full estimated item value); raise toward live high-sec values, roughly 0.01 to 0.10, to keep install costs realistic.",
    ],
    validValues: "Number from 0.0 to 1.0.",
  },
  {
    key: "clientVersion",
    defaultValue: 24.01,
    description:
      "Boot version reported to the client during the login handshake.",
    validValues: 'Number matching your client build, for example 24.01.',
  },
  {
    key: "clientBuild",
    defaultValue: 3396210,
    description:
      "Client build number reported to the client during the login handshake.",
    validValues: "Integer build number matching your client.",
  },
  {
    key: "eveBirthday",
    defaultValue: 170472,
    description:
      "Birthday value used by the handshake version checks.",
    validValues: "Integer matching your client build.",
  },
  {
    key: "machoVersion",
    defaultValue: 496,
    description:
      "MachoNet protocol version reported during session bootstrap.",
    validValues: "Integer matching your client build.",
  },
  {
    key: "projectCodename",
    defaultValue: "EvEJS",
    defaultComment: "client compatibility codename",
    description:
      "Project codename reported to the client during startup.",
    validValues:
      "String matching the client boot codename; leave the default unless your client build requires another value.",
  },
  {
    key: "projectRegion",
    defaultValue: "ccp",
    description:
      "Project region reported to the client during startup.",
    validValues: 'String. For the current client keep this as "ccp".',
  },
  {
    key: "projectVersion",
    defaultValue: "V24.01@ccp",
    description:
      "Full project version string reported to the client during startup.",
    validValues:
      'String matching your client boot version, for example "V24.01@ccp".',
  },
  {
    key: "clusterDowntimeStarts",
    defaultValue: "11:00:00",
    envVar: "EVEJS_CLUSTER_DOWNTIME_STARTS",
    envType: "string",
    description: [
      "UTC daily downtime start used by server-side startup reconciliation.",
      "Matches the target client's zcluster DowntimeStarts value format and falls back to 11:00:00 when unset.",
    ],
    validValues: 'UTC time in "HH:MM:SS" format.',
  },
  {
    key: "serverStatusLabel",
    defaultValue: "/Carbon/MachoNet/ServerStatus/OK",
    envVar: "EVEJS_SERVER_STATUS_LABEL",
    envType: "string",
    description: [
      "Login-screen server status label returned by machoNet.GetServerStatus.",
      "Use CCP-style labels such as /Carbon/MachoNet/ServerStatus/OK, /Carbon/MachoNet/ServerStatus/StartingUp, /Carbon/MachoNet/ServerStatus/ShuttingDown, or /Carbon/MachoNet/ServerStatus/NotAcceptingConnections.",
    ],
    validValues:
      'A known Carbon login-status label such as "/Carbon/MachoNet/ServerStatus/OK" or "/Carbon/MachoNet/ServerStatus/StartingUp".',
  },
  {
    key: "serverStatusProgressSeconds",
    defaultValue: 0,
    envVar: "EVEJS_SERVER_STATUS_PROGRESS_SECONDS",
    envType: "number",
    minValue: 0,
    description:
      "Progress/countdown value injected when serverStatusLabel is /Carbon/MachoNet/ServerStatus/StartingUp.",
    validValues: "Non-negative integer seconds.",
  },
  {
    key: "serverStatusProxyLimit",
    defaultValue: 0,
    envVar: "EVEJS_SERVER_STATUS_PROXY_LIMIT",
    envType: "number",
    minValue: 0,
    description:
      "Limit value injected when serverStatusLabel is /Carbon/MachoNet/ServerStatus/ProxyFullWithLimit.",
    validValues: "Non-negative integer.",
  },
  {
    key: "serverStatusClusterUserCount",
    defaultValue: 1,
    envVar: "EVEJS_SERVER_STATUS_CLUSTER_USER_COUNT",
    envType: "number",
    minValue: 0,
    description:
      "Cluster user count reported during login-status and handshake flows.",
    validValues: "Non-negative integer.",
  },
  {
    key: "serverStatusQueuePosition",
    defaultValue: 1,
    envVar: "EVEJS_SERVER_STATUS_QUEUE_POSITION",
    envType: "number",
    minValue: 0,
    description: [
      "Logon queue position exposed during handshake.",
      "Values of 2 or greater trigger the retail client queue flow.",
    ],
    validValues: "Non-negative integer.",
  },
  {
    key: "defaultCountryCode",
    defaultValue: "GB",
    envVar: "EVEJS_DEFAULT_COUNTRY_CODE",
    envType: "string",
    description: [
      "Two-letter ISO country code injected into the initial user session when an account does not define one.",
      "HyperNet visibility checks read session.countryCode during early client startup, so this default keeps the feature available in local dev.",
    ],
    validValues: 'Two-letter ISO country code such as "GB", "DE", or "US".',
  },
  {
    key: "hyperNetKillSwitch",
    defaultValue: false,
    envVar: "EVEJS_HYPERNET_KILL_SWITCH",
    envType: "boolean",
    description:
      "Exposes HyperNetKillSwitch through machoNet global config so the client can gate HyperNet availability.",
    validValues: "true or false.",
  },
  {
    key: "hyperNetPlexPriceOverride",
    defaultValue: 3500000,
    envVar: "EVEJS_HYPERNET_PLEX_PRICE_OVERRIDE",
    envType: "number",
    description: [
      "Fixed PLEX price exposed through machoNet global config for HyperNet token calculations.",
      "Using the same override on both client and server keeps token requirements deterministic in local development.",
    ],
    validValues: "Positive integer ISK value such as 3500000.",
  },
  {
    key: "hyperNetDevAutoGrantCores",
    defaultValue: true,
    envVar: "EVEJS_HYPERNET_DEV_AUTO_GRANT_CORES",
    envType: "boolean",
    description: [
      "Local-development convenience toggle that auto-grants a starter HyperCore stack when a character first opens HyperNet.",
      "Disable this for stricter CCP parity once characters are provisioned with real HyperCores.",
    ],
    validValues: "true or false.",
  },
  {
    key: "hyperNetSeedEnabled",
    defaultValue: true,
    envVar: "EVEJS_HYPERNET_SEED_ENABLED",
    envType: "boolean",
    description: [
      "Enables optional HyperNet startup seeding using GM Elysian's home-station hangar.",
      "This is kept separate from the persistent raffle core so seeded demo listings can be turned off cleanly.",
    ],
    validValues: "true or false.",
  },
  {
    key: "hyperNetSeedOwnerId",
    defaultValue: 140000004,
    envVar: "EVEJS_HYPERNET_SEED_OWNER_ID",
    envType: "number",
    description:
      "Character ID used as the seller/source hangar for optional HyperNet startup seeding.",
    validValues: "Positive character ID.",
  },
  {
    key: "hyperNetSeedRestockEnabled",
    defaultValue: true,
    envVar: "EVEJS_HYPERNET_SEED_RESTOCK_ENABLED",
    envType: "boolean",
    description:
      "Allows the HyperNet seed manager to restock GM seed inventory before creating demo listings.",
    validValues: "true or false.",
  },
  {
    key: "hyperNetSeedMinShips",
    defaultValue: 2,
    envVar: "EVEJS_HYPERNET_SEED_MIN_SHIPS",
    envType: "number",
    description:
      "Minimum number of seeded ship raffles the startup seed manager targets when HyperNet seeding is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "hyperNetSeedMaxShips",
    defaultValue: 5,
    envVar: "EVEJS_HYPERNET_SEED_MAX_SHIPS",
    envType: "number",
    description:
      "Maximum number of seeded ship raffles the startup seed manager targets when HyperNet seeding is enabled.",
    validValues: "Non-negative integer greater than or equal to hyperNetSeedMinShips.",
  },
  {
    key: "hyperNetSeedMinItems",
    defaultValue: 2,
    envVar: "EVEJS_HYPERNET_SEED_MIN_ITEMS",
    envType: "number",
    description:
      "Minimum number of seeded non-ship raffles the startup seed manager targets when HyperNet seeding is enabled.",
    validValues: "Non-negative integer.",
  },
  {
    key: "hyperNetSeedMaxItems",
    defaultValue: 5,
    envVar: "EVEJS_HYPERNET_SEED_MAX_ITEMS",
    envType: "number",
    description:
      "Maximum number of seeded non-ship raffles the startup seed manager targets when HyperNet seeding is enabled.",
    validValues: "Non-negative integer greater than or equal to hyperNetSeedMinItems.",
  },
  {
    key: "logLevel",
    defaultValue: 1,
    allowedValues: [0, 1, 2],
    envVar: "EVEJS_LOG_LEVEL",
    envType: "number",
    description:
      "Controls how much the server writes to the log output.",
    validValues:
      "0 = silent, 1 = normal server logging, 2 = verbose debug logging.",
  },
  {
    key: "logPacketPayloadDetails",
    defaultValue: false,
    envVar: "EVEJS_LOG_PACKET_PAYLOAD_DETAILS",
    envType: "boolean",
    description:
      "When verbose debug logging is enabled, also dumps decoded packet payload previews and outgoing packet hex summaries on hot network paths.",
    validValues: "true or false.",
  },
  {
    key: "gameServerBindHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_GAME_SERVER_BIND_HOST",
    envType: "string",
    description:
      "Local interface used by the main game TCP listener. Keep this on 127.0.0.1 unless a container or similarly isolated network boundary provides the external localhost-only restriction.",
    validValues: 'Bind address such as "127.0.0.1" or "0.0.0.0".',
  },
  {
    key: "serverPort",
    defaultValue: 26000,
    envVar: "EVEJS_SERVER_PORT",
    envType: "number",
    description:
      "TCP port used by the main game server listener.",
    validValues: "Available TCP port number.",
  },
  {
    key: "socketKeepAliveEnabled",
    defaultValue: true,
    envVar: "EVEJS_SOCKET_KEEPALIVE_ENABLED",
    envType: "boolean",
    description: [
      "Enables TCP keep-alive on accepted game client sockets so the OS reaps dead/half-open connections promptly.",
      "Without it an ungracefully dropped client lingers as a live session: the player keeps showing in local chat and station guest lists, and the duplicate-login guard blocks their reconnection until the dead socket finally times out.",
    ],
    validValues: "true or false.",
  },
  {
    key: "socketKeepAliveInitialDelayMs",
    defaultValue: 30000,
    envVar: "EVEJS_SOCKET_KEEPALIVE_INITIAL_DELAY_MS",
    envType: "number",
    minValue: 0,
    description:
      "Idle time before the OS starts sending TCP keep-alive probes on a game client socket.",
    validValues: "Non-negative duration in milliseconds.",
  },
  {
    key: "socketNoDelayEnabled",
    defaultValue: true,
    envVar: "EVEJS_SOCKET_NODELAY_ENABLED",
    envType: "boolean",
    description: [
      "Disables Nagle's algorithm on game client sockets so small RPC packets are sent immediately instead of being buffered.",
      "Lowers latency for the many small request/response packets the MachoNet protocol exchanges.",
    ],
    validValues: "true or false.",
  },
  {
    key: "socketIdleTimeoutMs",
    defaultValue: 0,
    envVar: "EVEJS_SOCKET_IDLE_TIMEOUT_MS",
    envType: "number",
    minValue: 0,
    description: [
      "Optional application-level idle timeout for game client sockets. When greater than 0 a socket with no activity for this long is destroyed.",
      "Left disabled (0) by default because keep-alive already reaps dead peers and a legitimately idle docked client sends no traffic.",
    ],
    validValues: "Non-negative duration in milliseconds. 0 disables the idle timeout.",
  },
  {
    key: "presenceReconcileIntervalMs",
    defaultValue: 30000,
    envVar: "EVEJS_PRESENCE_RECONCILE_INTERVAL_MS",
    envType: "number",
    minValue: 0,
    description: [
      "How often the presence reconciler re-pushes authoritative who-is-here state so any missed live-presence delta self-heals.",
      "This is the safety net for the fire-and-forget presence broadcasts (local chat membership and station/structure guests). 0 disables the reconciler entirely.",
    ],
    validValues: "Non-negative duration in milliseconds. 0 disables reconciliation.",
  },
  {
    key: "presenceReconcileChatEnabled",
    defaultValue: true,
    envVar: "EVEJS_PRESENCE_RECONCILE_CHAT_ENABLED",
    envType: "boolean",
    description: [
      "Re-publishes the full authoritative local-chat membership snapshot to each character every reconcile tick.",
      "The snapshot is the same payload the client requests on demand, so re-pushing it is an idempotent full-list refresh.",
    ],
    validValues: "true or false.",
  },
  {
    key: "presenceReconcileXmppEnabled",
    defaultValue: true,
    envVar: "EVEJS_PRESENCE_RECONCILE_XMPP_ENABLED",
    envType: "boolean",
    description: [
      "Re-asserts each character's XMPP MUC room presence every reconcile tick so chat-window rosters (local, corp, fleet, alliance, militia) self-heal a missed join.",
      "Sends idempotent available-only presence (no leave/rejoin flicker) and skips delayed-local rooms. Disable to cut reconcile traffic on large shards.",
    ],
    validValues: "true or false.",
  },
  {
    key: "loginTakeoverEnabled",
    defaultValue: true,
    envVar: "EVEJS_LOGIN_TAKEOVER_ENABLED",
    envType: "boolean",
    description: [
      "Controls what happens when a character is selected while an earlier session still holds it.",
      "true (default) makes the new login evict the prior session and take over, letting a player reconnect immediately after an ungraceful drop instead of waiting for keep-alive to reap the stale socket. false keeps the conservative reject — the new login is refused with 'already online'.",
    ],
    validValues: "true or false.",
  },
  {
    key: "gameServerHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_GAME_SERVER_HOST",
    envType: "string",
    description:
      "Host name or IP address the client should use when connecting to the main game TCP listener.",
    validValues: 'Host name or IP string such as "127.0.0.1" or "203.0.113.10".',
  },
  {
    key: "marketDaemonHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_MARKET_DAEMON_HOST",
    envType: "string",
    description:
      "Host name or IP address used by the main server to reach the standalone Rust market daemon RPC listener.",
    validValues: 'Host name or IP string such as "127.0.0.1" or "192.168.1.20".',
  },
  {
    key: "marketDaemonPort",
    defaultValue: 40111,
    envVar: "EVEJS_MARKET_DAEMON_PORT",
    envType: "number",
    description:
      "TCP port used by the main server when forwarding marketProxy calls to the standalone market daemon RPC listener.",
    validValues: "Available TCP port number.",
  },
  {
    key: "marketDaemonConnectTimeoutMs",
    defaultValue: 1500,
    envVar: "EVEJS_MARKET_DAEMON_CONNECT_TIMEOUT_MS",
    envType: "number",
    description:
      "How long the main server waits for the market daemon TCP connection to open before treating it as unavailable.",
    validValues: "Positive integer duration in milliseconds.",
  },
  {
    key: "marketDaemonRequestTimeoutMs",
    defaultValue: 15000,
    envVar: "EVEJS_MARKET_DAEMON_REQUEST_TIMEOUT_MS",
    envType: "number",
    description:
      "How long an individual forwarded market RPC call may take before the main server fails it.",
    validValues: "Positive integer duration in milliseconds.",
  },
  {
    key: "marketDaemonRetryDelayMs",
    defaultValue: 2000,
    envVar: "EVEJS_MARKET_DAEMON_RETRY_DELAY_MS",
    envType: "number",
    description:
      "Delay between background reconnect attempts when the main server is waiting for the standalone market daemon to come online.",
    validValues: "Positive integer duration in milliseconds.",
  },
  {
    key: "imageServerUrl",
    defaultValue: "http://127.0.0.1:26001/",
    envVar: "EVEJS_IMAGE_SERVER_URL",
    envType: "string",
    description:
      "Base URL sent to the client for image and icon requests.",
    validValues: 'Absolute URL string ending with a slash, for example "http://127.0.0.1:26001/".',
  },
  {
    key: "imageServerBindHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_IMAGE_SERVER_BIND_HOST",
    envType: "string",
    description:
      "Host or bind address the local image HTTP server listens on.",
    validValues: 'Host name or IP string such as "127.0.0.1" or "0.0.0.0".',
  },
  {
    key: "microservicesRedirectUrl",
    defaultValue: "http://localhost:26002/",
    envVar: "EVEJS_MICROSERVICES_REDIRECT_URL",
    envType: "string",
    description:
      "Base URL used to redirect supported microservice calls away from CCP.",
    validValues: 'Absolute URL string ending with a slash, for example "http://localhost:26002/".',
  },
  {
    key: "microservicesPublicBaseUrl",
    defaultValue: "http://127.0.0.1:26002/",
    envVar: "EVEJS_MICROSERVICES_PUBLIC_BASE_URL",
    envType: "string",
    description:
      "Server-side HTTP base URL where the EveJS microservice and public-gateway bridge listens for forwarded helper traffic.",
    validValues: 'Absolute URL string ending with a slash, for example "http://127.0.0.1:26002/".',
  },
  {
    key: "microservicesBindHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_MICROSERVICES_BIND_HOST",
    envType: "string",
    description:
      "Host or bind address the EveJS microservice and public-gateway bridge listens on.",
    validValues: 'Host name or IP string such as "127.0.0.1" or "0.0.0.0".',
  },
  {
    key: "microservicesInternalBindHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_MICROSERVICES_INTERNAL_BIND_HOST",
    envType: "string",
    description:
      "Private bind address for the intercepted TLS and CDN responders behind the public client bridge. Keep this on loopback even when friends connect remotely.",
    validValues: 'Loopback host name or IP string such as "127.0.0.1".',
  },
  {
    key: "redshiftMonitorHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_REDSHIFT_MONITOR_HOST",
    envType: "string",
    description:
      "Host or bind address the Redshift TiDi monitor API listens on.",
    validValues: 'Host name or IP string such as "127.0.0.1" or "0.0.0.0".',
  },
  {
    key: "redshiftMonitorPort",
    defaultValue: 26400,
    envVar: "EVEJS_REDSHIFT_MONITOR_PORT",
    envType: "number",
    description:
      "TCP port used by the Redshift TiDi monitor API.",
    validValues: "Available TCP port number.",
  },
  {
    key: "proxyBlockedHosts",
    defaultValue:
      "api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com",
    envVar: "EVEJS_PROXY_BLOCKED_HOSTS",
    envType: "string",
    description:
      "Comma-separated hostnames or dot-prefix suffixes the local HTTP proxy should block instead of forwarding off-box.",
    validValues:
      'Comma-separated host patterns, for example "api.ipify.org,sentry.io,.sentry.io,google-analytics.com,.google-analytics.com".',
  },
  {
    key: "proxyAllowedHosts",
    defaultValue: "",
    envVar: "EVEJS_PROXY_ALLOWED_HOSTS",
    envType: "string",
    description:
      "Comma-separated extra hostnames or suffix patterns the local HTTP proxy may forward off-box when they are not handled by the built-in EveJS gateway intercepts.",
    validValues:
      'Comma-separated host patterns, for example "images.example.com,.examplecdn.net", or blank to allow only EveJS-handled endpoints.',
  },
  {
    key: "proxyUnhandledHostPolicy",
    defaultValue: "block",
    envVar: "EVEJS_PROXY_UNHANDLED_HOST_POLICY",
    envType: "string",
    description:
      'Controls what the local HTTP proxy does with proxied hosts that are neither EveJS-intercepted nor explicitly allow-listed. "block" is the safe default that suppresses telemetry and stray outbound traffic; "forward" restores the old transparent pass-through behavior.',
    validValues: '"block" or "forward".',
  },
  {
    key: "xmppServerBindHost",
    defaultValue: "127.0.0.1",
    envVar: "EVEJS_XMPP_SERVER_BIND_HOST",
    envType: "string",
    description:
      "Local interface used by the XMPP chat listener. Keep this on 127.0.0.1 unless a container or similarly isolated network boundary provides the external localhost-only restriction.",
    validValues: 'Bind address such as "127.0.0.1" or "0.0.0.0".',
  },
  {
    key: "xmppServerPort",
    defaultValue: 5222,
    envVar: "EVEJS_XMPP_SERVER_PORT",
    envType: "number",
    description:
      "TCP port used by the local XMPP chat stub server.",
    validValues: "Available TCP port number.",
  },
  {
    key: "xmppConnectHost",
    defaultValue: "localhost",
    envVar: "EVEJS_XMPP_CONNECT_HOST",
    envType: "string",
    description:
      "Host name or IP address returned to the client for the XMPP chat connection target.",
    validValues: 'Host name or IP string such as "localhost" or "chat.example.com".',
  },
  {
    key: "xmppDomain",
    defaultValue: "localhost",
    envVar: "EVEJS_XMPP_DOMAIN",
    envType: "string",
    description:
      "XMPP domain used for bare JIDs and chat identity values.",
    validValues: 'Domain or host string such as "localhost" or "chat.example.com".',
  },
  {
    key: "xmppConferenceDomain",
    defaultValue: "conference.localhost",
    envVar: "EVEJS_XMPP_CONFERENCE_DOMAIN",
    envType: "string",
    description:
      "XMPP conference domain used for chat room JIDs.",
    validValues: 'Domain or host string such as "conference.localhost" or "conference.chat.example.com".',
  },
  {
    key: "playerConnectToken",
    defaultValue: "",
    envVar: "EVEJS_PLAYER_CONNECT_TOKEN",
    envType: "string",
    description:
      "Shared secret that gates the /playerconnect/* helper endpoints (health ping + CA download) used by the PlayerConnect bundle. When empty, those endpoints are disabled.",
    validValues: "Any non-empty string, or empty to disable the PlayerConnect endpoints.",
  },
  {
    key: "omegaLicenseEnabled",
    defaultValue: true,
    envVar: "EVEJS_OMEGA_LICENSE",
    envType: "boolean",
    description:
      "Enables the stubbed omega-license path for modern eve_public flows.",
    validValues: "true or false.",
  },
  {
    key: "newEdenStoreEnabled",
    defaultValue: true,
    envVar: "EVEJS_NEW_EDEN_STORE_ENABLED",
    envType: "boolean",
    description:
      "Enables the cache-backed New Eden Store, legacy storeManager catalog, and public payment surfaces.",
    validValues: "true or false.",
  },
  {
    key: "newEdenStoreFastCheckoutEnabled",
    defaultValue: true,
    envVar: "EVEJS_NEW_EDEN_STORE_FAST_CHECKOUT_ENABLED",
    envType: "boolean",
    description:
      "Enables the legacy FastCheckoutService path the client uses for in-game PLEX purchases.",
    validValues: "true or false.",
  },
  {
    key: "newEdenStoreFakeCashPurchasesEnabled",
    defaultValue: true,
    envVar: "EVEJS_NEW_EDEN_STORE_FAKE_CASH_PURCHASES_ENABLED",
    envType: "boolean",
    description:
      "Lets cash purchase attempts succeed locally and grant the selected offer without touching a real payment processor.",
    validValues: "true or false.",
  },
  {
    key: "newEdenStoreFakeFastCheckoutResponse",
    defaultValue: "OK",
    envVar: "EVEJS_NEW_EDEN_STORE_FAKE_FAST_CHECKOUT_RESPONSE",
    envType: "string",
    description:
      "Response string returned by FastCheckoutService.BuyOffer when the local fake purchase completes.",
    validValues: 'Non-empty string such as "OK".',
  },
  {
    key: "newEdenStoreFakeChinaFunnelEnabled",
    defaultValue: false,
    envVar: "EVEJS_NEW_EDEN_STORE_FAKE_CHINA_FUNNEL_ENABLED",
    envType: "boolean",
    description:
      "Forces the client down the China-funnel branch of fast checkout testing.",
    validValues: "true or false.",
  },
  {
    key: "newEdenStoreFakeBuyPlexOfferUrl",
    defaultValue: "",
    envVar: "EVEJS_NEW_EDEN_STORE_FAKE_BUY_PLEX_OFFER_URL",
    envType: "string",
    description:
      "Optional URL the client opens when testing the external buy-plex-offer path.",
    validValues: 'Absolute URL string, or blank to use the local default.',
  },
  {
    key: "newEdenStoreUseShellExecuteToBuyPlexOffer",
    defaultValue: true,
    envVar: "EVEJS_NEW_EDEN_STORE_USE_SHELL_EXECUTE_TO_BUY_PLEX_OFFER",
    envType: "boolean",
    description:
      "Controls whether the client uses shell execute for external PLEX-offer purchase URLs during fast checkout tests.",
    validValues: "true or false.",
  },
  {
    key: "newEdenStoreEditorPort",
    defaultValue: 26008,
    envVar: "EVEJS_NEW_EDEN_STORE_EDITOR_PORT",
    envType: "number",
    description:
      "TCP port used by the local New Eden Store editor GUI under scripts/newedenstore.",
    validValues: "Available TCP port number.",
  },
  {
    key: "newEdenStoreCentsPerPlex",
    defaultValue: 100,
    envVar: "EVEJS_NEW_EDEN_STORE_CENTS_PER_PLEX",
    envType: "number",
    description:
      "Conversion rate used by the store purchase helpers when translating stored PLEX offer pricing into whole PLEX debits.",
    validValues: "Positive integer such as 100.",
  },
  {
    key: "newEdenStoreDefaultCashTaxRatePoints",
    defaultValue: 0,
    envVar: "EVEJS_NEW_EDEN_STORE_DEFAULT_CASH_TAX_RATE_POINTS",
    envType: "number",
    description:
      "Tax rate in basis points applied to fake cash CostRequest calculations for public payment flows.",
    validValues: "Non-negative integer. 100 = 1%.",
  },
  {
    key: "newEdenStorePurchaseLogLimit",
    defaultValue: 500,
    envVar: "EVEJS_NEW_EDEN_STORE_PURCHASE_LOG_LIMIT",
    envType: "number",
    description:
      "Maximum number of completed New Eden Store purchases retained in the cache-backed runtime log.",
    validValues: "Positive integer.",
  },
  {
    key: "dailyLoginRewardsEnabled",
    defaultValue: true,
    envVar: "EVEJS_DAILY_LOGIN_REWARDS_ENABLED",
    envType: "boolean",
    description:
      "Enables the 15-day daily login reward campaign.",
    validValues: "true or false.",
  },
  {
    key: "dailyLoginRewards",
    defaultValue: [{ typeID: 49810, quantity: 1 }],
    envVar: "EVEJS_DAILY_LOGIN_REWARDS",
    envType: "json",
    valueType: "json",
    description: [
      "Ordered daily login reward definitions for the 15-day campaign.",
      "A one-entry array repeats that reward every day; shorter arrays cycle until all 15 days are filled.",
    ],
    validValues:
      "Non-empty JSON array of objects with positive integer typeID and quantity fields.",
    validateValue: validateDailyLoginRewards,
  },
  {
    key: "spaceDebrisLifetimeMs",
    defaultValue: 2 * 60 * 60 * 1000,
    envVar: "EVEJS_SPACE_DEBRIS_LIFETIME_MS",
    envType: "number",
    description:
      "How long GM and testing space debris persists before cleanup.",
    validValues: "Integer duration in milliseconds. 7200000 = 2 hours.",
  },
  {
    key: "tidiAutoscaler",
    defaultValue: true,
    envVar: "EVEJS_TIDI_AUTOSCALER",
    envType: "boolean",
    description:
      "Enables automatic tick-lateness-based time dilation scaling.",
    validValues: "true or false.",
  },
  {
    key: "NewEdenSystemLoading",
    defaultValue: 1,
    allowedValues: [1, 2, 3, 4],
    envVar: "EVEJS_NEW_EDEN_SYSTEM_LOADING",
    envType: "number",
    description:
      [
        "Controls which solar-system scenes are created during server startup.",
        "1 = current lazy/default boot: only Jita, New Caldari, and Manifest are preloaded so the existing startup behavior stays the same.",
        "2 = preload every high-security system by checking the solar-system security data for displayed security `0.5+` at startup, so newly added systems are picked up automatically.",
        "3 = preload every solar system in New Eden at startup.",
        "4 = OnGoingLazy: preload only Jita, New Caldari, and Manifest, but keep every stargate active so destination systems load on demand when a player jumps through.",
      ],
    validValues: "1, 2, 3, or 4. Any other value falls back to 1.",
  },
  {
    key: "asteroidFieldsEnabled",
    defaultValue: true,
    envVar: "EVEJS_ASTEROID_FIELDS",
    envType: "boolean",
    description:
      [
        "Turns generated cosmetic asteroid-belt fields on or off when a solar-system scene is created.",
        "When this is off, belts still exist in static data, but the runtime does not populate the extra asteroid entities into space scenes.",
    ],
    validValues: "true or false.",
  },
  {
    key: "asteroidBeltStartupReset",
    defaultValue: true,
    envVar: "EVEJS_ASTEROID_BELT_STARTUP_RESET",
    envType: "boolean",
    description:
      [
        "Clears persisted belt asteroid depletion state during server startup so every asteroid belt repopulates.",
        "Matches Tranquility, where mined-out belts come back on downtime rather than on a respawn timer. Generated ice sites keep their own respawn lifecycle and are not affected.",
      ],
    validValues: "true or false.",
  },
  {
    key: "defaultStargateBillboardsEnabled",
    defaultValue: true,
    envVar: "EVEJS_DEFAULT_STARGATE_BILLBOARDS",
    envType: "boolean",
    description:
      [
        "Turns on generated default billboard props beside empire-space stargates (`0.1+`).",
        "These use PublicEveJS bubble-scoped static visibility, matching the existing generated CONCORD scene style.",
      ],
    validValues: "true or false.",
  },
  {
    key: "defaultEmpireSentryGunsEnabled",
    defaultValue: true,
    envVar: "EVEJS_DEFAULT_EMPIRE_SENTRY_GUNS",
    envType: "boolean",
    description:
      [
        "Turns on generated default sentry-gun props at empire-space stargates and NPC stations (`0.1+`).",
        "This is visual parity scaffolding for gate/station sentries; it does not replace Crimewatch CONCORD response.",
      ],
    validValues: "true or false.",
  },
  {
    key: "ambientTrafficEnabled",
    defaultValue: false,
    envVar: "EVEJS_AMBIENT_TRAFFIC_ENABLED",
    envType: "boolean",
    description: [
      "Enables scheduled civilian convoy traffic with virtual inter-system transit and player-proximity materialization.",
      "The first implementation is a configurable Caldari logistics route intended for the Jita-to-Tama pilot corridor.",
    ],
    validValues: "true or false.",
  },
  {
    key: "ambientTrafficRouteSystemIDs",
    defaultValue: "30000142,30000143,30001379,30001376,30002813",
    envVar: "EVEJS_AMBIENT_TRAFFIC_ROUTE_SYSTEM_IDS",
    envType: "string",
    description:
      "Ordered, adjacent solar-system IDs followed by the ambient convoy. The route reverses when it reaches either endpoint.",
    validValues: "Two or more comma-separated, directly connected solar-system IDs.",
  },
  {
    key: "ambientTrafficOriginStationID",
    defaultValue: 60003760,
    envVar: "EVEJS_AMBIENT_TRAFFIC_ORIGIN_STATION_ID",
    envType: "number",
    minValue: 1,
    description:
      "Station used as the first endpoint of the ambient traffic route; defaults to Jita IV - Moon 4 - Caldari Navy Assembly Plant.",
    validValues: "Positive station ID in the first configured route system.",
  },
  {
    key: "ambientTrafficDestinationStationID",
    defaultValue: 60005203,
    envVar: "EVEJS_AMBIENT_TRAFFIC_DESTINATION_STATION_ID",
    envType: "number",
    minValue: 1,
    description:
      "Station used as the far endpoint of the ambient traffic route; defaults to the Republic Security Services station in Tama.",
    validValues: "Positive station ID in the final configured route system.",
  },
  {
    key: "ambientTrafficConvoyCount",
    defaultValue: 1,
    envVar: "EVEJS_AMBIENT_TRAFFIC_CONVOY_COUNT",
    envType: "number",
    minValue: 1,
    maxValue: 8,
    description:
      "Number of staggered virtual convoys assigned to the configured route.",
    validValues: "Integer from 1 through 8.",
  },
  {
    key: "ambientTrafficInitialDepartureDelaySeconds",
    defaultValue: 30,
    envVar: "EVEJS_AMBIENT_TRAFFIC_INITIAL_DEPARTURE_DELAY_SECONDS",
    envType: "number",
    minValue: 1,
    description:
      "Delay after server startup before a newly initialized convoy first departs its origin station.",
    validValues: "Positive number of seconds.",
  },
  {
    key: "ambientTrafficDockedDwellSeconds",
    defaultValue: 180,
    envVar: "EVEJS_AMBIENT_TRAFFIC_DOCKED_DWELL_SECONDS",
    envType: "number",
    minValue: 5,
    description:
      "Time a convoy remains virtually docked before beginning the return or outbound trip.",
    validValues: "Number of seconds greater than or equal to 5.",
  },
  {
    key: "ambientTrafficPoweredUndockMinimumSeconds",
    defaultValue: 15,
    envVar: "EVEJS_AMBIENT_TRAFFIC_POWERED_UNDOCK_MINIMUM_SECONDS",
    envType: "number",
    minValue: 1,
    description:
      "Minimum time a materialized convoy flies under normal subwarp engine power along the station undock vector before it may align to warp.",
    validValues: "Positive number of seconds.",
  },
  {
    key: "ambientTrafficPoweredUndockClearanceMeters",
    defaultValue: 5000,
    envVar: "EVEJS_AMBIENT_TRAFFIC_POWERED_UNDOCK_CLEARANCE_METERS",
    envType: "number",
    minValue: 1000,
    description:
      "Distance the lead hauler must travel from its authored player-undock point before the convoy begins aligning to warp.",
    validValues: "Distance in metres greater than or equal to 1000.",
  },
  {
    key: "ambientTrafficPoweredUndockMaximumSeconds",
    defaultValue: 45,
    envVar: "EVEJS_AMBIENT_TRAFFIC_POWERED_UNDOCK_MAXIMUM_SECONDS",
    envType: "number",
    minValue: 5,
    description:
      "Base powered-undock timeout. The runtime automatically raises it when a hull's speed and align time require a larger safe turning envelope; an obstructed ship virtualizes instead of being forced to turn through a station.",
    validValues: "Number of seconds greater than or equal to 5.",
  },
  {
    key: "ambientTrafficVirtualTransitSeconds",
    defaultValue: 15,
    envVar: "EVEJS_AMBIENT_TRAFFIC_VIRTUAL_TRANSIT_SECONDS",
    envType: "number",
    minValue: 1,
    description:
      "Virtual travel time assigned to each stargate jump while the convoy has no physical ships in a scene.",
    validValues: "Positive number of seconds.",
  },
  {
    key: "ambientTrafficVirtualSystemDwellSeconds",
    defaultValue: 20,
    envVar: "EVEJS_AMBIENT_TRAFFIC_VIRTUAL_SYSTEM_DWELL_SECONDS",
    envType: "number",
    minValue: 1,
    description:
      "Virtual time spent crossing an intermediate system when no player is present to observe the convoy.",
    validValues: "Positive number of seconds.",
  },
  {
    key: "livingUniverseEnabled",
    defaultValue: false,
    envVar: "EVEJS_LIVING_UNIVERSE_ENABLED",
    envType: "boolean",
    description: [
      "Enables the persistent distributed NPC population around Jita and the Tama corridor.",
      "Actors advance through routes while off-grid and materialize as fully fitted native ships only in player-occupied scenes.",
    ],
    validValues: "true or false.",
  },
  {
    key: "industrialHirelingsEnabled",
    defaultValue: false,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_ENABLED",
    envType: "boolean",
    description: [
      "Master switch for player-owned industrial hireling contracts inside the Living Universe. livingUniverseEnabled must also be on.",
      "When disabled, no hireling state is initialized, no contracts are advanced, and no hireling ships are materialized. Existing contracts remain preserved for a later re-enable.",
    ],
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsEnabled",
    defaultValue: false,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_ENABLED",
    envType: "boolean",
    description: [
      "Enables package-based mining crew contracts with one persistent multi-hull roster.",
      "The Living Universe and industrialHirelingsEnabled switches must also be enabled.",
    ],
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsLegacyHiringEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_LEGACY_HIRING_ENABLED",
    envType: "boolean",
    description:
      "Keeps the old individual miner and hauler purchase commands available while package-based mining crews are being introduced.",
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsCargoCycleEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_CARGO_CYCLE_ENABLED",
    envType: "boolean",
    description:
      "Enables finite miner holds, full-only jetcans, and the crew's on-grid hauler collection and delivery cycle.",
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsThreatDefenseEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_THREAT_DEFENSE_ENABLED",
    envType: "boolean",
    description:
      "Enables governed defensive-drone threat assessment and coordinated crew retreat behavior.",
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsVirtualProductionEnabled",
    defaultValue: false,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_VIRTUAL_PRODUCTION_ENABLED",
    envType: "boolean",
    description:
      "Enables unobserved aggregate mining production after durable belt-depletion accounting is installed.",
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsEconomyEnabled",
    defaultValue: false,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_ECONOMY_ENABLED",
    envType: "boolean",
    description:
      "Enforces mobilization fees, refundable loss escrow, payroll, renewals, and upgrades for mining crews.",
    validValues: "true or false.",
  },
  {
    key: "industrialMiningCrewsMaxPhysicalShipsPerSystem",
    defaultValue: 40,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_MAX_PHYSICAL_SHIPS_PER_SYSTEM",
    envType: "number",
    minValue: 4,
    maxValue: 64,
    description:
      "Industrial-crew physical hull ceiling per observed system, preserving Living Universe capacity for other actors.",
    validValues: "Integer from 4 through 64.",
  },
  {
    key: "industrialMiningCrewsMaxDefensiveDrones",
    defaultValue: 20,
    envVar: "EVEJS_INDUSTRIAL_MINING_CREWS_MAX_DEFENSIVE_DRONES",
    envType: "number",
    minValue: 0,
    maxValue: 50,
    description:
      "Maximum physical defensive drones that one mining crew may have deployed at once.",
    validValues: "Integer from 0 through 50.",
  },
  {
    key: "industrialHirelingsMiningEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_MINING_ENABLED",
    envType: "boolean",
    description:
      "Enables miner contracts and Support Mining Operation orders while the industrial-hireling master switch is on.",
    validValues: "true or false.",
  },
  {
    key: "industrialHirelingsHaulingEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_HAULING_ENABLED",
    envType: "boolean",
    description:
      "Enables hauler contracts and Haul This Operation orders while the industrial-hireling master switch is on.",
    validValues: "true or false.",
  },
  {
    key: "industrialHirelingsRemoteSitesEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_REMOTE_SITES_ENABLED",
    envType: "boolean",
    description: [
      "Enables site-centric industrial operations, including remote belt discovery and crew assignment.",
      "Disable this switch to retain the legacy employer-ship-centered mining order while preserving all saved site assignments.",
    ],
    validValues: "true or false.",
  },
  {
    key: "industrialHirelingsOperationBookmarksEnabled",
    defaultValue: true,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_OPERATION_BOOKMARKS_ENABLED",
    envType: "boolean",
    description:
      "Maintains native personal bookmarks for assigned industrial operation sites while remote-site operations are enabled.",
    validValues: "true or false.",
  },
  {
    key: "industrialHirelingsMaxActivePerCharacter",
    defaultValue: 2,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_MAX_ACTIVE_PER_CHARACTER",
    envType: "number",
    minValue: 1,
    maxValue: 8,
    description:
      "Maximum simultaneous active or paused industrial hireling contracts owned by one character.",
    validValues: "Integer from 1 through 8.",
  },
  {
    key: "industrialHirelingsDefaultContractHours",
    defaultValue: 24,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_DEFAULT_CONTRACT_HOURS",
    envType: "number",
    minValue: 1,
    maxValue: 720,
    description:
      "Real-time duration of a newly created industrial hireling contract before renewal is required.",
    validValues: "Integer hours from 1 through 720.",
  },
  {
    key: "industrialHirelingsSchedulerIntervalMs",
    defaultValue: 5000,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_SCHEDULER_INTERVAL_MS",
    envType: "number",
    minValue: 1000,
    maxValue: 60000,
    description:
      "Wall-clock interval for bounded hireling cargo delivery and restart recovery. This scheduler does not run in the 100 ms space tick.",
    validValues: "Integer milliseconds from 1000 through 60000.",
  },
  {
    key: "industrialHirelingsNavigationLegSeconds",
    defaultValue: 30,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_NAVIGATION_LEG_SECONDS",
    envType: "number",
    minValue: 5,
    maxValue: 3600,
    description:
      "Wall-clock travel time for each persisted stargate leg followed by an owned industrial crew. Route progress is recovered from deadlines after restart.",
    validValues: "Integer seconds from 5 through 3600.",
  },
  {
    key: "industrialHirelingsMaxJobsPerPass",
    defaultValue: 4,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_MAX_JOBS_PER_PASS",
    envType: "number",
    minValue: 1,
    maxValue: 32,
    description:
      "Maximum cargo manifests or due crew-navigation records processed per hireling scheduler pass, bounding background database work.",
    validValues: "Integer from 1 through 32.",
  },
  {
    key: "industrialHirelingsHaulerTransitSeconds",
    defaultValue: 30,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_HAULER_TRANSIT_SECONDS",
    envType: "number",
    minValue: 5,
    maxValue: 3600,
    description:
      "Minimum wall-clock travel time between a visible jetcan pickup and delivery to the configured station hangar.",
    validValues: "Integer seconds from 5 through 3600.",
  },
  {
    key: "industrialHirelingsHaulerMaxPickupDistanceMeters",
    defaultValue: 250000,
    envVar: "EVEJS_INDUSTRIAL_HIRELINGS_HAULER_MAX_PICKUP_DISTANCE_METERS",
    envType: "number",
    minValue: 2500,
    maxValue: 1000000,
    description:
      "Maximum distance from the employer ship at which the nearest employer-owned jetcan may be assigned to a hauler.",
    validValues: "Integer meters from 2500 through 1000000.",
  },
  {
    key: "liveEventsEnabled",
    defaultValue: false,
    envVar: "EVEJS_LIVE_EVENTS_ENABLED",
    envType: "boolean",
    description: [
      "Enables persistent server-side live events and their deadline-driven scheduler.",
      "Definitions remain individually disabled until their implementation and verification gates pass.",
    ],
    validValues: "true or false.",
  },
  {
    key: "liveEventsSchedulerIntervalMs",
    defaultValue: 5000,
    envVar: "EVEJS_LIVE_EVENTS_SCHEDULER_INTERVAL_MS",
    envType: "number",
    minValue: 250,
    description:
      "Wall-clock interval for the live-event deadline queue. This scheduler does not run in the 100 ms space tick.",
    validValues: "Integer milliseconds greater than or equal to 250.",
  },
  {
    key: "liveEventsSchedulerBudgetMs",
    defaultValue: 2,
    envVar: "EVEJS_LIVE_EVENTS_SCHEDULER_BUDGET_MS",
    envType: "number",
    minValue: 0.1,
    description:
      "Maximum monotonic work time consumed by one live-event scheduler wake before due work is deferred.",
    validValues: "Positive number of milliseconds greater than or equal to 0.1.",
  },
  {
    key: "liveEventsMaxJobsPerPass",
    defaultValue: 8,
    envVar: "EVEJS_LIVE_EVENTS_MAX_JOBS_PER_PASS",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description:
      "Maximum event work orders reconciled by one bounded scheduler wake.",
    validValues: "Integer from 1 through 100.",
  },
  {
    key: "liveEventsMaxActiveGlobal",
    defaultValue: 2,
    envVar: "EVEJS_LIVE_EVENTS_MAX_ACTIVE_GLOBAL",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description:
      "Maximum non-terminal live-event records active across the universe.",
    validValues: "Integer from 1 through 100.",
  },
  {
    key: "liveEventsMaxActivePerSystem",
    defaultValue: 1,
    envVar: "EVEJS_LIVE_EVENTS_MAX_ACTIVE_PER_SYSTEM",
    envType: "number",
    minValue: 1,
    maxValue: 10,
    description:
      "Maximum non-terminal live-event records assigned to one solar system.",
    validValues: "Integer from 1 through 10.",
  },
  {
    key: "xEveEnabled",
    defaultValue: false,
    envVar: "EVEJS_X_EVE_ENABLED",
    envType: "boolean",
    description: [
      "Enables the X-Eve economic kernel, balanced ledger, event inbox, and adaptive background scheduler.",
      "This first slice is disabled by default and does not yet settle native wallets, market orders, inventory, or contracts.",
    ],
    validValues: "true or false.",
  },
  {
    key: "xEveSchedulerIntervalMs",
    defaultValue: 1000,
    envVar: "EVEJS_X_EVE_SCHEDULER_INTERVAL_MS",
    envType: "number",
    minValue: 250,
    maxValue: 60000,
    description:
      "Wall-clock interval for X-Eve's independent single-flight scheduler; it never runs inside the 100 ms space tick.",
    validValues: "Integer milliseconds from 250 through 60000.",
  },
  {
    key: "xEveSchedulerBudgetMs",
    defaultValue: 2,
    envVar: "EVEJS_X_EVE_SCHEDULER_BUDGET_MS",
    envType: "number",
    minValue: 0.1,
    maxValue: 10,
    description:
      "Maximum healthy-load synchronous work slice for one X-Eve scheduler pass.",
    validValues: "Number of milliseconds from 0.1 through 10.",
  },
  {
    key: "xEveDurabilityIntervalMs",
    defaultValue: 2000,
    envVar: "EVEJS_X_EVE_DURABILITY_INTERVAL_MS",
    envType: "number",
    minValue: 500,
    maxValue: 60000,
    description:
      "Maximum wall-clock interval before X-Eve hands dirty state to the durable SQLite journal, even while writes remain continuous.",
    validValues: "Integer milliseconds from 500 through 60000.",
  },
  {
    key: "xEveMaxJobsPerPass",
    defaultValue: 32,
    envVar: "EVEJS_X_EVE_MAX_JOBS_PER_PASS",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description:
      "Maximum X-Eve continuations handled in one scheduler pass within the configured time budget; overdue work remains queued.",
    validValues: "Integer from 1 through 100.",
  },
  {
    key: "xEveMaxRetryAttempts",
    defaultValue: 8,
    envVar: "EVEJS_X_EVE_MAX_RETRY_ATTEMPTS",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description:
      "Maximum attempts for a deterministic X-Eve work failure before it is retained as a dead letter for inspection.",
    validValues: "Integer from 1 through 100.",
  },
  {
    key: "xEveTickSampleCount",
    defaultValue: 20,
    envVar: "EVEJS_X_EVE_TICK_SAMPLE_COUNT",
    envType: "number",
    minValue: 10,
    maxValue: 120,
    description:
      "Recent runtime-tick samples used by X-Eve's admission governor.",
    validValues: "Integer from 10 through 120.",
  },
  {
    key: "xEveTickWarningMs",
    defaultValue: 120,
    envVar: "EVEJS_X_EVE_TICK_WARNING_MS",
    envType: "number",
    minValue: 101,
    maxValue: 499,
    description:
      "Rolling p95 tick interval where X-Eve defers planning and maintenance work.",
    validValues: "Number of milliseconds from 101 through 499.",
  },
  {
    key: "xEveTickOverloadMs",
    defaultValue: 130,
    envVar: "EVEJS_X_EVE_TICK_OVERLOAD_MS",
    envType: "number",
    minValue: 102,
    maxValue: 499,
    description:
      "Rolling p95 tick interval where X-Eve admits only tiny settlement and deadline continuations.",
    validValues: "Number of milliseconds from 102 through 499 and not below the warning threshold.",
  },
  {
    key: "xEveEmergencyShedMs",
    defaultValue: 500,
    envVar: "EVEJS_X_EVE_EMERGENCY_SHED_MS",
    envType: "number",
    minValue: 130,
    maxValue: 599,
    description:
      "A single tick interval at this level immediately stops all X-Eve background work while preserving its queues.",
    validValues: "Number of milliseconds from 130 through 599.",
  },
  {
    key: "xEveUnplayableMs",
    defaultValue: 600,
    envVar: "EVEJS_X_EVE_UNPLAYABLE_MS",
    envType: "number",
    minValue: 500,
    maxValue: 600,
    description:
      "Telemetry boundary for an unplayable tick interval; X-Eve already hard-sheds before reaching it.",
    validValues: "Number of milliseconds from 500 through 600.",
  },
  {
    key: "xEveRecoveryThresholdMs",
    defaultValue: 115,
    envVar: "EVEJS_X_EVE_RECOVERY_THRESHOLD_MS",
    envType: "number",
    minValue: 100,
    maxValue: 119,
    description:
      "Tick p95 that must be regained before X-Eve begins its healthy recovery window.",
    validValues: "Number of milliseconds from 100 through 119.",
  },
  {
    key: "xEveRecoverySeconds",
    defaultValue: 5,
    envVar: "EVEJS_X_EVE_RECOVERY_SECONDS",
    envType: "number",
    minValue: 1,
    maxValue: 60,
    description:
      "Healthy time required before deferred X-Eve planning resumes, preventing latency-mode flapping.",
    validValues: "Number of seconds from 1 through 60.",
  },
  {
    key: "livingUniversePopulationSize",
    defaultValue: 400,
    envVar: "EVEJS_LIVING_UNIVERSE_POPULATION_SIZE",
    envType: "number",
    minValue: 1,
    maxValue: 5000,
    description:
      "Persistent actor count. The initial Jita-area production test is calibrated for 400 actors; higher values remain virtual until observed.",
    validValues: "Integer from 1 through 5000.",
  },
  {
    key: "livingUniverseMaxMaterializedPerSystem",
    defaultValue: 48,
    envVar: "EVEJS_LIVING_UNIVERSE_MAX_MATERIALIZED_PER_SYSTEM",
    envType: "number",
    minValue: 1,
    maxValue: 500,
    description:
      "Shared maximum for materialized NPC ships in one player-occupied solar system. Living-universe traffic and live events reserve from this pool.",
    validValues: "Integer from 1 through 500.",
  },
  {
    key: "livingUniverseMaxMaterializedGlobal",
    defaultValue: 120,
    envVar: "EVEJS_LIVING_UNIVERSE_MAX_MATERIALIZED_GLOBAL",
    envType: "number",
    minValue: 1,
    maxValue: 2000,
    description:
      "Shared global physical-NPC budget. Living-universe actors and live-event actors above the cap continue advancing virtually.",
    validValues: "Integer from 1 through 2000.",
  },
  {
    key: "livingUniverseMaterializationsPerTick",
    defaultValue: 2,
    envVar: "EVEJS_LIVING_UNIVERSE_MATERIALIZATIONS_PER_TICK",
    envType: "number",
    minValue: 1,
    maxValue: 20,
    description:
      "Maximum flight groups materialized per one-second scheduler tick, preventing scene-entry spawn spikes.",
    validValues: "Integer from 1 through 20.",
  },
  {
    key: "livingUniverseSchedulerBudgetMs",
    defaultValue: 8,
    envVar: "EVEJS_LIVING_UNIVERSE_SCHEDULER_BUDGET_MS",
    envType: "number",
    minValue: 1,
    maxValue: 50,
    description:
      "Soft per-second work budget for due virtual living-universe flights. Player-observed flights are always processed first and are not skipped by this budget.",
    validValues: "Number of milliseconds from 1 through 50.",
  },
  {
    key: "livingUniverseReplacementSchedulerSharePercent",
    defaultValue: 75,
    envVar: "EVEJS_LIVING_UNIVERSE_REPLACEMENT_SCHEDULER_SHARE_PERCENT",
    envType: "number",
    minValue: 1,
    maxValue: 99,
    description:
      "Share of contested empty-system flight transitions reserved for haulers carrying active replacement-priority freight. Unused capacity remains available to ordinary flights.",
    validValues: "Integer percentage from 1 through 99.",
  },
  {
    key: "livingUniverseMaxDueFlightsPerTick",
    defaultValue: 64,
    envVar: "EVEJS_LIVING_UNIVERSE_MAX_DUE_FLIGHTS_PER_TICK",
    envType: "number",
    minValue: 1,
    maxValue: 1000,
    description:
      "Maximum empty-system flight transitions processed in one scheduler pass; overdue work remains queued for the next pass.",
    validValues: "Integer from 1 through 1000.",
  },
  {
    key: "livingUniversePilotSyncBatchSize",
    defaultValue: 128,
    envVar: "EVEJS_LIVING_UNIVERSE_PILOT_SYNC_BATCH_SIZE",
    envType: "number",
    minValue: 16,
    maxValue: 1000,
    description:
      "Maximum changed synthetic pilot records synchronized into Local during one scheduler pass. Materialized pilots are prioritized and excess records remain queued.",
    validValues: "Integer from 16 through 1000.",
  },
  {
    key: "livingUniverseDockedDwellSeconds",
    defaultValue: 180,
    envVar: "EVEJS_LIVING_UNIVERSE_DOCKED_DWELL_SECONDS",
    envType: "number",
    minValue: 5,
    description: "Virtual station turnaround time between living-universe trips.",
    validValues: "Number of seconds greater than or equal to 5.",
  },
  {
    key: "livingUniverseDutyDwellSeconds",
    defaultValue: 300,
    envVar: "EVEJS_LIVING_UNIVERSE_DUTY_DWELL_SECONDS",
    envType: "number",
    minValue: 15,
    description:
      "Time miners remain on belt duty before returning to their assigned station.",
    validValues: "Number of seconds greater than or equal to 15.",
  },
  {
    key: "livingUniverseVirtualTransitSeconds",
    defaultValue: 18,
    envVar: "EVEJS_LIVING_UNIVERSE_VIRTUAL_TRANSIT_SECONDS",
    envType: "number",
    minValue: 1,
    description:
      "Gate-session time between a living-universe flight leaving one system and arriving in the next; in-system undock, align, warp, and approach time is calculated separately from ship and route data.",
    validValues: "Positive number of seconds.",
  },
  {
    key: "livingUniverseOffGridTravelTimeMultiplier",
    defaultValue: 1,
    envVar: "EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description: [
      "Development accelerator for virtual travel in solar systems with no connected player scene.",
      "1 keeps modeled travel time; 10 advances empty-system legs ten times faster. Materialized and player-observed movement always remains at native ship physics.",
    ],
    validValues: "Number from 1 through 100.",
  },
  {
    key: "livingUniverseOffGridActivityTimeMultiplier",
    defaultValue: 1,
    envVar: "EVEJS_LIVING_UNIVERSE_OFFGRID_ACTIVITY_TIME_MULTIPLIER",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description: [
      "Development and stress-test accelerator for virtual station dwell, mining duty, replacement delays, and off-grid conflict cadence.",
      "1 keeps real modeled durations. Player movement, combat physics, the game tick, persistence, and X-Eve durability clocks are never accelerated.",
    ],
    validValues: "Number from 1 through 100.",
  },
  {
    key: "livingUniverseVirtualSystemDwellSeconds",
    defaultValue: 25,
    envVar: "EVEJS_LIVING_UNIVERSE_VIRTUAL_SYSTEM_DWELL_SECONDS",
    envType: "number",
    minValue: 1,
    description:
      "Fallback off-grid crossing time used only when living-universe ship statistics or route geometry are unavailable.",
    validValues: "Positive number of seconds.",
  },
  {
    key: "livingUniverseReplacementDelaySeconds",
    defaultValue: 300,
    envVar: "EVEJS_LIVING_UNIVERSE_REPLACEMENT_DELAY_SECONDS",
    envType: "number",
    minValue: 10,
    description:
      "Delay before a destroyed persistent flight receives replacement hulls at its origin station.",
    validValues: "Number of seconds greater than or equal to 10.",
  },
  {
    key: "livingConflictEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_CONFLICT_ENABLED",
    envType: "boolean",
    description:
      "Lets persistent living-universe pirate, civilian and police flights meet in witnessed or off-grid encounters that create real ship losses and replacement demand.",
    validValues: "true or false.",
  },
  {
    key: "livingConflictCampaignsEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_CONFLICT_CAMPAIGNS_ENABLED",
    envType: "boolean",
    description:
      "Distributes combat flights across named regional fronts and attributes encounters, losses and supply demand to those campaigns.",
    validValues: "true or false.",
  },
  {
    key: "livingConflictRoamingEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_CONFLICT_ROAMING_ENABLED",
    envType: "boolean",
    description:
      "Schedules persistent, independently jittered roaming groups and temporary gate camps whose route overlaps create emergent encounters.",
    validValues: "true or false.",
  },
  {
    key: "livingConflictRoamingGroupLimit",
    defaultValue: 96,
    envVar: "EVEJS_LIVING_CONFLICT_ROAMING_GROUP_LIMIT",
    envType: "number",
    minValue: 2,
    maxValue: 512,
    description:
      "Maximum persistent task groups assigned to the deadline-driven roaming layer.",
    validValues: "Integer from 2 through 512.",
  },
  {
    key: "livingConflictRoamingWorkBudgetMs",
    defaultValue: 1.5,
    envVar: "EVEJS_LIVING_CONFLICT_ROAMING_WORK_BUDGET_MS",
    envType: "number",
    minValue: 0.25,
    maxValue: 10,
    description:
      "Soft per-second CPU budget for due roaming transitions and route-intersection discovery.",
    validValues: "Number of milliseconds from 0.25 through 10.",
  },
  {
    key: "livingConflictRoamingMaxTransitionsPerTick",
    defaultValue: 16,
    envVar: "EVEJS_LIVING_CONFLICT_ROAMING_MAX_TRANSITIONS_PER_TICK",
    envType: "number",
    minValue: 1,
    maxValue: 128,
    description:
      "Maximum due roaming or gate-camp state transitions processed in one Living Universe pass.",
    validValues: "Integer from 1 through 128.",
  },
  {
    key: "livingConflictRoamingMaxPresenceChecksPerTick",
    defaultValue: 192,
    envVar: "EVEJS_LIVING_CONFLICT_ROAMING_MAX_PRESENCE_CHECKS_PER_TICK",
    envType: "number",
    minValue: 8,
    maxValue: 4096,
    description:
      "Maximum indexed hostile-presence comparisons made by the roaming layer in one pass.",
    validValues: "Integer from 8 through 4096.",
  },
  {
    key: "livingConflictGateCampLimit",
    defaultValue: 6,
    envVar: "EVEJS_LIVING_CONFLICT_GATE_CAMP_LIMIT",
    envType: "number",
    minValue: 1,
    maxValue: 32,
    description:
      "Maximum simultaneous temporary NPC gate camps across the modeled universe.",
    validValues: "Integer from 1 through 32.",
  },
  {
    key: "livingConflictEncounterIntervalSeconds",
    defaultValue: 1200,
    envVar: "EVEJS_LIVING_CONFLICT_ENCOUNTER_INTERVAL_SECONDS",
    envType: "number",
    minValue: 60,
    description:
      "Average wall-clock interval between living-universe encounters. The campaign default produces roughly three opportunities per hour while preserving real travel and combat windows.",
    validValues: "Number of seconds greater than or equal to 60.",
  },
  {
    key: "livingConflictEncounterDurationSeconds",
    defaultValue: 600,
    envVar: "EVEJS_LIVING_CONFLICT_ENCOUNTER_DURATION_SECONDS",
    envType: "number",
    minValue: 60,
    description:
      "Maximum real-time combat window before an unresolved encounter disengages or receives a deterministic off-grid outcome.",
    validValues: "Number of seconds greater than or equal to 60.",
  },
  {
    key: "livingConflictInitialDelaySeconds",
    defaultValue: 90,
    envVar: "EVEJS_LIVING_CONFLICT_INITIAL_DELAY_SECONDS",
    envType: "number",
    minValue: 10,
    description: "Delay after startup or reset before the first living-universe encounter is scheduled.",
    validValues: "Number of seconds greater than or equal to 10.",
  },
  {
    key: "livingConflictMaxActiveEncounters",
    defaultValue: 4,
    envVar: "EVEJS_LIVING_CONFLICT_MAX_ACTIVE_ENCOUNTERS",
    envType: "number",
    minValue: 1,
    maxValue: 10,
    description: "Maximum concurrent staging or active living-universe encounters.",
    validValues: "Integer from 1 through 10.",
  },
  {
    key: "livingEconomyEnabled",
    defaultValue: false,
    envVar: "EVEJS_LIVING_ECONOMY_ENABLED",
    envType: "boolean",
    description: [
      "Connects living-universe freight flights to a conserved Jita-region station economy.",
      "Haulers reserve real seed stock at the source and only add it to the destination after completing the route.",
    ],
    validValues: "true or false.",
  },
  {
    key: "livingEconomyPulseSeconds",
    defaultValue: 15,
    envVar: "EVEJS_LIVING_ECONOMY_PULSE_SECONDS",
    envType: "number",
    minValue: 5,
    description:
      "Seconds between market-demand scans, completed-delivery processing, production checks, and freight-job creation.",
    validValues: "Number of seconds greater than or equal to 5.",
  },
  {
    key: "livingEconomyWorkBudgetMs",
    defaultValue: 4,
    envVar: "EVEJS_LIVING_ECONOMY_WORK_BUDGET_MS",
    envType: "number",
    minValue: 0.5,
    maxValue: 25,
    description:
      "Maximum synchronous JavaScript work slice before a living-economy pulse yields to the server tick.",
    validValues: "Number of milliseconds from 0.5 through 25.",
  },
  {
    key: "livingEconomyStockBootstrapBatchSize",
    defaultValue: 1000,
    envVar: "EVEJS_LIVING_ECONOMY_STOCK_BOOTSTRAP_BATCH_SIZE",
    envType: "number",
    minValue: 100,
    maxValue: 4000,
    description:
      "Seed-stock rows loaded per cooperative batch while the regional economy cache starts.",
    validValues: "Integer from 100 through 4000.",
  },
  {
    key: "livingEconomyStockReconcileBatchSize",
    defaultValue: 320,
    envVar: "EVEJS_LIVING_ECONOMY_STOCK_RECONCILE_BATCH_SIZE",
    envType: "number",
    minValue: 50,
    maxValue: 4000,
    description:
      "Minimum seed-stock rows reconciled from one region during each living-economy pulse.",
    validValues: "Integer from 50 through 4000.",
  },
  {
    key: "livingEconomyFullStockReconcileSeconds",
    defaultValue: 14400,
    envVar: "EVEJS_LIVING_ECONOMY_FULL_STOCK_RECONCILE_SECONDS",
    envType: "number",
    minValue: 900,
    description:
      "Target time for the rolling regional cache to recheck every market stock row.",
    validValues: "Number of seconds greater than or equal to 900.",
  },
  {
    key: "livingEconomyRoutePlanningSeconds",
    defaultValue: 300,
    envVar: "EVEJS_LIVING_ECONOMY_ROUTE_PLANNING_SECONDS",
    envType: "number",
    minValue: 30,
    description:
      "Minimum interval between cooperative universe-wide freight-opportunity rebuilds.",
    validValues: "Number of seconds greater than or equal to 30.",
  },
  {
    key: "livingEconomyTelemetryIntervalSeconds",
    defaultValue: 600,
    envVar: "EVEJS_LIVING_ECONOMY_TELEMETRY_INTERVAL_SECONDS",
    envType: "number",
    minValue: 60,
    description:
      "Interval between persistent living-economy financial and stock timeline snapshots.",
    validValues: "Number of seconds greater than or equal to 60.",
  },
  {
    key: "livingEconomyTelemetryRetentionSnapshots",
    defaultValue: 1008,
    envVar: "EVEJS_LIVING_ECONOMY_TELEMETRY_RETENTION_SNAPSHOTS",
    envType: "number",
    minValue: 6,
    maxValue: 10080,
    description:
      "Number of persistent living-economy telemetry snapshots to retain.",
    validValues: "Integer from 6 through 10080.",
  },
  {
    key: "livingEconomyProductionIntervalSeconds",
    defaultValue: 120,
    envVar: "EVEJS_LIVING_ECONOMY_PRODUCTION_INTERVAL_SECONDS",
    envType: "number",
    minValue: 30,
    description:
      "Minimum interval between NPC industry-job installations for one station and product.",
    validValues: "Number of seconds greater than or equal to 30.",
  },
  {
    key: "livingEconomyMaxActiveIndustryJobs",
    defaultValue: 320,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_ACTIVE_INDUSTRY_JOBS",
    envType: "number",
    minValue: 1,
    maxValue: 1000,
    description:
      "Maximum persistent NPC manufacturing, blueprint research, and copying jobs reserving inputs or awaiting completion across the universe economy.",
    validValues: "Integer from 1 through 1000.",
  },
  {
    key: "livingEconomyIndustryMaximumJobSeconds",
    defaultValue: 7200,
    envVar: "EVEJS_LIVING_ECONOMY_INDUSTRY_MAXIMUM_JOB_SECONDS",
    envType: "number",
    minValue: 300,
    description:
      "Target maximum blueprint duration per NPC manufacturing batch; a single long blueprint run may exceed it.",
    validValues: "Number of seconds greater than or equal to 300.",
  },
  {
    key: "livingEconomyIndustryTimeScale",
    defaultValue: 1,
    envVar: "EVEJS_LIVING_ECONOMY_INDUSTRY_TIME_SCALE",
    envType: "number",
    minValue: 0.01,
    maxValue: 100,
    description:
      "Multiplier applied to official blueprint manufacturing times for NPC industry; 1 uses real blueprint time.",
    validValues: "Number from 0.01 through 100.",
  },
  {
    key: "livingEconomyMaxActiveJobs",
    defaultValue: 320,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_ACTIVE_JOBS",
    envType: "number",
    minValue: 1,
    maxValue: 1000,
    description:
      "Maximum reserved or in-transit NPC freight jobs across the universe economy.",
    validValues: "Integer from 1 through 1000.",
  },
  {
    key: "livingEconomyMaxJobsPerPulse",
    defaultValue: 24,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_JOBS_PER_PULSE",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description:
      "Maximum new freight reservations created during one living-economy market pulse.",
    validValues: "Integer from 1 through 100.",
  },
  {
    key: "livingEconomyReplacementFreightSharePercent",
    defaultValue: 75,
    envVar: "EVEJS_LIVING_ECONOMY_REPLACEMENT_FREIGHT_SHARE_PERCENT",
    envType: "number",
    minValue: 0,
    maxValue: 100,
    description:
      "Share of active and per-pulse NPC freight capacity reserved for replacement hulls, fittings, ammunition, and their production inputs while replacement demand is waiting.",
    validValues: "Number from 0 through 100.",
  },
  {
    key: "livingEconomyMaxParallelHullLines",
    defaultValue: 3,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_PARALLEL_HULL_LINES",
    envType: "number",
    minValue: 1,
    maxValue: 8,
    description:
      "Maximum concurrent demand-driven manufacturing jobs per ship hull type at a producer station. Each job still builds exactly one hull so replacements release incrementally; 1 preserves the legacy one-hull-at-a-time serialization.",
    validValues: "Integer from 1 through 8.",
  },
  {
    key: "livingEconomyFactionShipyardEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_ECONOMY_FACTION_SHIPYARD_ENABLED",
    envType: "boolean",
    description:
      "Pirate faction hulls are supplied by the owning faction's own shipyard stations (demand-driven seeded stock) instead of consuming empire minerals through faction-assembly recipes. Disable to restore the legacy mineral-consuming assembly path.",
    validValues: "true or false.",
  },
  {
    key: "livingEconomyFactionShipyardHullsPerPulse",
    defaultValue: 12,
    envVar: "EVEJS_LIVING_ECONOMY_FACTION_SHIPYARD_HULLS_PER_PULSE",
    envType: "number",
    minValue: 1,
    maxValue: 48,
    description:
      "Maximum pirate faction hulls seeded into faction shipyard stock per living-economy pulse while replacement demand for those hulls is unmet.",
    validValues: "Integer from 1 through 48.",
  },
  {
    key: "livingEconomyMobilizationEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION",
    envType: "boolean",
    description:
      [
        "War-economy mobilization (slice W1): the living economy reads replacement-backlog",
        "pressure (backlog size, oldest-pending age, demand creation vs fulfillment rate) and",
        "scales its own throughput caps between the configured peacetime values and a surge",
        "posture — freight capacity and hauler repositioning first, then industry pacing and a",
        "demand-driven-only production time scale, with pirate shipyard/smuggler and refinery",
        "sympathy. Conflict pacing is never touched, and everything stands back down as the",
        "backlog drains. Disable to freeze every cap at its configured base value.",
      ],
    validValues: "true or false.",
  },
  {
    key: "livingEconomyMobilizationTargetBacklogPackages",
    defaultValue: 30,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION_TARGET_BACKLOG",
    envType: "number",
    minValue: 5,
    maxValue: 500,
    description:
      "Pending replacement packages the economy considers a healthy buffer. Backlog pressure is zero at or below this and ramps toward livingEconomyMobilizationFullBacklogPackages.",
    validValues: "Number from 5 through 500.",
  },
  {
    key: "livingEconomyMobilizationFullBacklogPackages",
    defaultValue: 120,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION_FULL_BACKLOG",
    envType: "number",
    minValue: 10,
    maxValue: 2000,
    description:
      "Pending replacement packages at which backlog pressure alone drives full mobilization. Values at or below the target backlog are lifted to target+5 at runtime.",
    validValues: "Number from 10 through 2000.",
  },
  {
    key: "livingEconomyMobilizationSlewPerMinute",
    defaultValue: 0.1,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION_SLEW_PER_MINUTE",
    envType: "number",
    minValue: 0.01,
    maxValue: 1,
    description:
      "How fast the mobilization level may RISE per minute of sustained pressure (0.1 = full mobilization after ~10 minutes). The asymmetry against the stand-down slew provides hysteresis.",
    validValues: "Number from 0.01 through 1.",
  },
  {
    key: "livingEconomyMobilizationStandDownSlewPerMinute",
    defaultValue: 0.033,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION_STAND_DOWN_SLEW_PER_MINUTE",
    envType: "number",
    minValue: 0.005,
    maxValue: 1,
    description:
      "How fast the mobilization level may FALL per minute once pressure clears (0.033 = ~30-minute stand-down). Slower than the ramp-up so the economy does not flap around the threshold.",
    validValues: "Number from 0.005 through 1.",
  },
  {
    key: "livingEconomyMobilizationMaxLevel",
    defaultValue: 1,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION_MAX_LEVEL",
    envType: "number",
    minValue: 0,
    maxValue: 1,
    description:
      "Operator amplitude throttle for mobilization: 1 permits the full surge posture, 0.5 permits half of every surge delta, 0 pins the economy at peacetime caps without disabling the controller's telemetry.",
    validValues: "Number from 0 through 1.",
  },
  {
    key: "livingEconomyMobilizationWarTimeScaleFactor",
    defaultValue: 0.1,
    envVar: "EVEJS_LIVING_ECONOMY_MOBILIZATION_WAR_TIME_SCALE",
    envType: "number",
    minValue: 0.02,
    maxValue: 1,
    description:
      [
        "Duration multiplier applied at FULL mobilization to demand-driven industry jobs only",
        "(replacement/campaign production and its blueprint science) on top of",
        "livingEconomyIndustryTimeScale. Normal stock-driven production keeps peacetime pacing,",
        "so surging war production cannot flood civilian markets. 0.1 turns a 2.8-day",
        "foundation battleship build into ~7 hours at full mobilization; 1 disables the effect.",
      ],
    validValues: "Number from 0.02 through 1.",
  },
  {
    key: "livingEconomyNpcRefineryEfficiencyPercent",
    defaultValue: 72,
    envVar: "EVEJS_LIVING_ECONOMY_NPC_REFINERY_EFFICIENCY_PERCENT",
    envType: "number",
    minValue: 30,
    maxValue: 90,
    description:
      "Mineral yield percentage when NPC stations refine ore delivered by NPC mining flights. Raises or lowers the whole mineral inflow of the living economy.",
    validValues: "Number from 30 through 90.",
  },
  {
    key: "livingEconomyProcurementWarPremiumMaxPercent",
    defaultValue: 150,
    envVar: "EVEJS_LIVING_ECONOMY_PROCUREMENT_WAR_PREMIUM_MAX_PERCENT",
    envType: "number",
    minValue: 100,
    maxValue: 300,
    description:
      "Price ceiling, as a percent of the good's anchor price, that NPC corporations may bid when buying production inputs for replacement-priority demand. The premium ramps with how long the demand has waited; 100 disables the premium.",
    validValues: "Number from 100 through 300.",
  },
  {
    key: "livingEconomyFactionSmugglerDeliveryMinutes",
    defaultValue: 30,
    envVar: "EVEJS_LIVING_ECONOMY_FACTION_SMUGGLER_DELIVERY_MINUTES",
    envType: "number",
    minValue: 5,
    maxValue: 1440,
    description:
      "Age in wall-clock minutes after which a pending pirate-hull replacement demand is served by an off-screen smuggler delivery directly at its home station, covering routes ordinary freight cannot serve (lowsec/nullsec legs admit only secure convoys).",
    validValues: "Integer from 5 through 1440.",
  },
  {
    key: "livingEconomyMaxActiveRepositions",
    defaultValue: 16,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_ACTIVE_REPOSITIONS",
    envType: "number",
    minValue: 0,
    maxValue: 500,
    description:
      "Maximum empty NPC haulers simultaneously repositioning toward stations with useful freight stock; zero disables repositioning.",
    validValues: "Integer from 0 through 500.",
  },
  {
    key: "livingEconomyMaxRepositionsPerPulse",
    defaultValue: 2,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_REPOSITIONS_PER_PULSE",
    envType: "number",
    minValue: 0,
    maxValue: 50,
    description:
      "Maximum docked empty NPC haulers dispatched toward useful freight sources during one living-economy pulse.",
    validValues: "Integer from 0 through 50.",
  },
  {
    key: "livingEconomyMaxProductionRunsPerPulse",
    defaultValue: 24,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_PRODUCTION_RUNS_PER_PULSE",
    envType: "number",
    minValue: 1,
    maxValue: 100,
    description:
      "Maximum new persistent NPC manufacturing, blueprint research, or copying jobs installed during one living-economy pulse.",
    validValues: "Integer from 1 through 100.",
  },
  {
    key: "livingEconomyMaxRepricesPerPulse",
    defaultValue: 8,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_REPRICES_PER_PULSE",
    envType: "number",
    minValue: 0,
    maxValue: 100,
    description:
      "Maximum stock-sensitive basic-good price updates during one living-economy pulse; zero disables repricing.",
    validValues: "Integer from 0 through 100.",
  },
  {
    key: "livingEconomyRegionalRoutingEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_ECONOMY_REGIONAL_ROUTING_ENABLED",
    envType: "boolean",
    description:
      "Lets docked NPC haulers choose cached, demand-scored routes between representative stations across New Eden instead of remaining on authored fixed routes.",
    validValues: "true or false.",
  },
  {
    key: "livingEconomyProcurementEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_ECONOMY_PROCUREMENT_ENABLED",
    envType: "boolean",
    description:
      "Publishes funded, player-visible NPC corporation buy orders for common ores, ordinary salvage and scrap.",
    validValues: "true or false.",
  },
  {
    key: "livingEconomyProcurementReviewSeconds",
    defaultValue: 600,
    envVar: "EVEJS_LIVING_ECONOMY_PROCUREMENT_REVIEW_SECONDS",
    envType: "number",
    minValue: 60,
    description:
      "Seconds between bounded NPC corporation buy-order reviews and repricing passes.",
    validValues: "Number of seconds greater than or equal to 60.",
  },
  {
    key: "livingEconomyMaxProcurementOrders",
    defaultValue: 240,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_PROCUREMENT_ORDERS",
    envType: "number",
    minValue: 1,
    maxValue: 250,
    description:
      "Maximum open living-economy NPC corporation buy orders across the universe economy.",
    validValues: "Integer from 1 through 250.",
  },
  {
    key: "livingEconomyMaxProcurementChangesPerReview",
    defaultValue: 40,
    envVar: "EVEJS_LIVING_ECONOMY_MAX_PROCUREMENT_CHANGES_PER_REVIEW",
    envType: "number",
    minValue: 1,
    maxValue: 50,
    description:
      "Maximum buy-order placements, reprices or cancellations during one ten-minute procurement review.",
    validValues: "Integer from 1 through 50.",
  },
  {
    key: "deadspaceWarpRestrictionEnabled",
    defaultValue: true,
    envVar: "EVEJS_DEADSPACE_WARP_RESTRICTION",
    envType: "boolean",
    description:
      [
        "Enforces TQ deadspace parity: while inside a mission/dungeon pocket, warping within the",
        "same complex is blocked (acceleration gates are the only way between rooms), and a warp",
        "from outside that would land inside a site is clamped to the site's warp-in point.",
        "Gate transit warps are exempt. Disable to allow free in-pocket warping.",
      ],
    validValues: "true or false.",
  },
  {
    key: "factionStandingLossOnKillEnabled",
    defaultValue: true,
    envVar: "EVEJS_FACTION_STANDING_LOSS_ON_KILL",
    envType: "boolean",
    description:
      [
        "TQ parity: destroying a faction NPC lowers your standing with that NPC's faction only",
        "(the golden mission logs show a single-faction hit with no derived propagation).",
        "Debounced per (character, faction, system) on a 10-minute window like Tranquility.",
        "Disable to turn off faction-standing loss from kills entirely.",
      ],
    validValues: "true or false.",
  },
  {
    key: "factionStandingLossPerKillRaw",
    defaultValue: -0.00006875,
    envVar: "EVEJS_FACTION_STANDING_LOSS_PER_KILL",
    envType: "number",
    description:
      [
        "The raw per-kill faction-standing modification applied when a faction NPC is destroyed",
        "(before the (10+S) distance-to-floor scaling the standing math applies).",
        "CCP's true per-entity value is unpublished and NOT in the SDE; -0.00006875 (= -11/160000)",
        "is calibrated from the golden mission logs (Guristas faction rats) and applied uniformly",
        "as a parity shortcut. Per-ship-class variation needs more golden logs to source.",
      ],
    validValues: "a negative number (raw standing modification).",
  },
  {
    key: "factionStandingGainOnKillEnabled",
    defaultValue: true,
    envVar: "EVEJS_FACTION_STANDING_GAIN_ON_KILL",
    envType: "boolean",
    description:
      [
        "Resident track R1 (NOT TQ parity): destroying a faction NPC grants a small standing gain",
        "with that faction's designated enemies (factions whose authored relation toward the victim",
        "faction is strongly negative). Gives residents a combat path to repair or build empire",
        "standing by hunting pirates. Debounced per (character, enemy faction, system) on the same",
        "10-minute window as the loss path. Disable for strict TQ standing behavior.",
      ],
    validValues: "true or false.",
  },
  {
    key: "factionStandingGainPerKillRaw",
    defaultValue: 0.00003,
    envVar: "EVEJS_FACTION_STANDING_GAIN_PER_KILL",
    envType: "number",
    description:
      [
        "The raw per-kill faction-standing gain applied to each enemy faction of a destroyed",
        "faction NPC when factionStandingGainOnKillEnabled is true (before the distance-to-ceiling",
        "scaling the standing math applies). Deliberately smaller than the loss magnitude so",
        "grinding hostile rats repairs standing slower than aggression destroys it.",
      ],
    validValues: "a positive number (raw standing modification).",
  },
  {
    key: "livingHostilityEnabled",
    defaultValue: true,
    envVar: "EVEJS_LIVING_HOSTILITY",
    envType: "boolean",
    description:
      [
        "Resident track R1: attacking one side of a living encounter makes that faction hostile to",
        "the attacking player instantly for livingHostilityMinutes (refreshed on repeat aggression),",
        "and a persistent faction standing below livingHostilityStandingFloor makes that faction",
        "shoot-on-sight until repaired. While enabled, living pirate/police NPCs admit players as",
        "combat targets per-player through this hostility check instead of engaging everyone.",
        "Disable to restore the legacy posture (living flights ignore or blanket-attack players by",
        "spawn flavor with no per-player standing logic).",
      ],
    validValues: "true or false.",
  },
  {
    key: "livingHostilityMinutes",
    defaultValue: 15,
    envVar: "EVEJS_LIVING_HOSTILITY_MINUTES",
    envType: "number",
    minValue: 1,
    maxValue: 240,
    description:
      "How long, in wall-clock minutes, a living faction stays hostile to a player after the player aggresses it. Repeat aggression refreshes the window.",
    validValues: "Number from 1 through 240.",
  },
  {
    key: "livingHostilityStandingFloor",
    defaultValue: -5,
    envVar: "EVEJS_LIVING_HOSTILITY_STANDING_FLOOR",
    envType: "number",
    minValue: -10,
    maxValue: 0,
    description:
      "Effective-standing threshold below which a living faction treats a player as shoot-on-sight even without recent aggression. Also published to the client as the hostile-response threshold on living combat NPCs.",
    validValues: "Number from -10 through 0.",
  },
  {
    key: "missionDeclinePenaltyEnabled",
    defaultValue: true,
    envVar: "EVEJS_MISSION_DECLINE_PENALTY",
    envType: "boolean",
    description:
      [
        "TQ parity: declining an agent mission a second time within the 4-hour free-decline window",
        "lowers your standing with the agent and its corporation (= agent/10), with the faction hit",
        "arriving via derived propagation. The first decline per agent per 4h is free. Magnitude uses",
        "the mission's own would-be agent reward negated; the golden logs show the true value runs",
        "~1.2-1.5x higher and varies per mission (needs more decline logs to source an exact factor).",
        "Disable to turn off decline standing penalties entirely.",
      ],
    validValues: "true or false.",
  },
  {
    key: "npcAuthoredStartupEnabled",
    defaultValue: false,
    envVar: "EVEJS_NPC_AUTHORED_STARTUP",
    envType: "boolean",
    description:
      [
        "Turns on the startup rules we have written by hand in the local NPC data files.",
        "Plain-English meaning: if this is off, those custom NPC and CONCORD auto-spawns will not appear when a solar system scene is created.",
      ],
    validValues: "true or false.",
  },
  {
    key: "npcDefaultConcordStartupEnabled",
    defaultValue: false,
    envVar: "EVEJS_NPC_DEFAULT_CONCORD_STARTUP",
    envType: "boolean",
    description:
      [
        "Turns on generated default CONCORD gate coverage for high-security systems (`0.5+`).",
        "This is separate from npcAuthoredStartupEnabled, so generated default CONCORD can still appear even if authored startup is off.",
      ],
    validValues: "true or false.",
  },
  {
    key: "npcDefaultConcordGateAutoAggroNpcsEnabled",
    defaultValue: false,
    envVar: "EVEJS_NPC_DEFAULT_CONCORD_GATE_AUTO_AGGRO_NPCS",
    envType: "boolean",
    description:
      [
        "When generated default CONCORD gate coverage is enabled, lets those gate checkpoint ships auto-aggro nearby NPC ships.",
        "This only affects generated default gate CONCORD; station screens stay passive and Crimewatch CONCORD response is unchanged.",
      ],
    validValues: "true or false.",
  },
  {
    key: "npcDefaultConcordStationScreensEnabled",
    defaultValue: true,
    envVar: "EVEJS_NPC_DEFAULT_CONCORD_STATION_SCREENS",
    envType: "boolean",
    description:
      [
        "When generated default CONCORD coverage is on, also place passive CONCORD patrol groups near stations in `1.0` and `0.9` systems.",
        "Think of these as visible station security screens, not the separate Crimewatch punishment fleet that warps in after a criminal act.",
    ],
    validValues: "true or false.",
  },
  {
    key: "npcDefaultEverMoreGatePresenceEnabled",
    defaultValue: true,
    envVar: "EVEJS_NPC_DEFAULT_EVERMORE_GATE_PRESENCE",
    envType: "boolean",
    description:
      [
        "Swaps Jita's generated generic gate scenery for the TQ-style EverMore/Villore Sec Ops gate presence.",
        "The EverMore style is Jita-only; other systems keep the generic empire gate sentry and billboard layout.",
      ],
    validValues: "true or false.",
  },
  {
    key: "npcDefaultEverMoreGatePresenceSystemIDs",
    defaultValue: "30000142",
    envVar: "EVEJS_NPC_DEFAULT_EVERMORE_GATE_PRESENCE_SYSTEM_IDS",
    envType: "string",
    allowBlank: true,
    description:
      [
        "Legacy comma-or-space-separated solarSystemIDs for generated EverMore gate presence.",
        "Only Jita is honored by the current parity helper, matching the TQ EverMore administration change observed in official gate logs.",
      ],
    validValues: "Blank or a comma/space-separated list of numeric solarSystemIDs, for example \"30000142\".",
  },
  {
    key: "crimewatchConcordResponseEnabled",
    defaultValue: true,
    envVar: "EVEJS_CRIMEWATCH_CONCORD_RESPONSE",
    envType: "boolean",
    description:
      "Enables automatic Crimewatch-driven CONCORD response to criminal actions in high-security space.",
    validValues: "true or false.",
  },
  {
    key: "crimewatchConcordPodKillEnabled",
    defaultValue: false,
    envVar: "EVEJS_CRIMEWATCH_CONCORD_POD_KILL",
    envType: "boolean",
    description:
      [
        "When automatic Crimewatch CONCORD response is enabled, lets that transient punishment wing continue onto a criminal capsule after the ship dies.",
        "This does not affect passive startup/default CONCORD presence.",
      ],
    validValues: "true or false.",
  },
  {
    key: "proxyNodeId",
    defaultValue: 0xffaa,
    envVar: "EVEJS_PROXY_NODE_ID",
    envType: "number",
    description:
      "Proxy node ID reported to the client and used when generating bound object IDs.",
    validValues: "Integer node ID. 65450 matches the traditional 0xFFAA value.",
  },
];

const CONFIG_ENTRY_DEFINITIONS_BY_KEY = new Map(
  CONFIG_ENTRY_DEFINITIONS.map((entry) => [entry.key, entry]),
);

const defaults = Object.fromEntries(
  CONFIG_ENTRY_DEFINITIONS.map((entry) => [entry.key, entry.defaultValue]),
);

function stripJsonComments(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  let result = "";
  let inString = false;
  let isEscaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += "\n";
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && nextChar === "/") {
        inBlockComment = false;
        index += 1;
        continue;
      }
      if (char === "\n") {
        result += "\n";
      }
      continue;
    }

    if (inString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && nextChar === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && nextChar === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function readJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const rawText = fs.readFileSync(filePath, "utf8");
    const strippedText = stripJsonComments(rawText).trim();
    if (strippedText === "") {
      return {};
    }
    return JSON.parse(strippedText);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function parseBoolean(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseNumber(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJson(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return undefined;
  }
}

function validateDailyLoginRewards(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("dailyLoginRewards must be a non-empty array.");
  }

  return value.map((reward, index) => {
    const typeID = Number(reward && reward.typeID);
    const quantity = Number(reward && reward.quantity);
    if (!Number.isInteger(typeID) || typeID <= 0) {
      throw new Error(`dailyLoginRewards[${index}].typeID must be a positive integer.`);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`dailyLoginRewards[${index}].quantity must be a positive integer.`);
    }
    return { typeID, quantity };
  });
}

function parseEnvValue(entry) {
  if (!entry || !entry.envVar) {
    return undefined;
  }

  const rawValue = process.env[entry.envVar];
  if (rawValue === undefined) {
    return undefined;
  }

  switch (entry.envType) {
    case "boolean":
      return parseBoolean(rawValue);
    case "number":
      return parseNumber(rawValue);
    case "string": {
      const normalized = rawValue.trim();
      return normalized === "" ? undefined : normalized;
    }
    case "json":
      return parseJson(rawValue);
    default:
      return undefined;
  }
}

function inferConfigEntryType(entry) {
  if (!entry) {
    return "string";
  }
  if (entry.valueType) {
    return entry.valueType;
  }
  if (entry.envType) {
    return entry.envType;
  }

  if (
    Array.isArray(entry.defaultValue) ||
    (entry.defaultValue !== null && typeof entry.defaultValue === "object")
  ) {
    return "json";
  }

  switch (typeof entry.defaultValue) {
    case "boolean":
    case "number":
    case "string":
      return typeof entry.defaultValue;
    default:
      return "string";
  }
}

function validateAllowedValue(entry, value) {
  if (
    typeof entry?.minValue === "number" &&
    typeof value === "number" &&
    (
      value < entry.minValue ||
      (entry.exclusiveMinValue === true && value === entry.minValue)
    )
  ) {
    throw new Error(
      `${entry.key} must be ${
        entry.exclusiveMinValue === true ? "greater than" : "at least"
      } ${entry.minValue}.`,
    );
  }

  if (
    typeof entry?.maxValue === "number" &&
    typeof value === "number" &&
    value > entry.maxValue
  ) {
    throw new Error(`${entry.key} must be at most ${entry.maxValue}.`);
  }

  if (
    Array.isArray(entry?.allowedValues) &&
    !entry.allowedValues.includes(value)
  ) {
    throw new Error(
      `${entry.key} must be one of ${entry.allowedValues
        .map((allowedValue) => JSON.stringify(allowedValue))
        .join(", ")}.`,
    );
  }

  if (typeof entry?.validateValue === "function") {
    return entry.validateValue(value);
  }

  return value;
}

function coerceConfigValue(entry, value) {
  const valueType = inferConfigEntryType(entry);

  switch (valueType) {
    case "boolean": {
      if (typeof value === "boolean") {
        return validateAllowedValue(entry, value);
      }
      if (typeof value === "number" && (value === 0 || value === 1)) {
        return validateAllowedValue(entry, value === 1);
      }
      if (typeof value === "string") {
        const parsedBoolean = parseBoolean(value);
        if (parsedBoolean !== undefined) {
          return validateAllowedValue(entry, parsedBoolean);
        }
      }
      throw new Error(`${entry.key} must be true or false.`);
    }
    case "number": {
      let parsedNumber = value;
      if (typeof parsedNumber === "string") {
        parsedNumber = parseNumber(parsedNumber);
      }
      if (typeof parsedNumber === "number" && Number.isFinite(parsedNumber)) {
        return validateAllowedValue(entry, parsedNumber);
      }
      throw new Error(`${entry.key} must be a valid number.`);
    }
    case "string": {
      if (typeof value !== "string") {
        throw new Error(`${entry.key} must be a string.`);
      }
      const trimmedValue = value.trim();
      if (trimmedValue === "") {
        throw new Error(`${entry.key} cannot be blank.`);
      }
      return validateAllowedValue(entry, trimmedValue);
    }
    case "json": {
      let parsedValue = value;
      if (typeof parsedValue === "string") {
        try {
          parsedValue = JSON.parse(parsedValue);
        } catch (error) {
          throw new Error(`${entry.key} must be valid JSON.`);
        }
      }
      return validateAllowedValue(entry, parsedValue);
    }
    default:
      return value;
  }
}

function withDefinedEntries(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function loadEnvConfig() {
  return withDefinedEntries(
    Object.fromEntries(
      CONFIG_ENTRY_DEFINITIONS.map((entry) => [
        entry.key,
        parseEnvValue(entry),
      ]),
    ),
  );
}

function normalizePersistedConfig(rawConfig = {}) {
  const normalized = {};

  const hasRewardArray = Object.prototype.hasOwnProperty.call(
    rawConfig || {},
    "dailyLoginRewards",
  );
  if (!hasRewardArray) {
    const legacyTypeID = Number(rawConfig && rawConfig.dailyLoginRewardTypeID);
    const legacyQuantity = Number(rawConfig && rawConfig.dailyLoginRewardQuantity);
    if (
      Number.isInteger(legacyTypeID) && legacyTypeID > 0 &&
      Number.isInteger(legacyQuantity) && legacyQuantity > 0
    ) {
      normalized.dailyLoginRewards = [{
        typeID: legacyTypeID,
        quantity: legacyQuantity,
      }];
    }
  }

  for (const [key, value] of Object.entries(rawConfig || {})) {
    if (REMOVED_CONFIG_KEYS.has(key)) {
      continue;
    }
    normalized[key] = value;
  }

  const normalizedProjectCodename = String(
    normalized.projectCodename || "",
  ).trim().toLowerCase();
  if (
    normalizedProjectCodename === "crucible" ||
    normalizedProjectCodename === "cruicible"
  ) {
    normalized.projectCodename = defaults.projectCodename;
  }
  if (String(normalized.projectRegion || "").trim().toLowerCase() === "evejs") {
    normalized.projectRegion = defaults.projectRegion;
  }
  if (
    ["V23.02@evejs", "V23.02@ccp"].includes(
      String(normalized.projectVersion || "").trim(),
    )
  ) {
    normalized.projectVersion = defaults.projectVersion;
  }

  return normalized;
}

function buildPersistedConfigSnapshot(rawConfig = {}) {
  const normalizedConfig = normalizePersistedConfig(rawConfig);
  return {
    ...defaults,
    ...normalizedConfig,
  };
}

function formatInlineConfigValue(value) {
  return JSON.stringify(value);
}

function buildDocumentedCommentLines(entry) {
  const descriptionLines = Array.isArray(entry.description)
    ? entry.description
    : [entry.description];
  const defaultComment = entry.defaultComment || formatInlineConfigValue(entry.defaultValue);
  return [
    ...descriptionLines,
    `Valid values: ${entry.validValues}`,
    `Default: ${defaultComment}.`,
  ];
}

function inferJsonValueType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function buildFallbackCommentLines(key, value) {
  return [
    `Custom config override for "${key}".`,
    `Valid values: any JSON ${inferJsonValueType(value)} value.`,
  ];
}

function buildConfigPropertyLines(key, value, isLastEntry) {
  const serializedKey = JSON.stringify(key);
  const serializedValue = JSON.stringify(value, null, 2);
  const suffix = isLastEntry ? "" : ",";
  const prefix = `  ${serializedKey}: `;

  if (!serializedValue.includes("\n")) {
    return [`${prefix}${serializedValue}${suffix}`];
  }

  const valueLines = serializedValue.split("\n");
  const lines = [`${prefix}${valueLines[0]}`];
  const continuationIndent = " ".repeat(prefix.length);

  for (let index = 1; index < valueLines.length; index += 1) {
    const lineSuffix = index === valueLines.length - 1 ? suffix : "";
    lines.push(`${continuationIndent}${valueLines[index]}${lineSuffix}`);
  }

  return lines;
}

function buildCommentedConfigText(nextConfig = {}) {
  const entries = Object.entries(nextConfig);
  const lines = [
    "// EveJS Elysian server config.",
    "// This file supports // comments.",
    "// Missing keys are re-added with defaults when the server loads it.",
    "{",
  ];

  entries.forEach(([key, value], index) => {
    const entry = CONFIG_ENTRY_DEFINITIONS_BY_KEY.get(key);
    const commentLines = entry
      ? buildDocumentedCommentLines(entry)
      : buildFallbackCommentLines(key, value);

    for (const line of commentLines) {
      lines.push(`  // ${line}`);
    }

    lines.push("");
    lines.push(
      ...buildConfigPropertyLines(key, value, index === entries.length - 1),
    );

    if (index < entries.length - 1) {
      lines.push("");
    }
  });

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function syncConfigFileDefaults(filePath, rawConfig = {}, options = {}) {
  const fileExists = fs.existsSync(filePath);
  if (!fileExists && options.createIfMissing !== true) {
    return rawConfig;
  }

  const nextConfig = buildPersistedConfigSnapshot(rawConfig);
  const nextText = buildCommentedConfigText(nextConfig);
  const previousText = fileExists ? fs.readFileSync(filePath, "utf8") : null;

  if (previousText !== nextText) {
    fs.writeFileSync(filePath, nextText, "utf8");
  }

  return nextConfig;
}

const sharedConfigExists = fs.existsSync(sharedConfigPath);
const localConfigExists = fs.existsSync(localConfigPath);
const sharedRawConfig = normalizePersistedConfig(readJsonConfig(sharedConfigPath));
const localRawConfig = normalizePersistedConfig(readJsonConfig(localConfigPath));
const sharedConfig = syncConfigFileDefaults(
  sharedConfigPath,
  sharedRawConfig,
);
const localConfig = syncConfigFileDefaults(
  localConfigPath,
  localRawConfig,
  {
    createIfMissing: !sharedConfigExists && !localConfigExists,
  },
);
const xEveProfileConfig = normalizePersistedConfig(
  readJsonConfig(xEveProfilePath),
);
const xEveLocalConfig = normalizePersistedConfig(
  readJsonConfig(xEveLocalConfigPath),
);

const fileConfig = {
  ...sharedConfig,
  ...localConfig,
  ...xEveProfileConfig,
  ...xEveLocalConfig,
};

const envConfig = loadEnvConfig();

const config = {
  ...defaults,
  ...fileConfig,
  ...envConfig,
};

config.getNextBoundId = function getNextBoundId() {
  return nextBoundId++;
};

function getConfigDefinitions() {
  return CONFIG_ENTRY_DEFINITIONS.map((entry) => ({
    ...entry,
    description: Array.isArray(entry.description)
      ? [...entry.description]
      : [entry.description],
    allowedValues: Array.isArray(entry.allowedValues)
      ? [...entry.allowedValues]
      : undefined,
    valueType: inferConfigEntryType(entry),
  }));
}

function getConfigStateSnapshot() {
  const sharedRawConfig = normalizePersistedConfig(readJsonConfig(sharedConfigPath));
  const localRawConfig = normalizePersistedConfig(readJsonConfig(localConfigPath));
  const xEveProfileConfig = normalizePersistedConfig(
    readJsonConfig(xEveProfilePath),
  );
  const xEveLocalConfig = normalizePersistedConfig(
    readJsonConfig(xEveLocalConfigPath),
  );
  const fileConfigSnapshot = {
    ...defaults,
    ...sharedRawConfig,
    ...localRawConfig,
    ...xEveProfileConfig,
    ...xEveLocalConfig,
  };
  const envConfigSnapshot = loadEnvConfig();
  const resolvedConfig = {
    ...fileConfigSnapshot,
    ...envConfigSnapshot,
  };
  const sources = Object.fromEntries(
    CONFIG_ENTRY_DEFINITIONS.map((entry) => {
      if (Object.prototype.hasOwnProperty.call(envConfigSnapshot, entry.key)) {
        return [entry.key, "env"];
      }
      if (Object.prototype.hasOwnProperty.call(xEveLocalConfig, entry.key)) {
        return [entry.key, "x-eve-local"];
      }
      if (Object.prototype.hasOwnProperty.call(xEveProfileConfig, entry.key)) {
        return [entry.key, "x-eve-profile"];
      }
      if (Object.prototype.hasOwnProperty.call(localRawConfig, entry.key)) {
        return [entry.key, "local"];
      }
      if (Object.prototype.hasOwnProperty.call(sharedRawConfig, entry.key)) {
        return [entry.key, "shared"];
      }
      return [entry.key, "default"];
    }),
  );

  return {
    rootDir,
    sharedConfigPath,
    localConfigPath,
    xEveProfilePath,
    xEveLocalConfigPath,
    defaults: { ...defaults },
    sharedRawConfig,
    localRawConfig,
    xEveProfileConfig,
    xEveLocalConfig,
    fileConfig: fileConfigSnapshot,
    envConfig: envConfigSnapshot,
    resolvedConfig,
    sources,
  };
}

function buildValidatedConfigValues(rawValues = {}, options = {}) {
  if (
    rawValues === null ||
    typeof rawValues !== "object" ||
    Array.isArray(rawValues)
  ) {
    throw new Error("Config values must be provided as an object.");
  }

  const snapshot = getConfigStateSnapshot();
  const baseValues =
    options.baseValues && typeof options.baseValues === "object"
      ? options.baseValues
      : snapshot.fileConfig;
  const nextValues = {};

  for (const entry of CONFIG_ENTRY_DEFINITIONS) {
    const candidateValue = Object.prototype.hasOwnProperty.call(
      rawValues,
      entry.key,
    )
      ? rawValues[entry.key]
      : baseValues[entry.key];
    nextValues[entry.key] = coerceConfigValue(entry, candidateValue);
  }

  return nextValues;
}

function saveLocalConfig(rawValues = {}) {
  const currentLocalRawConfig = normalizePersistedConfig(
    readJsonConfig(localConfigPath),
  );
  const preservedCustomEntries = Object.fromEntries(
    Object.entries(currentLocalRawConfig).filter(
      ([key]) =>
        !CONFIG_ENTRY_DEFINITIONS_BY_KEY.has(key) && !REMOVED_CONFIG_KEYS.has(key),
    ),
  );
  const nextKnownValues = buildValidatedConfigValues(rawValues);

  syncConfigFileDefaults(
    localConfigPath,
    {
      ...preservedCustomEntries,
      ...nextKnownValues,
    },
    {
      createIfMissing: true,
    },
  );

  return getConfigStateSnapshot();
}

Object.defineProperties(config, {
  getConfigDefinitions: {
    value: getConfigDefinitions,
  },
  getConfigStateSnapshot: {
    value: getConfigStateSnapshot,
  },
  buildValidatedConfigValues: {
    value: buildValidatedConfigValues,
  },
  saveLocalConfig: {
    value: saveLocalConfig,
  },
});

module.exports = config;
