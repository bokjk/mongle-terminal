# Offline test helper. Executes the proposal's ENTIRE main flow, replacing ONLY
# Invoke-Captured through its AST extent. No real executable, gh/git or network.
param([string]$ProposalPath, [string]$FixtureRoot, [string]$OutcomesJson)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($ProposalPath, [ref]$tokens, [ref]$errors)
if (@($errors).Count) { throw 'Proposal parse failed.' }
$functions = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-Captured' }, $true))
if ($functions.Count -ne 1) { throw 'Expected one subprocess boundary.' }
$replacement = @'
function Invoke-Captured([string]$Tool, [string[]]$Arguments) {
  if (!(Get-Variable -Scope Script -Name fixtureState -ErrorAction SilentlyContinue)) {
    $script:fixtureState = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($env:MOCK_STATE)) -AsHashtable
  }
  $s = $script:fixtureState
  $s.calls += @(@{ tool = $Tool; operation = ($Arguments -join ' ') })
  try {
    if ($Tool -ceq 'git') { return $env:GITHUB_SHA }
    if ($Tool -cne 'gh') { throw 'No executable fallback in mock.' }
    if ($Arguments[0] -ceq 'release' -and $Arguments[1] -ceq 'create') {
      if ($s.release) { throw 'Existing release.' }
      $s.createCalls++
      $s.release = @{ id = 11; tag_name = $Arguments[2]; draft = $true; body = $Arguments[[array]::IndexOf($Arguments, '--notes') + 1] }
      return ''
    }
    if ($Arguments[0] -cne 'api') { throw 'Unexpected gh mock command.' }
    $endpoints = @($Arguments | Where-Object { $_.StartsWith('repos/') -or $_.StartsWith('https://uploads.github.com/') })
    if ($endpoints.Count -ne 1) { throw 'Unexpected mock API shape.' }
    $endpoint = $endpoints[0]
    if ($endpoint.StartsWith('https://uploads.github.com/')) {
      $s.uploadCalls++
      if ($s.mode -ceq 'upload-failure' -and $s.uploadCalls -eq 2) { throw 'Synthetic upload failure.' }
      $name = [Uri]::UnescapeDataString(($endpoint -split '\?name=', 2)[1])
      $file = $Arguments[[array]::IndexOf($Arguments, '--input') + 1]
      $s.assets += @(@{ name = $name; size = (Get-Item -LiteralPath $file).Length; digest = ('sha256:' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()); state = 'uploaded' })
      return '{}'
    }
    if ($endpoint -ceq 'repos/bokjk/mongle-terminal') { return '{"full_name":"bokjk/mongle-terminal","private":true,"visibility":"private"}' }
    if ($endpoint.StartsWith('repos/bokjk/mongle-terminal/git/ref/tags/')) {
      $sha = if ($s.mode -ceq 'tag-mismatch') { 'd' * 40 } else { $env:GITHUB_SHA }
      return (@{ ref = 'refs/tags/v0.3.13'; object = @{ type = 'commit'; sha = $sha } } | ConvertTo-Json -Depth 5 -Compress)
    }
    if ($endpoint.Contains('/releases?')) {
      if (!$s.release) { return '[[]]' }
      return '[[' + ($s.release | ConvertTo-Json -Depth 5 -Compress) + ']]'
    }
    if ($endpoint.Contains('/assets?')) {
      return '[' + (ConvertTo-Json -InputObject @($s.assets) -Depth 6 -Compress) + ']'
    }
    if ($endpoint -ceq 'repos/bokjk/mongle-terminal/releases/11') { return ($s.release | ConvertTo-Json -Depth 5 -Compress) }
    throw 'Unexpected mock endpoint; network is unavailable.'
  } finally {
    [IO.File]::WriteAllText($env:MOCK_STATE, ($s | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  }
}
'@
$source = [IO.File]::ReadAllText($ProposalPath)
$extent = $functions[0].Extent
$modified = $source.Substring(0, $extent.StartOffset) + $replacement + $source.Substring($extent.EndOffset)
$temporaryScript = Join-Path $FixtureRoot 'proposal-with-mocked-processes.ps1'
[IO.File]::WriteAllText($temporaryScript, $modified, [Text.UTF8Encoding]::new($false))
& $temporaryScript -Version 0.3.13 -VerificationOutcomesJson $OutcomesJson -ArtifactUploadOutcome failure -ArtifactStorageFailure upload-failed
