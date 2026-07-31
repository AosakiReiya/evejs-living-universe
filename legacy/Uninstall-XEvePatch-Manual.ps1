[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$EveJSPath
)

$ErrorActionPreference = 'Stop'

$releaseRoot = Split-Path -Parent $PSCommandPath
$releaseRoot = [System.IO.Path]::GetFullPath($releaseRoot)
$baselineManifestPath = Join-Path $releaseRoot 'patches\baseline-manifest.json'

$targetRoot = $EveJSPath
if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) {
    throw "EveJSPath directory not found: $targetRoot"
}

$installRoot = Join-Path $targetRoot '_local\x-eve-patch'
$installStatePath = Join-Path $installRoot 'install.json'
$lockPath = Join-Path $installRoot 'install.lock'

if (-not (Test-Path -LiteralPath $installStatePath -PathType Leaf)) {
    throw "Install state not found at: $installStatePath"
}

$installState = Get-Content -LiteralPath $installStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$backupRootRelative = $installState.backupRoot
$backupRoot = Join-Path $installRoot $backupRootRelative

if (-not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
    throw "Backup directory not found at: $backupRoot"
}

$baselineManifest = Get-Content -LiteralPath $baselineManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$modifiedCount = 0
$deletedCount = 0
$errors = @()

foreach ($record in $baselineManifest.files) {
    $relativePath = $record.path
    $kind = $record.kind
    $targetPath = Join-Path $targetRoot $relativePath

    if ($kind -eq 'modified') {
        $backupPath = Join-Path $backupRoot $relativePath
        if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            $errors += "Backup missing for modified file: $relativePath"
            continue
        }
        $parent = Split-Path -Parent $targetPath
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            [System.IO.Directory]::CreateDirectory($parent) | Out-Null
        }
        Copy-Item -LiteralPath $backupPath -Destination $targetPath -Force
        Write-Host "[Restored] $relativePath"
        $modifiedCount++
    }
    elseif ($kind -eq 'added') {
        if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
            Remove-Item -LiteralPath $targetPath -Force
            Write-Host "[Deleted]  $relativePath"
            $deletedCount++

            $dir = Split-Path -Parent $targetPath
            while ($dir -ne $targetRoot -and (Test-Path -LiteralPath $dir -PathType Container)) {
                $children = @(Get-ChildItem -LiteralPath $dir -Force)
                if ($children.Count -eq 0) {
                    Remove-Item -LiteralPath $dir -Force
                    Write-Host "[Dir removed] $dir"
                    $dir = Split-Path -Parent $dir
                }
                else { break }
            }
        }
        else {
            Write-Host "[Skipped]  $relativePath (already gone)"
        }
    }
}

Remove-Item -LiteralPath $installStatePath -Force -ErrorAction SilentlyContinue
Write-Host "[Deleted] install.json"

if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    Write-Host "[Deleted] install.lock"
}

Write-Host "`n=== Uninstall Summary ==="
Write-Host "Files restored from backup: $modifiedCount"
Write-Host "Added files deleted: $deletedCount"
if ($errors.Count -gt 0) {
    Write-Host "Errors:"
    $errors | ForEach-Object { Write-Warning $_ }
}
if ($errors.Count -eq 0) {
    Write-Host "X-Eve Living Universe has been removed. Backup retained at: $backupRoot"
}
