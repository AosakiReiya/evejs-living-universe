[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$playPath = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..\..\Play.bat")
)
if (-not (Test-Path -LiteralPath $playPath -PathType Leaf)) {
    throw "Play.bat is missing: $playPath"
}

$playText = [System.IO.File]::ReadAllText($playPath)
$ensureMarker = ":EnsureServerAvailable"
$nativeStartMarker = "if not defined EVEJS_SERVER_START_IN_PROGRESS"
$loopMarker = "for /L %%N in (1,1,900) do ("
$checkMarker = "`n:CheckGameServerPort"

$ensureIndex = $playText.IndexOf(
    $ensureMarker,
    [System.StringComparison]::Ordinal
)
$nativeStartIndex = $playText.IndexOf(
    $nativeStartMarker,
    [System.StringComparison]::Ordinal
)
$loopIndex = $playText.IndexOf(
    $loopMarker,
    [System.StringComparison]::Ordinal
)
$checkIndex = $playText.IndexOf(
    $checkMarker,
    $loopIndex,
    [System.StringComparison]::Ordinal
)
if (
    $ensureIndex -lt 0 -or
    $nativeStartIndex -le $ensureIndex -or
    $loopIndex -le $nativeStartIndex -or
    $checkIndex -le $loopIndex
) {
    throw "Play.bat server-availability sections are missing or out of order."
}

$decisionStartIndex = $playText.IndexOf(
    "call :CheckGameServerPort",
    $ensureIndex,
    [System.StringComparison]::Ordinal
)
if (
    $decisionStartIndex -lt $ensureIndex -or
    $decisionStartIndex -ge $nativeStartIndex
) {
    throw "Play.bat initial endpoint checks are missing."
}

$preStartDecision = $playText.Substring(
    $decisionStartIndex,
    $nativeStartIndex - $decisionStartIndex
)
$strictReadyLine = (
    'if "!EVEJS_GAME_PORT_OK!"=="0" if "!EVEJS_PROXY_OK!"=="0" ' +
    'if "!EVEJS_LIVING_UNIVERSE_OK!"=="0" ('
)
$endpointReadyLine = (
    'if "!EVEJS_GAME_PORT_OK!"=="0" if "!EVEJS_PROXY_OK!"=="0" ('
)
$strictIndex = $preStartDecision.IndexOf(
    $strictReadyLine,
    [System.StringComparison]::Ordinal
)
$endpointIndex = $preStartDecision.IndexOf(
    $endpointReadyLine,
    [System.StringComparison]::Ordinal
)
if ($strictIndex -lt 0) {
    throw "Play.bat initial Living Universe readiness check is missing."
}
if ($endpointIndex -le $strictIndex) {
    throw (
        "Play.bat must accept healthy game and proxy endpoints before " +
        "attempting to start a native server."
    )
}

$pollingBlock = $playText.Substring(
    $loopIndex,
    $checkIndex - $loopIndex
)
if (
    $pollingBlock.IndexOf(
        $strictReadyLine,
        [System.StringComparison]::Ordinal
    ) -lt 0
) {
    throw "Play.bat native-start polling no longer waits for Living Universe."
}
if (
    $pollingBlock.IndexOf(
        $endpointReadyLine,
        [System.StringComparison]::Ordinal
    ) -ge 0
) {
    throw (
        "Play.bat native-start polling must retain the stricter Living " +
        "Universe readiness gate."
    )
}

$temporaryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetTempPath()) (
        "evejs-play-availability-test-" + [Guid]::NewGuid().ToString("N")
    ))
)
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
$harnessPath = Join-Path $temporaryRoot "availability-harness.bat"

try {
    $harness = @(
        "@echo off",
        "setlocal EnableDelayedExpansion",
        $preStartDecision.TrimEnd(),
        "exit /b 42",
        ":CheckGameServerPort",
        "exit /b %TEST_GAME_RESULT%",
        ":CheckProxyHealth",
        "exit /b %TEST_PROXY_RESULT%",
        ":CheckLivingUniverseReady",
        "exit /b %TEST_LIVING_RESULT%"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText(
        $harnessPath,
        $harness + "`r`n",
        [System.Text.Encoding]::ASCII
    )

    $scenarios = @(
        [pscustomobject]@{
            Name = "Docker endpoints ready without host telemetry"
            Game = 0
            Proxy = 0
            Living = 1
            Expected = 0
        },
        [pscustomobject]@{
            Name = "Native endpoints and Living Universe ready"
            Game = 0
            Proxy = 0
            Living = 0
            Expected = 0
        },
        [pscustomobject]@{
            Name = "Game endpoint unavailable"
            Game = 1
            Proxy = 0
            Living = 0
            Expected = 42
        },
        [pscustomobject]@{
            Name = "Proxy endpoint unavailable"
            Game = 0
            Proxy = 1
            Living = 0
            Expected = 42
        }
    )

    foreach ($scenario in $scenarios) {
        $command = (
            "set TEST_GAME_RESULT={0}&& " +
            "set TEST_PROXY_RESULT={1}&& " +
            "set TEST_LIVING_RESULT={2}&& " +
            "call `"{3}`""
        ) -f (
            $scenario.Game,
            $scenario.Proxy,
            $scenario.Living,
            $harnessPath
        )
        & $env:ComSpec /d /c $command | Out-Null
        $actual = $LASTEXITCODE
        if ($actual -ne $scenario.Expected) {
            throw (
                "$($scenario.Name) returned $actual; expected " +
                "$($scenario.Expected)."
            )
        }
    }

    Write-Host "Play.bat server-availability verification passed."
} finally {
    $systemTemporaryRoot = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetTempPath()
    ).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    if (
        $temporaryRoot.StartsWith(
            $systemTemporaryRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        (Test-Path -LiteralPath $temporaryRoot -PathType Container)
    ) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
