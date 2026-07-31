# Scripts

## Test-PatchRepository.ps1

Release-package audit used by CI. It validates that the repository contains only
the X-Eve delta and its public tooling:

- No full EveJS source or runtime trees are present or tracked.
- Exactly one canonical text patch with a clean payload.
- Release manifests are valid and consistent.

This script is **manifest-driven**: it does not require an EveJS dependency tree
to run, and it never reads `tmp/`.

## Local development

`tmp/` is a local, untracked working directory. It is not part of the release
package and is ignored by the audit.

Put a clean upstream EveJS baseline here for local install/verify testing:

```powershell
# From the repository root
mkdir tmp
# Extract the clean EveJS archive into tmp/EveJS-v0.12.3.1
```

Then test the installer against that tree:

```powershell
installer\Install-XEvePatch.ps1 -EveJSPath 'C:\path\to\repo\tmp\EveJS-v0.12.3.1'
installer\Verify-XEvePatch.ps1 -EveJSPath 'C:\path\to\repo\tmp\EveJS-v0.12.3.1'
```

`tmp/` is never committed. `git clean -fdX tmp` removes it.
