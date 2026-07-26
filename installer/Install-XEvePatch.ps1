[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$EveJSPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ReleaseName = 'X-Eve Living Universe'
$ReleaseVersion = 'v0.1.0-pre4'
$BaselineVersion = 'v0.12.3'
$ExpectedArchiveSha256 = '81E2B48DE1E55D8FAD413137F83FF26C7FEB4FFA943825093FFC1BB17468D27E'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step {
    param([string]$Message)
    Write-Host "[X-Eve] $Message"
}

function Get-CanonicalDirectory {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'EveJSPath must be supplied explicitly.'
    }

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) {
        throw "EveJSPath is not a directory: $Path"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "EveJSPath cannot be a junction or symbolic link: $($item.FullName)"
    }

    $full = [System.IO.Path]::GetFullPath($item.FullName).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $root = [System.IO.Path]::GetPathRoot($full).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if ([string]::Equals($full, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to use a filesystem root as EveJSPath: $full"
    }

    $userProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if (-not [string]::IsNullOrWhiteSpace($userProfilePath)) {
        $userProfilePath = [System.IO.Path]::GetFullPath($userProfilePath).TrimEnd(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        if ([string]::Equals($full, $userProfilePath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to use the user profile directory as EveJSPath: $full"
        }
    }

    return $full
}

function Assert-EveJSSentinel {
    param([string]$TargetRoot)

    $packagePath = Join-Path $TargetRoot 'server\package.json'
    $serverEntryPath = Join-Path $TargetRoot 'server\index.js'
    $marketPath = Join-Path $TargetRoot 'externalservices\market-server'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $serverEntryPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $marketPath -PathType Container)) {
        throw "The selected directory does not have the expected EveJS layout. Required sentinels: server\package.json, server\index.js, and externalservices\market-server."
    }

    try {
        $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "The EveJS package sentinel is not valid JSON: $packagePath"
    }
    if ([string]$package.name -ne 'eve.js') {
        throw "The package sentinel does not identify EveJS (expected package name 'eve.js'): $packagePath"
    }
}

function Assert-GitAvailable {
    $command = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command git -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        throw 'Git for Windows is required, but git.exe was not found on PATH.'
    }
    return $command.Source
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Assert-Sha256Text {
    param(
        [AllowNull()][object]$Value,
        [string]$Description,
        [switch]$AllowEmpty
    )

    $text = if ($null -eq $Value) { '' } else { [string]$Value }
    if ($AllowEmpty -and [string]::IsNullOrWhiteSpace($text)) {
        return ''
    }
    if ($text -notmatch '^[0-9a-fA-F]{64}$') {
        throw "$Description is not a valid SHA-256 value."
    }
    return $text.ToUpperInvariant()
}

function Read-JsonFile {
    param(
        [string]$Path,
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "$Description is not valid JSON: $Path"
    }
}

function Get-ObjectProperty {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) {
        return $null
    }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property) {
            return $property.Value
        }
    }
    return $null
}

function Get-BaselineArchiveSha256 {
    param([object]$Manifest)

    $value = Get-ObjectProperty $Manifest @(
        'sourceArchiveSha256',
        'archiveSha256',
        'upstreamArchiveSha256',
        'baselineArchiveSha256'
    )
    if ($null -eq $value) {
        foreach ($containerName in @('compatibility', 'sourceArchive', 'archive', 'source', 'baselineArchive')) {
            $container = Get-ObjectProperty $Manifest @($containerName)
            $value = Get-ObjectProperty $container @('sha256', 'archiveSha256')
            if ($null -ne $value) {
                break
            }
        }
    }
    return Assert-Sha256Text $value 'The baseline archive SHA-256 metadata'
}

