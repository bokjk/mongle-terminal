// tests/platform/release-preservation.test.ts invokes this through node --test.
// Full main flow runs in pwsh with only its external-process boundary mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');
const proposal = path.join(repositoryRoot, 'scripts/preserve-release-draft.ps1');
const driver = path.join(here, 'release-preservation-driver.ps1');
const workflow = yaml.load(fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8'));
const fixtureParent = fs.realpathSync(tmpdir());
const steps = workflow.jobs.build.steps;
const byId = Object.fromEntries(steps.filter(s => s.id).map(s => [s.id, s]));
const gates = ['release', 'typecheck', 'runtime_build', 'regression', 'package', 'native', 'native_evidence', 'recheck', 'nsis', 'installed_evidence'];
const keys = ['releaseDocuments', 'typecheck', 'build', 'regression', 'package', 'native', 'nativeEvidence', 'postPackageDocuments', 'nsis', 'installedEvidence'];
const outcomes = Object.fromEntries(keys.map(k => [k, 'success']));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const publicRepository = { full_name: 'bokjk/mongle-terminal', private: false, visibility: 'public' };
const privateRepository = { ...publicRepository, private: true, visibility: 'private' };
const invalidRepositories = [
  ['other repository', { ...publicRepository, full_name: 'other/mongle-terminal' }],
  ['public flag with private visibility', { ...publicRepository, visibility: 'private' }],
  ['private flag with public visibility', { ...privateRepository, visibility: 'public' }],
  ['nonboolean private flag', { ...publicRepository, private: 'false' }],
  ['unsupported visibility', { ...privateRepository, visibility: 'internal' }],
];
function fixture(mode = 'success', repository = { full_name: 'bokjk/mongle-terminal', private: true, visibility: 'private' }) {
  const root = fs.mkdtempSync(path.join(fixtureParent, 'mongle-release-preservation-'));
  fs.mkdirSync(path.join(root, 'release'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mongle-terminal', version: '0.3.13' }));
  const names = ['MongleTerminal-Setup-0.3.13-x64.exe', 'MongleTerminal-Setup-0.3.13-x64.exe.blockmap', 'MongleTerminal-0.3.13-x64.zip', 'latest.yml'];
  for (const name of names) fs.writeFileSync(path.join(root, 'release', name), `synthetic ${name}`);
  fs.writeFileSync(path.join(root, 'release/SHA256SUMS.txt'), names.map(name => `${sha(fs.readFileSync(path.join(root, 'release', name)))}  ${name}`).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'release/RELEASE-NOTES.md'), 'Synthetic reviewed notes.\n');
  for (const relative of ['e2e/clipboard', 'e2e/update-desktop', 'installed-upgrade']) {
    const dir = path.join(root, 'test-results', relative); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ passed: true, cleanedUp: true,
      ...(relative === 'installed-upgrade' ? { newVersion: '0.3.13', newInstallerSha256: sha(fs.readFileSync(path.join(root, 'release', names[0]))), installedAsarSha256: 'e'.repeat(64), installedHostBundle: { files: 20, sha256: 'f'.repeat(64) }, bundleDifference: { missing: [], extra: [], changed: [] } } : {}),
      privateField: 'SYNTHETIC_PRIVATE_DO_NOT_LOG' }));
  }
  const release = ['published', 'mixed', 'graphql-duplicate'].includes(mode) ? { id: 11, tag_name: 'v0.3.13', draft: mode !== 'published', body: 'another run attempt' } : null;
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ mode, repository, release, assets: [], calls: [], createCalls: 0, uploadCalls: 0, listCalls: 0, postCreateLookups: 0, restListCalls: 0 }));
  // No credential is inherited by the child. The mock has no real subprocess path.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|GH_|GITHUB_|ACTIONS_)/i.test(key)));
  Object.assign(env, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'bokjk/mongle-terminal', GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.3.13', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKSPACE: root, GH_TOKEN: 'synthetic-not-a-credential', GITHUB_STEP_SUMMARY: path.join(root, 'summary.md'), GITHUB_OUTPUT: path.join(root, 'outputs.txt'), MOCK_STATE: path.join(root, 'state.json') });
  return { root, env, state: () => JSON.parse(fs.readFileSync(path.join(root, 'state.json'))),
    invoke: (changes = {}) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', driver, '-ProposalPath', proposal, '-FixtureRoot', root, '-OutcomesJson', JSON.stringify({ ...outcomes, ...changes })], { env, encoding: 'utf8', timeout: 60000, windowsHide: true }),
    dispose: () => { assert.equal(path.dirname(fs.realpathSync(root)), fixtureParent); assert.ok(path.basename(root).startsWith('mongle-release-preservation-')); fs.rmSync(root, { recursive: true, force: true }); } };
}
function expression(value, context) {
  return vm.runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { cancelled: () => false, startsWith: (a,b) => a.startsWith(b), format: (s,a) => s.replace('{0}',a), ...context }, { timeout: 100 });
}
function state(artifact = 'success', fallback = 'skipped') {
  return { ...Object.fromEntries(gates.map(id => [id, { outcome: 'success' }])), release_artifact: { outcome: artifact }, private_preservation: { outcome: fallback, outputs: { 'manifest-sha256': 'b'.repeat(64) } } };
}
test('build and public draft check out the same immutable source SHA', () => {
  const buildCheckouts = steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  const draftCheckouts = workflow.jobs.draft.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(buildCheckouts.length, 1);
  assert.equal(draftCheckouts.length, 1);
  assert.equal(buildCheckouts[0].with.ref, '${{ github.sha }}');
  assert.equal(workflow.jobs.build.outputs['source-sha'], '${{ github.sha }}');
  assert.equal(draftCheckouts[0].with.ref, '${{ needs.build.outputs.source-sha }}');
  for (const checkout of [...buildCheckouts, ...draftCheckouts]) assert.equal(checkout.with['persist-credentials'], false);
});
test('workflow keeps mandatory tests hard-failing, original artifact route automatic, token only in fallback env', () => {
  for (const id of gates) assert.notEqual(byId[id]['continue-on-error'], true);
  assert.equal(byId.release_artifact['continue-on-error'], true);
  assert.equal(workflow.jobs.build.permissions.contents, 'write');
  assert.ok(!JSON.stringify(workflow.jobs.build).includes('RELEASE_REPO_TOKEN'));
  for (const step of steps) if (step.id !== 'private_preservation') assert.ok(!step.env?.GH_TOKEN);
  assert.equal(expression(workflow.jobs.draft.if, { needs: { build: { result: 'success', outputs: { preservation: 'artifact' } } } }), true);
  assert.equal(expression(workflow.jobs.draft.if, { needs: { build: { result: 'success', outputs: { preservation: 'private-draft' } } } }), false);
  assert.equal(expression(workflow.jobs.draft.if, { needs: { build: { result: 'failure', outputs: { preservation: 'artifact' } } } }), false);
});
test('workflow rejects branch/foreign repo dispatch and fallback on any failed/skipped gate', () => {
  const github = { repository: 'bokjk/mongle-terminal', ref: 'refs/tags/v0.3.13', event_name: 'push' };
  assert.equal(expression(workflow.jobs.build.if, { github, inputs: {} }), true);
  for (const change of [{ ref: 'refs/heads/main' }, { repository: 'other/repo' }, { event_name: 'pull_request' }]) assert.equal(expression(workflow.jobs.build.if, { github: { ...github, ...change }, inputs: {} }), false);
  assert.equal(expression(workflow.jobs.build.if, { github: { ...github, event_name: 'workflow_dispatch' }, inputs: { tag: 'v0.3.13' } }), true);
  assert.equal(expression(workflow.jobs.build.if, { github: { ...github, event_name: 'workflow_dispatch' }, inputs: { tag: 'v0.3.12' } }), false);
  assert.equal(expression(byId.private_preservation.if, { steps: state('failure') }), true);
  assert.equal(expression(byId.private_preservation.if, { steps: state() }), false);
  for (const id of gates) for (const outcome of ['failure', 'skipped', 'cancelled']) { const s = state('failure'); s[id].outcome = outcome; assert.equal(expression(byId.private_preservation.if, { steps: s }), false); }
});
test('actual final storage gate accepts artifact/fallback only, rejects both-failed and failed checks', () => {
  const f = fixture(); try {
    for (const [artifact, fallback, good] of [['success','skipped',true], ['failure','success',true], ['failure','failure',false], ['skipped','skipped',false]]) {
      const r = spawnSync('pwsh', ['-NoProfile','-NonInteractive','-Command',byId.preservation.run], { env: { ...f.env, STEPS_JSON: JSON.stringify(state(artifact,fallback)) }, encoding:'utf8', windowsHide:true });
      assert.equal(r.status === 0, good, r.stderr);
    }
    const s=state();s.regression.outcome='failure';const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',byId.preservation.run],{env:{...f.env,STEPS_JSON:JSON.stringify(s)},encoding:'utf8',windowsHide:true});assert.notEqual(r.status,0);
  } finally { f.dispose(); }
});
test('whole main GraphQL discovery saves exact assets despite REST draft omission; same-attempt retry uploads nothing', () => {
  const f=fixture();try {
    const r=f.invoke();assert.equal(r.status,0,r.stderr);assert.equal(f.state().createCalls,1);assert.equal(f.state().uploadCalls,7);
    const bytes=fs.readFileSync(path.join(f.root,'release/PRESERVATION-MANIFEST.json'));const m=JSON.parse(bytes);
    assert.equal(m.sha,'a'.repeat(40));assert.equal(m.runId,'123');assert.equal(m.attempt,'1');assert.equal(m.artifactStorageFailure,'upload-failed');assert.equal(m.installedVerification.installedAsarSha256,'e'.repeat(64));
    assert.equal(m.installedVerification.newInstallerSha256,m.files[0].sha256);
    for(const asset of f.state().assets){const bytes=fs.readFileSync(path.join(f.root,'release',asset.name));assert.equal(asset.digest,`sha256:${sha(bytes)}`);assert.equal(asset.size,bytes.length);}
    assert.ok(r.stdout.includes(sha(bytes)));const summary=fs.readFileSync(f.env.GITHUB_STEP_SUMMARY,'utf8');assert.ok(summary.includes(sha(bytes)));assert.ok(summary.includes('gh release download v0.3.13'));assert.ok(!summary.includes('SYNTHETIC_PRIVATE_DO_NOT_LOG'));assert.ok(!r.stdout.includes('synthetic-not-a-credential'));
    assert.ok(fs.readFileSync(f.env.GITHUB_OUTPUT,'utf8').includes(`manifest-sha256=${sha(bytes)}`));
    const again=f.invoke();assert.equal(again.status,0,again.stderr);assert.equal(f.state().uploadCalls,7);assert.equal(f.state().createCalls,1);
    assert.equal(f.state().restListCalls,0);
    assert.ok(f.state().calls.some(call=>call.operation.includes(' graphql ')));
  }finally{f.dispose();}
});
for(const mode of ['upload-failure','published','mixed','tag-mismatch'])test(`whole main ${mode} remains failed and cannot report preserved success`,()=>{
  const f=fixture(mode);try{const r=f.invoke();assert.notEqual(r.status,0);assert.ok(!fs.existsSync(f.env.GITHUB_OUTPUT));if(mode!=='upload-failure'){assert.equal(f.state().uploadCalls,0);assert.equal(f.state().createCalls,0);}else{assert.equal(f.state().assets.length,1);}}finally{f.dispose();}
});
test('whole main rejects failed verification and mismatched installed installer before remote writes',()=>{
  const f=fixture();try{let r=f.invoke({regression:'failure'});assert.notEqual(r.status,0);assert.equal(f.state().createCalls,0);const p=path.join(f.root,'test-results/installed-upgrade/result.json');const v=JSON.parse(fs.readFileSync(p));v.newInstallerSha256='0'.repeat(64);fs.writeFileSync(p,JSON.stringify(v));r=f.invoke();assert.notEqual(r.status,0);assert.equal(f.state().createCalls,0);assert.equal(f.state().uploadCalls,0);}finally{f.dispose();}
});

