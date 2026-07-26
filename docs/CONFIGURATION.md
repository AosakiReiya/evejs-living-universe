# Configuration

The pre5 patch installs an X-Eve profile that is loaded automatically by the
ordinary EveJS server. Starting `Play.bat` or `StartServer.bat` enables the
Living Universe, economy, conflict, industrial crews, live events, family
estate, and X-Eve with 5,000 persistent pilots. No X-Eve-specific launcher is
used.

The server resolves settings in this order, with each later source taking
precedence:

1. Source defaults.
2. `evejs.config.json`.
3. The ordinary private `evejs.config.local.json`.
4. The installed public `evejs.config.x-eve.json` profile.
5. An optional private `evejs.config.x-eve.local.json` override.
6. Corresponding `EVEJS_*` environment variables.

The public profile is part of the verified patch and should not be edited.
Personal X-Eve settings belong in `evejs.config.x-eve.local.json`; the file is
not supplied by the patch and is not included in verification or uninstall.
Local configuration, credentials, addresses, certificates, and databases
should never be committed to this patch repository.

## Installed play profile

The installed profile uses these principal values:

| JSON key | Source default | Installed pre5 value |
| --- | ---: | ---: |
| `familyEstateEnabled` | `false` | `true` |
| `livingUniverseEnabled` | `false` | `true` |
| `livingEconomyEnabled` | `false` | `true` |
| `livingConflictEnabled` | `true` | `true` |
| `livingConflictCampaignsEnabled` | `true` | `true` |
| `livingConflictRoamingEnabled` | `true` | `true` |
| `industrialHirelingsEnabled` | `false` | `true` |
| `industrialMiningCrewsEnabled` | `false` | `true` |
| `liveEventsEnabled` | `false` | `true` |
| `xEveEnabled` | `false` | `true` |
| `livingUniversePopulationSize` | `400` | `5000` |
| `livingUniverseMaxMaterializedPerSystem` | `48` | `64` |
| `livingUniverseMaxMaterializedGlobal` | `120` | `180` |
| `livingUniverseMaterializationsPerTick` | `2` | `1` |

Persistent pilots appear in the Local roster for their current solar system.
Pilots in a gate-transition window are intentionally hidden until their arrival
is committed, so they do not appear in two systems at once. The 5,000-pilot
population is distributed across New Eden; it is not placed in one Local list.

X Command configuration is not part of this profile or repository. A future
X Command release will be a separate overlay on these core services.

## Optional lower-capacity override

On a lower-capacity host, create `evejs.config.x-eve.local.json` at the EveJS
root with a small override such as:

```json
{
  "livingUniversePopulationSize": 400,
  "livingUniverseMaxMaterializedPerSystem": 48,
  "livingUniverseMaxMaterializedGlobal": 120,
  "livingUniverseMaterializationsPerTick": 2
}
```

This file is an override fragment. Only include values you want to replace.
Restart the normal server after changing it.

## Principal feature gates

| JSON key | Environment variable | Installed | Purpose |
| --- | --- | ---: | --- |
| `ambientTrafficEnabled` | `EVEJS_AMBIENT_TRAFFIC_ENABLED` | `false` | Small authored convoy pilot, separate from the distributed population. |
| `livingUniverseEnabled` | `EVEJS_LIVING_UNIVERSE_ENABLED` | `true` | Persistent pilots, virtual travel, and observed materialization. |
| `livingEconomyEnabled` | `EVEJS_LIVING_ECONOMY_ENABLED` | `true` | Conserved regional stock, mining, hauling, procurement, and production. |
| `liveEventsEnabled` | `EVEJS_LIVE_EVENTS_ENABLED` | `true` | Deadline-driven optional event framework. |
| `xEveEnabled` | `EVEJS_X_EVE_ENABLED` | `true` | Experimental economic kernel and adaptive scheduler. |
| `familyEstateEnabled` | `EVEJS_FAMILY_ESTATE_ENABLED` | `true` | Optional shared-corporation estate and restoration flow. |

Some dependent settings default to `true`, but remain inert while their parent
feature gate is off. In particular, conflict settings do nothing without the
Living Universe, and estate logistics require the estate plus the relevant
economy and traffic systems.

## Population and physical presence

| JSON key | Installed | Meaning |
| --- | ---: | --- |
| `livingUniversePopulationSize` | `5000` | Persistent pilot count; accepted range is 1-5000. |
| `livingUniverseMaxMaterializedPerSystem` | `64` | Maximum physical simulation in one occupied system. |
| `livingUniverseMaxMaterializedGlobal` | `180` | Shared global physical-NPC budget. |
| `livingUniverseMaterializationsPerTick` | `1` | Flight groups allowed to materialize per one-second scheduler pass. |
| `livingUniverseSchedulerBudgetMs` | `8` | Soft work budget per living-universe scheduler pass. |
| `livingUniverseMaxDueFlightsPerTick` | `64` | Maximum unobserved flight transitions handled per pass. |
| `livingUniversePilotSyncBatchSize` | `128` | Maximum changed synthetic Local records synchronized per pass. |