function ConvertTo-SafeRelativePath {
    param([object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        throw 'A manifest contains an empty file path.'
    }
    $path = ([string]$Value).Replace('\', '/')
    if ($path.StartsWith('/') -or $path.StartsWith('\\') -or $path -match '^[A-Za-z]:') {
        throw "A manifest path must be relative: $path"
    }
    $segments = $path.Split('/')
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw "A manifest path contains an unsafe segment: $path"
        }
        if ($segment.IndexOf(':') -ge 0 -or $segment.IndexOf([char]0) -ge 0) {
            throw "A manifest path contains an unsafe character: $path"
        }
    }

    # Runtime state and secrets are never valid patch targets. The one authored
    # gameStore JSON file is source-controlled simulation content, not a live DB.
    if ($path -match '(?i)^_local/' -or
        $path -match '(?i)(^|/)(certs?|logs?)(/|$)' -or
        $path -match '(?i)(^|/)\.env(?:\.|$)' -or
        $path -match '(?i)\.sqlite(?:\d+)?(?:$|[-.])' -or
        ($path -match '(?i)^server/src/gameStore/data/' -and
            $path -ne 'server/src/gameStore/data/liveEventDefinitions/data.json')) {
        throw "The patch manifest attempts to touch protected runtime data, certificates, logs, or secrets: $path"
    }
    return $path
}

function Resolve-TargetChild {
    param(
        [string]$TargetRoot,
        [string]$RelativePath
    )

    $nativeRelative = $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $TargetRoot $nativeRelative))
    $prefix = $TargetRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "A manifest path escapes EveJSPath: $RelativePath"
    }
    return $candidate
}

function Assert-NoReparsePoint {
    param(
        [string]$TargetRoot,
        [string]$Candidate
    )

    $relative = $Candidate.Substring($TargetRoot.Length).TrimStart('\', '/')
    $current = $TargetRoot
    if (-not [string]::IsNullOrEmpty($relative)) {
        foreach ($segment in $relative.Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
            $current = Join-Path $current $segment
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Refusing to traverse a junction or symbolic link: $current"
                }
            }
        }
    }
}

function New-ManifestMap {
    param(
        [object]$Manifest,
        [string]$Description,
        [switch]$Installed
    )

    $filesProperty = $Manifest.PSObject.Properties['files']
    if ($null -eq $filesProperty) {
        throw "$Description does not contain a files array."
    }
    $records = @($filesProperty.Value)
    if ($records.Count -eq 0) {
        throw "$Description has an empty files array."
    }

    $map = @{}
    foreach ($record in $records) {
        $path = ConvertTo-SafeRelativePath (Get-ObjectProperty $record @('path'))
        if ($map.ContainsKey($path)) {
            throw "$Description contains a duplicate path: $path"
        }
        $kind = ([string](Get-ObjectProperty $record @('kind'))).ToLowerInvariant()
        if ($kind -ne 'modified' -and $kind -ne 'added') {
            throw "$Description has an unsupported kind '$kind' for $path. Only modified and added are permitted."
        }

        $sizeValue = Get-ObjectProperty $record @('size')
        $size = 0L
        if ($null -ne $sizeValue) {
            try { $size = [Convert]::ToInt64($sizeValue) } catch { throw "$Description has an invalid size for $path." }
        }
        if ($size -lt 0) {
            throw "$Description has a negative size for $path."
        }

        $shaValue = Get-ObjectProperty $record @('sha256')
        if ($Installed -or $kind -eq 'modified') {
            $sha = Assert-Sha256Text $shaValue "$Description SHA-256 for $path"
        }
        else {
            $sha = Assert-Sha256Text $shaValue "$Description SHA-256 for added path $path" -AllowEmpty
        }

        $map[$path] = [pscustomobject]@{
            path = $path
            sha256 = $sha
            size = $size
            kind = $kind
        }
    }
    return $map
}

function Assert-ManifestPair {
    param(
        [hashtable]$BaselineMap,
        [hashtable]$InstalledMap
    )

    if ($BaselineMap.Count -ne $InstalledMap.Count) {
        throw 'Baseline and installed manifests do not describe the same number of files.'
    }
    foreach ($path in $BaselineMap.Keys) {
        if (-not $InstalledMap.ContainsKey($path)) {
            throw "Installed manifest is missing the baseline path: $path"
        }
        if ($BaselineMap[$path].kind -ne $InstalledMap[$path].kind) {
            throw "Manifest kind mismatch for $path."
        }
    }
}

