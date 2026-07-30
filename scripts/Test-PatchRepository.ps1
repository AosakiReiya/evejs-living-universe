[CmdletBinding()]
param(
  [Parameter()]
  [string]$RepositoryRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = Join-Path $PSScriptRoot '..'
}

$ExpectedBaselineArchiveSha256 = '1DEB61A51F808D9F2B330214DA64EC297D9EE5F96EE4B8265692A65F35EEFC1E'
$Failures = [System.Collections.Generic.List[string]]::new()

function Add-AuditFailure {
  param([Parameter(Mandatory)][string]$Message)

  $script:Failures.Add($Message)
}

function Get-NormalizedFullPath {
  param([Parameter(Mandatory)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

$RepositoryRoot = Get-NormalizedFullPath -Path $RepositoryRoot
if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) {
  throw "Repository root does not exist: $RepositoryRoot"
}

$RootPrefix = $RepositoryRoot + [System.IO.Path]::DirectorySeparatorChar

function Convert-ToRepositoryPath {
  param([Parameter(Mandatory)][string]$FullName)

  $fullPath = Get-NormalizedFullPath -Path $FullName
  if (-not $fullPath.StartsWith($script:RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the repository root: $FullName"
  }

  return $fullPath.Substring($script:RootPrefix.Length).Replace('\', '/')
}

function Test-SafeRelativePath {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Context
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    Add-AuditFailure "$Context contains an empty path."
    return $false
  }

  if (
    $Path.StartsWith('/') -or
    $Path.StartsWith('\') -or
    $Path -match '^[A-Za-z]:' -or
    $Path.Contains('\') -or
    $Path.Contains([char]0)
  ) {
    Add-AuditFailure "$Context is not a portable relative path: $Path"
    return $false
  }

  $segments = @($Path.Split('/'))
  if ($segments.Count -eq 0 -or $segments -contains '' -or $segments -contains '.' -or $segments -contains '..') {
    Add-AuditFailure "$Context contains an empty, current-directory, or traversal segment: $Path"
    return $false
  }

  if ($Path -match '[:*?"<>|]') {
    Add-AuditFailure "$Context contains a platform-unsafe character: $Path"
    return $false
  }

  return $true
}

function Test-SensitivePath {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Context
  )

  $normalized = $Path.Replace('\', '/').Trim('/')
  $segments = @($normalized.Split('/'))
  $forbiddenSegments = @(
    '_local',
    'cert',
    'certs',
    'certificate',
    'certificates',
    'config-local',
    'config_local',
    'database',
    'databases',
    'deploy',
    'deployment',
    'local-config',
    'local_config',
    'log',
    'logs',
    'node_modules',
    'playerconnect',
    'private',
    'remote',
    'runtime',
    'runtime-data',
    'runtime_data',
    'secrets'
  )

  foreach ($segment in $segments) {
    if ($forbiddenSegments -contains $segment.ToLowerInvariant()) {
      Add-AuditFailure "$Context enters a private, deployment, or runtime location: $Path"
      return $false
    }
  }

  $leaf = $segments[-1]
  $sensitiveNamePatterns = @(
    '(?i)^\.env(?:\..+)?$',
    '(?i)^evejs\.config\.local\.json$',
    '(?i)^.*config[-_.]?local(?:\..+)?$',
    '(?i)^.*\.local\.json$',
    '(?i)^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$',
    '(?i)^(?:authorized_keys|known_hosts)$',
    '(?i)^.*\.(?:db|db3|sqlite|sqlite3|sqlite-wal|sqlite-shm)$',
    '(?i)^.*\.(?:log|pem|key|pfx|p12|ppk|crt|cer|der|jks|keystore)$'
  )

  foreach ($pattern in $sensitiveNamePatterns) {
    if ($leaf -match $pattern) {
      Add-AuditFailure "$Context names a private configuration, database, log, certificate, or key file: $Path"
      return $false
    }
  }

  return $true
}

function Test-IsPublicIPv4 {
  param([Parameter(Mandatory)][string]$Value)

  $address = $null
  if (
    -not [System.Net.IPAddress]::TryParse($Value, [ref]$address) -or
    $address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork
  ) {
    return $false
  }

  $bytes = $address.GetAddressBytes()
  if (
    $bytes[0] -eq 0 -or
    $bytes[0] -eq 10 -or
    $bytes[0] -eq 127 -or
    $bytes[0] -ge 224 -or
    ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127) -or
    ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or
    ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 0 -and $bytes[2] -eq 2) -or
    ($bytes[0] -eq 198 -and $bytes[1] -in @(18, 19)) -or
    ($bytes[0] -eq 198 -and $bytes[1] -eq 51 -and $bytes[2] -eq 100) -or
    ($bytes[0] -eq 203 -and $bytes[1] -eq 0 -and $bytes[2] -eq 113)
  ) {
    return $false
  }

  return $true
}

function Test-IsPublicIPv6 {
  param([Parameter(Mandatory)][string]$Value)

  $address = $null
  if (
    -not [System.Net.IPAddress]::TryParse($Value, [ref]$address) -or
    $address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetworkV6
  ) {
    return $false
  }

  if (
    [System.Net.IPAddress]::IsLoopback($address) -or
    $address.IsIPv6LinkLocal -or
    $address.IsIPv6Multicast -or
    $address.IsIPv6SiteLocal -or
    $address.IsIPv4MappedToIPv6
  ) {
    return $false
  }

  $bytes = $address.GetAddressBytes()
  $isUnspecified = @($bytes | Where-Object { $_ -ne 0 }).Count -eq 0
  $isUniqueLocal = ($bytes[0] -band 0xFE) -eq 0xFC
  $isDocumentation = (
    $bytes[0] -eq 0x20 -and
    $bytes[1] -eq 0x01 -and
    $bytes[2] -eq 0x0D -and
    $bytes[3] -eq 0xB8
  )
  if ($isUnspecified -or $isUniqueLocal -or $isDocumentation) {
    return $false
  }

  return $true
}

function Test-IsPlaceholderSecret {
  param([Parameter(Mandatory)][string]$Value)

  $normalized = $Value.Trim()
  return (
    [string]::IsNullOrWhiteSpace($normalized) -or
    $normalized -match '(?i)^(?:example|placeholder|redacted|changeme|change-me|your[-_ ].*|test(?:[-_ ].*)?|\*+|x+)$'
  )
}

function Get-ManifestEntries {
  param(
    [Parameter(Mandatory)]$Manifest,
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter()][switch]$AllowAddedBaselinePlaceholder
  )

  if ($null -eq $Manifest -or $Manifest -is [System.Array]) {
    Add-AuditFailure "JSON manifest must contain one top-level object: $ManifestPath"
    return @()
  }

  $propertyNames = @($Manifest.PSObject.Properties.Name)
  if ($propertyNames -notcontains 'files') {
    Add-AuditFailure "JSON manifest is missing its files array: $ManifestPath"
    return @()
  }

  if ($null -eq $Manifest.files) {
    Add-AuditFailure "JSON manifest has a null files array: $ManifestPath"
    return @()
  }

  $entries = @($Manifest.files)
  if ($entries.Count -eq 0) {
    Add-AuditFailure "JSON manifest has an empty files array: $ManifestPath"
    return @()
  }

  $seenPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $requiredEntryProperties = @('kind', 'path', 'sha256', 'size')
  $validatedEntries = [System.Collections.Generic.List[object]]::new()

  for ($index = 0; $index -lt $entries.Count; $index += 1) {
    $entry = $entries[$index]
    $entryContext = "$ManifestPath files[$index]"
    if ($null -eq $entry -or $entry -is [System.Array]) {
      Add-AuditFailure "$entryContext must be an object."
      continue
    }

    $entryProperties = @($entry.PSObject.Properties.Name | Sort-Object)
    $expectedProperties = @($requiredEntryProperties | Sort-Object)
    if (($entryProperties -join ',') -cne ($expectedProperties -join ',')) {
      Add-AuditFailure "$entryContext must contain exactly path, sha256, size, and kind."
      continue
    }

    $entryPath = [string]$entry.path
    $pathIsSafe = Test-SafeRelativePath -Path $entryPath -Context $entryContext
    $pathIsPublic = Test-SensitivePath -Path $entryPath -Context $entryContext
    if ($pathIsSafe -and $pathIsPublic -and -not $seenPaths.Add($entryPath)) {
      Add-AuditFailure "$ManifestPath contains a duplicate file path: $entryPath"
    }

    $size = 0L
    if (-not [long]::TryParse([string]$entry.size, [ref]$size) -or $size -lt 0) {
      Add-AuditFailure "$entryContext has an invalid non-negative byte size."
    }

    $kind = [string]$entry.kind
    if ($kind -cnotin @('added', 'modified')) {
      Add-AuditFailure "$entryContext has an invalid kind; expected added or modified."
    }

    $sha256 = [string]$entry.sha256
    $isAddedBaselinePlaceholder = (
      $AllowAddedBaselinePlaceholder -and
      $kind -ceq 'added' -and
      $null -eq $entry.sha256 -and
      $size -eq 0
    )
    if (-not $isAddedBaselinePlaceholder -and $sha256 -notmatch '^[0-9A-Fa-f]{64}$') {
      Add-AuditFailure "$entryContext has an invalid SHA-256 value."
    }
    if ($AllowAddedBaselinePlaceholder -and $kind -ceq 'added' -and -not $isAddedBaselinePlaceholder) {
      Add-AuditFailure "$entryContext must use a null SHA-256 and zero size for a file absent from the baseline."
    }

    $validatedEntries.Add([pscustomobject]@{
      Path = $entryPath
      Sha256 = $(if ([string]::IsNullOrEmpty($sha256)) { $null } else { $sha256.ToUpperInvariant() })
      Size = $size
      Kind = $kind
    })
  }

  return @($validatedEntries)
}

# The package is deliberately constrained to documentation, installers, one patch,
# verification scripts, and GitHub metadata. A copied EveJS source tree fails even
# when it is untracked, so a local mistake cannot be hidden by .gitignore.
$allowedRootDirectories = @('.github', 'docs', 'installer', 'patches', 'scripts')
$forbiddenRootNames = @(
  'certs',
  'database',
  'databases',
  'deploy',
  'docker',
  'externalservices',
  'logs',
  'node_modules',
  'runtime',
  'server',
  'tools'
)

$rootItems = @(Get-ChildItem -LiteralPath $RepositoryRoot -Force | Where-Object { $_.Name -ne '.git' })
foreach ($item in $rootItems) {
  $nameLower = $item.Name.ToLowerInvariant()
  if ($forbiddenRootNames -contains $nameLower) {
    Add-AuditFailure "Forbidden full-source or runtime top-level item is present: $($item.Name)"
  }

  if ($item.PSIsContainer) {
    if ($allowedRootDirectories -notcontains $nameLower) {
      Add-AuditFailure "Unexpected top-level directory is present: $($item.Name)"
    }
    continue
  }

  if ($item.Name -notmatch '(?i)^(?:README|LICENSE|CHANGELOG)(?:\.(?:md|txt))?$|^\.git(?:ignore|attributes)$') {
    Add-AuditFailure "Unexpected top-level file is present: $($item.Name)"
  }
}

$repositoryItems = @(
  Get-ChildItem -LiteralPath $RepositoryRoot -Force -Recurse |
    Where-Object {
      $relative = Convert-ToRepositoryPath -FullName $_.FullName
      $relative -ne '.git' -and -not $relative.StartsWith('.git/', [System.StringComparison]::OrdinalIgnoreCase)
    }
)

foreach ($item in $repositoryItems) {
  $relativePath = Convert-ToRepositoryPath -FullName $item.FullName
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Add-AuditFailure "Symbolic links and reparse points are not allowed in the release package: $relativePath"
  }

  [void](Test-SensitivePath -Path $relativePath -Context 'Repository path')
  if ($item.PSIsContainer) {
    continue
  }

  $topLevel = $relativePath.Split('/')[0].ToLowerInvariant()
  $leaf = [System.IO.Path]::GetFileName($relativePath)
  $extension = [System.IO.Path]::GetExtension($leaf).ToLowerInvariant()
  $typeAllowed = switch ($topLevel) {
    'docs' { $extension -in @('.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'); break }
    'installer' { $extension -in @('.ps1', '.bat', '.cmd', '.md'); break }
    'scripts' { $extension -in @('.ps1', '.md'); break }
    '.github' { $extension -in @('.yml', '.yaml', '.md'); break }
    'patches' { $extension -in @('.patch', '.json', '.dockerignore', '.sh', '.js') -or $leaf -ceq 'SHA256SUMS'; break }
    default { $true }
  }

  if (-not $typeAllowed) {
    Add-AuditFailure "Unexpected file type in public package tree: $relativePath"
  }

  if ($extension -eq '.diff') {
    Add-AuditFailure "Secondary diff files are not allowed; publish exactly one canonical .patch: $relativePath"
  }
}

# If this is already a Git working tree, inspect the index as well as the disk.
# This catches forbidden files staged in Git but deleted from the working copy.
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($null -ne $gitCommand -and (Test-Path -LiteralPath (Join-Path $RepositoryRoot '.git'))) {
  $gitTopLevelOutput = @(& $gitCommand.Source -C $RepositoryRoot rev-parse --show-toplevel 2>$null)
  $gitTopLevelExitCode = $LASTEXITCODE
  $gitTopLevel = $gitTopLevelOutput | Select-Object -First 1
  if ($gitTopLevelExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($gitTopLevel)) {
    Add-AuditFailure 'A .git entry exists, but Git could not inspect this working tree.'
  }
  elseif ((Get-NormalizedFullPath -Path $gitTopLevel) -cne $RepositoryRoot) {
    Add-AuditFailure "Git top-level path does not match the audited repository root: $gitTopLevel"
  }
  else {
    $trackedPaths = @(& $gitCommand.Source -C $RepositoryRoot ls-files)
    if ($LASTEXITCODE -ne 0) {
      Add-AuditFailure 'Git could not enumerate tracked files.'
    }

    foreach ($trackedPath in $trackedPaths) {
      if (-not (Test-SafeRelativePath -Path $trackedPath -Context 'Tracked Git path')) {
        continue
      }

      [void](Test-SensitivePath -Path $trackedPath -Context 'Tracked Git path')
      $trackedTopLevel = $trackedPath.Split('/')[0].ToLowerInvariant()
      if ($forbiddenRootNames -contains $trackedTopLevel) {
        Add-AuditFailure "Forbidden full-source or runtime top-level item is tracked: $trackedPath"
      }
      elseif (
        $allowedRootDirectories -notcontains $trackedTopLevel -and
        $trackedPath -notmatch '(?i)^(?:README|LICENSE|CHANGELOG)(?:\.(?:md|txt))?$|^\.git(?:ignore|attributes)$'
      ) {
        Add-AuditFailure "Unexpected top-level Git path is tracked: $trackedPath"
      }
    }
  }
}

$patchFiles = @(
  Get-ChildItem -LiteralPath $RepositoryRoot -Force -Recurse -File -Filter '*.patch' |
    Where-Object {
      $relative = Convert-ToRepositoryPath -FullName $_.FullName
      -not $relative.StartsWith('.git/', [System.StringComparison]::OrdinalIgnoreCase)
    }
)

if ($patchFiles.Count -ne 1) {
  Add-AuditFailure "Expected exactly one canonical .patch file; found $($patchFiles.Count)."
}

$canonicalPatch = $null
$patchPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$patchKinds = @{}
if ($patchFiles.Count -eq 1) {
  $canonicalPatch = $patchFiles[0]
  $canonicalPatchPath = Convert-ToRepositoryPath -FullName $canonicalPatch.FullName
  if ($canonicalPatchPath -cne 'patches/x-eve-living-universe.patch') {
    Add-AuditFailure "Canonical patch has an unexpected release path or name: $canonicalPatchPath"
  }

  if ($canonicalPatch.Length -le 0) {
    Add-AuditFailure 'Canonical patch is empty.'
  }

  $patchBytes = [System.IO.File]::ReadAllBytes($canonicalPatch.FullName)
  if ([System.Array]::IndexOf($patchBytes, [byte]0) -ge 0) {
    Add-AuditFailure 'Canonical patch contains NUL bytes and is not a plain-text source patch.'
  }

  $patchLines = @(Get-Content -LiteralPath $canonicalPatch.FullName)
  $currentDiffPath = $null
  $diffCount = 0
  for ($patchLineIndex = 0; $patchLineIndex -lt $patchLines.Count; $patchLineIndex += 1) {
    $line = $patchLines[$patchLineIndex]
    $patchLineNumber = $patchLineIndex + 1
    if ($line -ceq 'GIT binary patch' -or $line -cmatch '^Binary files .+ differ$') {
      Add-AuditFailure "Canonical patch contains a binary diff at patch line $patchLineNumber."
    }

    if ($line.StartsWith('diff --git ')) {
      $diffCount += 1
      $currentDiffPath = $null
      if ($line -cnotmatch '^diff --git a/([^\s"]+) b/([^\s"]+)$') {
        Add-AuditFailure "Patch has a quoted, malformed, or non-canonical diff header: $line"
        continue
      }

      $leftPath = $Matches[1]
      $rightPath = $Matches[2]
      $leftSafe = Test-SafeRelativePath -Path $leftPath -Context 'Patch source path'
      $rightSafe = Test-SafeRelativePath -Path $rightPath -Context 'Patch destination path'
      $leftPublic = Test-SensitivePath -Path $leftPath -Context 'Patch source path'
      $rightPublic = Test-SensitivePath -Path $rightPath -Context 'Patch destination path'
      if ($leftSafe -and $rightSafe -and $leftPublic -and $rightPublic) {
        if ($rightPath -match '(?i)\.(?:diff|patch)$') {
          Add-AuditFailure "Canonical patch must not embed another patch or diff artifact: $rightPath"
        }
        if ([System.IO.Path]::GetFileName($rightPath) -match '(?i)^(?:RUN_REPORT|TEST_REPORT|BENCHMARK_REPORT)\.md$') {
          Add-AuditFailure "Canonical patch must not embed a generated development report: $rightPath"
        }
        [void]$patchPaths.Add($rightPath)
        $currentDiffPath = $rightPath
        $patchKinds[$rightPath] = 'modified'
      }
      continue
    }

    if ($line -ceq 'new file mode 100644' -or $line -ceq 'new file mode 100755') {
      if ($null -ne $currentDiffPath) {
        $patchKinds[$currentDiffPath] = 'added'
      }
      continue
    }

    if ($line -cmatch '^(?:---|\+\+\+) (.+)$') {
      $headerPath = $Matches[1]
      if ($headerPath -ceq '/dev/null') {
        continue
      }

      if ($headerPath -cnotmatch '^[ab]/(.+)$') {
        Add-AuditFailure "Patch has a malformed file header path: $headerPath"
        continue
      }

      $strippedHeaderPath = $Matches[1]
      [void](Test-SafeRelativePath -Path $strippedHeaderPath -Context 'Patch file header')
      [void](Test-SensitivePath -Path $strippedHeaderPath -Context 'Patch file header')
      continue
    }

    if ($line -cmatch '^(?:rename|copy) (?:from|to) (.+)$') {
      $movePath = $Matches[1]
      [void](Test-SafeRelativePath -Path $movePath -Context 'Patch rename/copy path')
      [void](Test-SensitivePath -Path $movePath -Context 'Patch rename/copy path')
      continue
    }

    if (
      $line -match '^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |@@ |\\ No newline)'
    ) {
      continue
    }

    # Inspect every source payload line, including removed and context text. A
    # removed secret or machine path is still present in the published patch.
    $payload = $line
    if ($payload.Length -gt 0 -and $payload[0] -in @('+', '-', ' ')) {
      $payload = $payload.Substring(1)
    }

    $hasAbsoluteLocalPath = (
      $payload -match '(?i)(?<![A-Za-z0-9+.-])(?:file:///)?[A-Z]:[\\/]' -or
      $payload -match '\\\\[A-Za-z0-9._-]+[\\/]'
    )
    if (-not $hasAbsoluteLocalPath) {
      $posixPathCandidates = [System.Text.RegularExpressions.Regex]::Matches(
        $payload,
        '(?i)/(?:Users|home|root|tmp|opt|srv|var/(?:tmp|log|lib|run))/'
      )
      foreach ($candidate in $posixPathCandidates) {
        $prefix = $payload.Substring(0, $candidate.Index)
        $lastSpace = [Math]::Max($prefix.LastIndexOf(' '), $prefix.LastIndexOf("`t"))
        $tokenPrefix = $prefix.Substring($lastSpace + 1)
        if (-not $tokenPrefix.Contains('://')) {
          $hasAbsoluteLocalPath = $true
          break
        }
      }
    }
    if ($hasAbsoluteLocalPath) {
      Add-AuditFailure "Canonical patch payload contains an absolute local path at patch line $patchLineNumber."
    }

    if ($payload -match '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b') {
      Add-AuditFailure "Canonical patch payload contains an email address at patch line $patchLineNumber."
    }

    $ipv4Candidates = [System.Text.RegularExpressions.Regex]::Matches(
      $payload,
      '(?<![0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9])'
    )
    foreach ($candidate in $ipv4Candidates) {
      if (Test-IsPublicIPv4 -Value $candidate.Value) {
        Add-AuditFailure "Canonical patch payload contains a public IPv4 address at patch line $patchLineNumber."
        break
      }
    }

    $ipv6Candidates = [System.Text.RegularExpressions.Regex]::Matches(
      $payload,
      '(?<![0-9A-Fa-f:])(?=[23][0-9A-Fa-f]{3}:[0-9A-Fa-f:]*[0-9A-Fa-f])[23][0-9A-Fa-f]{3}(?::[0-9A-Fa-f]{0,4}){2,7}(?![0-9A-Fa-f:])'
    )
    foreach ($candidate in $ipv6Candidates) {
      if (Test-IsPublicIPv6 -Value $candidate.Value) {
        Add-AuditFailure "Canonical patch payload contains a public IPv6 address at patch line $patchLineNumber."
        break
      }
    }

    if (
      $payload -match '-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----' -or
      $payload -match '\bgh[pousr]_[A-Za-z0-9]{20,}\b' -or
      $payload -match '\bgithub_pat_[A-Za-z0-9_]{20,}\b' -or
      $payload -match '\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b' -or
      $payload -match '\bAKIA[0-9A-Z]{16}\b' -or
      $payload -match '\bAIza[0-9A-Za-z_-]{30,}\b' -or
      $payload -match '\bxox[baprs]-[A-Za-z0-9-]{10,}\b' -or
      $payload -match '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b' -or
      $payload -match '(?i)\b(?:authorization|proxy-authorization)\s*[:=]\s*[''"]?(?:basic|bearer)\s+[A-Za-z0-9._~+/-]{12,}'
    ) {
      Add-AuditFailure "Canonical patch payload contains private-key or token-shaped material at patch line $patchLineNumber."
    }

    $literalSecretMatch = [System.Text.RegularExpressions.Regex]::Match(
      $payload,
      '(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*([''"])(?<value>[^''"\r\n]{4,})\1'
    )
    if (
      $literalSecretMatch.Success -and
      -not (Test-IsPlaceholderSecret -Value $literalSecretMatch.Groups['value'].Value)
    ) {
      Add-AuditFailure "Canonical patch payload contains a literal credential assignment at patch line $patchLineNumber."
    }
  }

  if ($diffCount -eq 0 -or $patchPaths.Count -eq 0) {
    Add-AuditFailure 'Canonical patch contains no canonical diff --git file entries.'
  }

  if ($null -eq $gitCommand) {
    Add-AuditFailure 'Git is required to validate the canonical patch syntax.'
  }
  else {
    $gitParseOutput = (& $gitCommand.Source -C $RepositoryRoot apply --numstat -- $canonicalPatch.FullName 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      Add-AuditFailure "Git could not parse the canonical patch: $gitParseOutput"
    }
  }
}

$jsonManifestFiles = @(
  Get-ChildItem -LiteralPath $RepositoryRoot -Force -Recurse -File -Filter '*.json' |
    Where-Object {
      $relative = Convert-ToRepositoryPath -FullName $_.FullName
      -not $relative.StartsWith('.git/', [System.StringComparison]::OrdinalIgnoreCase)
    }
)

$manifestByName = @{}
foreach ($manifestFile in $jsonManifestFiles) {
  $manifestPath = Convert-ToRepositoryPath -FullName $manifestFile.FullName
  if ($manifestFile.Name -cnotin @('baseline-manifest.json', 'installed-manifest.json')) {
    Add-AuditFailure "Unexpected JSON file; only the two release manifests are allowed: $manifestPath"
    continue
  }

  if ($manifestByName.ContainsKey($manifestFile.Name)) {
    Add-AuditFailure "Duplicate JSON manifest name: $($manifestFile.Name)"
    continue
  }

  try {
    $manifest = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
    $manifestByName[$manifestFile.Name] = [pscustomobject]@{
      File = $manifestFile
      Path = $manifestPath
      Data = $manifest
      Entries = @(
        Get-ManifestEntries `
          -Manifest $manifest `
          -ManifestPath $manifestPath `
          -AllowAddedBaselinePlaceholder:($manifestFile.Name -ceq 'baseline-manifest.json')
      )
    }
  }
  catch {
    Add-AuditFailure "JSON manifest could not be parsed ($manifestPath): $($_.Exception.Message)"
  }
}

foreach ($requiredManifest in @('baseline-manifest.json', 'installed-manifest.json')) {
  if (-not $manifestByName.ContainsKey($requiredManifest)) {
    Add-AuditFailure "Required JSON manifest is missing: $requiredManifest"
  }
}

foreach ($manifestName in @('baseline-manifest.json', 'installed-manifest.json')) {
  if (-not $manifestByName.ContainsKey($manifestName)) {
    continue
  }

  $manifestRecord = $manifestByName[$manifestName]
  $manifestProperties = @($manifestRecord.Data.PSObject.Properties.Name)
  foreach ($requiredProperty in @('schemaVersion', 'pluginVersion', 'fileCount', 'files')) {
    if ($manifestProperties -notcontains $requiredProperty) {
      Add-AuditFailure "$manifestName is missing required property: $requiredProperty"
    }
  }

  if ($manifestProperties -contains 'schemaVersion' -and [string]$manifestRecord.Data.schemaVersion -cne '1') {
    Add-AuditFailure "$manifestName has an unsupported schemaVersion."
  }
  if ($manifestProperties -contains 'pluginVersion' -and [string]::IsNullOrWhiteSpace([string]$manifestRecord.Data.pluginVersion)) {
    Add-AuditFailure "$manifestName has an empty pluginVersion identifier."
  }
  if ($manifestProperties -contains 'fileCount') {
    $declaredFileCount = 0L
    if (
      -not [long]::TryParse([string]$manifestRecord.Data.fileCount, [ref]$declaredFileCount) -or
      $declaredFileCount -ne $manifestRecord.Entries.Count
    ) {
      Add-AuditFailure "$manifestName fileCount does not match its files array."
    }
  }
}

if (
  $manifestByName.ContainsKey('baseline-manifest.json') -and
  $manifestByName.ContainsKey('installed-manifest.json') -and
  [string]$manifestByName['baseline-manifest.json'].Data.pluginVersion -cne [string]$manifestByName['installed-manifest.json'].Data.pluginVersion
) {
  Add-AuditFailure 'Plugin version identifiers do not match between the two manifests.'
}

if ($null -ne $canonicalPatch -and $manifestByName.Count -gt 0) {
  $patchDirectory = Get-NormalizedFullPath -Path $canonicalPatch.DirectoryName
  foreach ($manifestRecord in $manifestByName.Values) {
    if ((Get-NormalizedFullPath -Path $manifestRecord.File.DirectoryName) -cne $patchDirectory) {
      Add-AuditFailure "Release manifest must be adjacent to the canonical patch: $($manifestRecord.Path)"
    }
  }
}

if ($manifestByName.ContainsKey('installed-manifest.json') -and $null -ne $canonicalPatch) {
  $installedRecord = $manifestByName['installed-manifest.json']
  $installedProperties = @($installedRecord.Data.PSObject.Properties.Name)
  if ($installedProperties -notcontains 'patchFile' -or [string]$installedRecord.Data.patchFile -cne $canonicalPatch.Name) {
    Add-AuditFailure 'installed-manifest.json patchFile does not name the canonical patch.'
  }
  if ($installedProperties -notcontains 'patchSha256') {
    Add-AuditFailure 'installed-manifest.json is missing patchSha256.'
  }
  else {
    $declaredPatchHash = [string]$installedRecord.Data.patchSha256
    $actualPatchHash = (Get-FileHash -LiteralPath $canonicalPatch.FullName -Algorithm SHA256).Hash
    if ($declaredPatchHash -notmatch '^[0-9A-Fa-f]{64}$' -or $declaredPatchHash.ToUpperInvariant() -cne $actualPatchHash) {
      Add-AuditFailure 'installed-manifest.json patchSha256 does not match the canonical patch.'
    }
  }

  $installedAddedCount = @($installedRecord.Entries | Where-Object { $_.Kind -ceq 'added' }).Count
  $installedModifiedCount = @($installedRecord.Entries | Where-Object { $_.Kind -ceq 'modified' }).Count
  foreach ($countCheck in @(
    [pscustomobject]@{ Property = 'addedFileCount'; Expected = $installedAddedCount },
    [pscustomobject]@{ Property = 'modifiedFileCount'; Expected = $installedModifiedCount }
  )) {
    if ($installedProperties -notcontains $countCheck.Property) {
      Add-AuditFailure "installed-manifest.json is missing $($countCheck.Property)."
      continue
    }
    if ([string]$installedRecord.Data.($countCheck.Property) -cne [string]$countCheck.Expected) {
      Add-AuditFailure "installed-manifest.json $($countCheck.Property) is incorrect."
    }
  }
}

if ($manifestByName.ContainsKey('baseline-manifest.json')) {
  $baselineData = $manifestByName['baseline-manifest.json'].Data
  $baselineProperties = @($baselineData.PSObject.Properties.Name)
  if ($baselineProperties -notcontains 'compatibility' -or $null -eq $baselineData.compatibility) {
    Add-AuditFailure 'baseline-manifest.json is missing compatibility metadata.'
  }
  else {
    $compatibilityProperties = @($baselineData.compatibility.PSObject.Properties.Name)
    foreach ($requiredCompatibilityProperty in @('product', 'version', 'archiveName', 'archiveSha256')) {
      if ($compatibilityProperties -notcontains $requiredCompatibilityProperty) {
        Add-AuditFailure "baseline-manifest.json compatibility is missing $requiredCompatibilityProperty."
      }
    }
    if ($compatibilityProperties -contains 'version' -and [string]$baselineData.compatibility.version -cne 'v0.12.3.1') {
      Add-AuditFailure 'baseline-manifest.json compatibility.version is not v0.12.3.1.'
    }
    if (
      $compatibilityProperties -contains 'archiveSha256' -and
      [string]$baselineData.compatibility.archiveSha256.ToUpperInvariant() -cne $ExpectedBaselineArchiveSha256
    ) {
      Add-AuditFailure 'baseline-manifest.json compatibility.archiveSha256 does not identify the approved EveJS v0.12.3.1 source archive.'
    }
  }
}

# Both manifests must describe precisely the files changed by the patch. This keeps
# verification and uninstall behavior scoped to the published delta.
foreach ($manifestName in @('baseline-manifest.json', 'installed-manifest.json')) {
  if (-not $manifestByName.ContainsKey($manifestName)) {
    continue
  }

  $manifestRecord = $manifestByName[$manifestName]
  $manifestPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($entry in $manifestRecord.Entries) {
    [void]$manifestPaths.Add($entry.Path)
    if ($patchKinds.ContainsKey($entry.Path) -and $entry.Kind -cne $patchKinds[$entry.Path]) {
      Add-AuditFailure "$manifestName kind does not match the patch for $($entry.Path)."
    }
  }

  foreach ($patchPath in $patchPaths) {
    if (-not $manifestPaths.Contains($patchPath)) {
      Add-AuditFailure "$manifestName does not cover patched path: $patchPath"
    }
  }

  foreach ($manifestPath in $manifestPaths) {
    if (-not $patchPaths.Contains($manifestPath)) {
      Add-AuditFailure "$manifestName contains a path not present in the patch: $manifestPath"
    }
  }
}

$checksumFiles = @(
  Get-ChildItem -LiteralPath $RepositoryRoot -Force -Recurse -File |
    Where-Object { $_.Name -ceq 'SHA256SUMS' }
)

if ($checksumFiles.Count -gt 1) {
  Add-AuditFailure "Expected at most one SHA256SUMS file; found $($checksumFiles.Count)."
}
elseif ($checksumFiles.Count -eq 1 -and $null -ne $canonicalPatch) {
  $checksumFile = $checksumFiles[0]
  if ((Get-NormalizedFullPath -Path $checksumFile.DirectoryName) -cne (Get-NormalizedFullPath -Path $canonicalPatch.DirectoryName)) {
    Add-AuditFailure 'SHA256SUMS must be adjacent to the canonical patch.'
  }

  $checksumEntries = @{}
  $checksumLines = @(Get-Content -LiteralPath $checksumFile.FullName)
  for ($lineIndex = 0; $lineIndex -lt $checksumLines.Count; $lineIndex += 1) {
    $line = $checksumLines[$lineIndex]
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) {
      continue
    }

    if ($line -cnotmatch '^([0-9A-Fa-f]{64})[ \t]+\*?(.+?)\s*$') {
      Add-AuditFailure "Malformed SHA256SUMS line $($lineIndex + 1)."
      continue
    }

    $declaredHash = $Matches[1].ToUpperInvariant()
    $checksumPath = $Matches[2]
    if (-not (Test-SafeRelativePath -Path $checksumPath -Context 'SHA256SUMS path')) {
      continue
    }
    if (-not (Test-SensitivePath -Path $checksumPath -Context 'SHA256SUMS path')) {
      continue
    }
    if ($checksumEntries.ContainsKey($checksumPath)) {
      Add-AuditFailure "SHA256SUMS contains a duplicate path: $checksumPath"
      continue
    }

    $checksumEntries[$checksumPath] = $declaredHash
    $candidatePath = Get-NormalizedFullPath -Path (Join-Path $checksumFile.DirectoryName $checksumPath)
    $checksumRootPrefix = (Get-NormalizedFullPath -Path $checksumFile.DirectoryName) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidatePath.StartsWith($checksumRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      Add-AuditFailure "SHA256SUMS path escapes its release directory: $checksumPath"
      continue
    }
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      Add-AuditFailure "SHA256SUMS references a missing file: $checksumPath"
      continue
    }

    $actualHash = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash
    if ($actualHash -cne $declaredHash) {
      Add-AuditFailure "SHA256 mismatch for $checksumPath."
    }
  }

  $expectedChecksumPaths = @(
    $canonicalPatch.Name,
    'baseline-manifest.json',
    'installed-manifest.json'
  )
  foreach ($expectedChecksumPath in $expectedChecksumPaths) {
    if (-not $checksumEntries.ContainsKey($expectedChecksumPath)) {
      Add-AuditFailure "SHA256SUMS is missing required entry: $expectedChecksumPath"
    }
  }
  foreach ($checksumPath in $checksumEntries.Keys) {
    if ($checksumPath -cnotin $expectedChecksumPaths) {
      Add-AuditFailure "SHA256SUMS contains an unexpected entry: $checksumPath"
    }
  }
}

# Detect private key payloads even if somebody disguises one with an allowed name.
$textFiles = @(
  $repositoryItems | Where-Object {
    -not $_.PSIsContainer -and
    [System.IO.Path]::GetExtension($_.Name).ToLowerInvariant() -in @('.md', '.txt', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.json', '.patch')
  }
)
foreach ($textFile in $textFiles) {
  $privateKeyMarker = Select-String -LiteralPath $textFile.FullName -Pattern '-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----' -Quiet
  if ($privateKeyMarker) {
    Add-AuditFailure "Private-key material is present in: $(Convert-ToRepositoryPath -FullName $textFile.FullName)"
  }
}

if ($Failures.Count -gt 0) {
  Write-Host "Patch repository audit failed with $($Failures.Count) problem(s):" -ForegroundColor Red
  foreach ($failure in $Failures) {
    Write-Host " - $failure" -ForegroundColor Red
  }
  exit 1
}

Write-Host 'Patch repository audit passed.' -ForegroundColor Green
Write-Host ' - No full EveJS source or runtime trees are present or tracked.'
Write-Host ' - Exactly one canonical text patch is present; its paths and payload pass the public-release privacy scan.'
Write-Host ' - Release manifests and SHA256SUMS are valid and complete.'
