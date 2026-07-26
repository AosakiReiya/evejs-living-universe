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
        throw 'The selected directory does not have the expected EveJS sentinels.'
    }
    try {
        $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw "The EveJS package sentinel is not valid JSON: $packagePath"
    }
    if ([string]$package.name -ne 'eve.js') {
        throw "The package sentinel does not identify EveJS: $packagePath"
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
    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property) { return $property.Value }
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
            if ($null -ne $value) { break }
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
    foreach ($segment in $path.Split('/')) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or
            $segment.IndexOf(':') -ge 0 -or $segment.IndexOf([char]0) -ge 0) {
            throw "A manifest path is unsafe: $path"
        }
    }
    if ($path -match '(?i)^_local/' -or
        $path -match '(?i)(^|/)(certs?|logs?)(/|$)' -or
        $path -match '(?i)(^|/)\.env(?:\.|$)' -or
        $path -match '(?i)\.sqlite(?:\d+)?(?:$|[-.])' -or
        ($path -match '(?i)^server/src/gameStore/data/' -and
            $path -ne 'server/src/gameStore/data/liveEventDefinitions/data.json')) {
        throw "The manifest attempts to touch protected runtime data, certificates, logs, or secrets: $path"
    }
    return $path
}

function Resolve-ChildPath {
    param(
        [string]$Root,
        [string]$RelativePath
    )
    $nativeRelative = $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $nativeRelative))
    $prefix = $Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "A relative path escapes its permitted root: $RelativePath"
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

function New-ManifestMap {
    param(
        [object]$Manifest,
        [string]$Description,
        [switch]$Installed
    )

    $filesProperty = $Manifest.PSObject.Properties['files']
    if ($null -eq $filesProperty) { throw "$Description does not contain a files array." }
    $records = @($filesProperty.Value)
    if ($records.Count -eq 0) { throw "$Description has an empty files array." }
    $map = @{}
    foreach ($record in $records) {
        $path = ConvertTo-SafeRelativePath (Get-ObjectProperty $record @('path'))
        if ($map.ContainsKey($path)) { throw "$Description contains a duplicate path: $path" }
        $kind = ([string](Get-ObjectProperty $record @('kind'))).ToLowerInvariant()
        if ($kind -ne 'modified' -and $kind -ne 'added') {
            throw "$Description has an unsupported kind '$kind' for $path."
        }
        try { $size = [Convert]::ToInt64((Get-ObjectProperty $record @('size'))) }
        catch { throw "$Description has an invalid size for $path." }
        if ($size -lt 0) { throw "$Description has a negative size for $path." }
        $shaValue = Get-ObjectProperty $record @('sha256')
        if ($Installed -or $kind -eq 'modified') {
            $sha = Assert-Sha256Text $shaValue "$Description SHA-256 for $path"
        }
        else {
            $sha = Assert-Sha256Text $shaValue "$Description SHA-256 for added path $path" -AllowEmpty
        }
        $map[$path] = [pscustomobject]@{ path = $path; sha256 = $sha; size = $size; kind = $kind }
    }
    return $map
}

function Assert-ManifestPair {
    param([hashtable]$BaselineMap, [hashtable]$InstalledMap)
    if ($BaselineMap.Count -ne $InstalledMap.Count) {
        throw 'Baseline and installed manifests have different file counts.'
    }
    foreach ($path in $BaselineMap.Keys) {
        if (-not $InstalledMap.ContainsKey($path) -or $InstalledMap[$path].kind -ne $BaselineMap[$path].kind) {
            throw "Baseline and installed manifests disagree about $path."
        }
    }
}

function Assert-StateMatchesManifest {
    param([hashtable]$StateMap, [hashtable]$InstalledMap)
    if ($StateMap.Count -ne $InstalledMap.Count) {
        throw 'Local install state does not match the release manifest file count.'
    }
    foreach ($path in $InstalledMap.Keys) {
        if (-not $StateMap.ContainsKey($path)) {
            throw "Local install state is missing $path."
        }
        $stateRecord = $StateMap[$path]
        $manifestRecord = $InstalledMap[$path]
        if ($stateRecord.kind -ne $manifestRecord.kind -or
            $stateRecord.sha256 -ne $manifestRecord.sha256 -or
            [int64]$stateRecord.size -ne [int64]$manifestRecord.size) {
            throw "Local install state does not match the signed release metadata for $path."
        }
    }
}

function Assert-InstalledFiles {
    param([string]$TargetRoot, [hashtable]$InstalledMap)
    foreach ($path in ($InstalledMap.Keys | Sort-Object)) {
        $record = $InstalledMap[$path]
        $targetPath = Resolve-ChildPath $TargetRoot $path
        Assert-NoReparsePoint $TargetRoot $targetPath
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "Refusing to uninstall because an installed file is missing: $path"
        }
        $item = Get-Item -LiteralPath $targetPath -Force
        if ([int64]$item.Length -ne [int64]$record.size -or (Get-Sha256 $targetPath) -ne $record.sha256) {
            throw "Refusing to uninstall because an installed file was modified: $path"
        }
    }
}

