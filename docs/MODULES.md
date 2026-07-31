# X-Eve Living Universe — Module map

The patch ships as **one release** but is internally organized into **modules**.
Each module is an independently toggleable subsystem with its own feature gate
in `evejs.config.x-eve.json`, its own overlay files, its own verification
scripts, and its own ops tools.

The authoritative machine-readable index is `patches/modules.json`, generated
by `make modules` (the `xeve-patch modules generate` command; the classifier
lives in `internal/modules/classify.go`). The index is pure metadata: it never
moves files and never changes hashes. Every file in
`patches/files/` belongs to exactly one module, and every module is installed
by default.

```
xeve-patch modules                     # summary of all modules
xeve-patch modules --module economy    # files of one module
xeve-patch modules --json              # raw index
```

The release manifest (`patches/manifest.json`, schema v3) also carries the
module assignment on every file entry, so it is self-contained for module
queries. `make manifest` regenerates the module index and then the manifest in
one step.

## Modules

| Module | Feature gate | Files | Verify | Ops | What it is |
| --- | --- | ---: | ---: | ---: | --- |
| `core` | *(always installed)* | 46 | 0 | 0 | Shared platform: launchers, config, gameStore persistence, chat infrastructure, main space tick, destiny/movement, networking, image/web gateways, general NPC engine |
| `livingUniverse` | `livingUniverseEnabled` | 12 | 11 | 1 | Persistent NPC pilots, virtual travel, observed materialization, portraits, affiliations, ambient traffic |
| `livingEconomy` | `livingEconomyEnabled` | 24 | 17 | 8 | Regional stock, mining, hauling, procurement, production, market topology, Rust market daemon changes |
| `livingConflict` | `livingConflictEnabled` | 11 | 8 | 1 | Witnessable combat, faction hostility, kill credit, replacement demand, roaming conflicts, security responses |
| `industrialHirelings` | `industrialHirelingsEnabled` | 18 | 6 | 1 | Corporation-visible industrial crews, mining crews, pooled drones, employee projection, contracts |
| `familyEstate` | `familyEstateEnabled` | 13 | 6 | 0 | Shared-corporation estate, restoration flow, estate wormhole conduits/signatures |
| `liveEvents` | `liveEventsEnabled` | 7 | 3 | 0 | Deadline-driven event framework and definitions |
| `xEve` | `xEveEnabled` | 6 | 2 | 1 | Experimental economic kernel, ledger, event circuit, load governor, adaptive scheduler |

## File kinds inside a module

- **Overlay files** (`files`) — server sources and data that the patch adds or
  modifies.
- **Verify scripts** (`verify`) — `server/scripts/verify*.js` tests, one per
  behavior. They run in isolated `node` processes (they set conflicting
  `process.env` gates at load time and cannot be merged). Run them through the
  CLI:

  ```bash
  xeve-patch verify <evejs-path> --module livingEconomy   # one module's tests
  xeve-patch verify <evejs-path> --tests                  # all modules' tests
  xeve-patch verify <evejs-path> --module liveEvents --filter Deadline
  ```

  Headless unit tests pass on a freshly installed tree; integration scripts
  that load `node_modules` or the local database need the normal first launch
  first (same rule as the legacy `-RunTests`). A failing script exits nonzero.
- **Ops scripts** (`scripts`) — `server/scripts/` maintenance tools
  (bootstrap, repair, sync, migrate, inspect, audit). Destructive or
  one-off; never run automatically.

## Cross-cutting files

The `core` module owns files that many subsystems depend on
(`server/src/space/runtime.js`, `server/src/config/index.js`,
`server/src/gameStore/sqliteStore.js`, chat infrastructure, the general NPC
engine, launchers, and the Docker overlay). Because these are shared, module
selection (a future `install --modules`) can never be a pure file subset; the
core closure is always installed and the baseline is always verified in full.

## Relationship to feature gates

`evejs.config.x-eve.json` is the runtime switchboard: each non-core module
gate defaults to `true`, and dependent settings are inert while their parent
gate is off. Turning off a gate at runtime does not remove files; the module
index describes file ownership, not runtime state.

`xeve-patch modules <evejs-path>` shows which modules are effectively enabled
for a given tree, applying `evejs.config.x-eve.local.json` overrides:

```
[x] core              46 files  (always installed)
[x] livingUniverse    24 files  gate: livingUniverseEnabled
[ ] liveEvents        10 files  gate: liveEventsEnabled
```

## Why selective install is not supported

`xeve-patch install --modules <...>` is deliberately out of scope:

- The baseline is always verified in full before any install, because a
  modified tree is unsafe regardless of which modules are selected.
- The overlay is only a few megabytes; skipping part of the copy saves almost
  nothing.
- Partial install would force every combination of modules to be tested and
  would make uninstall/repair/verify module-aware.
- Runtime feature gates already provide the real capability: to run only some
  subsystems, set the other gates to `false` in
  `evejs.config.x-eve.local.json`. No reinstall needed.

## Adding a file to the mod

1. Add or change the file under `patches/files/` (or
   `patches/docker-overlay/` for Docker layer files), keeping the upstream
   EveJS-relative path.
2. If it is a new file, classify it in `internal/modules/classify.go` by
   adding a prefix rule (or an explicit path) for its module.
3. Regenerate everything:
   ```bash
   make manifest     # regenerates patches/modules.json, then manifest v3
   make check        # gofmt, vet, test, audit
   ```
4. `make check` fails if a manifest file has no module assignment, so a new
   file can never ship unclassified.
