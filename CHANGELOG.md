# Changelog

All notable public patch releases are recorded here.

This project uses pre-release version labels while compatibility, persistence,
and balance are still being tested.

## 0.1.0-pre5 - 2026-07-26

### Automatic regional economy startup

- Kept the normal imported Jita + New Caldari market as the compact first-run
  base while retaining the NPC-station topology needed by Living Economy.
- Added a normal-start, non-destructive topology migration for existing pre4
  databases. It inserts only absent region, system, and station authority and
  does not rewrite stock, player orders, or market history.
- Added race-safe create-only stock adjustments. The first economy cold start
  creates only absent raw-mineral rows at the 37 regional hubs; existing rows,
  including depleted zero-quantity rows, are never refilled.
- Removed the need to run `bootstrapLivingEconomyMarket.js` for normal play.
  The script remains available only for deliberate administrator/reset work.

### Upgrade and verification

- Added source-content build stamps so the ordinary launcher recompiles a
  stale market daemon after patch upgrades instead of silently reusing it.
- Added focused topology, preservation, partial-retry, backward-compatibility,
  and real Node-to-Rust/SQLite verification.
- Regenerated the single v0.12.3 patch, manifests, checksums, and installer
  metadata for pre5.

## 0.1.0-pre4 - 2026-07-26

### Living Universe core boundary

- Kept X-Eve's economic kernel, adaptive scheduler, and event circuit in the
  Living Universe core.
- Kept industrial-crew contracts, persistence, scheduling, navigation, scene
  lifecycle, and the `/hireling` command as core simulation services.
- Removed X Command's web interface, API server, authentication, account
  linking, and UI-specific command adapters from this package. X Command will
  be distributed separately and can layer over the adapter-neutral core later.

### Industrial crew travel

- Added durable station-to-station crew navigation with validated routes,
  bounded leg advancement, restart-safe deadlines, and arrival handling.
- Corrected contract expiry and scheduler behavior while a crew is travelling,
  and added focused navigation coverage.
- Regenerated the patch, manifests, and checksums for the exact v0.12.3
  baseline.

## 0.1.0-pre3 - 2026-07-26

### Ordinary EveJS launch

- Moved the supported baseline to the exact EveJS v0.12.3 archive identified by
  SHA-256
  `81E2B48DE1E55D8FAD413137F83FF26C7FEB4FFA943825093FFC1BB17468D27E`.
- Integrated X-Eve startup into the regular `Play.bat` and `StartServer.bat`
  flow; no separate X-Eve launcher is installed or required.
- Added automatic first-run market preparation. The regular server stack seeds
  Jita and New Caldari when the market database is absent, builds the Rust
  market daemon when needed, and waits for both market endpoints before play.
- Made `Play.bat` wait for the game server, proxy, Living Universe population,
  economy stock cache, and X-Eve scheduler before launching the client.

### Installed play profile

- Added a verified `evejs.config.x-eve.json` profile that enables the Living
  Universe, economy, conflict, industrial crews, live events, family estate,
  and X-Eve with 5,000 persistent pilots.
- Kept the ordinary mutable `evejs.config.local.json` outside the patch so
  routine EveJS configuration updates do not invalidate install verification.
- Added optional private `evejs.config.x-eve.local.json` overrides and retained
  final `EVEJS_*` environment-variable precedence.

### Presence and verification

- Synchronized every persistent synthetic pilot into the authoritative
  per-system Local roster while hiding only actors in an unresolved gate
  transition, preventing duplicate cross-system presence.
- Corrected observed physical-ship motion so materialized traffic visibly
  follows, orbits, approaches, and transitions instead of appearing stationary.
- Corrected native-NPC special-effect presentation so lasers, other turret and
  launcher fire, fitted assistance beams, and EWAR effects carry the hull and
  module graphics data expected by the client.
- Resolved attribute-only NPC EWAR by its named dogma effect instead of falling
  back to a targetless laser, and assigned safe unique synthetic module IDs so
  simultaneous web, scramble, ECM, and related effects cannot overwrite one
  another.
- Added bounded pilot-directory synchronization, collision checks for names and
  portraits, and focused population, Local-membership, scheduler, economy, and
  X-Eve readiness verification.
- Regenerated the patch-only release, baseline manifest, installed manifest, and
  checksums for a clean v0.12.3 apply without redistributing the server tree or
  runtime data.