function Assert-BaselineBackups {
    param(
        [string]$TargetRoot,
        [string]$BackupRoot,
        [hashtable]$BaselineMap
    )
    Assert-NoReparsePoint $TargetRoot $BackupRoot
    foreach ($path in ($BaselineMap.Keys | Sort-Object)) {
        $record = $BaselineMap[$path]
        if ($record.kind -ne 'modified') { continue }
        $backupPath = Resolve-ChildPath $BackupRoot $path
        Assert-NoReparsePoint $TargetRoot $backupPath
        if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            throw "Baseline backup is missing: $path"
        }
        $item = Get-Item -LiteralPath $backupPath -Force
        if ([int64]$item.Length -ne [int64]$record.size -or (Get-Sha256 $backupPath) -ne $record.sha256) {
            throw "Baseline backup failed verification: $path"
        }
    }
}

function Assert-BaselineFiles {
    param([string]$TargetRoot, [hashtable]$BaselineMap)
    foreach ($path in ($BaselineMap.Keys | Sort-Object)) {
        $record = $BaselineMap[$path]
        $targetPath = Resolve-ChildPath $TargetRoot $path
        Assert-NoReparsePoint $TargetRoot $targetPath
        if ($record.kind -eq 'added') {
            if (Test-Path -LiteralPath $targetPath) {
                throw "An added patch file still exists after uninstall: $path"
            }
            continue
        }
        if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            throw "A restored baseline file is missing: $path"
        }
        $item = Get-Item -LiteralPath $targetPath -Force
        if ([int64]$item.Length -ne [int64]$record.size -or (Get-Sha256 $targetPath) -ne $record.sha256) {
            throw "Restored baseline verification failed: $path"
        }
    }
}

function Copy-InstalledStaging {
    param(
        [string]$TargetRoot,
        [string]$StagingRoot,
        [hashtable]$InstalledMap
    )
    foreach ($path in ($InstalledMap.Keys | Sort-Object)) {
        $record = $InstalledMap[$path]
        $sourcePath = Resolve-ChildPath $TargetRoot $path
        $stagingPath = Resolve-ChildPath $StagingRoot $path
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $stagingPath)) | Out-Null
        [System.IO.File]::Copy($sourcePath, $stagingPath, $false)
        if ((Get-Sha256 $stagingPath) -ne $record.sha256) {
            throw "Uninstall staging verification failed: $path"
        }
    }
}

function Restore-InstalledStaging {
    param(
        [string]$TargetRoot,
        [string]$StagingRoot,
        [hashtable]$InstalledMap
    )
    foreach ($path in ($InstalledMap.Keys | Sort-Object)) {
        $sourcePath = Resolve-ChildPath $StagingRoot $path
        $targetPath = Resolve-ChildPath $TargetRoot $path
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Cannot roll back uninstall because staging is missing: $path"
        }
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $targetPath)) | Out-Null
        [System.IO.File]::Copy($sourcePath, $targetPath, $true)
    }
    Assert-InstalledFiles $TargetRoot $InstalledMap
}

function Remove-EmptyParentDirectories {
    param([string]$TargetRoot, [string]$FilePath)
    $directory = Split-Path -Parent $FilePath
    while (-not [string]::IsNullOrWhiteSpace($directory) -and
        -not [string]::Equals($directory, $TargetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            $directory = Split-Path -Parent $directory
            continue
        }
        if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { break }
        [System.IO.Directory]::Delete($directory, $false)
        $directory = Split-Path -Parent $directory
    }
}

function Apply-Uninstall {
    param(
        [string]$TargetRoot,
        [string]$BackupRoot,
        [hashtable]$BaselineMap
    )
    foreach ($path in ($BaselineMap.Keys | Sort-Object)) {
        $record = $BaselineMap[$path]
        $targetPath = Resolve-ChildPath $TargetRoot $path
        if ($record.kind -eq 'modified') {
            $backupPath = Resolve-ChildPath $BackupRoot $path
            [System.IO.File]::Copy($backupPath, $targetPath, $true)
        }
        else {
            [System.IO.File]::Delete($targetPath)
            Remove-EmptyParentDirectories $TargetRoot $targetPath
        }
    }
}

