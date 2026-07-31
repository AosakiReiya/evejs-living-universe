[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ensureScript = Join-Path $PSScriptRoot "EnsureMarketServer.ps1"
if (-not (Test-Path -LiteralPath $ensureScript -PathType Leaf)) {
    throw "EnsureMarketServer.ps1 is missing: $ensureScript"
}

$temporaryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetTempPath()) (
        "evejs-ensure-market-test-" + [Guid]::NewGuid().ToString("N")
    ))
)
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null

try {
    # Dot-sourcing loads the helper functions without running market startup.
    . $ensureScript -RepoRoot $temporaryRoot

    $descendantBatch = Join-Path $temporaryRoot "batch with descendant.bat"
    [System.IO.File]::WriteAllText(
        $descendantBatch,
@"
@echo off
powershell.exe -NoLogo -NoProfile -Command "`$ErrorActionPreference='Stop'; Start-Process -WindowStyle Hidden -WorkingDirectory `$env:SystemRoot -FilePath (Join-Path `$env:SystemRoot 'System32\ping.exe') -ArgumentList '-n','8','127.0.0.1'"
exit /b 0
"@,
        [System.Text.Encoding]::ASCII
    )

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-BatchFile -Path $descendantBatch
    $timer.Stop()
    if ($timer.Elapsed.TotalSeconds -ge 3) {
        throw (
            "Invoke-BatchFile waited for a descendant after the batch exited " +
            "($([Math]::Round($timer.Elapsed.TotalSeconds, 2)) seconds)."
        )
    }

    $failureBatch = Join-Path $temporaryRoot "batch failure.bat"
    [System.IO.File]::WriteAllText(
        $failureBatch,
        "@echo off`r`nexit /b 23`r`n",
        [System.Text.Encoding]::ASCII
    )
    $failureObserved = $false
    try {
        Invoke-BatchFile -Path $failureBatch
    } catch {
        if ($_.Exception.Message -notmatch "exited with code 23") {
            throw
        }
        $failureObserved = $true
    }
    if (-not $failureObserved) {
        throw "Invoke-BatchFile did not propagate a non-zero batch exit code."
    }

    Write-Host "EnsureMarketServer batch invocation verification passed."
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
        $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(2)
        do {
            try {
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
                break
            } catch {
                if ([DateTime]::UtcNow -ge $cleanupDeadline) {
                    throw
                }
                Start-Sleep -Milliseconds 100
            }
        } while (Test-Path -LiteralPath $temporaryRoot)
    }
}
