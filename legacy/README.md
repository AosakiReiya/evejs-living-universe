# Legacy v0.2.3 PowerShell installer

This directory contains the **v0.2.3 PowerShell installer** and its release
data. It is retained only for **migration and fallback**:

- Existing v0.2.3 installations that need to be removed before upgrading to the
  Go CLI (`xeve-patch`), and
- a manual recovery path if the Go CLI cannot run on the host.

**New installations must use the Go CLI (`xeve-patch`) in the repository root.**
Do not extend these scripts; they operate on the old single `.patch` +
two-manifest layout and will not be updated.

## Layout

```
legacy/
  Install-XEvePatch.ps1        # v0.2.3 install (git apply)
  Uninstall-XEvePatch.ps1      # v0.2.3 verified uninstall
  Verify-XEvePatch.ps1         # v0.2.3 verify
  Uninstall-XEvePatch-Manual.ps1
  Install.bat / Verify.bat / Uninstall.bat
  Test-PatchRepository.ps1     # v0.2.3 audit
  patches/
    x-eve-living-universe.patch
    baseline-manifest.json
    installed-manifest.json
```

The scripts resolve their release data relative to `legacy/`, so they work
unchanged from this directory:

```powershell
# Uninstall a v0.2.3 installation before upgrading to xeve-patch v0.3.0
powershell -ExecutionPolicy Bypass -File .\legacy\Uninstall-XEvePatch.ps1 `
  -EveJSPath 'C:\path\to\EveJS'
```

## Removing this directory later

Once no v0.2.3 installations remain, delete `legacy/` and drop the
`legacy/patches` data from future releases.