function Remove-StagingDirectory {
    param(
        [string]$InstallRoot,
        [string]$StagingRoot
    )
    $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $InstallRoot 'uninstall-staging'))
    $allowedPrefix = $allowedRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $resolved = [System.IO.Path]::GetFullPath($StagingRoot)
    if (-not $resolved.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove an unexpected staging directory: $resolved"
    }
    if (Test-Path -LiteralPath $resolved -PathType Container) {
        [System.IO.Directory]::Delete($resolved, $true)
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
Assert-GitAvailable

$baselineManifest = Read-JsonFile $baselineManifestPath 'Baseline manifest'
$installedManifest = Read-JsonFile $installedManifestPath 'Installed manifest'
if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    throw "Release patch is missing: $patchPath"
}
$archiveSha256 = Get-BaselineArchiveSha256 $baselineManifest
if ($archiveSha256 -ne $ExpectedArchiveSha256) {
    throw 'Baseline manifest archive SHA-256 does not identify the supported EveJS v0.12.3 archive.'
}
$manifestPatchSha256 = Assert-Sha256Text (Get-ObjectProperty $installedManifest @('patchSha256')) 'Installed manifest patchSha256'
if ((Get-Sha256 $patchPath) -ne $manifestPatchSha256) {
    throw 'The release patch SHA-256 does not match installed-manifest.json.'
}
$baselineMap = New-ManifestMap $baselineManifest 'Baseline manifest'
$installedMap = New-ManifestMap $installedManifest 'Installed manifest' -Installed
Assert-ManifestPair $baselineMap $installedMap

$installRoot = Join-Path $targetRoot '_local\x-eve-patch'
$installStatePath = Join-Path $installRoot 'install.json'
$lockPath = Join-Path $installRoot 'install.lock'
Assert-NoReparsePoint $targetRoot $installRoot
$installState = Read-JsonFile $installStatePath 'Local X-Eve install state'
if ([string](Get-ObjectProperty $installState @('release')) -ne $ReleaseVersion -or
    [string](Get-ObjectProperty $installState @('baseline')) -ne $BaselineVersion) {
    throw 'Local install state belongs to a different X-Eve release or EveJS baseline.'
}
$statePatchSha256 = Assert-Sha256Text (Get-ObjectProperty $installState @('patchSha256')) 'Local install-state patchSha256'
if ($statePatchSha256 -ne $manifestPatchSha256) {
    throw 'Local install state does not match this release patch.'
}
$stateMap = New-ManifestMap $installState 'Local install state' -Installed
Assert-StateMatchesManifest $stateMap $installedMap

$backupRootRelative = ([string](Get-ObjectProperty $installState @('backupRoot'))).Replace('\', '/')
if ($backupRootRelative -notmatch '^backups/[0-9]{8}T[0-9]{9}Z$') {
    throw 'Local install state contains an invalid backupRoot.'
}
$backupRoot = Resolve-ChildPath $installRoot $backupRootRelative
Assert-NoReparsePoint $targetRoot $backupRoot

$lockStream = $null
$stagingRoot = $null
$uninstallStarted = $false
$uninstallCommitted = $false
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

    Write-Step 'Verifying that no installed patch file has been modified'
    Assert-InstalledFiles $targetRoot $installedMap
    Write-Step 'Verifying every original-file backup before changing anything'
    Assert-BaselineBackups $targetRoot $backupRoot $baselineMap

    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $stagingRoot = Join-Path $installRoot ("uninstall-staging\$timestamp")
    Assert-NoReparsePoint $targetRoot $stagingRoot
    [System.IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
    Copy-InstalledStaging $targetRoot $stagingRoot $installedMap

    Write-Step 'Restoring modified originals and removing only unchanged added files'
    $uninstallStarted = $true
    Apply-Uninstall $targetRoot $backupRoot $baselineMap
    Assert-BaselineFiles $targetRoot $baselineMap

    [System.IO.File]::Delete($installStatePath)
    $uninstallCommitted = $true
    Write-Step "$ReleaseName $ReleaseVersion was uninstalled successfully."
    Write-Host "The verified original-file backup was retained at: $backupRoot"
}
catch {
    $primaryError = $_.Exception.Message
    $rollbackError = $null
    if ($uninstallStarted -and -not $uninstallCommitted -and $null -ne $stagingRoot) {
        try {
            Write-Warning 'Uninstall failed; restoring the verified patched files from temporary staging.'
            Restore-InstalledStaging $targetRoot $stagingRoot $installedMap
            Write-Step 'Uninstall rollback completed successfully.'
        }
        catch {
            $rollbackError = $_.Exception.Message
        }
    }
    if ($null -ne $rollbackError) {
        throw "Uninstall failed: $primaryError`nUninstall rollback also failed: $rollbackError`nDo not run the server until these paths are inspected: $stagingRoot and $backupRoot"
    }
    throw "Uninstall failed: $primaryError"
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
    if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        try { [System.IO.File]::Delete($lockPath) } catch { Write-Warning "Could not remove operation lock: $lockPath" }
    }
    if ($uninstallCommitted -and $null -ne $stagingRoot) {
        try { Remove-StagingDirectory $installRoot $stagingRoot }
        catch { Write-Warning "Could not remove temporary uninstall staging: $stagingRoot" }
    }
}
