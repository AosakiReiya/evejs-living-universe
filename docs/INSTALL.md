# Installation

This repository contains a source patch and its installer, not a complete game
server. Obtain the compatible base independently.

## Requirements

- Windows with PowerShell 5.1 or newer.
- Git for Windows available on `PATH`.
- A clean, separately obtained compatible v0.12.3 server tree.
- Node.js, Rust, and the Visual Studio C++ Build Tools required by EveJS's
  standalone market service.
- A backup of any configuration, databases, certificates, and world state you
  intend to keep.

The installer does not download the server baseline or an EVE client. It does not configure a
public server, firewall, DNS, certificates, or client connection profile.

## 1. Verify the base archive

The v0.12.3 archive used for this patch has this SHA-256:

```text
81E2B48DE1E55D8FAD413137F83FF26C7FEB4FFA943825093FFC1BB17468D27E
```

Verify your independently obtained archive:

```powershell
Get-FileHash -Algorithm SHA256 'C:\Downloads\EveJS-v0.12.3.zip'
```

The hash must match exactly. A filename alone is not proof of compatibility.
If it differs, stop rather than forcing the patch.

## 2. Prepare a clean copy

Extract the archive to a new directory. Do not point the installer at:

- a running server;
- an installation containing unrelated source edits;
- a directory from another server release;
- your only copy of important databases or configuration.

Stop the game server, market service, and related tools before installing. The
installer checks the expected v0.12.3 file hashes and the absence of patch-added
paths before it writes anything.

## 3. Apply the single patch

From the root of this patch repository, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Install-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.3'
```

Or use the wrapper:

```bat
installer\Install.bat "C:\Games\EveJS-v0.12.3"
```

The installer:

1. resolves and validates the target;
2. checks the exact supported baseline;
3. rejects an existing patch installation or conflicting added paths;
4. backs up modified originals under
   `_local/x-eve-patch/backups/<timestamp>` inside the target;
5. runs a dry patch check before applying anything;
6. applies the one versioned patch;
7. verifies installed-file hashes; and
8. automatically rolls back if installation fails.

The backup and install record are local operational data. Do not commit the
target's `_local` directory to a public repository.

## 4. Verify

Run the non-mutating installed-file verification:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Verify-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.3'
```

The wrapper form is:

```bat
installer\Verify.bat "C:\Games\EveJS-v0.12.3"
```

To include the patch's test suite after normal server dependencies are
installed:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\Verify-XEvePatch.ps1 `
  -EveJSPath 'C:\Games\EveJS-v0.12.3' -RunTests
```

Or:

```bat
installer\Verify.bat "C:\Games\EveJS-v0.12.3" --run-tests
```

A file-integrity pass confirms that the expected patch is present. A test pass
also exercises the bundled server-side verification scripts. Run the ordinary
`Play.bat` once first so EveJS has installed its server dependencies and created
the local database, then stop the server before using `--run-tests`. The
living-economy integration check runs only when market RPC is available.

## 5. Start with the regular player launcher

Complete the normal EveJS client setup once, then double-click the root
`Play.bat`. If EveJS is not already running, the ordinary launcher starts
`StartServer.bat` in the background. The server path starts its market
dependency and waits for the installed 5,000-pilot Living Universe, X-Eve,
market stock cache, and proxy before the client opens.

No X-Eve-specific player launcher is installed. The first regular launch may
take several minutes because it creates the Jita + New Caldari market seed and
compiles the market service when those artifacts are absent. If it reports a
missing Rust or C++ toolchain, run `tools\InstallRustForMarket.bat` once and
then use `Play.bat` again.

The installed public profile uses normal 1x simulation timing. Local chat lists
pilots currently present in the player's system; it does not place all 5,000
pilots in one Local channel.

The verified `evejs.config.x-eve.json` file supplies that play profile. Do not
edit it directly. Put personal feature or capacity overrides in an optional
`evejs.config.x-eve.local.json` at the server root. That private file and the
ordinary mutable `evejs.config.local.json` are not owned by the patch, so
normal configuration changes do not invalidate patch verification.

## Upgrade from an earlier patch release

Each release records the exact canonical-patch hash it installed. Before
installing a newer release, stop the server and run the uninstaller from the
same repository release that performed the current installation. Back up any
intentional source changes first.

Do not use a newer release's uninstaller to remove an older release and do not
overwrite the local install record. After the old release has been cleanly
removed, apply the newer release to the restored compatible baseline. If the
old uninstaller reports changed files, preserve those changes and resolve them
deliberately instead of forcing an overwrite.

## Uninstall

Stop the server and run:

```bat
installer\Uninstall.bat "C:\Games\EveJS-v0.12.3"
```

Uninstall is deliberately conservative. If a patched file has changed since
installation, it refuses to overwrite that work. For an unchanged install it
restores backed-up originals, removes unchanged patch-added files, and removes
the local install record.

Back up world state separately. Removing source changes is not the same as
reversing database migrations or simulated economic activity produced while the
patch was running.

## Installation refusal is a safety result

Do not bypass a baseline, hash, added-path, or changed-file refusal. Extract a
fresh v0.12.3 copy, verify its archive hash, and try again. Manual partial
application makes later verification and uninstall unreliable.