test('public source repository preserves only an unpublished draft and resumes the same provenance', () => {
  const f = fixture('success', publicRepository);
  try {
    let r = f.invoke(); assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().release.draft, true);
    assert.equal(f.state().createCalls, 1); assert.equal(f.state().uploadCalls, 7);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'release/PRESERVATION-MANIFEST.json')));
    assert.equal(manifest.schema, 'mongle-private-release-preservation-v1');
    assert.equal(manifest.repository, publicRepository.full_name);
    assert.equal(manifest.sha, f.env.GITHUB_SHA);
    r = f.invoke(); assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().createCalls, 1); assert.equal(f.state().uploadCalls, 7);
    assert.equal(f.state().release.draft, true);
  } finally { f.dispose(); }
});

for (const [label, repository] of invalidRepositories) test(`whole main rejects ${label} before any release mutation`, () => {
  const f = fixture('success', repository);
  try {
    const r = f.invoke(); assert.ifError(r.error); assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Expected the named source repository/);
    assert.equal(f.state().createCalls, 0); assert.equal(f.state().uploadCalls, 0);
    assert.ok(!fs.existsSync(f.env.GITHUB_OUTPUT));
  } finally { f.dispose(); }
});

for (const mode of ['published', 'mixed', 'published-aftercreate']) test(`public repository still refuses ${mode} without uploading`, () => {
  const f = fixture(mode, publicRepository);
  try {
    const r = f.invoke(); assert.ifError(r.error); assert.notEqual(r.status, 0);
    assert.match(r.stderr, mode === 'mixed' ? /Draft belongs to another run/ : /An existing published release must never be changed/);
    assert.equal(f.state().uploadCalls, 0);
    assert.equal(f.state().createCalls, mode === 'published-aftercreate' ? 1 : 0);
    assert.ok(!fs.existsSync(f.env.GITHUB_OUTPUT));
  } finally { f.dispose(); }
});

