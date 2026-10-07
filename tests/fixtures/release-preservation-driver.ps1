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
      if ($Arguments -notcontains '--draft' -or $Arguments -notcontains '--verify-tag' -or $Arguments -notcontains '--latest=false') { throw 'Creation must remain an unpublished draft of an existing tag.' }
      if ($s.release) { throw 'Existing release.' }
      $s.createCalls++
      # Keep the saved GitHub REST response shape (including null fields/assets),
      # with synthetic identity. Creation state and listing visibility differ.
      $s.release = @{ id = 11; tag_name = $Arguments[2]; draft = $true; body = $Arguments[[array]::IndexOf($Arguments, '--notes') + 1];
        url = 'https://api.github.com/repos/bokjk/mongle-terminal/releases/11';
        assets_url = 'https://api.github.com/repos/bokjk/mongle-terminal/releases/11/assets';
        html_url = 'https://github.com/bokjk/mongle-terminal/releases/tag/untagged-synthetic';
        target_commitish = 'dev'; name = 'Private verified preservation'; immutable = $false;
        prerelease = $false; published_at = $null; assets = @(); tarball_url = $null; zipball_url = $null }
      if ($s.mode -ceq 'published-aftercreate') { $s.release.draft = $false }
      if ($s.mode -ceq 'mixed-aftercreate') { $s.release.body = 'another run attempt' }
      return ''
    }
    if ($Arguments[0] -cne 'api') { throw 'Unexpected gh mock command.' }
    if ($Arguments -contains 'graphql') {
      $s.listCalls++
      $queries = @($Arguments | Where-Object { $_.StartsWith('query=') })
      if ($queries.Count -ne 1 -or !$queries[0].Contains('databaseId tagName isDraft description') -or !$queries[0].Contains('releases(first: 100, after: $endCursor)')) { throw 'Unexpected GraphQL query.' }
      $cursorArgs = @($Arguments | Where-Object { $_.StartsWith('endCursor=') })
      if ($cursorArgs.Count -gt 1 -or ($cursorArgs.Count -eq 1 -and $cursorArgs[0] -cne 'endCursor=synthetic-page-2')) { throw 'Unexpected GraphQL cursor.' }
      if ($s.mode -ceq 'graphql-errors') { return '{"errors":[{"message":"SYNTHETIC_PRIVATE_DO_NOT_LOG"}],"data":{"repository":null}}' }
      if ($s.mode -ceq 'graphql-null-repository') { return '{"data":{"repository":null}}' }
      if ($s.createCalls -gt 0) {
        $s.postCreateLookups++
        if ($s.mode -ceq 'api-error-aftercreate') { throw 'Synthetic listing API failure.' }
      }
      $hidden = !$s.release -or $s.mode -ceq 'nevervisible' -or ($s.mode -ceq 'delayedvisibility' -and $s.postCreateLookups -le 2)
      $nodes = @()
      if (!$hidden) { $nodes += @{ databaseId = $s.release.id; tagName = $s.release.tag_name; isDraft = $s.release.draft; description = $s.release.body } }
      $more = $false
      $endCursor = $null
      if ($s.mode -cin @('graphql-pages', 'graphql-duplicate', 'graphql-bad-cursor')) {
        $more = $cursorArgs.Count -eq 0 -or $s.mode -ceq 'graphql-bad-cursor'
        if ($more) { $endCursor = 'synthetic-page-2' }
        if ($cursorArgs.Count -eq 0 -and $s.mode -cne 'graphql-duplicate') { $nodes = @(@{ databaseId = 99; tagName = 'v0.0.1'; isDraft = $false; description = $null }) }
      }
      return (@{ data = @{ repository = @{ releases = @{ nodes = @($nodes); pageInfo = @{ hasNextPage = $more; endCursor = $endCursor } } } } } | ConvertTo-Json -Depth 10 -Compress)
    }
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
    if ($endpoint -ceq 'repos/bokjk/mongle-terminal') { return ($s.repository | ConvertTo-Json -Compress) }
    if ($endpoint.StartsWith('repos/bokjk/mongle-terminal/git/ref/tags/')) {
      $sha = if ($s.mode -ceq 'tag-mismatch') { 'd' * 40 } else { $env:GITHUB_SHA }
      return (@{ ref = 'refs/tags/v0.3.13'; object = @{ type = 'commit'; sha = $sha } } | ConvertTo-Json -Depth 5 -Compress)
    }
    if ($endpoint.Contains('/releases?')) {
      # Installation-token regression: REST discovery never exposes drafts,
      # while GraphQL and REST GET by the known ID remain usable.
      $s.restListCalls++
      return '[[]]'
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
