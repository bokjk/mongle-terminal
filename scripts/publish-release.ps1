param(
  [Parameter(Mandatory = $true)][ValidatePattern('^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')][string]$Version,
  [string]$OutputDir = 'release',
  [switch]$CheckOnly
)
$repository = 'bokjk/mongle-terminal-releases'
$tag = "v$Version"
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath "$OutputDir/RELEASE-NOTES.md" -PathType Leaf)) { throw 'Missing reviewed release notes.' }
$assets = @(
  "$OutputDir/MongleTerminal-Setup-$Version-x64.exe",
  "$OutputDir/MongleTerminal-Setup-$Version-x64.exe.blockmap",
  "$OutputDir/MongleTerminal-$Version-x64.zip",
  "$OutputDir/latest.yml",
  "$OutputDir/SHA256SUMS.txt"
)
foreach ($asset in $assets) { if (!(Test-Path -LiteralPath $asset -PathType Leaf)) { throw "Missing release asset: $asset" } }
$checksumLines = Get-Content -LiteralPath "$OutputDir/SHA256SUMS.txt"
if ($checksumLines.Count -ne 4) { throw 'Unexpected checksum count.' }
$expectedNames = @($assets[0..3] | ForEach-Object { Split-Path -Leaf $_ })
foreach ($line in $checksumLines) {
  if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$') { throw 'Invalid checksum record.' }
  $expected = $Matches[1]
  $name = $Matches[2]
  if ($name -notin $expectedNames) { throw 'Unexpected checksum filename.' }
  $expectedNames = @($expectedNames | Where-Object { $_ -ne $name })
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutputDir $name)).Hash.ToLowerInvariant() -ne $expected) { throw "Checksum mismatch: $name" }
}
if ($expectedNames.Count -ne 0) { throw 'Missing checksum record.' }
if ($CheckOnly) { Write-Output 'Release asset checksums verified.'; exit 0 }
$visibility = gh repo view $repository --json visibility --jq .visibility
if ($LASTEXITCODE -ne 0 -or $visibility -ne 'PUBLIC') { throw 'The distribution repository must be public.' }
$releasesJson = gh release list --repo $repository --limit 100 --json tagName,isDraft
if ($LASTEXITCODE) { throw 'Cannot read existing releases.' }
$existing = @($releasesJson | ConvertFrom-Json) | Where-Object { $_.tagName -eq $tag }
if ($existing) {
  if (!$existing.isDraft) { throw 'This version is already published; published releases are immutable. Bump the version.' }
  gh release upload "$tag" @assets --repo $repository --clobber
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  gh release edit "$tag" --repo $repository --draft --notes-file "$OutputDir/RELEASE-NOTES.md"
} else {
  # This tag belongs to the public README repository, never the private source history.
  gh release create "$tag" @assets --repo $repository --target main --draft --latest=false --title "Mongle Terminal $Version" --notes-file "$OutputDir/RELEASE-NOTES.md"
}
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Output 'Draft prepared. Review the release and publish it manually when ready.'
