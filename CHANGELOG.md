# Changelog

All notable public patch releases are recorded here.

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
