# Preserve verified release files when Actions artifact storage is unavailable.
# Invoke only after ALL mandatory release checks succeeded and windows-release
# artifact upload failed. Do not infer a quota-specific cause from an action
# outcome: upload-artifact exposes failure, not a dependable error-category output.
# The trusted caller must pass actual steps.<id>.outcome (not conclusion) for:
# releaseDocuments,typecheck,build,regression,package,native,nativeEvidence,
# postPackageDocuments,nsis,installedEvidence.
# This script cannot independently prove those caller-supplied outcomes.
# Native/NSIS result files are additionally mandatory, even when not uploaded.
# Strict identity rule: checkout HEAD, existing local/remote version tag, and
# GITHUB_SHA must match. workflow_dispatch from a different ref is rejected;
# this script does not silently substitute the tag SHA. Tag-push use is expected.
#
# Set GH_TOKEN to this job's github.token ONLY on the calling step. contents:write
# is a JOB permission, not a step isolation boundary. Never use a public-repo PAT.
# Keep the existing release-tag concurrency group; do not run competing writers.
# No public publishing, tag creation/movement, overwrites, or global configuration.
# References: https://cli.github.com/manual/gh_release_create
#             https://docs.github.com/en/rest/releases/assets
#
# Success emits only a JSON manifest envelope. Raw CLI stderr/result JSON is never
# printed. A partial release stays unpublished as a draft even in a public
# source repository; the SAME run/attempt and
# exact manifest may resume it. Different attempts require separate human review.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$Version,
  [Parameter(Mandatory)][string]$VerificationOutcomesJson,
  [Parameter(Mandatory)][ValidateSet('failure')][string]$ArtifactUploadOutcome,
  [Parameter(Mandatory)][ValidateSet('upload-failed')][string]$ArtifactStorageFailure,
  [switch]$IncludePrivateValidationResults
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = 'bokjk/mongle-terminal'
$tag = "v$Version"

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
}
function Parse-Json([string]$Text) {
  try { return ConvertFrom-Json -InputObject $Text -AsHashtable -ErrorAction Stop }
  catch { throw 'Invalid JSON; raw content withheld.' }
}
function Invoke-Captured([string]$Tool, [string[]]$Arguments) {
  # ArgumentList avoids command-string interpolation; credentials stay in env.
  $command = Get-Command $Tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $command.Source
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  $info.Environment['GH_HOST'] = 'github.com'
  $info.Environment['GH_PROMPT_DISABLED'] = '1'
  [void]$info.Environment.Remove('GH_DEBUG')
  [void]$info.Environment.Remove('DEBUG')
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(600000)) {
      $process.Kill($true)
      throw 'Preservation subprocess timed out; remote outcome must be rechecked.'
    }
    $output = $stdout.GetAwaiter().GetResult()
    [void]$stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "Preservation subprocess failed (exit $($process.ExitCode)); raw output withheld." }
    return $output.Trim()
  } finally { $process.Dispose() }
}
function Api([string]$Endpoint, [switch]$Pages) {
  $arguments = @('api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28', $Endpoint)
  if ($Pages) { $arguments += @('--paginate', '--slurp') }
  return Parse-Json (Invoke-Captured 'gh' $arguments)
}
function Plain-File([string]$File) {
  $item = Get-Item -LiteralPath $File -ErrorAction Stop
  Assert-Condition (!$item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) 'Expected a regular file, not a link.'
  return $item
}
function File-Record([string]$File, [string]$AssetName) {
  $item = Plain-File $File
  Assert-Condition ($item.Length -gt 0 -and $item.Length -lt 2GB) 'Asset must be nonempty and below 2 GiB.'
  return [ordered]@{ name = $AssetName; bytes = [long]$item.Length; sha256 = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Assert-LocalFile([string]$File, $Expected) {
  $actual = File-Record $File $Expected.name
  Assert-Condition ($actual.bytes -eq $Expected.bytes -and $actual.sha256 -ceq $Expected.sha256) 'Local asset changed after manifest creation.'
}
function Assert-RemoteContext {
  $repo = Api "repos/$repository"
  Assert-Condition ($repo.full_name -ceq $repository -and $repo.private -is [bool] -and
    (($repo.private -and $repo.visibility -ceq 'private') -or
     (!$repo.private -and $repo.visibility -ceq 'public'))) 'Expected the named source repository with consistent public/private visibility.'
  $reference = Api "repos/$repository/git/ref/tags/$tag"
  Assert-Condition ($reference.ref -ceq "refs/tags/$tag") 'Exact existing tag is required.'
  $object = $reference.object
  for ($depth = 0; $object.type -ceq 'tag'; $depth++) {
    Assert-Condition ($depth -lt 8 -and $object.sha -match '^[a-f0-9]{40}$') 'Invalid annotated tag chain.'
    $tagObject = Api "repos/$repository/git/tags/$($object.sha)"
    $object = $tagObject.object
  }
  Assert-Condition ($object.type -ceq 'commit' -and $object.sha -ceq $script:commit) 'Remote tag does not resolve to GITHUB_SHA.'
}
function Find-Release {
  # REST release lists can omit drafts for Actions installation tokens even
  # though GraphQL sees them (cli/cli#5252). Do not infer absence from REST.
  # gh release list --json does not expose databaseId/body: query them directly.
  $query = 'query($endCursor: String) { repository(owner: "bokjk", name: "mongle-terminal") { releases(first: 100, after: $endCursor) { nodes { databaseId tagName isDraft description } pageInfo { hasNextPage endCursor } } } }'
  $cursor = $null
  $seenCursors = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $found = $null
  do {
    $arguments = @('api', '--hostname', 'github.com', 'graphql', '-f', "query=$query")
    if ($null -ne $cursor) { $arguments += @('-f', "endCursor=$cursor") }
    $page = Parse-Json (Invoke-Captured 'gh' $arguments)
    Assert-Condition ($page -is [Collections.IDictionary]) 'Invalid GraphQL release response.'
    Assert-Condition (!$page.Contains('errors') -or @($page.errors).Count -eq 0) 'GraphQL release query failed; raw errors withheld.'
    Assert-Condition ($page.data -is [Collections.IDictionary] -and $page.data.repository -is [Collections.IDictionary]) 'GraphQL repository unavailable; not treating it as an absent release.'
    $connection = $page.data.repository.releases
    Assert-Condition ($connection -is [Collections.IDictionary] -and $connection.nodes -is [array] -and $connection.pageInfo -is [Collections.IDictionary]) 'Invalid GraphQL release connection.'
    foreach ($entry in $connection.nodes) {
      Assert-Condition ($entry -is [Collections.IDictionary] -and $entry.tagName -is [string] -and $entry.isDraft -is [bool]) 'Invalid GraphQL release node.'
      if ($entry.tagName -ceq $tag) {
        Assert-Condition ($null -eq $found) 'Ambiguous release tag.'
        Assert-Condition (($entry.databaseId -is [long] -or $entry.databaseId -is [int]) -and $entry.databaseId -gt 0) 'Invalid release database ID.'
        Assert-Condition ($null -eq $entry.description -or $entry.description -is [string]) 'Invalid release description.'
        $found = @{ id = [long]$entry.databaseId; tag_name = $entry.tagName; draft = $entry.isDraft; body = $entry.description }
      }
    }
    Assert-Condition ($connection.pageInfo.hasNextPage -is [bool]) 'Invalid GraphQL pagination state.'
    $more = $connection.pageInfo.hasNextPage
    if ($more) {
      $cursor = $connection.pageInfo.endCursor
      Assert-Condition ($cursor -is [string] -and ![string]::IsNullOrWhiteSpace($cursor) -and $seenCursors.Add($cursor)) 'Invalid or repeated GraphQL cursor.'
    }
  } while ($more)
  return $found
}
function Assert-Draft($Release) {
  Assert-Condition ($null -ne $Release) 'Expected release is missing; preservation incomplete.'
  Assert-Condition ($Release.tag_name -ceq $tag -and $Release.draft -is [bool] -and $Release.draft -eq $true) 'An existing published release must never be changed.'
  Assert-Condition ($Release.body -ceq $script:body) 'Draft belongs to another run/attempt/SHA/manifest; refusing mixed retry.'
}
function Wait-NewRelease {
  # A successful create can precede visibility in the paginated release listing.
  # Retry only absence, never API/parse errors or an existing invalid release.
  for ($lookup = 1; $lookup -le 12; $lookup++) {
    $candidate = Find-Release
    if ($null -ne $candidate) {
      Assert-Draft $candidate
      return $candidate
    }
    if ($lookup -lt 12) { Start-Sleep -Seconds 2 }
  }
  throw 'Created release is still missing after 12 lookups; preservation incomplete.'
}
function Remote-Assets([long]$ReleaseId) {
  $pages = Api "repos/$repository/releases/$ReleaseId/assets?per_page=100" -Pages
  return @($pages | ForEach-Object { foreach ($asset in $_) { $asset } })
}
function Assert-AssetSet($Assets, [switch]$Complete) {
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($asset in $Assets) {
    Assert-Condition ($seen.Add([string]$asset.name)) 'Duplicate remote asset name.'
    Assert-Condition ($script:expected.Contains([string]$asset.name)) 'Unexpected remote asset; refusing mixed retry.'
    $record = $script:expected[[string]$asset.name]
    Assert-Condition ($record.name -ceq $asset.name) 'Remote filename case differs from the exact allowlist.'
    Assert-Condition ($asset.state -ceq 'uploaded' -and [long]$asset.size -eq $record.bytes -and
      $asset.digest -ceq "sha256:$($record.sha256)") 'Remote asset size/digest/state mismatch or unavailable digest.'
  }
  if ($Complete) { Assert-Condition ($seen.Count -eq $script:expected.Count) 'Required remote assets are missing.' }
}

Assert-Condition ($env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_REPOSITORY -ceq $repository) 'Only the trusted source-repository Actions job may call this script.'
Assert-Condition ($env:GITHUB_SERVER_URL -ceq 'https://github.com' -and $env:GITHUB_API_URL -ceq 'https://api.github.com') 'Unexpected GitHub server.'
Assert-Condition ($env:GITHUB_EVENT_NAME -cin @('push', 'workflow_dispatch')) 'PR/event execution is forbidden.'
Assert-Condition ($env:GITHUB_SHA -cmatch '^[a-f0-9]{40}$' -and $env:GITHUB_RUN_ID -match '^[1-9][0-9]*$' -and $env:GITHUB_RUN_ATTEMPT -match '^[1-9][0-9]*$') 'Missing exact Actions identity.'
Assert-Condition (![string]::IsNullOrWhiteSpace($env:GH_TOKEN)) 'Calling step must supply its repository-scoped job token.'
Assert-Condition ([string]::IsNullOrWhiteSpace($env:RELEASE_REPO_TOKEN)) 'Public distribution credentials must not be supplied.'
if ($env:GITHUB_EVENT_NAME -ceq 'push') { Assert-Condition ($env:GITHUB_REF -ceq "refs/tags/$tag") 'Tag push does not match requested version.' }
$commit = $env:GITHUB_SHA
$runId = $env:GITHUB_RUN_ID
$attempt = $env:GITHUB_RUN_ATTEMPT
$root = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
Assert-Condition ((Invoke-Captured 'git' @('-C', $root, 'rev-parse', 'HEAD')) -ceq $commit) 'Checkout HEAD does not match GITHUB_SHA.'
Assert-Condition ((Invoke-Captured 'git' @('-C', $root, 'rev-parse', '--verify', "refs/tags/$tag`^{commit}")) -ceq $commit) 'Local existing tag does not match GITHUB_SHA.'
$outcomes = Parse-Json $VerificationOutcomesJson
foreach ($gate in @('releaseDocuments', 'typecheck', 'build', 'regression', 'package', 'native', 'nativeEvidence', 'postPackageDocuments', 'nsis', 'installedEvidence')) {
  Assert-Condition ($outcomes -is [Collections.IDictionary] -and $outcomes[$gate] -ceq 'success') 'Every mandatory verification outcome must be success.'
}
Assert-Condition (![string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY) -and
  ![string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) 'Actions summary/output channels are required.'
$package = Parse-Json ([IO.File]::ReadAllText((Join-Path $root 'package.json')))
Assert-Condition ($package.name -ceq 'mongle-terminal' -and $package.version -ceq $Version) 'Package version mismatch.'
Assert-RemoteContext

$releaseDir = Join-Path $root 'release'
$directory = Get-Item -LiteralPath $releaseDir
Assert-Condition ($directory.PSIsContainer -and (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) 'Release directory must not be a link.'
$names = @("MongleTerminal-Setup-$Version-x64.exe", "MongleTerminal-Setup-$Version-x64.exe.blockmap",
  "MongleTerminal-$Version-x64.zip", 'latest.yml', 'SHA256SUMS.txt', 'RELEASE-NOTES.md')
$paths = [ordered]@{}
$records = @()
foreach ($name in $names) {
  $file = Join-Path $releaseDir $name
  $paths[$name] = $file
  $records += File-Record $file $name
}
$sumLines = [IO.File]::ReadAllLines($paths['SHA256SUMS.txt'])
Assert-Condition ($sumLines.Count -eq 4) 'SHA256SUMS must contain exactly four assets.'
$sumSeen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($line in $sumLines) {
  Assert-Condition ($line -cmatch '^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$') 'Malformed SHA256SUMS entry.'
  $digest = $Matches[1]; $name = $Matches[2]
  Assert-Condition ($name -cin $names[0..3] -and $sumSeen.Add($name)) 'Unexpected or duplicate checksum filename.'
  $record = @($records | Where-Object { $_.name -ceq $name })[0]
  Assert-Condition ($digest -ceq $record.sha256) 'Release checksum mismatch.'
}

# These are required evidence, but private attachment of their raw JSON is opt-in.
$proofFiles = [ordered]@{
  'validation-clipboard.json' = 'test-results/e2e/clipboard/result.json'
  'validation-update-desktop.json' = 'test-results/e2e/update-desktop/result.json'
  'validation-installed-upgrade.json' = 'test-results/installed-upgrade/result.json'
}
$proofs = @()
$installedVerification = $null
foreach ($name in $proofFiles.Keys) {
  $file = Join-Path $root $proofFiles[$name]
  $record = File-Record $file $name
  Assert-Condition ($record.bytes -le 1MB) 'Validation evidence exceeds 1 MiB.'
  $value = Parse-Json ([IO.File]::ReadAllText($file))
  Assert-Condition ($value.passed -is [bool] -and $value.passed -eq $true -and $value.cleanedUp -is [bool] -and $value.cleanedUp -eq $true) 'Native/NSIS verification or cleanup did not pass.'
  if ($name -ceq 'validation-installed-upgrade.json') {
    Assert-Condition ($value.newVersion -ceq $Version -and $value.newInstallerSha256 -ceq $records[0].sha256) 'Installed verification does not identify this exact installer.'
    Assert-Condition ($value.installedAsarSha256 -cmatch '^[a-f0-9]{64}$' -and
      $value.installedHostBundle.sha256 -cmatch '^[a-f0-9]{64}$' -and
      $value.installedHostBundle.files -is [long] -and $value.installedHostBundle.files -gt 0) 'Missing installed binary fingerprints.'
    foreach ($kind in @('missing', 'extra', 'changed')) {
      Assert-Condition ($value.bundleDifference[$kind] -is [array] -and $value.bundleDifference[$kind].Count -eq 0) 'Installed bundle must exactly match packaged candidate.'
    }
    $installedVerification = [ordered]@{
      newVersion = $Version; newInstallerSha256 = $value.newInstallerSha256
      installedAsarSha256 = $value.installedAsarSha256
      installedHostBundle = [ordered]@{ files = $value.installedHostBundle.files; sha256 = $value.installedHostBundle.sha256 }
      bundleDifference = [ordered]@{ missing = @(); extra = @(); changed = @() }
    }
  }
  $proofs += [ordered]@{ name = $name; bytes = $record.bytes; sha256 = $record.sha256; passed = $true; cleanedUp = $true }
  if ($IncludePrivateValidationResults) { $paths[$name] = $file; $records += $record }
}
$manifest = [ordered]@{
  schema = 'mongle-private-release-preservation-v1'; repository = $repository
  tag = $tag; sha = $commit; runId = $runId; attempt = $attempt
  artifactStorageFailure = $ArtifactStorageFailure; artifactUploadOutcome = $ArtifactUploadOutcome
  verificationOutcomes = [ordered]@{}; validation = $proofs; installedVerification = $installedVerification; files = $records
}
foreach ($gate in @('releaseDocuments', 'typecheck', 'build', 'regression', 'package', 'native', 'nativeEvidence', 'postPackageDocuments', 'nsis', 'installedEvidence')) { $manifest.verificationOutcomes[$gate] = 'success' }
$manifestName = 'PRESERVATION-MANIFEST.json'
$manifestPath = Join-Path $releaseDir $manifestName
$manifestJson = ($manifest | ConvertTo-Json -Depth 10) + "`n"
if (Test-Path -LiteralPath $manifestPath) {
  [void](Plain-File $manifestPath)
  Assert-Condition ([IO.File]::ReadAllText($manifestPath) -ceq $manifestJson) 'Existing local preservation manifest differs; refusing overwrite.'
} else { [IO.File]::WriteAllText($manifestPath, $manifestJson, [Text.UTF8Encoding]::new($false)) }
$manifestRecord = File-Record $manifestPath $manifestName
$paths[$manifestName] = $manifestPath
$expected = [ordered]@{}
foreach ($record in ($records + @($manifestRecord))) { $expected[$record.name] = $record }
# Exact body comparison includes the manifest digest; same run cannot mix builds.
$body = "<!-- mongle-private-preservation:v1 tag=$tag sha=$commit run=$runId attempt=$attempt manifest=$($manifestRecord.sha256) -->"
$release = Find-Release
if ($null -eq $release) {
  Assert-RemoteContext
  [void](Invoke-Captured 'gh' @('release', 'create', $tag, '--repo', "github.com/$repository",
    '--verify-tag', '--draft', '--latest=false', '--title', "Verified source draft preservation $tag", '--notes', $body))
  $release = Wait-NewRelease
}
Assert-Draft $release
$releaseId = [long]$release.id
foreach ($name in $paths.Keys) {
  Assert-RemoteContext
  $release = Api "repos/$repository/releases/$releaseId"
  Assert-Draft $release
  $assets = @(Remote-Assets $releaseId)
  Assert-AssetSet $assets
  Assert-LocalFile $paths[$name] $expected[$name]
  if (@($assets | Where-Object { $_.name -ceq $name }).Count -eq 0) {
    # No --clobber. Optional proof basenames differ, so set the asset filename
    # explicitly via REST rather than gh's #label syntax (which only sets label).
    [void](Invoke-Captured 'gh' @('api', '--hostname', 'github.com', '--method', 'POST',
      '-H', 'Content-Type: application/octet-stream', '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      "https://uploads.github.com/repos/$repository/releases/$releaseId/assets?name=$([Uri]::EscapeDataString($name))",
      '--input', $paths[$name]))
  }
}
Assert-RemoteContext
Assert-Draft (Api "repos/$repository/releases/$releaseId")
Assert-AssetSet @(Remote-Assets $releaseId) -Complete
foreach ($name in $paths.Keys) { Assert-LocalFile $paths[$name] $expected[$name] }
# Required audit channels. Do not mark fallback successful without both writes.
Assert-Condition (![string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY) -and
  ![string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) 'Actions summary/output channels are required.'
$envelope = [ordered]@{ manifest = $manifest; manifestSha256 = $manifestRecord.sha256 } | ConvertTo-Json -Depth 12
# Never print tokens, raw verification JSON or captured CLI output.
Write-Output $envelope
$summary = @(
  '', '## Verified unpublished source draft; public distribution was NOT performed', '',
  '~~~json', $envelope, '~~~', '',
  'The manifest SHA256 above is the trusted digest from this verified run, not a value to trust from downloaded assets.',
  'Use a new empty local directory. With an already authenticated source-repository gh session:', '',
  '~~~powershell',
  ('$retrievalDir = ''<new-empty-directory>'''),
  ("gh release download $tag --repo $repository --pattern PRESERVATION-MANIFEST.json --dir " + '$retrievalDir'),
  'if ($LASTEXITCODE) { throw ''Manifest download failed'' }',
  ('$manifestPath = Join-Path $retrievalDir ''PRESERVATION-MANIFEST.json'''),
  ("if ((Get-FileHash -LiteralPath " + '$manifestPath' + " -Algorithm SHA256).Hash.ToLowerInvariant() -cne '$($manifestRecord.sha256)') { throw 'Manifest digest mismatch' }"),
  ('$m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json'),
  ("if (`$m.repository -cne '$repository' -or `$m.tag -cne '$tag' -or `$m.sha -cne '$commit' -or `$m.runId -cne '$runId' -or `$m.attempt -cne '$attempt') { throw 'Run identity mismatch' }"),
  ('$expectedNames = @(' + (($names | ForEach-Object { "'$_'" }) -join ',') + ')'),
  '$releaseFiles = @($m.files | Where-Object { $_.name -cin $expectedNames })',
  'if ($releaseFiles.Count -ne 6 -or @($releaseFiles.name | Sort-Object -Unique).Count -ne 6) { throw ''Manifest file set mismatch'' }',
  'foreach ($name in $expectedNames) {',
  ("  gh release download $tag --repo $repository --pattern " + '$name --dir $retrievalDir'),
  '  if ($LASTEXITCODE) { throw ''Asset download failed'' }',
  '  $f = @($releaseFiles | Where-Object { $_.name -ceq $name })[0]',
  '  $p = Join-Path $retrievalDir $name',
  '  if ((Get-Item -LiteralPath $p).Length -ne $f.bytes -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256) { throw ''Asset bytes mismatch'' }',
  '}',
  ("./scripts/publish-release.ps1 -Version $Version -OutputDir " + '$retrievalDir -CheckOnly'),
  'if ($LASTEXITCODE) { throw ''Distribution checks failed'' }',
  '~~~', '',
  'After these checks, separately perform the approved public draft/publish procedure using the existing publish-release.ps1 five-asset allowlist.',
  'Do not copy source archives, this preservation manifest, or private validation JSON to the public distribution repository.',
  'Use the existing local distribution credentials; do not copy a public token into this build job.'
) -join "`n"
[IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, $summary + "`n", [Text.UTF8Encoding]::new($false))
[IO.File]::AppendAllText($env:GITHUB_OUTPUT, "manifest-sha256=$($manifestRecord.sha256)`n", [Text.UTF8Encoding]::new($false))