test('complete read-only probe supports public/private repositories and rejects inconsistent identity or published releases', () => {
  const probe = yaml.load(fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release-storage-probe.yml'), 'utf8'));
  const body = probe.jobs.probe.steps.find(step => step.run).run;
  // The actual workflow body executes unchanged. A PowerShell function shadows
  // gh and rejects every unrecognized call; there is no subprocess fallback.
  const mock = String.raw`
function gh {
  $global:LASTEXITCODE = 0
  $config = ConvertFrom-Json -InputObject $env:PROBE_FIXTURE -AsHashtable
  if ($args -contains 'graphql') {
    $queries = @($args | Where-Object { $_ -is [string] -and $_.StartsWith('query=') })
    if ($queries.Count -ne 1 -or $queries[0] -notmatch '^query=query\(') { throw 'Only a read-only GraphQL query is allowed.' }
    return (@{ data = @{ repository = @{ releases = @{ nodes = @(@{ databaseId = 11; tagName = 'v0.3.13'; isDraft = $config.draft; description = 'synthetic marker' }); pageInfo = @{ hasNextPage = $false; endCursor = $null } } } } } | ConvertTo-Json -Depth 10 -Compress)
  }
  if ($args -notcontains '--method' -or $args -notcontains 'GET') { throw 'Probe attempted a non-GET operation.' }
  $endpoints = @($args | Where-Object { $_ -is [string] -and $_.StartsWith('repos/') })
  if ($endpoints.Count -ne 1) { throw 'Unexpected probe API shape.' }
  switch -CaseSensitive ($endpoints[0]) {
    'repos/bokjk/mongle-terminal' { return ($config.repository | ConvertTo-Json -Compress) }
    'repos/bokjk/mongle-terminal/releases?per_page=100' { return '[[]]' }
    'repos/bokjk/mongle-terminal/releases/11' { return (@{ id = 11; tag_name = 'v0.3.13'; draft = $config.draft; body = 'synthetic marker' } | ConvertTo-Json -Compress) }
    'repos/bokjk/mongle-terminal/releases/11/assets?per_page=100' { return '[[]]' }
    default { throw 'Unexpected endpoint; no real network fallback exists.' }
  }
}
`;
  const cases = [
    ['private draft', privateRepository, true, true],
    ['public draft', publicRepository, true, true],
    ...invalidRepositories.map(([label, repository]) => [label, repository, true, false]),
    ['public published', publicRepository, false, false],
    ['private published', privateRepository, false, false],
  ];
  for (const [label, repository, draft, good] of cases) {
    const f = fixture();
    try {
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', mock + '\n' + body], {
        env: { ...f.env, PROBE_TAG: 'v0.3.13', PROBE_RELEASE_ID: '11', PROBE_FIXTURE: JSON.stringify({ repository, draft }) },
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      assert.ifError(r.error); assert.equal(r.status === 0, good, `${label}: ${r.stderr}`);
      if (good) {
        const summary = JSON.parse(fs.readFileSync(f.env.GITHUB_STEP_SUMMARY, 'utf8'));
        assert.equal(summary.draft, true); assert.equal(summary.id, '11');
        assert.equal(summary.graphqlFound, true); assert.equal(summary.restListContainsTarget, false);
      } else assert.ok(!fs.existsSync(f.env.GITHUB_STEP_SUMMARY));
    } finally { f.dispose(); }
  }
});

test('whole main waits only for genuine absence in GraphQL after creating a draft', () => {
  const f = fixture('delayedvisibility');
  try {
    const r = f.invoke();
    assert.ifError(r.error);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().createCalls, 1);
    assert.equal(f.state().postCreateLookups, 3);
    assert.equal(f.state().listCalls, 4);
    assert.equal(f.state().uploadCalls, 7);
    assert.ok(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8').includes('manifest-sha256='));
  } finally { f.dispose(); }
});

test('whole main follows GraphQL cursor pages for initial discovery and same-attempt retry', () => {
  const f = fixture('graphql-pages');
  try {
    let r = f.invoke(); assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().createCalls, 1);
    assert.equal(f.state().listCalls, 4);
    assert.equal(f.state().uploadCalls, 7);
    r = f.invoke(); assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
    assert.equal(f.state().listCalls, 6);
    assert.equal(f.state().createCalls, 1);
    assert.equal(f.state().uploadCalls, 7);
    assert.equal(f.state().restListCalls, 0);
  } finally { f.dispose(); }
});

