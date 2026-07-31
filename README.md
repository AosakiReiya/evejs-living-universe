# X-Eve Living Universe

A patch-based extension for EVEJS.

> This is a patch-only repository, not a runnable server distribution.
> It contains neither the compatible server baseline nor an EVE client, CCP assets,
> databases, certificates, generated portraits, or private server
> configuration. Obtain a compatible base independently and apply the patch to
> your own clean copy.

X Command is intentionally not included in this repository. The Living
Universe core keeps the industrial-crew services and adapter-neutral command
seams that a separate X Command package can use later, without coupling this
patch to its web interface, API, authentication, or account-linking layer.

## Compatibility

See [CHANGELOG](CHANGELOG.md) for supported EVEJS versions and release history.

Do not apply the patch to another server version, an already modified tree, or
your only working copy. The installer validates the expected baseline
before changing anything and stops on a mismatch.

## Install

You need the Go-built `xeve-patch` CLI, a clean EveJS v0.12.3.1 baseline, and
Node.js/Rust/VS Build Tools for running the server itself. Stop the server and
its supporting services, extract a clean EVEJS baseline, then run:

```bash
xeve-patch install /path/to/EveJS-v0.12.3.1
```

The CLI validates the exact baseline against the release manifest, backs up the
original files it changes, applies the overlay, verifies every installed file,
and rolls back automatically on any failure.

Verify an installed tree, or a clean baseline, separately:

```bash
xeve-patch verify /path/to/EveJS-v0.12.3.1
```

Run the patch's bundled verification scripts (grouped by subsystem) after the
server has been started once:

```bash
xeve-patch verify /path/to/EveJS-v0.12.3.1 --module livingEconomy
xeve-patch verify /path/to/EveJS-v0.12.3.1 --tests
```

Additional commands: `xeve-patch status`, `xeve-patch repair`,
`xeve-patch uninstall`, and `xeve-patch modules`. Run `xeve-patch` with no
arguments for the interactive menu. Use `xeve-patch install --silent` for CI.

See [Installation](docs/INSTALL.md) for backup, verification, test, and
uninstall details.

## Start normally

The patch installs its public Living Universe profile as part of EveJS. After
the usual EveJS client setup, double-click the ordinary root `Play.bat`.
If the server is not running, `Play.bat` starts the normal `StartServer.bat`
path automatically. That path starts the market dependency, the EveJS server,
and then waits for the 5,000-pilot universe, X-Eve, market stock cache, and
proxy before launching the client.

When a Docker server is already running, `Play.bat` accepts the reachable game
and proxy endpoints as ready without requiring Windows to read
container-internal runtime telemetry or validate a Linux PID. This prevents
the launcher from starting a conflicting native server alongside Docker.

There is no X-Eve-specific player launcher and no private test profile. Normal
first-run setup starts from the imported Jita + New Caldari base market data.
The same regular startup synchronizes the NPC-station directory and Living
Economy creates only missing raw-mineral seed-stock rows at the 37 regional
hubs; no manual bootstrap is required. Existing rows, including rows depleted
to zero, player orders, and market history are left unchanged.
`server\scripts\bootstrapLivingEconomyMarket.js` remains an administrator/reset
tool only.

The first launch also compiles the market service, and later launches
automatically rebuild it when its sources change. This can take several
minutes. If the Rust/C++ toolchain is missing, run EveJS's bundled
`tools\InstallRustForMarket.bat` once, then use `Play.bat` normally.

The installed profile creates 5,000 persistent pilots. Local chat shows the
pilots currently present in the player's system; pilots travelling between
systems or intentionally delayed by session transitions are correctly absent
until they arrive.

Keep `evejs.config.x-eve.json` unchanged because it is part of the verified
patch. Put personal X-Eve capacity or feature overrides in the optional private
`evejs.config.x-eve.local.json`; ordinary EveJS settings can continue to use
`evejs.config.local.json`.

The normal performance reference is a **100 ms** tick interval. Treat **120 ms
p95** as a warning and **130 ms p95** as a load-test ceiling, not a normal
playing target. The optional **10x off-grid travel multiplier is for testing
only**: it accelerates unobserved virtual travel while observed and materialized
ships continue using normal movement timing.

See [Configuration](docs/CONFIGURATION.md) and
[Performance](docs/PERFORMANCE.md) before changing population or physical NPC
budgets.

## Docker deployment

> If you're running on Windows, make sure WSL has enough memory allocated. The testing environment uses 8GB of RAM. It won't necessarily consume that much, but if you encounter I/O stalls or infinite disk reads, check your RAM settings.
> You can configure it in %UserProfile%\.wslconfig or Docker Desktop → Settings → Resources → WSL2.

The patch ships Docker overlay files that adapt the upstream EveJS Docker
infrastructure for X-Eve features. After patching a clean baseline,
rebuild the local image and seed the market database:

