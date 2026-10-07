import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_LOGIN, BRANCH_DESCRIPTION_MAX, BRANCH_EXAMPLES, BRANCH_TYPES, COMMENT_MARKER, STATUS_CONTEXT, STATUS_DESCRIPTION_MAX,
  branchNameProblem, decideTarget, inlineCode, pullRequestFacts, runPolicy,
} from '../../scripts/pr-target.ts';
import type { BranchProblem, Fetch, TargetDecision, TargetFacts } from '../../scripts/pr-target.ts';
import { applyBranchRules, loadRulesets, parseArgs } from '../../scripts/apply-branch-rules.ts';
import type { GhResult, RulesetPayload } from '../../scripts/apply-branch-rules.ts';

const repository = 'bokjk/mongle-terminal';
const headSha = 'c'.repeat(40);
const apiRoot = '/repos/' + repository;
const statusCall = 'POST /statuses/' + headSha;
const listCall = (page = 1) => 'GET /issues/7/comments?per_page=100&page=' + page;
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };

interface Comment { id: number; body: string; user: { login: string } }
interface GitHubState { comments: Comment[]; nextId: number; retargetStatus?: number; statusStatus?: number }
interface Recorded { method: string; path: string; headers: Record<string, string>; body?: any }

const newState = (overrides: Partial<GitHubState> = {}): GitHubState => ({ comments: [], nextId: 1000, ...overrides });

/** The GitHub REST behaviour the policy relies on, shared by the in-process fake and the HTTP stub. */
function route(state: GitHubState, method: string, url: URL, body: any): { status: number; json?: unknown } {
  const comment = /^\/repos\/bokjk\/mongle-terminal\/issues\/comments\/(\d+)$/.exec(url.pathname);
  if (method === 'PATCH' && url.pathname === apiRoot + '/pulls/7') {
    return state.retargetStatus
      ? { status: state.retargetStatus, json: { message: 'Validation Failed' } }
      : { status: 200, json: { number: 7, base: { ref: body.base } } };
  }
  if (method === 'GET' && url.pathname === apiRoot + '/issues/7/comments') {
    const perPage = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    return { status: 200, json: state.comments.slice((page - 1) * perPage, page * perPage) };
  }
  if (method === 'POST' && url.pathname === apiRoot + '/issues/7/comments') {
    const created = { id: state.nextId++, body: body.body, user: { login: BOT_LOGIN } };
    state.comments.push(created);
    return { status: 201, json: created };
  }
  if (comment && method === 'PATCH') {
    const target = state.comments.find(item => item.id === Number(comment[1]));
    if (!target) return { status: 404, json: { message: 'Not Found' } };
    target.body = body.body;
    return { status: 200, json: target };
  }
  if (comment && method === 'DELETE') {
    state.comments = state.comments.filter(item => item.id !== Number(comment[1]));
    return { status: 204 };
  }
  if (method === 'POST' && url.pathname === apiRoot + '/statuses/' + headSha) {
    return state.statusStatus
      ? { status: state.statusStatus, json: { message: 'Resource not accessible by integration' } }
      : { status: 201, json: { state: body.state, context: body.context } };
  }
  return { status: 404, json: { message: 'Unexpected ' + method + ' ' + url.pathname } };
}

