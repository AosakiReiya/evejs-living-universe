# Installation

This repository contains a patch (as an overlay content tree plus a release
manifest) and its Go CLI, not a complete game server. Obtain the compatible
base independently.

## Requirements

- A `xeve-patch` binary for your platform (from the release zip, or built with
  `make build`).
- A clean, separately obtained compatible v0.12.3.1 server tree.
- Node.js, Rust, and the Visual Studio C++ Build Tools required by EveJS's
  standalone market service.
- A backup of any configuration, databases, certificates, and world state you
  intend to keep.

The CLI does not download the server baseline or an EVE client. It does not
configure a public server, firewall, DNS, certificates, or client connection
profile. It does not require Git on the target host.

## 1. Verify the base archive

The v0.12.3.1 archive used for this patch has this SHA-256:

```text
1DEB61A51F808D9F2B330214DA64EC297D9EE5F96EE4B8265692A65F35EEFC1E
```

Verify your independently obtained archive:

```powershell
Get-FileHash -Algorithm SHA256 'C:\Downloads\EveJS-v0.12.3.1.zip'
```

The hash must match exactly. A filename alone is not proof of compatibility.
If it differs, stop rather than forcing the patch.

## 2. Prepare a clean copy

Extract the archive to a new directory. Do not point the CLI at:

- a running server;
- an installation containing unrelated source edits;
- a directory from another server release;
- your only copy of important databases or configuration.

Stop the game server, market service, and related tools before installing. The
CLI checks the expected v0.12.3.1 file hashes and the absence of patch-added
paths before it writes anything.

## 3. Install

Unpack the release zip and run `xeve-patch` from the extracted folder (it finds
its `patches/` data next to the binary). Double-click the executable for the
interactive menu, or use the command line:

```bash
xeve-patch install "C:\Games\EveJS-v0.12.3.1"
```

The CLI:

1. resolves and validates the target (refusing symlinks, the filesystem root,
   and non-EveJS trees);
2. checks the exact supported baseline;
3. rejects an existing patch installation or conflicting added paths;
4. backs up modified originals under
   `_local/x-eve-patch/backups/<timestamp>` inside the target;
5. applies the overlay content tree from `patches/files/` and then the Docker
   overlay from `patches/docker-overlay/`;
6. verifies installed-file hashes and runtime static-data references; and
7. automatically rolls back to the verified baseline if installation fails.

The backup and install record are local operational data. Do not commit the
target's `_local` directory to a public repository.

## 4. Verify

Run the non-mutating installed-file verification:

```bash
xeve-patch verify "C:\Games\EveJS-v0.12.3.1"
```

On an uninstalled tree the same command validates the clean baseline instead.
To validate the release data itself (every overlay file matches its manifest
hash), run:

```bash
xeve-patch verify --integrity
```

A file-integrity pass confirms that the expected patch is present and that
every static GameStore data path referenced by patched runtime code exists.

### Running the bundled verification scripts

After the regular first launch has installed server dependencies and created
the local database, run the patch's own `server/scripts/verify*.js` tests. They
execute in isolated `node` processes, grouped by subsystem module:

```bash
xeve-patch verify "C:\Games\EveJS-v0.12.3.1" --module livingEconomy
xeve-patch verify "C:\Games\EveJS-v0.12.3.1" --tests          # all modules
xeve-patch verify "C:\Games\EveJS-v0.12.3.1" --module liveEvents --filter Deadline
```

Headless unit tests also pass on a freshly installed tree; any script that
fails exits nonzero. See [Module map](MODULES.md).

## 5. Repair

If a patched file was edited or deleted, restore the exact installed state:

```bash
xeve-patch repair "C:\Games\EveJS-v0.12.3.1"
```

This re-applies overlay content from the release package and re-verifies.

## 6. Start with the regular player launcher

Complete the normal EveJS client setup once, then double-click the root
`Play.bat`. If EveJS is not already running, the ordinary launcher starts
`StartServer.bat` in the background. The server path starts its market
dependency and waits for the installed 5,000-pilot Living Universe, X-Eve,
market stock cache, and proxy before the client opens.

No X-Eve-specific player launcher is installed. The first regular launch may
take several minutes because it creates the Jita + New Caldari base market,
synchronizes NPC-station topology, and compiles the market service. Living
Economy then creates only missing raw-mineral rows at its 37 regional hubs.
This is automatic: do not run `bootstrapLivingEconomyMarket.js` for normal
play. Existing and depleted stock rows, player orders, and market history are
preserved. Later regular launches rebuild the market service only when its
sources change.

If startup reports a missing Rust or C++ toolchain, run
`tools\InstallRustForMarket.bat` once and then use `Play.bat` again.

The installed public profile uses normal 1x simulation timing. Local chat lists
pilots currently present in the player's system; it does not place all 5,000
pilots in one Local channel.

The verified `evejs.config.x-eve.json` file supplies that play profile. Do not
edit it directly. Put personal feature or capacity overrides in an optional
`evejs.config.x-eve.local.json` at the server root. That private file and the
ordinary mutable `evejs.config.local.json` are not owned by the patch, so
normal configuration changes do not invalidate patch verification.

## Uninstall

Stop the server and run:

```bash
xeve-patch uninstall "C:\Games\EveJS-v0.12.3.1"
```

Uninstall is deliberately conservative. If a patched file has changed since
installation, it refuses to overwrite that work. For an unchanged install it
restores backed-up originals, removes unchanged patch-added files, and removes
the local install record.

Back up world state separately. Removing source changes is not the same as
reversing database migrations or simulated economic activity produced while the
patch was running.

## Upgrading from v0.2.3 (PowerShell installer)

Trees installed by the v0.2.3 PowerShell installer carry an old-format install
record. Uninstall them with the retained legacy scripts before installing
v0.3.0:

```powershell
powershell -ExecutionPolicy Bypass -File .\legacy\Uninstall-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.3.1'
```

Then install with `xeve-patch` normally. See [legacy](../legacy/README.md).

## Installation refusal is a safety result

Do not bypass a baseline, hash, added-path, or changed-file refusal. Extract a
fresh v0.12.3.1 copy, verify its archive hash, and try again. Manual partial
application makes later verification and uninstall unreliable.
