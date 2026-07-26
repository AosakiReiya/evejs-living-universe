# X-Eve Living Universe

X-Eve Living Universe is an independent source patch for a compatible v0.12.3
server baseline. It adds a persistent virtual NPC population, regional
economic activity, materialized traffic around players, conflict, industry,
logistics, and supporting performance controls.

> This is a patch-only repository, not a runnable server distribution.
> It contains neither the compatible server baseline nor an EVE client, CCP assets,
> databases, certificates, generated portraits, or private server
> configuration. Obtain a compatible base independently and apply the patch to
> your own clean copy.

`v0.1.0` is the first public release for the exact EveJS v0.12.3 compatible
baseline. Back up any installation and world data before applying the patch.

X Command is intentionally not included in this repository. The Living
Universe core keeps the industrial-crew services and adapter-neutral command
seams that a separate X Command package can use later, without coupling this
patch to its web interface, API, authentication, or account-linking layer.

## Compatibility

The current patch targets one exact **v0.12.3 compatible server baseline**. The
independently obtained archive used to build and verify this release has this
SHA-256:

```text
81E2B48DE1E55D8FAD413137F83FF26C7FEB4FFA943825093FFC1BB17468D27E
```

Check an archive in PowerShell with:

```powershell
Get-FileHash -Algorithm SHA256 'C:\path\to\EveJS-v0.12.3.zip'
```

Do not apply the patch to another server version, an already modified tree, or
your only working copy. The installer validates the expected v0.12.3 baseline
before changing anything and stops on a mismatch.

## Install

You need Git for Windows, PowerShell, Node.js, Rust, and the Visual Studio C++
Build Tools used by EveJS's standalone market service. Stop the server and its
supporting services, extract a clean v0.12.3 base, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Install-XEvePatch.ps1 `
  -EveJSPath 'C:\path\to\EveJS-v0.12.3'
```

The installer applies the single versioned patch, verifies the result, and
rolls back automatically if an installation step fails. The batch-file wrapper
is equivalent:

```bat
installer\Install.bat "C:\path\to\EveJS-v0.12.3"
```

Verify the installation separately with:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Verify-XEvePatch.ps1 `
  -EveJSPath 'C:\path\to\EveJS-v0.12.3'
```

See [Installation](docs/INSTALL.md) for backup, verification, test, and
uninstall details.

## Start normally

The patch installs its public Living Universe profile as part of EveJS. After
the usual EveJS client setup, double-click the ordinary root `Play.bat`.
If the server is not running, `Play.bat` starts the normal `StartServer.bat`
path automatically. That path starts the market dependency, the EveJS server,
and then waits for the 5,000-pilot universe, X-Eve, market stock cache, and
proxy before launching the client.

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

## What the patch adds

- Persistent NPC pilots with affiliations, roles, racial doctrines, loadouts,
  local presence, and portrait support.
- Deadline-driven virtual travel across the universe, with ships materialized
  only where players can observe them.
- Mining, freight, procurement, regional stock, manufacturing, and market flows
  designed around conserved inputs and completed deliveries.
- Witnessable combat, pirate activity, security responses, losses, and the
  resulting replacement demand.
- Bounded schedulers, physical-ship caps, durable state, economy telemetry, and
  performance admission controls.
- Separately gated estate, wormhole, live-event, and X-Eve experimental
  systems; the installed play profile enables the verified public set.

Read [Architecture](docs/ARCHITECTURE.md) for the simulation model.

## Repository contents

- `patches/v0.12.3/x-eve-living-universe-v0.1.0.patch` - the single
  versioned source patch.
- `installer/` - baseline validation, installation, verification, rollback, and
  uninstall helpers.
- `docs/` - public installation, configuration, architecture, and performance
  notes.

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
