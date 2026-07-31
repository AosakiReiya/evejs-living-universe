param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [ValidateRange(5, 300)]
    [int]$MaximumTelemetryAgeSeconds = 30
)

$ErrorActionPreference = "Stop"

function Get-ConfiguredBoolean {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,

        [Parameter(Mandatory = $true)]
        [string]$Key,

        [bool]$Fallback = $false
    )

    $match = [regex]::Match(
        $Text,
        ('(?m)^\s*"{0}"\s*:\s*(true|false)\s*,?\s*$' -f [regex]::Escape($Key)),
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) {
        return $Fallback
    }
    return $match.Groups[1].Value.Equals(
        "true",
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-ConfiguredInteger {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,

        [Parameter(Mandatory = $true)]
        [string]$Key,

        [int]$Fallback
    )

    $match = [regex]::Match(
        $Text,
        ('(?m)^\s*"{0}"\s*:\s*(\d+)\s*,?\s*$' -f [regex]::Escape($Key))
    )
    if (-not $match.Success) {
        return $Fallback
    }
    return [int]$match.Groups[1].Value
}

function Get-EnvironmentBoolean {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [bool]$Fallback = $false
    )

    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Fallback
    }
    if ($value -match '^(?i:true|1|yes|on)$') {
        return $true
    }
    if ($value -match '^(?i:false|0|no|off)$') {
        return $false
    }
    return $Fallback
}

function Get-EnvironmentInteger {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [int]$Fallback
    )

    $value = [Environment]::GetEnvironmentVariable($Name)
    $parsed = 0
    if (
        [string]::IsNullOrWhiteSpace($value) -or
        -not [int]::TryParse($value, [ref]$parsed)
    ) {
        return $Fallback
    }
    return $parsed
}

try {
    $resolvedRoot = [System.IO.Path]::GetFullPath($RepoRoot)
    $configTexts = @()
    foreach ($configName in @(
        "evejs.config.local.json",
        "evejs.config.x-eve.json",
        "evejs.config.x-eve.local.json"
    )) {
        $configPath = Join-Path $resolvedRoot $configName
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            $configTexts += Get-Content -LiteralPath $configPath -Raw
        }
    }

    $livingUniverseEnabled = $false
    $expectedActors = 1
    $economyExpected = $false
    $xEveExpected = $false
    foreach ($configText in $configTexts) {
        $livingUniverseEnabled = Get-ConfiguredBoolean `
            -Text $configText `
            -Key "livingUniverseEnabled" `
            -Fallback $livingUniverseEnabled
        $expectedActors = Get-ConfiguredInteger `
            -Text $configText `
            -Key "livingUniversePopulationSize" `
            -Fallback $expectedActors
        $economyExpected = Get-ConfiguredBoolean `
            -Text $configText `
            -Key "livingEconomyEnabled" `
            -Fallback $economyExpected
        $xEveExpected = Get-ConfiguredBoolean `
            -Text $configText `
            -Key "xEveEnabled" `
            -Fallback $xEveExpected
    }
    $livingUniverseEnabled = Get-EnvironmentBoolean `
        -Name "EVEJS_LIVING_UNIVERSE_ENABLED" `
        -Fallback $livingUniverseEnabled
    $expectedActors = Get-EnvironmentInteger `
        -Name "EVEJS_LIVING_UNIVERSE_POPULATION_SIZE" `
        -Fallback $expectedActors
    $economyExpected = Get-EnvironmentBoolean `
        -Name "EVEJS_LIVING_ECONOMY_ENABLED" `
        -Fallback $economyExpected
    $xEveExpected = Get-EnvironmentBoolean `
        -Name "EVEJS_X_EVE_ENABLED" `
        -Fallback $xEveExpected

    if (-not $livingUniverseEnabled) {
        exit 0
    }

    $telemetryPath = Join-Path $resolvedRoot "_local\runtime-performance\latest.json"
    if (-not (Test-Path -LiteralPath $telemetryPath -PathType Leaf)) {
        exit 1
    }

    $telemetryFile = Get-Item -LiteralPath $telemetryPath
    if (
        ([DateTime]::UtcNow - $telemetryFile.LastWriteTimeUtc).TotalSeconds -gt
        $MaximumTelemetryAgeSeconds
    ) {
        exit 1
    }

    $telemetry = Get-Content -LiteralPath $telemetryPath -Raw | ConvertFrom-Json
    $serverPid = [int]$telemetry.process.pid
    if ($serverPid -le 0 -or -not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
        exit 1
    }
    if ($telemetry.livingUniverse.enabled -ne $true) {
        exit 1
    }
    if ([int]$telemetry.livingUniverse.actorCount -lt $expectedActors) {
        exit 1
    }
    if ($economyExpected) {
        if ($telemetry.livingUniverse.economy.enabled -ne $true) {
            exit 1
        }
        if ($telemetry.livingUniverse.economy.stockCache.ready -ne $true) {
            exit 1
        }
        if (
            -not [string]::IsNullOrWhiteSpace(
                [string]$telemetry.livingUniverse.economy.lastPulseError
            )
        ) {
            exit 1
        }
    }
    if ($xEveExpected) {
        if ($telemetry.xEve.enabled -ne $true -or $telemetry.xEve.started -ne $true) {
            exit 1
        }
    }

    exit 0
} catch {
    exit 1
}