for (const [mode, expected, lookups] of [
  ['graphql-errors', /GraphQL release query failed/, 1],
  ['graphql-null-repository', /GraphQL repository unavailable/, 1],
  ['graphql-duplicate', /Ambiguous release tag/, 2],
  ['graphql-bad-cursor', /Invalid or repeated GraphQL cursor/, 2],
]) test(`whole main ${mode} refuses mutations instead of treating failure as absence`, () => {
  const f = fixture(mode);
  try {
    const r = f.invoke(); assert.ifError(r.error); assert.notEqual(r.status, 0);
    assert.match(r.stderr, expected);
    assert.ok(!(r.stdout + r.stderr).includes('SYNTHETIC_PRIVATE_DO_NOT_LOG'));
    assert.equal(f.state().listCalls, lookups);
    assert.equal(f.state().createCalls, 0);
    assert.equal(f.state().uploadCalls, 0);
    assert.equal(f.state().restListCalls, 0);
    assert.ok(!fs.existsSync(f.env.GITHUB_OUTPUT));
  } finally { f.dispose(); }
});

test('whole main stops after exactly twelve missing post-create lookups without reporting success', () => {
  const f = fixture('nevervisible');
  try {
    const r = f.invoke();
    assert.ifError(r.error); // A process timeout is not evidence of bounded failure.
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Created release is still missing after 12 lookups/);
    assert.equal(f.state().createCalls, 1);
    assert.equal(f.state().postCreateLookups, 12);
    assert.equal(f.state().listCalls, 13);
    assert.equal(f.state().uploadCalls, 0);
    assert.ok(!fs.existsSync(f.env.GITHUB_OUTPUT));
    assert.ok(!fs.existsSync(f.env.GITHUB_STEP_SUMMARY));
  } finally { f.dispose(); }
});

for (const [mode, expected] of [
  ['published-aftercreate', /An existing published release must never be changed/],
  ['mixed-aftercreate', /Draft belongs to another run\/attempt\/SHA\/manifest/],
  ['api-error-aftercreate', /Synthetic listing API failure/],
]) test(`whole main ${mode} fails on the first lookup without retry`, () => {
  const f = fixture(mode);
  try {
    const r = f.invoke();
    assert.ifError(r.error);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, expected);
    assert.equal(f.state().createCalls, 1);
    assert.equal(f.state().postCreateLookups, 1);
    assert.equal(f.state().listCalls, 2);
    assert.equal(f.state().uploadCalls, 0);
    assert.ok(!fs.existsSync(f.env.GITHUB_OUTPUT));
  } finally { f.dispose(); }
});