function Get-PatchPaths {
    param([string]$PatchPath)

    $map = @{}
    foreach ($line in [System.IO.File]::ReadLines($PatchPath)) {
        if (-not $line.StartsWith('diff --git ')) {
            continue
        }
        if ($line -notmatch '^diff --git a/([^ ]+) b/([^ ]+)$') {
            throw "The patch contains an unsupported or ambiguous diff header: $line"
        }
        $oldPath = ConvertTo-SafeRelativePath $Matches[1]
        $newPath = ConvertTo-SafeRelativePath $Matches[2]
        if ($oldPath -ne $newPath) {
            throw "Renames are not supported by this installer: $oldPath -> $newPath"
        }
        if ($map.ContainsKey($oldPath)) {
            throw "The patch contains a duplicate diff for $oldPath."
        }
        $map[$oldPath] = $true
    }
    if ($map.Count -eq 0) {
        throw 'The patch contains no diff entries.'
    }
    return $map
}

function Assert-PatchMatchesManifest {
    param(
        [hashtable]$PatchPaths,
        [hashtable]$InstalledMap
    )

    if ($PatchPaths.Count -ne $InstalledMap.Count) {
        throw 'The patch and installed manifest contain different numbers of paths.'
    }
    foreach ($path in $PatchPaths.Keys) {
        if (-not $InstalledMap.ContainsKey($path)) {
            throw "The patch contains an unmanifested path: $path"
        }
    }
}

function Invoke-GitApply {
    param(
        [string]$GitPath,
        [string]$TargetRoot,
        [string]$PatchPath,
        [switch]$CheckOnly
    )

    # The release manifests describe exact installed bytes. Ignore a user's
    # global autocrlf preference so applying the same patch is deterministic.
    $arguments = @('-c', 'core.autocrlf=false', '-C', $TargetRoot, 'apply')
    if ($CheckOnly) {
        $arguments += '--check'
    }
    $arguments += @('--whitespace=nowarn', '--', $PatchPath)

    $previousPreference = $ErrorActionPreference
    try {
        $script:ErrorActionPreference = 'Continue'
        $output = @(& $GitPath @arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $script:ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        $detail = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        throw "git apply failed with exit code $exitCode.`n$detail"
    }
}

function Assert-BaselineFiles {
    param(
        [string]$TargetRoot,
        [hashtable]$BaselineMap
    )

    foreach ($path in ($BaselineMap.Keys | Sort-Object)) {
        $record = $BaselineMap[$path]
        $targetPath = Resolve-TargetChild $TargetRoot $path
        Assert-NoReparsePoint $TargetRoot $targetPath
        if ($record.kind -eq 'added') {
            if (Test-Path -LiteralPath $targetPath) {
                throw "The patch expects to add a path that already exists: $path"
            }
            continue
        }
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "A required v0.12.3 baseline file is missing: $path"
        }
        $item = Get-Item -LiteralPath $targetPath -Force
        if ([int64]$item.Length -ne [int64]$record.size) {
            throw "Baseline size mismatch for $path (expected $($record.size), found $($item.Length))."
        }
        $actualSha = Get-Sha256 $targetPath
        if ($actualSha -ne $record.sha256) {
            throw "Baseline SHA-256 mismatch for $path. The file is modified or is not from the supported EveJS v0.12.3 archive."
        }
    }
}

function Assert-InstalledFiles {
    param(
        [string]$TargetRoot,
        [hashtable]$InstalledMap
    )

    foreach ($path in ($InstalledMap.Keys | Sort-Object)) {
        $record = $InstalledMap[$path]
        $targetPath = Resolve-TargetChild $TargetRoot $path
        Assert-NoReparsePoint $TargetRoot $targetPath
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "Installed file is missing after patch application: $path"
        }
        $item = Get-Item -LiteralPath $targetPath -Force
        if ([int64]$item.Length -ne [int64]$record.size) {
            throw "Installed size mismatch for $path (expected $($record.size), found $($item.Length))."
        }
        $actualSha = Get-Sha256 $targetPath
        if ($actualSha -ne $record.sha256) {
            throw "Installed SHA-256 mismatch for $path."
        }
    }
}

function Copy-BaselineBackups {
    param(
        [string]$TargetRoot,
        [string]$BackupRoot,
        [hashtable]$BaselineMap
    )

    foreach ($path in ($BaselineMap.Keys | Sort-Object)) {
        $record = $BaselineMap[$path]
        if ($record.kind -ne 'modified') {
            continue
        }
        $sourcePath = Resolve-TargetChild $TargetRoot $path
        $backupPath = Resolve-TargetChild $BackupRoot $path
        $backupParent = Split-Path -Parent $backupPath
        [System.IO.Directory]::CreateDirectory($backupParent) | Out-Null
        [System.IO.File]::Copy($sourcePath, $backupPath, $false)
        if ((Get-Sha256 $backupPath) -ne $record.sha256) {
            throw "Backup verification failed for $path."
        }
    }
}

