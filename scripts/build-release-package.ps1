[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Commit = 'HEAD',
  [switch]$SkipChecks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
  }
}

function Remove-ReleaseTempDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TempBase
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedBase = [System.IO.Path]::GetFullPath($TempBase).TrimEnd('\', '/')
  $basePrefix = $resolvedBase + [System.IO.Path]::DirectorySeparatorChar
  $leaf = Split-Path -Leaf $resolvedPath
  if (-not $resolvedPath.StartsWith($basePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or $leaf -notlike 'napm-release-*') {
    throw "Refusing to remove unexpected temporary path: $resolvedPath"
  }

  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("napm-release-" + [System.Guid]::NewGuid().ToString('N'))
$finalArchive = $null
$removeFailedArchive = $false

Push-Location $repoRoot
try {
  $packageJson = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  $packageVersion = ([string]$packageJson.version).Trim()
  if (-not $Version) {
    $Version = $packageVersion
  }
  if ($Version -ne $packageVersion) {
    throw "Requested version '$Version' does not match package.json version '$packageVersion'."
  }
  if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.-]*$') {
    throw "Invalid release version: $Version"
  }

  $status = @(& git status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read Git worktree status.'
  }
  if ($status.Count -gt 0) {
    throw "The worktree is not clean. Commit the current changes before building a release package.`n$($status -join "`n")"
  }

  $commitHash = ([string](& git rev-parse "$Commit^{commit}")).Trim()
  if ($LASTEXITCODE -ne 0 -or $commitHash -notmatch '^[0-9a-f]{40}$') {
    throw "Unable to resolve commit: $Commit"
  }

  $releaseTag = "v$Version"
  $existingTags = @(& git tag --list $releaseTag)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to check whether release tag '$releaseTag' already exists."
  }
  if ($existingTags.Count -gt 0) {
    $tagCommitHash = ([string](& git rev-list -n 1 $releaseTag)).Trim()
    if ($LASTEXITCODE -ne 0 -or $tagCommitHash -notmatch '^[0-9a-f]{40}$') {
      throw "Unable to resolve existing release tag: $releaseTag"
    }
    if ($tagCommitHash -ne $commitHash) {
      throw "Release version '$Version' is already fixed to commit '$tagCommitHash' by tag '$releaseTag'. Current commit is '$commitHash'. Bump package.json and package-lock.json before building a new release."
    }
  }

  $shortCommit = $commitHash.Substring(0, 8)
  $branch = ([string](& git branch --show-current)).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to resolve current Git branch.'
  }

  if (-not $SkipChecks) {
    $npmCommandInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommandInfo) {
      $npmCommandInfo = Get-Command npm -ErrorAction Stop
    }
    $npmCommand = $npmCommandInfo.Source
    Invoke-CheckedCommand $npmCommand @('test', '--', '--runInBand', '--silent')
    Invoke-CheckedCommand $npmCommand @('run', 'lint')
    Invoke-CheckedCommand $npmCommand @('run', 'verify:runtime-contract')
  }

  $archiveName = "NAPM_skill-$Version-$shortCommit"
  $distDir = Join-Path $repoRoot 'dist'
  $finalArchive = Join-Path $distDir "$archiveName.zip"
  if (Test-Path -LiteralPath $finalArchive) {
    throw "Release package already exists: $finalArchive"
  }

  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null
  $gitArchive = Join-Path $tempRoot 'tracked-source.zip'
  $stagingDir = Join-Path $tempRoot 'staging'
  $verificationDir = Join-Path $tempRoot 'verification'
  New-Item -ItemType Directory -Path $stagingDir | Out-Null
  New-Item -ItemType Directory -Path $verificationDir | Out-Null

  Invoke-CheckedCommand 'git' @(
    'archive',
    '--format=zip',
    "--prefix=$archiveName/",
    "--output=$gitArchive",
    $commitHash
  )
  Expand-Archive -LiteralPath $gitArchive -DestinationPath $stagingDir

  $packageRoot = Join-Path $stagingDir $archiveName
  if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) {
    throw 'Git archive did not contain the expected package root.'
  }

  $archivedPackageJsonPath = Join-Path $packageRoot 'package.json'
  if (-not (Test-Path -LiteralPath $archivedPackageJsonPath -PathType Leaf)) {
    throw 'Git archive did not contain package.json.'
  }
  $archivedPackageJson = Get-Content -LiteralPath $archivedPackageJsonPath -Raw | ConvertFrom-Json
  $archivedVersion = ([string]$archivedPackageJson.version).Trim()
  if ($archivedVersion -ne $Version) {
    throw "Requested version '$Version' does not match package.json version '$archivedVersion' in commit '$commitHash'."
  }

  $manifest = [ordered]@{
    schema = 'gaiop_napm_release.v1'
    name = 'NAPM_skill'
    version = $Version
    commit = $commitHash
    shortCommit = $shortCommit
    sourceBranch = $branch
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    source = 'git_archive_tracked_files'
    qualityGates = if ($SkipChecks) { @('skipped_by_operator') } else { @('npm_test', 'npm_run_lint', 'runtime_contract') }
    installCommand = 'bash scripts/verify-staged-release.sh && bash scripts/install-release.sh --dry-run && bash scripts/install-release.sh'
  }
  $manifestPath = Join-Path $packageRoot 'RELEASE-MANIFEST.json'
  $manifestJson = $manifest | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )

  $removeFailedArchive = $true
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $finalArchive -CompressionLevel Optimal
  Expand-Archive -LiteralPath $finalArchive -DestinationPath $verificationDir
  $verifiedRoot = Join-Path $verificationDir $archiveName

  $requiredPaths = @(
    'RELEASE-MANIFEST.json',
    'package.json',
    'package-lock.json',
    'openclaw.plugin.json',
    'napm-openclaw-plugin.remote.js',
    'plugin/AlertReferenceStore.js',
    'plugin/AlertReferenceService.js',
    'plugin/AlertPacketFinalReplyService.js',
    'plugin/ReportIntentClassifier.js',
    'plugin/TrustedToolContextStore.js',
    'skills/shared/NapmObjectTargetResolver.js',
    'scripts/install-release.sh',
    'scripts/rollback-release.sh',
    'scripts/verify-staged-release.sh',
    'scripts/verify-napm-skill-runtime-contract.js',
    'scripts/stage-openclaw-extension.sh',
    'scripts/verify-openclaw-extension-runtime.js',
    'skills/openclaw-napm-query/scripts/run_napm_query.js',
    'skills/openclaw-napm-alert-query/services/AlertDisplayFormatService.js',
    'skills/openclaw-napm-alert-packet-analysis/services/AlertMetricProfileService.js',
    'skills/openclaw-napm-alert-packet-analysis/services/AlertPacketWorkflowService.js',
    'skills/openclaw-napm-alert-packet-analysis/services/AlertPacketResultContractService.js',
    'skills/openclaw-napm-syslog-receiver/scripts/run_syslog_receiver.js'
  )
  foreach ($relativePath in $requiredPaths) {
    $candidate = Join-Path $verifiedRoot ($relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $candidate)) {
      throw "Release verification failed; missing: $relativePath"
    }
  }

  $forbidden = Get-ChildItem -LiteralPath $verifiedRoot -Recurse -Force | Where-Object {
    ($_.PSIsContainer -and $_.Name -in @('.git', 'node_modules', 'archive', 'test', 'logs', 'output', 'data')) -or
    (-not $_.PSIsContainer -and $_.Name -eq '.env') -or
    (-not $_.PSIsContainer -and $_.Extension -in @('.docx', '.log', '.tar', '.tgz', '.zip')) -or
    (-not $_.PSIsContainer -and $_.Name -match '^query_.*\.json$') -or
    (-not $_.PSIsContainer -and $_.Name -eq 'alert_packet_query.json') -or
    (-not $_.PSIsContainer -and $_.FullName.EndsWith('watcher.config.json'))
  }
  if ($forbidden) {
    throw "Release verification found forbidden paths:`n$($forbidden.FullName -join "`n")"
  }

  $verifiedManifest = Get-Content -LiteralPath (Join-Path $verifiedRoot 'RELEASE-MANIFEST.json') -Raw | ConvertFrom-Json
  if ($verifiedManifest.version -ne $Version -or $verifiedManifest.commit -ne $commitHash) {
    throw 'Release manifest does not match the requested Git version.'
  }

  $archiveInfo = Get-Item -LiteralPath $finalArchive
  $sha256Algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $archiveStream = [System.IO.File]::OpenRead($finalArchive)
    try {
      $sha256Bytes = $sha256Algorithm.ComputeHash($archiveStream)
    } finally {
      $archiveStream.Dispose()
    }
  } finally {
    $sha256Algorithm.Dispose()
  }
  $sha256 = ([System.BitConverter]::ToString($sha256Bytes)).Replace('-', '').ToLowerInvariant()
  $removeFailedArchive = $false
  Write-Host ''
  Write-Host 'Release package created.' -ForegroundColor Green
  Write-Host "Path:    $finalArchive"
  Write-Host "Version: $Version"
  Write-Host "Commit:  $commitHash"
  Write-Host "SHA256:  $sha256"
  Write-Host "Bytes:   $($archiveInfo.Length)"
} finally {
  Pop-Location
  if ($removeFailedArchive -and $finalArchive -and (Test-Path -LiteralPath $finalArchive -PathType Leaf)) {
    Remove-Item -LiteralPath $finalArchive -Force
  }
  Remove-ReleaseTempDirectory -Path $tempRoot -TempBase $tempBase
}