function fakeGitHub(state: GitHubState) {
  const requests: Recorded[] = [];
  const fetch: Fetch = async (url, init) => {
    const target = new URL(url);
    const method = String(init.method);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: target.pathname + target.search, headers: Object.fromEntries(new Headers(init.headers)), body });
    const { status, json } = route(state, method, target, body);
    return new Response(status === 204 || json === undefined ? null : JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

function prEvent({ base = 'dev', head = 'fix/tray-restore', fork = false, state = 'open' }: { base?: string; head?: string; fork?: boolean; state?: string } = {}) {
  return {
    action: 'opened',
    number: 7,
    pull_request: {
      number: 7,
      state,
      base: { ref: base, sha: 'a'.repeat(40), repo: { full_name: repository } },
      head: { ref: head, sha: headSha, repo: { full_name: fork ? 'contributor/mongle-terminal' : repository } },
    },
    repository: { full_name: repository },
  };
}

const baseEnv = {
  GITHUB_EVENT_PATH: 'event.json',
  GITHUB_REPOSITORY: repository,
  GITHUB_TOKEN: 'test-token',
  GITHUB_API_URL: 'https://api.github.test',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '12345',
};

async function runWith(event: unknown, state = newState(), overrides: Record<string, string | undefined> = {}) {
  const github = fakeGitHub(state);
  const logs: string[] = [], errors: string[] = [];
  const code = await runPolicy({
    env: { ...baseEnv, ...overrides },
    fetch: github.fetch,
    readText: async () => JSON.stringify(event),
    log: line => logs.push(line),
    error: line => errors.push(line),
  });
  const calls = github.requests.map(request => request.method + ' ' + request.path.replace(apiRoot, ''));
  return { code, state, logs, errors, requests: github.requests, calls };
}

test('branch names follow the single <type>/<description> rule', () => {
  const valid = [...BRANCH_EXAMPLES, 'codex/pr-target-policy', 'docs/readme_update', 'feat/123', 'chore/a.b_c-d', 'fix/' + 'a'.repeat(BRANCH_DESCRIPTION_MAX)];
  for (const name of valid) assert.equal(branchNameProblem(name), undefined, name);
  const invalid: Array<[string, string]> = [
    ['feature/tray', 'missing-type'], ['fix', 'missing-type'], ['Fix/tray', 'missing-type'], ['/tray', 'missing-type'], ['patch-1', 'missing-type'],
    ['fix/', 'invalid-description'], ['fix/Tray', 'invalid-description'], ['fix/tray restore', 'invalid-description'],
    ['fix/tray--restore', 'invalid-description'], ['fix/-tray', 'invalid-description'], ['fix/tray.', 'invalid-description'],
    ['fix/tray/restore', 'invalid-description'], ['fix/트레이', 'invalid-description'],
    ['fix/$(touch pwned)', 'invalid-description'], ['fix/`id`', 'invalid-description'],
    ['fix/' + 'a'.repeat(BRANCH_DESCRIPTION_MAX + 1), 'description-too-long'],
  ];
  for (const [name, problem] of invalid) assert.equal(branchNameProblem(name), problem, name);
});

test('decision table: topic branches go to dev and main only takes the release PR from this repository', () => {
  const allow = (reason: 'topic' | 'release' | 'back-merge') => ({ allowed: true as const, reason });
  const reject = (problem: BranchProblem) => ({ allowed: false as const, problem });
  const facts = (baseRef: string, headRef: string, sameRepository: boolean): TargetFacts => ({ baseRef, headRef, sameRepository });
  const cases: Array<[TargetFacts, TargetDecision]> = [
    [facts('dev', 'fix/tray-restore', false), { base: 'dev', verdict: allow('topic') }],
    [facts('dev', 'codex/pr-target', true), { base: 'dev', verdict: allow('topic') }],
    [facts('dev', 'main', false), { base: 'dev', verdict: reject('protected-head') }],
    [facts('dev', 'dev', false), { base: 'dev', verdict: reject('protected-head') }],
    [facts('dev', 'main', true), { base: 'dev', verdict: allow('back-merge') }],
    [facts('dev', 'Fix/Tray', false), { base: 'dev', verdict: reject('missing-type') }],
    [facts('dev', 'fix/Tray', false), { base: 'dev', verdict: reject('invalid-description') }],
    [facts('main', 'dev', true), { base: 'main', verdict: allow('release') }],
    [facts('main', 'dev', false), { retargetFrom: 'main', base: 'dev', verdict: reject('protected-head') }],
    [facts('main', 'main', false), { retargetFrom: 'main', base: 'dev', verdict: reject('protected-head') }],
    [facts('main', 'fix/tray-restore', false), { retargetFrom: 'main', base: 'dev', verdict: allow('topic') }],
    [facts('main', 'feat/mobile-paste', true), { retargetFrom: 'main', base: 'dev', verdict: allow('topic') }],
    [facts('main', 'patch-1', false), { retargetFrom: 'main', base: 'dev', verdict: reject('missing-type') }],
    [facts('gh-pages', 'docs/site', false), { retargetFrom: 'gh-pages', base: 'dev', verdict: allow('topic') }],
    [facts('feat/base', 'main', true), { retargetFrom: 'feat/base', base: 'dev', verdict: allow('back-merge') }],
    [facts('feat/base', 'dev', true), { base: 'feat/base', verdict: reject('protected-head') }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(decideTarget(input), expected, JSON.stringify(input));
});

test('event parsing keeps branch names as data and only this repository counts as the same repository', () => {
  const untrusted = 'fix/$(touch pwned)`id`';
  assert.deepEqual(pullRequestFacts(prEvent({ head: untrusted }), repository), { number: 7, state: 'open', baseRef: 'dev', headRef: untrusted, headSha, sameRepository: true });
  assert.equal(pullRequestFacts(prEvent({ fork: true }), repository).sameRepository, false);
  assert.equal(pullRequestFacts(prEvent(), 'BokJK/Mongle-Terminal').sameRepository, true);
  const deletedFork = prEvent();
  (deletedFork.pull_request.head as { repo: unknown }).repo = null;
  assert.equal(pullRequestFacts(deletedFork, repository).sameRepository, false);
  assert.throws(() => pullRequestFacts({}, repository), /pull_request/);
  const badSha = prEvent();
  badSha.pull_request.head.sha = 'main; echo bad';
  assert.throws(() => pullRequestFacts(badSha, repository), /full commit SHA/);
  assert.throws(() => pullRequestFacts(prEvent(), 'someone/else'), /different repository/);
});

test('PR comments render untrusted branch names as inert code spans', () => {
  assert.equal(inlineCode('fix/tray-restore'), '`fix/tray-restore`');
  assert.equal(inlineCode('fix/`id`'), '`` fix/`id` ``');
  assert.equal(inlineCode('a``b'), '```a``b```');
  assert.equal(inlineCode('x\u0007y\u202ez @bokjk'), '`x\ufffdy\ufffdz @bokjk`');
  assert.equal(inlineCode('a'.repeat(200)), '`' + 'a'.repeat(120) + '…`');
});

test('an allowed topic PR to dev sets a success status and adds no comment', async () => {
  const run = await runWith(prEvent({ fork: true }));
  assert.equal(run.code, 0, run.errors.join('\n'));
  assert.deepEqual(run.calls, [listCall(), statusCall]);
  const status = run.requests[1].body;
  assert.deepEqual(Object.keys(status).sort(), ['context', 'description', 'state', 'target_url']);
  assert.equal(status.state, 'success');
  assert.equal(status.context, STATUS_CONTEXT);
  assert.equal(status.target_url, 'https://github.com/bokjk/mongle-terminal/actions/runs/12345');
  assert.ok(Array.from(status.description as string).length <= STATUS_DESCRIPTION_MAX);
  assert.deepEqual(run.state.comments, []);
});

test('rejected PRs keep exactly one bot comment and never edit comments written by people', async () => {
  const person = { id: 1, body: COMMENT_MARKER + '\n사람이 붙여 넣은 표식', user: { login: 'someone' } };
  const first = await runWith(prEvent({ head: 'main', fork: true }), newState({ comments: [person] }));
  assert.equal(first.code, 1);
  assert.deepEqual(first.calls, [listCall(), 'POST /issues/7/comments', statusCall]);
  const posted = first.requests[1].body.body as string;
  assert.ok(posted.startsWith(COMMENT_MARKER));
  assert.match(posted, /`main`·`dev` 브랜치는 PR의 원본/);
  assert.match(posted, /git fetch upstream dev/);
  assert.ok(posted.includes('https://github.com/bokjk/mongle-terminal/blob/dev/CONTRIBUTING.md'));
  assert.equal(first.requests[2].body.state, 'failure');
  assert.match(first.errors.join('\n'), /^::error title=PR target branch::PR #7 does not meet the branch policy/m);

  const second = await runWith(prEvent({ head: 'Fix/Tray', fork: true }), first.state);
  assert.equal(second.code, 1);
  assert.deepEqual(second.calls, [listCall(), 'PATCH /issues/comments/1000', statusCall]);
  assert.match(second.requests[1].body.body, /허용된 `<종류>\/`로 시작하지 않습니다/);
  assert.equal(second.state.comments.find(comment => comment.id === 1)?.body, person.body);
  assert.equal(second.state.comments.length, 2);

  const repeated = await runWith(prEvent({ head: 'Fix/Tray', fork: true }), second.state);
  assert.deepEqual(repeated.calls, [listCall(), statusCall], 'an unchanged comment is not rewritten');
});

test('once a PR is valid an earlier warning becomes a short note', async () => {
  const state = newState({ comments: [{ id: 50, body: COMMENT_MARKER + '\n### ❌ old', user: { login: BOT_LOGIN } }] });
  const run = await runWith(prEvent(), state);
  assert.equal(run.code, 0, run.errors.join('\n'));
  assert.deepEqual(run.calls, [listCall(), 'PATCH /issues/comments/50', statusCall]);
  assert.match(state.comments[0].body, /^<!-- mongle-pr-target -->\n✅ 이제 대상 브랜치와 브랜치 이름이 규칙에 맞습니다/);
});

test('policy comments are found on later pages and duplicates are removed', async () => {
  const others = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'LGTM', user: { login: 'reviewer' } }));
  const bot = (id: number) => ({ id, body: COMMENT_MARKER + '\nold ' + id, user: { login: BOT_LOGIN } });
  const state = newState({ comments: [...others, bot(500), bot(501)] });
  const run = await runWith(prEvent({ head: 'dev', fork: true }), state);
  assert.equal(run.code, 1);
  assert.deepEqual(run.calls, [listCall(1), listCall(2), 'PATCH /issues/comments/500', 'DELETE /issues/comments/501', statusCall]);
  assert.deepEqual(state.comments.filter(comment => comment.user.login === BOT_LOGIN).map(comment => comment.id), [500]);
});

test('PRs to main or another base are moved to dev and judged by the dev rules in the same run', async () => {
  const moved = await runWith(prEvent({ base: 'main', head: 'feat/mobile-paste', fork: true }));
  assert.equal(moved.code, 0, moved.errors.join('\n'));
  assert.deepEqual(moved.calls, ['PATCH /pulls/7', listCall(), 'POST /issues/7/comments', statusCall]);
  const [retarget, , comment, status] = moved.requests;
  assert.deepEqual(retarget.body, { base: 'dev' });
  assert.equal(retarget.headers.authorization, 'Bearer test-token');
  assert.equal(retarget.headers.accept, 'application/vnd.github+json');
  assert.equal(retarget.headers['x-github-api-version'], '2022-11-28');
  assert.equal(retarget.headers['content-type'], 'application/json');
  assert.match(comment.body.body, /대상\(base\)을 `main`에서 `dev`로 옮겼습니다/);
  assert.match(comment.body.body, /규칙에 맞으므로 추가 조치는 필요 없습니다/);
  assert.equal(status.body.state, 'success');
  assert.match(status.body.description, /^대상을 dev로 옮겼습니다\./);

  const rejected = await runWith(prEvent({ base: 'main', head: 'dev', fork: true }));
  assert.equal(rejected.code, 1);
  assert.deepEqual(rejected.calls, ['PATCH /pulls/7', listCall(), 'POST /issues/7/comments', statusCall]);
  assert.match(rejected.requests[2].body.body, /대상을 `dev`로 옮겼지만 브랜치 규칙에 맞지 않습니다/);
  assert.equal(rejected.requests[3].body.state, 'failure');

  const other = await runWith(prEvent({ base: 'gh-pages', head: 'docs/site' }));
  assert.equal(other.code, 0, other.errors.join('\n'));
  assert.equal(other.calls[0], 'PATCH /pulls/7');
  assert.match(other.requests[2].body.body, /`gh-pages`에서 `dev`로 옮겼습니다/);

  const release = await runWith(prEvent({ base: 'main', head: 'dev' }));
  assert.equal(release.code, 0, release.errors.join('\n'));
  assert.deepEqual(release.calls, [listCall(), statusCall]);
});

test('a refused retarget fails the check with a clear log and comment', async () => {
  const run = await runWith(prEvent({ base: 'main', head: 'fix/tray-restore', fork: true }), newState({ retargetStatus: 422 }));
  assert.equal(run.code, 1);
  assert.deepEqual(run.calls, ['PATCH /pulls/7', listCall(), 'POST /issues/7/comments', statusCall]);
  assert.match(run.errors.join('\n'), /Could not move PR #7 to dev: PATCH \/pulls\/7 failed with HTTP 422: Validation Failed/);
  assert.match(run.requests[2].body.body, /대상 브랜치를 `dev`로 옮기지 못했습니다/);
  assert.equal(run.requests[3].body.state, 'failure');
});

test('failing to publish the status fails the job even for an allowed PR', async () => {
  const run = await runWith(prEvent(), newState({ statusStatus: 403 }));
  assert.equal(run.code, 1);
  assert.match(run.errors.join('\n'), /Could not set the "PR target branch" commit status: .*HTTP 403/);
});

test('shell-like branch names only travel as JSON data', async () => {
  const untrusted = 'fix/$(touch pwned)`id`';
  const run = await runWith(prEvent({ base: 'main', head: untrusted, fork: true }));
  assert.equal(run.code, 1);
  assert.ok(run.requests.every(request => !request.path.includes('pwned') && !request.path.includes('$(')));
  assert.ok((run.requests[2].body.body as string).includes('현재 원본 브랜치: `` fix/$(touch pwned)`id` ``'));
  assert.ok(run.logs.some(line => line.includes(JSON.stringify(untrusted))));
});

test('closed PRs and unusable configuration make no GitHub requests', async () => {
  const closed = await runWith(prEvent({ state: 'closed' }));
  assert.equal(closed.code, 0);
  assert.deepEqual(closed.calls, []);
  const broken: Array<[Record<string, string>, RegExp]> = [
    [{ GITHUB_TOKEN: '' }, /GITHUB_TOKEN/],
    [{ GITHUB_REPOSITORY: 'bokjk/mongle-terminal/extra' }, /GITHUB_REPOSITORY/],
    [{ GITHUB_API_URL: 'http://api.github.test' }, /GITHUB_API_URL must use https/],
  ];
  for (const [overrides, message] of broken) {
    const run = await runWith(prEvent(), newState(), overrides);
    assert.equal(run.code, 1);
    assert.deepEqual(run.calls, []);
    assert.match(run.errors.join('\n'), message);
  }
});

test('the CLI runs under plain Node from a sparse checkout and calls GitHub in policy order', async () => {
  const parent = path.resolve('.test-data/pr-target');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'run-'));
  assert.ok(directory.startsWith(parent + path.sep));
  const state = newState();
  const received: Recorded[] = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = raw ? JSON.parse(raw) : undefined;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)]));
    received.push({ method: request.method ?? '', path: url.pathname + url.search, headers, body });
    const { status, json } = route(state, request.method ?? '', url, body);
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    response.end(status === 204 || json === undefined ? undefined : JSON.stringify(json));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const take = () => received.splice(0).map(request => ({ ...request, call: request.method + ' ' + request.path.replace(apiRoot, '') }));
  try {
    // Mirror the workflow: only the script is checked out and no package.json declares "type": "module".
    const checkout = path.join(directory, 'checkout');
    await mkdir(path.join(checkout, 'scripts'), { recursive: true });
    await copyFile(fileURLToPath(new URL('../../scripts/pr-target.ts', import.meta.url)), path.join(checkout, 'scripts', 'pr-target.ts'));
    await writeFile(path.join(checkout, 'package.json'), '{}\n');
    const cli = async (name: string, event: unknown) => {
      const eventPath = path.join(directory, name + '.json');
      await writeFile(eventPath, JSON.stringify(event));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: repository,
        GITHUB_TOKEN: 'stub-token',
        GITHUB_API_URL: 'http://127.0.0.1:' + port,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '4242',
      };
      delete env.NODE_OPTIONS;
      return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, ['scripts/pr-target.ts'], { cwd: checkout, env, windowsHide: true, timeout: 30_000 }, (error, stdout, stderr) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
        });
      });
    };
    const runUrl = 'https://github.com/bokjk/mongle-terminal/actions/runs/4242';

    // 1. A topic branch opened against main: move to dev, judge by the dev rules, comment, then status.
    let result = await cli('opened-main', prEvent({ base: 'main', head: 'feat/mobile-paste', fork: true }));
    assert.equal(result.code, 0, result.stderr);
    let requests = take();
    assert.deepEqual(requests.map(request => request.call), ['PATCH /pulls/7', listCall(), 'POST /issues/7/comments', statusCall]);
    assert.deepEqual(requests[0].body, { base: 'dev' });
    assert.match(requests[2].body.body, /`main`에서 `dev`로 옮겼습니다[\s\S]*규칙에 맞으므로/);
    assert.deepEqual({ ...requests[3].body, description: undefined }, { state: 'success', context: STATUS_CONTEXT, description: undefined, target_url: runUrl });
    assert.ok(requests.every(request => request.headers.authorization === 'Bearer stub-token'));

    // 2. A fork's dev branch against main: moved, rejected under the dev rules, the same comment updated.
    result = await cli('fork-dev-main', prEvent({ base: 'main', head: 'dev', fork: true }));
    assert.equal(result.code, 1);
    requests = take();
    assert.deepEqual(requests.map(request => request.call), ['PATCH /pulls/7', listCall(), 'PATCH /issues/comments/1000', statusCall]);
    assert.equal(requests[3].body.state, 'failure');
    assert.match(result.stderr, /::error title=PR target branch::PR #7 does not meet the branch policy/);

    // 3. GitHub refuses the retarget: clear log, comment and failure status, non-zero exit.
    state.retargetStatus = 422;
    result = await cli('retarget-refused', prEvent({ base: 'main', head: 'fix/tray-restore', fork: true }));
    assert.equal(result.code, 1);
    requests = take();
    assert.deepEqual(requests.map(request => request.call), ['PATCH /pulls/7', listCall(), 'PATCH /issues/comments/1000', statusCall]);
    assert.match(result.stderr, /Could not move PR #7 to dev: .*HTTP 422/);
    assert.equal(requests[3].body.state, 'failure');

    // 4. Fixed PR to dev: the earlier warning becomes a short valid note and the status turns green.
    state.retargetStatus = undefined;
    result = await cli('topic-dev', prEvent({ head: 'fix/tray-restore', fork: true }));
    assert.equal(result.code, 0, result.stderr);
    requests = take();
    assert.deepEqual(requests.map(request => request.call), [listCall(), 'PATCH /issues/comments/1000', statusCall]);
    assert.match(requests[1].body.body, /✅ 이제 대상 브랜치와 브랜치 이름이 규칙에 맞습니다/);
    assert.equal(requests[2].body.state, 'success');
    assert.deepEqual(state.comments.map(comment => comment.id), [1000]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(directory).startsWith(parent + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});

type Step = { uses?: string; with?: Record<string, unknown>; run?: string; env?: Record<string, unknown> };
type Workflow = { on: Record<string, any>; permissions?: Record<string, string>; jobs: Record<string, { name?: string; steps?: Step[] }> };
const loadWorkflow = async (file: string) => yaml.load(await readFile(file, 'utf8')) as Workflow;

test('required status checks match the workflows and the pull_request_target job never touches PR code', async () => {
  const ci = await loadWorkflow('.github/workflows/ci.yml');
  const policy = await loadWorkflow('.github/workflows/pr-target.yml');
  const description = await loadWorkflow('.github/workflows/pr-description.yml');
  const ciJobs = Object.values(ci.jobs);
  const ciNames = ciJobs.map(job => job.name?.includes("|| 'Windows checks'") ? 'Windows checks' : job.name);
  ciNames.push(...Object.values(description.jobs).map(job => job.name));
  const [policyJob, ...extraJobs] = Object.values(policy.jobs);
  assert.ok(ciNames.includes('Windows checks'));
  assert.deepEqual(extraJobs, []);
  assert.equal(policyJob.name, 'PR target policy');
  assert.equal(STATUS_CONTEXT, 'PR target branch');

  const rulesets = await loadRulesets();
  assert.deepEqual(rulesets.map(ruleset => ruleset.conditions.ref_name), [{ include: ['refs/heads/main'], exclude: [] }, { include: ['refs/heads/dev'], exclude: [] }]);
  const rule = (ruleset: RulesetPayload, type: string) => ruleset.rules.find(item => item.type === type)?.parameters;
  for (const ruleset of rulesets) {
    const checks = rule(ruleset, 'required_status_checks') as { strict_required_status_checks_policy: boolean; required_status_checks: Array<{ context: string; integration_id?: number }> };
    const contexts = checks.required_status_checks.map(check => check.context);
    // Each required context is produced by a workflow: a ci.yml job name or the policy commit status.
    assert.deepEqual([...contexts].sort(), ['Windows checks', 'PR description', STATUS_CONTEXT].sort(), ruleset.name);
    assert.ok(contexts.every(context => context === STATUS_CONTEXT || ciNames.includes(context)));
    assert.ok(!contexts.includes(String(policyJob.name)), 'the policy job check sits on the default branch commit, not on the PR');
    assert.ok(checks.required_status_checks.every(check => check.integration_id === 15368));
    assert.equal(checks.strict_required_status_checks_policy, true);
    assert.deepEqual(ruleset.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
    for (const type of ['deletion', 'non_fast_forward', 'pull_request']) assert.ok(ruleset.rules.some(item => item.type === type), ruleset.name + ' ' + type);
  }
  const [main, dev] = rulesets;
  assert.deepEqual(rule(main, 'update'), { update_allows_fetch_and_merge: false }, 'only bypass actors may update main');
  assert.ok(!dev.rules.some(item => item.type === 'update'));
  assert.equal(rule(dev, 'pull_request')?.required_approving_review_count, 1);
  assert.equal(rule(dev, 'pull_request')?.dismiss_stale_reviews_on_push, true);

  assert.deepEqual(Object.keys(policy.on), ['pull_request_target']);
  assert.deepEqual(policy.on.pull_request_target.types, ['opened', 'reopened', 'edited', 'synchronize', 'ready_for_review']);
  assert.deepEqual(policy.permissions, { contents: 'read', 'pull-requests': 'write', statuses: 'write' });
  const steps = policyJob.steps ?? [];
  const ciSteps = ciJobs.flatMap(job => job.steps ?? []);
  const pinned = (action: string) => ciSteps.find(step => step.uses?.startsWith(action + '@'))?.uses;
  assert.deepEqual(steps.flatMap(step => (step.uses ? [step.uses] : [])), [pinned('actions/checkout'), pinned('actions/setup-node')]);
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with ?? {};
  assert.equal(checkout['persist-credentials'], false);
  assert.equal(checkout['sparse-checkout'], 'scripts/pr-target.ts');
  assert.ok(!('ref' in checkout) && !('repository' in checkout), 'the policy must run the trusted default branch code');
  const runs = steps.flatMap(step => (step.run === undefined ? [] : [step.run]));
  assert.deepEqual(runs, ['node scripts/pr-target.ts']);
  for (const run of runs) assert.doesNotMatch(run, /\$\{\{|github\.event\.pull_request/);
  assert.deepEqual(steps.at(-1)?.env, { GITHUB_TOKEN: '$' + '{{ secrets.GITHUB_TOKEN }}' });

  // Pull requests are never path-filtered; a skipped workflow would leave a required check waiting.
  assert.equal(ci.on.push, undefined);
  assert.ok(!('paths' in ci.on.pull_request) && !('paths-ignore' in ci.on.pull_request));
});

test('CONTRIBUTING.md documents the same branch rule as the policy script', async () => {
  const guide = await readFile('CONTRIBUTING.md', 'utf8');
  const section = /^## 브랜치와 PR 대상\r?\n([\s\S]*?)^## /m.exec(guide)?.[1] ?? '';
  assert.ok(section, 'CONTRIBUTING.md needs a "## 브랜치와 PR 대상" section');
  assert.deepEqual(Array.from(section.matchAll(/^\| `([a-z]+)` \|/gm), match => match[1]), [...BRANCH_TYPES]);
  assert.ok(section.includes('1–' + BRANCH_DESCRIPTION_MAX + '자'));
  assert.ok(section.includes('`-`, `.`, `_`'));
  for (const example of BRANCH_EXAMPLES) assert.ok(section.includes('`' + example + '`'), example);
});

test('branch rules are created or updated by name and --dry-run never writes', async () => {
  const rulesets = await loadRulesets();
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const gh = async (args: readonly string[], input?: string): Promise<GhResult> => {
    calls.push({ args, input });
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ nameWithOwner: repository }), stderr: '' };
    if (args.includes('--method')) return { code: 0, stdout: JSON.stringify({ id: 77, enforcement: 'active' }), stderr: '' };
    return { code: 0, stdout: JSON.stringify([{ id: 42, name: rulesets[1].name, source_type: 'Repository' }, { id: 9, name: 'unrelated', source_type: 'Repository' }]), stderr: '' };
  };
  const quiet = { log: () => undefined, error: () => undefined };
  assert.equal(await applyBranchRules({ rulesets, dryRun: true, gh, ...quiet }), 0);
  assert.deepEqual(calls.map(call => call.args[0]), ['repo', 'api']);
  assert.ok(calls.every(call => !call.args.includes('--method') && call.input === undefined));
  assert.ok(calls[1].args.includes('repos/' + repository + '/rulesets?per_page=100&includes_parents=false'));

  calls.length = 0;
  assert.equal(await applyBranchRules({ rulesets, repo: repository, dryRun: false, gh, ...quiet }), 0);
  const writes = calls.filter(call => call.args.includes('--method'));
  const target = (args: readonly string[]) => args.slice(args.indexOf('--method') + 1, args.indexOf('--method') + 3);
  assert.deepEqual(writes.map(call => target(call.args)), [['POST', 'repos/' + repository + '/rulesets'], ['PUT', 'repos/' + repository + '/rulesets/42']]);
  assert.deepEqual(writes.map(call => JSON.parse(call.input ?? '')), rulesets);
  assert.ok(writes.every(call => call.args.at(-2) === '--input' && call.args.at(-1) === '-'));
});

test('ruleset errors explain the private Free plan 403, admin access and bad input', async () => {
  const rulesets = await loadRulesets();
  const errors: string[] = [];
  const planLimited = async (args: readonly string[]): Promise<GhResult> => args.includes('--method')
    ? { code: 1, stdout: '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}', stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n' }
    : { code: 0, stdout: '[]', stderr: '' };
  assert.equal(await applyBranchRules({ rulesets, repo: repository, dryRun: false, gh: planLimited, log: () => undefined, error: line => errors.push(line) }), 1);
  assert.match(errors.join('\n'), /403[\s\S]*비공개 저장소의 무료 요금제[\s\S]*공개로 전환하거나 GitHub Pro/);

  errors.length = 0;
  const forbidden = async (): Promise<GhResult> => ({ code: 1, stdout: '', stderr: 'gh: Must have admin rights to Repository. (HTTP 403)\n' });
  assert.equal(await applyBranchRules({ rulesets, repo: repository, dryRun: true, gh: forbidden, log: () => undefined, error: line => errors.push(line) }), 1);
  assert.match(errors.join('\n'), /Administration 쓰기 권한이 있는 소유자 계정/);

  errors.length = 0;
  const missing = async (): Promise<GhResult> => ({ code: 1, stdout: '', stderr: '', missing: true });
  assert.equal(await applyBranchRules({ rulesets, dryRun: true, gh: missing, log: () => undefined, error: line => errors.push(line) }), 1);
  assert.match(errors.join('\n'), /gh auth login/);

  const calls: unknown[] = [];
  const recording = async (args: readonly string[]): Promise<GhResult> => { calls.push(args); return { code: 0, stdout: '[]', stderr: '' }; };
  assert.equal(await applyBranchRules({ rulesets, repo: 'bokjk/mongle;rm -rf', dryRun: true, gh: recording, log: () => undefined, error: () => undefined }), 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(parseArgs(['--dry-run', '--repo', 'a/b']), { dryRun: true, help: false, repo: 'a/b' });
  assert.deepEqual(parseArgs(['--repo=a/b']), { dryRun: false, help: false, repo: 'a/b' });
  assert.throws(() => parseArgs(['--force']), /알 수 없는 인수/);
});
