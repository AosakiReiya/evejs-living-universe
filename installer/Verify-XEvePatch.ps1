[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$EveJSPath,
    [switch]$RunTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedArchiveSha256 = '1DEB61A51F808D9F2B330214DA64EC297D9EE5F96EE4B8265692A65F35EEFC1E'

function Get-CanonicalTarget {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "EveJSPath is not a directory: $Path" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "EveJSPath cannot be a junction or symbolic link: $($item.FullName)"
    }
    $full = [IO.Path]::GetFullPath($item.FullName).TrimEnd('\', '/')
    $root = [IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
    $profile = [IO.Path]::GetFullPath(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    ).TrimEnd('\', '/')
    if ($full -eq $root -or $full -eq $profile) {
        throw "Refusing an unsafe EveJSPath: $full"
    }
    foreach ($sentinel in @('server\package.json', 'server\index.js', 'externalservices\market-server')) {
        if (-not (Test-Path -LiteralPath (Join-Path $full $sentinel))) {
            throw "The selected directory is not an EveJS tree; missing $sentinel"
        }
    }
    return $full
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Read-Json {
    param([string]$Path, [string]$Description)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "$Description is invalid JSON: $Path" }
}

function Get-SafePath {
    param([object]$Value)
    $path = ([string]$Value).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($path) -or [IO.Path]::IsPathRooted($path) -or
        $path -match '^[A-Za-z]:' -or $path -match '(^|/)\.\.(/|$)') {
        throw "Unsafe manifest path: $path"
    }
    if ($path -match '(?i)^_local/' -or $path -match '(?i)(^|/)(certs?|logs?)(/|$)' -or
        $path -match '(?i)(^|/)\.env(?:\.|$)' -or $path -match '(?i)\.sqlite(?:$|[-.])') {
        throw "Protected runtime path in manifest: $path"
    }
    return $path
}

function Resolve-TargetFile {
    param([string]$Root, [string]$Relative)
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root ($Relative.Replace('/', '\'))))
    $prefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest path escapes EveJSPath: $Relative"
    }
    return $candidate
}

function Get-ManifestMap {
    param([object]$Manifest, [switch]$Installed)
    $map = @{}
    foreach ($entry in @($Manifest.files)) {
        $path = Get-SafePath $entry.path
        if ($map.ContainsKey($path)) { throw "Duplicate manifest path: $path" }
        $kind = ([string]$entry.kind).ToLowerInvariant()
        if ($kind -notin @('modified', 'added')) { throw "Invalid manifest kind for $path" }
        $sha = if ($null -eq $entry.sha256) { '' } else { ([string]$entry.sha256).ToUpperInvariant() }
        if (($Installed -or $kind -eq 'modified') -and $sha -notmatch '^[0-9A-F]{64}$') {
            throw "Invalid SHA-256 for $path"
        }
        $map[$path] = [pscustomobject]@{
            path = $path
            kind = $kind
            sha256 = $sha
            size = [int64]$entry.size
        }
    }
    if ($map.Count -eq 0) { throw 'Manifest file list is empty.' }
    return $map
}

function Test-Files {
    param([string]$Root, [hashtable]$Map, [switch]$Installed)
    foreach ($path in ($Map.Keys | Sort-Object)) {
        $record = $Map[$path]
        $full = Resolve-TargetFile $Root $path
        if (-not $Installed -and $record.kind -eq 'added') {
            if (Test-Path -LiteralPath $full) { throw "Baseline conflict at patch-added path: $path" }
            continue
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Required file is missing: $path" }
        $item = Get-Item -LiteralPath $full -Force
        if ([int64]$item.Length -ne $record.size -or (Get-Sha256 $full) -ne $record.sha256) {
            throw "File integrity mismatch: $path"
        }
    }
}

function Test-RuntimeStaticDataReferences {
    param([string]$Root, [hashtable]$InstalledMap)
    $pattern = [regex]::new(
        '(?<relative>(?:\.\./)+gameStore/data/[A-Za-z0-9._-]+/data\.json)',
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    $rootPrefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    foreach ($path in ($InstalledMap.Keys | Sort-Object)) {
        if (-not $path.EndsWith('.js', [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $sourcePath = Resolve-TargetFile $Root $path
        $sourceText = [IO.File]::ReadAllText($sourcePath)
        foreach ($match in $pattern.Matches($sourceText)) {
            $referencePath = [IO.Path]::GetFullPath(
                (Join-Path (Split-Path -Parent $sourcePath) $match.Groups['relative'].Value)
            )
            if (-not $referencePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Runtime static-data reference escapes EveJSPath: $path"
            }
            if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) {
                $missingPath = $referencePath.Substring($rootPrefix.Length).Replace('\', '/')
                throw "Runtime static-data reference is missing: $path -> $missingPath"
            }
        }
    }
}

function Invoke-PatchCheck {
    param([string]$Root, [string]$PatchPath, [switch]$Reverse)
    $arguments = @('-c', 'core.autocrlf=true', '-C', $Root, 'apply', '--check', '--binary', '--whitespace=nowarn')
    if ($Reverse) { $arguments += '--reverse' }
    $arguments += @('--', $PatchPath)
    $output = @(& git @arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Git patch-state check failed.`n$(($output | ForEach-Object {[string]$_}) -join [Environment]::NewLine)"
    }
}

function Invoke-VerificationTests {
    param([string]$Root)
    $powershell = Get-Command powershell.exe -ErrorAction SilentlyContinue
    if ($null -eq $powershell) { throw 'powershell.exe is required for -RunTests.' }
    $playLauncherTest = Join-Path $Root 'tools\ServerStack\VerifyPlayServerAvailability.ps1'
    Write-Host '[X-Eve] Running VerifyPlayServerAvailability.ps1'
    & $powershell.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File $playLauncherTest
    if ($LASTEXITCODE -ne 0) {
        throw 'Verification command failed: VerifyPlayServerAvailability.ps1'
    }

    $marketLauncherTest = Join-Path $Root 'tools\ServerStack\VerifyEnsureMarketServer.ps1'
    Write-Host '[X-Eve] Running VerifyEnsureMarketServer.ps1'
    & $powershell.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File $marketLauncherTest
    if ($LASTEXITCODE -ne 0) {
        throw 'Verification command failed: VerifyEnsureMarketServer.ps1'
    }

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $node) { throw 'node.exe is required for -RunTests.' }
    $serverRoot = Join-Path $Root 'server'
    if (-not (Test-Path -LiteralPath (Join-Path $serverRoot 'node_modules\picocolors\package.json') -PathType Leaf)) {
        throw '-RunTests requires the normal EveJS server dependencies. Start the regular Play.bat once, let setup finish, stop the server, and retry.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root '_local\gameStore\manifest.json') -PathType Leaf)) {
        throw '-RunTests requires the normal EveJS local database. Start the regular Play.bat once, let setup finish, stop the server, and retry.'
    }
    $tests = @(
        'verifyLivingUniversePopulation.js',
        'verifyLivingUniverseTransitTiming.js',
        'verifyFamilyEstate.js',
        'verifyFamilyEstateClaim.js',
        'verifyFamilyEstateProjects.js',
        'verifyLivingEconomyMarketTopology.js',
        'verifyLivingEconomyAutomaticRegionalStock.js',
        'verifyLivingEconomyMobilization.js',
        'verifyLivingFactionHostility.js',
        'verifyManagedIndustrialCrewDefense.js',
        'verifyCorporationSyntheticEmployeeProjection.js',
        'verifyIndustrialCrewPresenceLifecycle.js',
        'verifySyntheticChatPresence.js',
        'verifyXEveCore.js',
        'verifyXEveEventCircuit.js'
    )
    Push-Location $serverRoot
    try {
        foreach ($test in $tests) {
            Write-Host "[X-Eve] Running $test"
            & $node.Source (Join-Path $serverRoot "scripts\$test")
            if ($LASTEXITCODE -ne 0) { throw "Verification command failed: $test" }
        }
        $marketReady = $false
        try {
            $client = [Net.Sockets.TcpClient]::new()
            $result = $client.BeginConnect('127.0.0.1', 40111, $null, $null)
            $marketReady = $result.AsyncWaitHandle.WaitOne(500, $false)
            if ($marketReady) { $client.EndConnect($result) }
            $client.Dispose()
        } catch { $marketReady = $false }
        if ($marketReady) {
            Write-Host '[X-Eve] Running verifyLivingEconomy.js'
            & $node.Source (Join-Path $serverRoot 'scripts\verifyLivingEconomy.js')
            if ($LASTEXITCODE -ne 0) { throw 'Verification command failed: verifyLivingEconomy.js' }
        } else {
            Write-Warning 'Market RPC 127.0.0.1:40111 is not running; skipped verifyLivingEconomy.js.'
        }
    } finally { Pop-Location }
}

if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git for Windows is required but was not found on PATH.'
}

$target = Get-CanonicalTarget $EveJSPath
$releaseRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSCommandPath) '..'))
$patchDirectory = Join-Path $releaseRoot 'patches'
$patchPath = Join-Path $patchDirectory 'x-eve-living-universe.patch'
$baselineManifest = Read-Json (Join-Path $patchDirectory 'baseline-manifest.json') 'Baseline manifest'
$installedManifest = Read-Json (Join-Path $patchDirectory 'installed-manifest.json') 'Installed manifest'

if ([string]$baselineManifest.compatibility.archiveSha256 -ne $ExpectedArchiveSha256) {
    throw 'Baseline manifest has the wrong v0.12.3.1 archive checksum.'
}
if ((Get-Sha256 $patchPath) -ne ([string]$installedManifest.patchSha256).ToUpperInvariant()) {
    throw 'Patch checksum does not match installed-manifest.json.'
}
$baselineMap = Get-ManifestMap $baselineManifest
$installedMap = Get-ManifestMap $installedManifest -Installed
if ($baselineMap.Count -ne $installedMap.Count) { throw 'Manifest file counts disagree.' }

$statePath = Join-Path $target '_local\x-eve-patch\install.json'
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Read-Json $statePath 'Local install state'
    if ([string]$state.patchSha256 -ne ([string]$installedManifest.patchSha256)) {
        throw 'Local install state belongs to a different patch.'
    }
    Test-Files $target $installedMap -Installed
    Test-RuntimeStaticDataReferences $target $installedMap
    Invoke-PatchCheck $target $patchPath -Reverse
    Write-Host '[X-Eve] Installed patch integrity and reverse-apply checks passed.'
    if ($RunTests) { Invoke-VerificationTests $target }
} else {
    if ($RunTests) { throw '-RunTests requires an installed patch and install state.' }
    Test-Files $target $baselineMap
    Invoke-PatchCheck $target $patchPath
    Write-Host '[X-Eve] Clean v0.12.3.1 baseline integrity and apply checks passed.'
}