### Known pre-release limitation

- Ship losses create replacement demand correctly, but the experimental X-Eve
  final delivery and package-credit path can accumulate a replacement backlog.
  This does not block population, Local presence, physical movement, witnessed
  combat, or persistence, and remains a follow-up area for playtest balancing
  and integration work.

## 0.1.0-pre2 - 2026-07-24

### Roaming conflict

- Added persistent pirate and security operation groups that stage, travel,
  patrol, camp, and disperse on jittered deadlines instead of creating every
  encounter from a global periodic scan.
- Added deterministic co-location checks so hostile groups meet only while
  sharing a system or the same directional gate lane during the same time
  window; expired catch-up contacts do not become present-day battles.
- Added witnessable gate camps and roaming contacts. Ships that are already
  materialized at a camp are adopted into combat in place rather than removed
  and respawned, and NPC combat remains neutral to a nearby player unless
  ordinary aggression rules make the player a participant.
- Added mutual conflict losses, retained civilian interdiction opportunities,
  and connected observed camp losses to replacement demand.

### Replacement logistics

- Removed the quantity-one reserve deadlock that could leave replacement hulls
  or fittings permanently requested but never delivered.
- Allowed priority replacement freight to consume the last remote source unit
  while protecting stock already staged at the requesting station.
- Made complete replacement fitting packages reserve and settle atomically so
  a partial batch cannot masquerade as a usable replacement.
- Restricted pirate-hull production to matching pirate factories and real
  mineral inputs; missing inputs now create ordinary priority procurement and
  freight work rather than a free import.
- Included the bounded NPC salvage-recovery dependency used by the current
  economy runtime, with durable job state and existing salvager reward rules.

### Capacity controls and verification

- Capped roaming conflict at 96 persistent groups, 16 due transitions and 192
  presence checks per pass, six concurrent camps, and a 1.5 ms synchronous
  work budget.
- Kept distant operations deadline-driven and virtual. Player-observed camps
  still obey the existing per-system and global materialized-ship budgets.
- Added fixed-size V8 garbage-collection telemetry and telemetry-capture build
  duration so host pauses can be separated from game-tick or roaming work
  without enabling a heavyweight profiler.
- Added focused verification for the roaming kernel, emergent contacts,
  already-visible camps, replacement delivery, priority demand, and
  mineral-backed pirate production, plus a focused GC telemetry verifier.
- Expanded the public-package audit to reject public IP addresses, email
  addresses, absolute machine paths, credential-shaped values, private keys,
  and binary diffs inside the canonical patch payload.

## 0.1.0-pre1 - 2026-07-21

Initial patch-only preview for the compatible v0.12.2 server baseline.

### Living universe

- Added persistent virtual NPC pilots distributed across regions, factions,
  corporations, and operational roles.
- Added deadline-based travel and work scheduling so distant actors advance
  without consuming a full physical ship tick.
- Added player-proximity materialization, local presence, portrait support,
  physical-ship budgets, and observed-flight behavior.
- Added regional and racial traffic doctrines, role-appropriate hull selection,
  fittings, combat effects, and governed module-drop behavior.

### Economy and conflict

- Added conserved mining, freight, procurement, stock, production, and industry
  flows with durable job and delivery state.
- Added regional route selection, competitive NPC buy orders, trade accounting,
  telemetry snapshots, and bounded stock reconciliation.
- Added witnessed and off-grid conflicts, campaigns, ship losses, distress
  incidents, and security or corporate response behavior.
- Added replacement demand so simulated loss feeds back into hauling and
  production.

### Experimental systems

- Added the disabled-by-default X-Eve scheduler and economic event circuit.
- Added optional live events, family-estate restoration, wormhole logistics, and
  starter-progression foundations behind feature gates.
- Added safe unobserved-travel acceleration for local testing while preserving
  normal timing when ships are observed or materialized.

### Performance and verification

- Added bounded background work, physical NPC caps, rolling tick telemetry,
  load shedding, recovery hysteresis, and runtime economy reporting.
- Added verification scripts for population, transit, materialization, economy,
  mining, industry, conflict, doctrines, estate logistics, and X-Eve recovery.

### Public packaging

- Repackaged the project as one versioned patch plus a validating installer.
- Excluded the server baseline, EVE client, CCP assets, databases, certificates,
  generated runtime content, and private deployment configuration.