A larger persistent population is comparatively cheap while virtual. Physical
caps, scene entry, combat, and player-observed behavior are more expensive.
Increase population and physical caps independently.

The installed profile starts at 5,000. If it does not stabilize on a particular
host, use the private override to step down to 2,500, 1,000, or 400 before
changing the physical caps. A maximum accepted configuration value is not a
capacity promise for a particular host.

## Economy controls

| JSON key | Default | Meaning |
| --- | ---: | --- |
| `livingEconomyPulseSeconds` | `15` | Interval between bounded economy passes. |
| `livingEconomyWorkBudgetMs` | `4` | Maximum synchronous work slice before yielding. |
| `livingEconomyStockReconcileBatchSize` | `320` | Minimum stock rows checked from one region per pulse. |
| `livingEconomyFullStockReconcileSeconds` | `14400` | Four-hour target for a rolling full stock review. |
| `livingEconomyRoutePlanningSeconds` | `300` | Minimum interval between universe freight-opportunity rebuilds. |
| `livingEconomyMaxActiveJobs` | `320` | Global reserved or in-transit freight cap. |
| `livingEconomyMaxJobsPerPulse` | `24` | Maximum new freight reservations per pulse. |
| `livingEconomyMaxActiveIndustryJobs` | `320` | Global persistent NPC industry cap. |
| `livingEconomyMaxProductionRunsPerPulse` | `24` | Maximum new industry jobs installed per pulse. |
| `livingEconomyTelemetryIntervalSeconds` | `600` | Ten-minute economic snapshot interval. |

The default production time scale is `1`, meaning normal modeled blueprint
time. `livingEconomyIndustryTimeScale: 0.1` is a 10x development accelerator;
use it for short tests, not balance or production-play conclusions.

## Roaming conflict controls

Roaming conflict is a dependent Living Universe feature. It remains inert
unless both `livingUniverseEnabled` and `livingConflictEnabled` are enabled.
The default caps deliberately create a small set of persistent operations from
the existing pilot and flight population; they do not add another unbounded
population.

| JSON key | Default | Meaning |
| --- | ---: | --- |
| `livingConflictRoamingEnabled` | `true` | Enables deadline-driven pirate, security, patrol, and gate-camp operations under the parent conflict gates. |
| `livingConflictRoamingGroupLimit` | `96` | Maximum persistent roaming operation groups. |
| `livingConflictRoamingWorkBudgetMs` | `1.5` | Enforced synchronous time budget for one roaming-kernel pass. |
| `livingConflictRoamingMaxTransitionsPerTick` | `16` | Maximum due group phase changes processed in one pass. |
| `livingConflictRoamingMaxPresenceChecksPerTick` | `192` | Maximum indexed co-location checks in one pass. |
| `livingConflictGateCampLimit` | `6` | Maximum groups simultaneously holding a gate-camp phase. |

Operation deadlines are jittered, and groups meet through indexed
co-location windows rather than an all-pairs scan. A visible gate camp still
uses the ordinary global and per-system materialized-ship budgets. If roaming
work falls behind, reduce the group and camp limits before increasing the work
budget; a larger budget spends more uninterrupted server time and does not
create more physical-scene capacity.

## Off-grid travel acceleration

`livingUniverseOffGridTravelTimeMultiplier` defaults to `1`. A value of `10`
makes eligible empty-system virtual legs advance ten times faster. It does not
speed up a materialized ship or a flight in a system with a connected player
scene. If observation begins during an accelerated leg, remaining time is
rebased to normal timing instead of teleporting the ship.

Use `10` only to shorten development tests. Use `1` for ordinary play,
transit-time validation, balance observations, and performance comparisons.

Environment-variable equivalent:

```powershell
$env:EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER = '10'
```

Remove that process-local override after the test.

## X-Eve admission controls

X-Eve is independently gated in source and enabled by the installed profile.
Its important installed latency values are:

| JSON key | Installed | Behavior |
| --- | ---: | --- |
| `xEveSchedulerBudgetMs` | `2` | Healthy-load work budget per pass. |
| `xEveTickWarningMs` | `120` | Rolling p95 where planning and maintenance defer. |
| `xEveTickOverloadMs` | `130` | Rolling p95 where only small due continuations are admitted. |
| `xEveEmergencyShedMs` | `500` | Single-tick boundary that immediately stops background work. |
| `xEveRecoveryThresholdMs` | `119` | p95 required before the recovery window can begin. |
| `xEveRecoverySeconds` | `5` | Healthy interval required before normal planning resumes. |

Do not raise the warning or overload thresholds to hide a capacity problem.
Reduce physical caps or background work first.

## Change discipline

1. Keep a copy of the last known-good private configuration.
2. Change one capacity family at a time.
3. Warm up the server before comparing telemetry.
4. Compare p95 tick interval, maximum tick work, scheduler backlog, memory, and
   economy throughput.
5. Revert the change if latency or backlog does not stabilize.

See [Performance](PERFORMANCE.md) for the measurement targets.
