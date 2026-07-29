# Changelog

All notable public patch releases are recorded here.

## 0.2.1 - 2026-07-29

First-start and scheduler-capacity hotfix for the exact EveJS v0.12.3.1
compatible baseline.

### First startup

- Prevents the market setup helper from waiting on detached descendants after
  a successful seed or build command.
- Includes the Live Events definition catalog required by the enabled public
  profile and verifies patched runtime static-data references during build,
  install, and installed-file verification.
- Adds a first-run regression verifier for prompt nested batch-command return
  and nonzero exit-code propagation.

### X-Eve capacity

- Raises the healthy X-Eve scheduler ceiling from 8 to 32 continuations per
  pass while retaining the existing 2 ms time budget and adaptive tick-pressure
  governor.
- Adds a regression that drains a 24-event observation burst in one healthy
  pass without weakening constrained, overloaded, shed, persistence, or
  idempotency behavior.
- Fixes the 72x failure mode where Living Economy observation work arrived
  faster than the former hard ceiling could drain it, causing maintenance
  backlog to grow past 10,000 despite healthy handler duration and tick p95.

## 0.2.0 - 2026-07-28

First Living Universe release for the exact EveJS v0.12.3.1 compatible
baseline.

### Compatibility and packaging

- Targets the independently obtained `EveJS-v0.12.3.1.zip` archive identified
  by SHA-256
  `1DEB61A51F808D9F2B330214DA64EC297D9EE5F96EE4B8265692A65F35EEFC1E`.
- Ships one source patch covering 197 paths: 64 modified files and 133 added
  files. The validating installer, verifier, rollback, and uninstall workflow
  remains scoped to those paths.
- Replaces the old release in the repository's current tree without rewriting
  its history. Version 0.1.0 remains the historical EveJS v0.12.3 release and
  must not be installed on v0.12.3.1.
- Keeps the X Command web interface, API, authentication, account linking,
  browser assets, and UI adapters outside the Living Universe package so X
  Command can remain a separate overlay.

### Economy, procurement, and mobilization

- Adds staged replacement production, parallel hull lines, and persistent
  industrial work needed to turn ship losses into replacement supply.
- Adds war-premium procurement orders that players can fill, including durable
  fulfillment and delivery accounting.
- Adds closed-loop mobilization so conflict pressure drives doctrine demand,
  procurement, production, deployment, and replacement.
- Adds pirate-faction replacement supply, faction shipyard behavior, and a
  bounded smuggler fallback when ordinary supply cannot satisfy hostile-space
  demand.
- Adds the NPC refinery path used by the simulated economy while preserving a
  meaningful player procurement opportunity.
- Preserves loud diagnostics and recoverable state when a scheduler pulse or
  persistent economy-state load fails.

### Faction conflict and industrial crews

- Adds faction hostility evaluation, hostile engagement behavior, kill-credit
  accounting, and standing consequences.
- Projects managed crews into their employer corporation, Local, corporation
  chat, and friendly relationship state while keeping their retained
  affiliation data.
- Adds pooled industrial-crew defense, drone and escort participation,
  threat-response thresholds, and durable travel and presence lifecycle
  behavior.

### Verification

- Adds focused verification for procurement and mobilization, faction
  hostility, managed-crew defense, corporation employee projection, Local
  presence, and synthetic chat presence.
- Validates clean application to the exact v0.12.3.1 baseline, installed file
  hashes, reverse application, uninstall, and exact baseline restoration.

## 0.1.0 - 2026-07-26

First public release for the exact EveJS v0.12.3 compatible baseline.

### Compatibility and packaging

- Targets the independently obtained v0.12.3 archive identified by SHA-256
  `81E2B48DE1E55D8FAD413137F83FF26C7FEB4FFA943825093FFC1BB17468D27E`.
- Ships as one source patch with validating install, verify, rollback, and
  uninstall tools; no server distribution, client, CCP assets, databases,
  certificates, runtime state, or private configuration are redistributed.
- Keeps X Command's web UI, API, authentication, account linking, and
  UI-specific adapters outside this package. The adapter-neutral economy and
  industrial-crew simulation remain in the Living Universe core.

### Ordinary EveJS launch

- Integrates the Living Universe and X-Eve startup into the regular `Play.bat`
  and `StartServer.bat` path; no feature-specific player launcher is required.
- Installs a verified public play profile with 5,000 persistent pilots.
- Waits for the game server, proxy, population, economy stock cache, and X-Eve
  scheduler before launching the client.
- Uses source-content build stamps so the ordinary launcher recompiles a stale
  market daemon after source changes.

### Living Universe

- Adds persistent virtual NPC pilots with affiliations, jobs, racial doctrine,
  loadouts, portraits, and authoritative per-system Local presence.
- Advances distant actors through bounded, deadline-based virtual travel while
  materializing physical ships only where players can observe them.
- Corrects observed ship motion, Local transitions, native-NPC weapons and
  assistance effects, EWAR presentation, and simultaneous synthetic modules.
- Adds bounded mining, industry, freight, procurement, trade, salvage,
  replacement logistics, roaming fleets, camps, encounters, and ship losses.

### Regional economy

- Starts from the compact imported Jita + New Caldari base market.
- Retains and synchronizes authoritative NPC-station topology needed by the
  regional simulation.
- Automatically creates only absent raw-mineral rows at 37 regional hubs during
  the normal Living Economy cold start; no manual bootstrap is required.
- Preserves existing stock, depleted zero-quantity rows, player orders, and
  market history.
- Uses race-safe create-only adjustments, deterministic identities, bounded
  per-region batches, and retry-safe partial completion.

### Industrial crews and optional systems

- Adds durable industrial-crew contracts, scheduling, station-to-station
  navigation, restart-safe deadlines, arrival handling, and scene lifecycle.
- Adds separately gated live events, family-estate restoration, wormhole
  logistics, and the X-Eve economic scheduler and event circuit.
- Keeps optional local acceleration limited to unobserved virtual work while
  observed ships retain normal movement timing.

### Performance and verification

- Adds physical-ship caps, bounded background work, scheduler admission
  controls, load shedding, recovery hysteresis, and rolling runtime,
  economy, conflict, replacement, and garbage-collection telemetry.
- Adds focused verification for population, presence, transit,
  materialization, mining, industry, economy conservation, adjustment replay,
  conflict, doctrines, industrial navigation, family estate, and X-Eve
  recovery.
- Validates clean installation, exact installed state, reverse application,
  uninstall, and exact baseline restoration.

### Known limitation

- Ship losses create replacement demand correctly, but the experimental X-Eve
  final-delivery and package-credit path can accumulate a replacement backlog.
  This does not block population, Local presence, physical movement, witnessed
  combat, persistence, or ordinary economy startup and remains a follow-up area
  for playtest balancing and integration work.