```bash
cd EveJS-{your evejs version}

# Build the patched image
docker compose build

# Initialise the game database (SDE download, first start only)
docker compose run --rm init

# Seed the market database (choose one seed engine)
docker compose run --rm --no-deps market-tools rebuild v1 --preset jita_new_caldari
# or use the Tranquility snapshot:
# docker compose run --rm --no-deps market-tools rebuild v2

# Start the stack
docker compose up --detach
```

The patched entrypoint automatically synchronises the Living Economy station
topology before the Node.js server starts.

### Multi-container architecture

The compose stack runs three services from the same image:

| Service        | Command        | Role                                                     |
| -------------- | -------------- | -------------------------------------------------------- |
| `init`         | `init`         | One-shot SDE download and game-database build            |
| `market`       | `market`       | Rust market daemon (RPC port 40111, health 40110)        |
| `server`       | `server`       | Node.js game server with X-Eve, Living Universe, economy |
| `market-tools` | `market-tools` | CLI for market database management (profile `tools`)     |

The `server` service depends on `market:healthy` so the topology sync and
runtime have a ready market database.

### Configuration

Set X-Eve feature flags via the `evejs.config.x-eve.json` file (included in the
image) or override individual settings through environment variables:

```yaml
# docker-compose.override.yml
services:
  server:
    environment:
      EVEJS_X_EVE_ENABLED: "false"
      EVEJS_LIVING_UNIVERSE_POPULATION_SIZE: "1000"
      EVEJS_LIVING_ECONOMY_ENABLED: "true"
```

### Data persistence

All persistent data lives in the `evejs-data` Docker volume:

- Game database (SDE)
- Market database (SQLite, with backup rotation)
- Runtime-generated images (character portraits, alliance logos)
- X-Eve and Living Universe runtime state (SQLite via gameStore)

### Ports

Default compose binding is `127.0.0.1` only. Exposed ports:

| Port  | Service                     | Protocol |
| ----- | --------------------------- | -------- |
| 26000 | Game server                 | TCP      |
| 26001 | Image server                | TCP      |
| 26002 | Microservices               | TCP      |
| 26003 | CDN loopback (HTTPS)        | TCP      |
| 40110 | Market daemon (HTTP health) | TCP      |
| 40111 | Market daemon (RPC)         | TCP      |
| 5222  | XMPP                        | TCP      |

## What the patch adds

- Persistent NPC pilots with affiliations, roles, racial doctrines, loadouts,
  local presence, and portrait support.
- Deadline-driven virtual travel across the universe, with ships materialized
  only where players can observe them.
- Mining, freight, procurement, regional stock, manufacturing, and market flows
  designed around conserved inputs and completed deliveries.
- Demand-driven war procurement that players can fill, bounded NPC refinery
  output, pirate-faction replacement supply, and a closed-loop mobilization
  controller that scales logistics and industry when losses outpace recovery.
- Witnessable combat, pirate activity, security responses, losses, and the
  resulting replacement demand.
- Per-player faction hostility, standing-based shoot-on-sight behavior, and
  player kill credit for living-faction losses.
- Corporation-visible industrial crews with Local and corporation-chat
  presence, friendly relationship projection, pooled defensive drones, and
  durable crew-level navigation.
- Bounded schedulers, physical-ship caps, durable state, economy telemetry, and
  performance admission controls.
- Separately gated estate, wormhole, live-event, and X-Eve experimental
  systems; the installed play profile enables the verified public set.

Read [Architecture](docs/ARCHITECTURE.md) for the simulation model.

## Repository contents

- `patches/files/` - the overlay content tree: the exact bytes of every file
  the patch adds or modifies (split by path instead of one monolithic diff).
- `patches/docker-overlay/` - Docker deployment adaptation files applied after
  the main overlay.
- `patches/manifest.json` - v2 release manifest: expected baseline and
  installed SHA-256/size for every touched file, plus the supported EveJS
  archive checksum. Generated by `make manifest`.
- `patches/modules.json` - module index: which file belongs to which subsystem
  (see [docs/MODULES.md](docs/MODULES.md)). Generated by `make modules`.
- `cmd/` and `internal/` - the `xeve-patch` Go CLI source.
- `Makefile` - build, cross-compile, manifest generation, test, and release
  helpers.
- `legacy/` - the v0.2.3 PowerShell installer and its patch data, retained for
  migration and fallback only.
- `docs/` - public installation, configuration, architecture, and performance
  notes.
- `CHANGELOG.md` - release history.

No patched server tree is stored here. Runtime data and private deployment
details do not belong in this repository.

## Project and trademark notice

This project is independent and is not affiliated with, endorsed by, or
sponsored by CCP Games or any upstream server project. EVE Online and all
related names, logos, marks, and game assets are the property of their
respective owners; EVE-related trademarks belong to CCP Games. No CCP client,
assets, or server baseline are redistributed here.

The license in [LICENSE](LICENSE) applies only to original contributions in
this patch repository. It does not grant rights to any compatible server
baseline, EVE Online, or other third-party material.