function Remove-EmptyParentDirectories {
    param(
        [string]$TargetRoot,
        [string]$FilePath
    )

    $directory = Split-Path -Parent $FilePath
    while (-not [string]::IsNullOrWhiteSpace($directory) -and
        -not [string]::Equals($directory, $TargetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            $directory = Split-Path -Parent $directory
            continue
        }
        if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) {
            break
        }
        [System.IO.Directory]::Delete($directory, $false)
        $directory = Split-Path -Parent $directory
    }
}

function Restore-Baseline {
    param(
        [string]$TargetRoot,
        [string]$BackupRoot,
        [hashtable]$BaselineMap
    )

    foreach ($path in ($BaselineMap.Keys | Sort-Object)) {
        $record = $BaselineMap[$path]
        $targetPath = Resolve-TargetChild $TargetRoot $path
        if ($record.kind -eq 'modified') {
            $backupPath = Resolve-TargetChild $BackupRoot $path
            if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
                throw "Cannot roll back because the baseline backup is missing: $path"
            }
            [System.IO.File]::Copy($backupPath, $targetPath, $true)
        }
        elseif (Test-Path -LiteralPath $targetPath) {
            if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
                throw "Cannot roll back added path because it is no longer a regular file: $path"
            }
            [System.IO.File]::Delete($targetPath)
            Remove-EmptyParentDirectories $TargetRoot $targetPath
        }
    }
    Assert-BaselineFiles $TargetRoot $BaselineMap
}

function Write-JsonAtomically {
    param(
        [string]$Path,
        [object]$Value
    )

    $temporaryPath = "$Path.tmp.$([Guid]::NewGuid().ToString('N'))"
    try {
        $json = $Value | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, $Utf8NoBom)
        [System.IO.File]::Move($temporaryPath, $Path)
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            [System.IO.File]::Delete($temporaryPath)
        }
    }
}

$installerRoot = Split-Path -Parent $PSCommandPath
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $installerRoot '..'))
$patchDirectory = Join-Path $releaseRoot 'patches\v0.12.3'
$patchPath = Join-Path $patchDirectory 'x-eve-living-universe-v0.1.0-pre4.patch'
$baselineManifestPath = Join-Path $patchDirectory 'baseline-manifest.json'
$installedManifestPath = Join-Path $patchDirectory 'installed-manifest.json'

$targetRoot = Get-CanonicalDirectory $EveJSPath
Assert-EveJSSentinel $targetRoot
$gitPath = Assert-GitAvailable

$baselineManifest = Read-JsonFile $baselineManifestPath 'Baseline manifest'
$installedManifest = Read-JsonFile $installedManifestPath 'Installed manifest'
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    throw "Release patch is missing: $patchPath"
}

$archiveSha256 = Get-BaselineArchiveSha256 $baselineManifest
if ($archiveSha256 -ne $ExpectedArchiveSha256) {
    throw "Baseline manifest archive SHA-256 does not identify the supported EveJS v0.12.3 archive."
}
$manifestPatchSha256 = Assert-Sha256Text (Get-ObjectProperty $installedManifest @('patchSha256')) 'Installed manifest patchSha256'
$actualPatchSha256 = Get-Sha256 $patchPath
if ($actualPatchSha256 -ne $manifestPatchSha256) {
    throw 'The release patch SHA-256 does not match installed-manifest.json.'
}

$baselineMap = New-ManifestMap $baselineManifest 'Baseline manifest'
$installedMap = New-ManifestMap $installedManifest 'Installed manifest' -Installed
Assert-ManifestPair $baselineMap $installedMap
$patchPaths = Get-PatchPaths $patchPath
Assert-PatchMatchesManifest $patchPaths $installedMap

