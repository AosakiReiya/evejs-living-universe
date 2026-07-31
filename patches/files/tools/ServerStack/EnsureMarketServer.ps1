param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [ValidateRange(10, 900)]
    [int]$StartupTimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"

$script:RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$script:MarketRoot = Join-Path $script:RepoRoot "externalservices\market-server"
$script:MarketExe = Join-Path $script:MarketRoot "target\release\market-server.exe"
$script:MarketBuildStamp = Join-Path $script:MarketRoot "target\release\market-server.sources.sha256"
$script:MarketConfig = Join-Path $script:MarketRoot "config\market-server.local.toml"
$script:MarketDatabase = Join-Path $script:MarketRoot "data\generated\market.sqlite"
$script:MarketBuildLauncher = Join-Path $script:RepoRoot "StartMarketServer.bat"
$script:MarketSeedLauncher = Join-Path $script:RepoRoot "tools\market-seed\BuildMarketSeed.bat"
$script:MarketTopologySync = Join-Path $script:RepoRoot "server\scripts\syncLivingEconomyMarketTopology.js"

function Test-TcpPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(750, $false)) {
            return $false
        }
        $client.EndConnect($connect)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-MarketReady {
    if (-not (Test-TcpPort -Port 40111)) {
        return $false
    }

    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -TimeoutSec 2 `
            -Uri "http://127.0.0.1:40110/health"
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    } catch {
        return $false
    }
}

function Invoke-BatchFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [string[]]$Arguments = @()
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required launcher not found: $Path"
    }

    $quotedPath = '"' + $Path.Replace('"', '""') + '"'
    $commandLine = @($quotedPath) + $Arguments
    # Start-Process -Wait waits for the complete descendant process tree on
    # Windows. Rust/MSVC builds can leave a descendant alive after the batch
    # file itself has completed, which stranded the ordinary first-start path.
    # Invoke cmd directly so completion follows the batch command's exit code.
    Push-Location -LiteralPath $script:RepoRoot
    try {
        & $env:ComSpec /d /c ($commandLine -join " ")
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        throw "$([System.IO.Path]::GetFileName($Path)) exited with code $exitCode."
    }
}

function Get-MarketSourceDigest {
    $buildInputs = @()
    foreach ($relativePath in @("Cargo.toml", "Cargo.lock", "build.rs")) {
        $candidate = Join-Path $script:MarketRoot $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $buildInputs += Get-Item -LiteralPath $candidate
        }
    }
    foreach ($relativePath in @("src", "crates")) {
        $candidate = Join-Path $script:MarketRoot $relativePath
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            $buildInputs += Get-ChildItem -LiteralPath $candidate -Recurse -File |
                Where-Object {
                    $_.Extension -eq ".rs" -or
                    $_.Name -eq "Cargo.toml" -or
                    $_.Name -eq "build.rs"
            }
        }
    }

    $rootPrefix = $script:MarketRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    $records = @(
        $buildInputs |
            Sort-Object FullName -Unique |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($rootPrefix.Length).Replace("\", "/")
                $fileHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                "$relativePath $fileHash"
            }
    )
    if ($records.Count -eq 0) {
        throw "No market-service source files were found under $script:MarketRoot"
    }
    $digestBytes = [Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($digestBytes))).Replace("-", "")
    } finally {
        $sha256.Dispose()
    }
}

function Test-MarketBuildRequired {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDigest
    )

    if (
        -not (Test-Path -LiteralPath $script:MarketExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $script:MarketBuildStamp -PathType Leaf)
    ) {
        return $true
    }
    $builtDigest = (Get-Content -LiteralPath $script:MarketBuildStamp -Raw).Trim()
    return $builtDigest -ne $SourceDigest
}

function Write-MarketBuildStamp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDigest
    )

    $stampDirectory = Split-Path -Parent $script:MarketBuildStamp
    if (-not (Test-Path -LiteralPath $stampDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $stampDirectory -Force | Out-Null
    }
    [IO.File]::WriteAllText(
        $script:MarketBuildStamp,
        $SourceDigest + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
}

if ($MyInvocation.InvocationName -eq ".") {
    return
}

$marketSourceDigest = Get-MarketSourceDigest
$marketBuildRequired = Test-MarketBuildRequired -SourceDigest $marketSourceDigest
$marketReady = Test-MarketReady
if ($marketReady) {
    if ($marketBuildRequired) {
        throw "The running market service is older than the installed sources. Stop EveJS, then start it again with the regular Play.bat."
    }
    Write-Host "  Market service is already ready."
    exit 0
}

if (-not (Test-Path -LiteralPath $script:MarketConfig -PathType Leaf)) {
    throw "Market server config not found: $script:MarketConfig"
}

if (-not (Test-Path -LiteralPath $script:MarketDatabase -PathType Leaf)) {
    Write-Host ""
    Write-Host "  First Living Universe launch: building the Jita + New Caldari market seed."
    Write-Host "  This one-time setup can take several minutes."
    Write-Host ""
    Invoke-BatchFile -Path $script:MarketSeedLauncher -Arguments @("jita")
}

if (-not (Test-Path -LiteralPath $script:MarketTopologySync -PathType Leaf)) {
    throw "Living Economy market topology synchronizer not found: $script:MarketTopologySync"
}
Write-Host "  Checking Living Economy market station topology..."
& node $script:MarketTopologySync `
    --database $script:MarketDatabase `
    --static-data (Join-Path $script:RepoRoot "_local\gameStore\data")
if ($LASTEXITCODE -ne 0) {
    throw "Living Economy market station topology synchronization failed with code $LASTEXITCODE."
}

if ($marketBuildRequired) {
    Write-Host ""
    Write-Host "  Compiling the Living Universe market service."
    Write-Host "  Later launches reuse this build until its sources change."
    Write-Host ""
    Invoke-BatchFile -Path $script:MarketBuildLauncher -Arguments @("build-release")
    if (-not (Test-Path -LiteralPath $script:MarketExe -PathType Leaf)) {
        throw "The market build completed without creating $script:MarketExe"
    }
    Write-MarketBuildStamp -SourceDigest $marketSourceDigest
}

if (-not (Test-Path -LiteralPath $script:MarketDatabase -PathType Leaf)) {
    throw "The market seed build completed without creating $script:MarketDatabase"
}
if (-not (Test-Path -LiteralPath $script:MarketExe -PathType Leaf)) {
    throw "The market build completed without creating $script:MarketExe"
}

Write-Host "  Starting Living Universe market service..."
$marketProcess = Start-Process `
    -FilePath $script:MarketExe `
    -ArgumentList @("--config", "config/market-server.local.toml", "serve") `
    -WorkingDirectory $script:MarketRoot `
    -PassThru

$deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
do {
    if (Test-MarketReady) {
        Write-Host "  Market service is ready."
        exit 0
    }
    if ($marketProcess.HasExited) {
        throw "The market service exited during startup with code $($marketProcess.ExitCode)."
    }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)

throw "The market service did not become ready within $StartupTimeoutSeconds seconds."