$installRoot = Join-Path $targetRoot '_local\x-eve-patch'
$installStatePath = Join-Path $installRoot 'install.json'
$lockPath = Join-Path $installRoot 'install.lock'
Assert-NoReparsePoint $targetRoot $installRoot
if (Test-Path -LiteralPath $installStatePath) {
    throw "An X-Eve installation state already exists. Verify or uninstall it before installing again: $installStatePath"
}

# Windows PowerShell 5.1 can fail legacy file-copy calls beyond the classic
# path limit even when the source tree itself is readable. Refuse before
# creating a partial backup and tell the operator to use a shorter install
# location (for example D:\EveJS).
$longestModifiedPath = @(
    $baselineMap.Values |
        Where-Object { $_.kind -eq 'modified' } |
        Sort-Object { $_.path.Length } -Descending
)[0].path.Replace('/', '\')
$projectedBackupPath = Join-Path $installRoot (
    "backups\20000101T000000000Z\$longestModifiedPath"
)
if ($projectedBackupPath.Length -ge 240) {
    throw "EveJSPath is too long for a safe verified backup on Windows PowerShell. Move the clean EveJS tree to a shorter path such as D:\EveJS and retry."
}

[System.IO.Directory]::CreateDirectory($installRoot) | Out-Null
$lockStream = $null
$backupRoot = $null
$attemptedApply = $false
$installCommitted = $false

try {
    try {
        $lockStream = New-Object System.IO.FileStream(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch {
        throw "Another X-Eve patch operation appears to be running: $lockPath"
    }

    Write-Step "Checking the exact EveJS $BaselineVersion baseline"
    Assert-BaselineFiles $targetRoot $baselineMap

    Write-Step 'Checking whether Git can apply the complete patch cleanly'
    Invoke-GitApply $gitPath $targetRoot $patchPath -CheckOnly

    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $backupRoot = Join-Path $installRoot ("backups\$timestamp")
    Assert-NoReparsePoint $targetRoot $backupRoot
    [System.IO.Directory]::CreateDirectory($backupRoot) | Out-Null

    Write-Step 'Backing up only the original files that the patch modifies'
    Copy-BaselineBackups $targetRoot $backupRoot $baselineMap

    Write-Step 'Applying the release patch'
    $attemptedApply = $true
    Invoke-GitApply $gitPath $targetRoot $patchPath

    Write-Step 'Verifying every installed file'
    Assert-InstalledFiles $targetRoot $installedMap

    $stateFiles = @(
        foreach ($path in ($installedMap.Keys | Sort-Object)) {
            $record = $installedMap[$path]
            [ordered]@{
                path = $record.path
                sha256 = $record.sha256
                size = [int64]$record.size
                kind = $record.kind
            }
        }
    )
    $relativeBackupRoot = $backupRoot.Substring($installRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $installState = [ordered]@{
        schemaVersion = 1
        release = $ReleaseVersion
        baseline = $BaselineVersion
        installedAtUtc = [DateTime]::UtcNow.ToString('o')
        patchSha256 = $actualPatchSha256
        sourceArchiveSha256 = $archiveSha256
        backupRoot = $relativeBackupRoot
        files = $stateFiles
    }
    Write-JsonAtomically $installStatePath $installState
    $installCommitted = $true

    Write-Step "$ReleaseName $ReleaseVersion installed successfully."
    Write-Host "Backup: $backupRoot"
    Write-Host "Install state: $installStatePath"
}
catch {
    $primaryError = $_.Exception.Message
    $rollbackError = $null
    if ($attemptedApply -and -not $installCommitted -and $null -ne $backupRoot) {
        try {
            Write-Warning 'Installation failed; restoring the verified v0.12.3 baseline.'
            Restore-Baseline $targetRoot $backupRoot $baselineMap
            if (Test-Path -LiteralPath $installStatePath -PathType Leaf) {
                [System.IO.File]::Delete($installStatePath)
            }
            Write-Step 'Rollback completed successfully. The verified backup was retained.'
        }
        catch {
            $rollbackError = $_.Exception.Message
        }
    }
    if ($null -ne $rollbackError) {
        throw "Installation failed: $primaryError`nRollback also failed: $rollbackError`nDo not run the server until the backup is inspected: $backupRoot"
    }
    throw "Installation failed: $primaryError"
}
finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        try { [System.IO.File]::Delete($lockPath) } catch { Write-Warning "Could not remove operation lock: $lockPath" }
    }
}
