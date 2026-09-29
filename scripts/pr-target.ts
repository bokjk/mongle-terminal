// PR target policy for .github/workflows/pr-target.yml (pull_request_target).
//
// The workflow checks out only this file from the trusted default branch and runs it with plain
// Node.js 24 type stripping, so it may use node: built-ins and erasable TypeScript syntax only.
// It never checks out, imports or executes pull request code. Branch names are untrusted input:
// they are compared as strings, sent to GitHub only inside JSON bodies and rendered as inert
// Markdown code spans. No value from the event reaches a shell or a URL path.
//
// The verdict is published as the "PR target branch" commit status on the PR head commit because
// the job's own check run is attached to the default branch commit. Commit statuses belong to a
// commit, not to a PR: PRs that share the same head commit also share the latest verdict.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_BRANCH = 'dev';
export const RELEASE_BRANCH = 'main';
/** Required status check context in .github/rulesets/*.json. The job itself is named "PR target policy". */
export const STATUS_CONTEXT = 'PR target branch';
export const STATUS_DESCRIPTION_MAX = 140;
export const COMMENT_MARKER = '<!-- mongle-pr-target -->';
/** Author of comments posted with the workflow GITHUB_TOKEN. Comments by anyone else are never edited. */
export const BOT_LOGIN = 'github-actions[bot]';

/**
 * The only definition of the contribution branch rule "<type>/<description>".
 * CONTRIBUTING.md documents the same values and tests/platform/pr-target.test.ts keeps them in sync.
 */
export const BRANCH_TYPES = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'codex'] as const;
export const BRANCH_DESCRIPTION_MAX = 60;
/** Lowercase letter/digit words joined by exactly one '-', '.' or '_'. */
export const BRANCH_DESCRIPTION_PATTERN = /^[a-z0-9]+(?:[-._][a-z0-9]+)*$/;
export const BRANCH_EXAMPLES = ['fix/tray-restore', 'fix/v0.3.0-installer'] as const;

export type NameProblem = 'missing-type' | 'invalid-description' | 'description-too-long';
export type BranchProblem = 'protected-head' | NameProblem;

export function branchNameProblem(name: string): NameProblem | undefined {
  const slash = name.indexOf('/');
  if (slash < 0 || !(BRANCH_TYPES as readonly string[]).includes(name.slice(0, slash))) return 'missing-type';
  const description = name.slice(slash + 1);
  if (!BRANCH_DESCRIPTION_PATTERN.test(description)) return 'invalid-description';
  return description.length > BRANCH_DESCRIPTION_MAX ? 'description-too-long' : undefined;
}

export interface TargetFacts {
  baseRef: string;
  headRef: string;
  /** True when the head branch lives in this repository rather than in a fork. */
  sameRepository: boolean;
}

export type Verdict =
  | { allowed: true; reason: 'topic' | 'release' | 'back-merge' }
  | { allowed: false; problem: BranchProblem };

export interface TargetDecision {
  /** Present when the PR must first move from this base to dev; the verdict then applies to dev. */
  retargetFrom?: string;
  /** Base branch the verdict applies to. */
  base: string;
  verdict: Verdict;
}

/** Contributions go from a topic branch to dev; main only takes this repository's dev (release PR). */
export function decideTarget({ baseRef, headRef, sameRepository }: TargetFacts): TargetDecision {
  if (baseRef === DEV_BRANCH) return { base: DEV_BRANCH, verdict: devVerdict(headRef, sameRepository) };
  if (sameRepository && headRef === DEV_BRANCH) {
    // The maintainer release PR. Moving any other PR from dev to dev would compare dev with itself.
    return baseRef === RELEASE_BRANCH
      ? { base: baseRef, verdict: { allowed: true, reason: 'release' } }
      : { base: baseRef, verdict: { allowed: false, problem: 'protected-head' } };
  }
  return { retargetFrom: baseRef, base: DEV_BRANCH, verdict: devVerdict(headRef, sameRepository) };
}

function devVerdict(headRef: string, sameRepository: boolean): Verdict {
  if (headRef === RELEASE_BRANCH && sameRepository) return { allowed: true, reason: 'back-merge' };
  if (headRef === RELEASE_BRANCH || headRef === DEV_BRANCH) return { allowed: false, problem: 'protected-head' };
  const problem = branchNameProblem(headRef);
  return problem ? { allowed: false, problem } : { allowed: true, reason: 'topic' };
}

export interface PullRequestFacts extends TargetFacts {
  number: number;
  state: string;
  headSha: string;
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object in the pull_request event.');
  return value as Record<string, unknown>;
}

function textAt(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error(label + ' must be a non-empty string.');
  return value;
}

export function pullRequestFacts(event: unknown, repository: string): PullRequestFacts {
  const pr = objectAt(objectAt(event, 'The event').pull_request, 'pull_request');
  const base = objectAt(pr.base, 'pull_request.base');
  const head = objectAt(pr.head, 'pull_request.head');
  const number = pr.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw new Error('pull_request.number must be a positive integer.');
  const headSha = textAt(head.sha, 'pull_request.head.sha');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Error('pull_request.head.sha must be a full commit SHA.');
  const baseRepository = textAt(objectAt(base.repo, 'pull_request.base.repo').full_name, 'pull_request.base.repo.full_name');
  if (baseRepository.toLowerCase() !== repository.toLowerCase()) throw new Error('The event belongs to a different repository than GITHUB_REPOSITORY.');
  // head.repo is null when the fork was deleted; such a head is never treated as this repository.
  const headRepository = head.repo == null ? undefined : textAt(objectAt(head.repo, 'pull_request.head.repo').full_name, 'pull_request.head.repo.full_name');
  return {
    number,
    state: textAt(pr.state, 'pull_request.state'),
    baseRef: textAt(base.ref, 'pull_request.base.ref'),
    headRef: textAt(head.ref, 'pull_request.head.ref'),
    headSha,
    sameRepository: headRepository !== undefined && headRepository.toLowerCase() === baseRepository.toLowerCase(),
  };
}

export interface PolicyConfig {
  repository: string;
  token: string;
  eventPath: string;
  apiUrl: string;
  serverUrl: string;
  runUrl?: string;
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export function isRepository(value: string): boolean {
  const name = value.split('/')[1];
  return REPOSITORY_PATTERN.test(value) && name !== '.' && name !== '..';
}

function trustedUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(label + ' must be an absolute URL.');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  // The token is only ever sent over https; plain http is accepted for a local test server.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(label + ' must use https.');
  if (url.username || url.password || url.search || url.hash) throw new Error(label + ' must not contain credentials, a query or a fragment.');
  return url.href.replace(/\/+$/, '');
}

export function policyConfig(env: Record<string, string | undefined>): PolicyConfig {
  const repository = env.GITHUB_REPOSITORY ?? '';
  if (!isRepository(repository)) throw new Error('GITHUB_REPOSITORY must be owner/name.');
  const token = env.GITHUB_TOKEN ?? '';
  if (!token) throw new Error('GITHUB_TOKEN is required to move the PR, update its comment and set the commit status.');
  const eventPath = env.GITHUB_EVENT_PATH ?? '';
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required; this policy reads the pull_request_target event.');
  const apiUrl = trustedUrl(env.GITHUB_API_URL || 'https://api.github.com', 'GITHUB_API_URL');
  const serverUrl = trustedUrl(env.GITHUB_SERVER_URL || 'https://github.com', 'GITHUB_SERVER_URL');
  const runId = env.GITHUB_RUN_ID ?? '';
  const runUrl = /^\d+$/.test(runId) ? serverUrl + '/' + repository + '/actions/runs/' + runId : undefined;
  return { repository, token, eventPath, apiUrl, serverUrl, runUrl };
}

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface GitHubClient {
  /** Routes are built from validated numbers and SHAs only; untrusted text travels in the JSON body. */
  request(method: HttpMethod, route: string, body?: unknown): Promise<unknown>;
}

export function gitHubClient(config: Pick<PolicyConfig, 'apiUrl' | 'repository' | 'token'>, fetchImpl: Fetch): GitHubClient {
  const [owner, name] = config.repository.split('/');
  const root = config.apiUrl + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name);
  return {
    async request(method, route, body) {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer ' + config.token,
        'user-agent': 'mongle-terminal-pr-target',
        'x-github-api-version': '2022-11-28',
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetchImpl(root + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { message?: unknown };
          if (typeof parsed.message === 'string') message = parsed.message;
        } catch {
          // Keep the raw response text.
        }
        throw new GitHubApiError(response.status, method + ' ' + route + ' failed with HTTP ' + response.status + ': ' + message);
      }
      return text ? JSON.parse(text) : undefined;
    },
  };
}

interface PolicyComment { id: number; body: string }

const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 30;

/** Policy comments in creation order. The marker alone is not trusted: the author must be the workflow bot. */
export async function policyComments(client: GitHubClient, number: number): Promise<PolicyComment[]> {
  const found: PolicyComment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const batch = await client.request('GET', '/issues/' + number + '/comments?per_page=' + COMMENTS_PER_PAGE + '&page=' + page);
    if (!Array.isArray(batch)) throw new Error('GitHub returned an unexpected comment list.');
    for (const item of batch) {
      const comment = item as { id?: unknown; body?: unknown; user?: { login?: unknown } | null };
      if (comment.user?.login === BOT_LOGIN && typeof comment.body === 'string' && comment.body.startsWith(COMMENT_MARKER)
        && typeof comment.id === 'number' && Number.isSafeInteger(comment.id)) found.push({ id: comment.id, body: comment.body });
    }
    if (batch.length < COMMENTS_PER_PAGE) break;
  }
  return found;
}

export type CommentMode = 'upsert' | 'update-only';
export type CommentResult = 'created' | 'updated' | 'unchanged' | 'skipped';

/** Keeps exactly one policy comment per PR: update the oldest, delete duplicates, never post twice. */
export async function syncPolicyComment(client: GitHubClient, number: number, body: string, mode: CommentMode, warn: (line: string) => void): Promise<CommentResult> {
  const [current, ...duplicates] = await policyComments(client, number);
  if (!current) {
    if (mode === 'update-only') return 'skipped';
    await client.request('POST', '/issues/' + number + '/comments', { body });
    return 'created';
  }
  let result: CommentResult = 'unchanged';
  if (current.body !== body) {
    await client.request('PATCH', '/issues/comments/' + current.id, { body });
    result = 'updated';
  }
  for (const duplicate of duplicates) {
    try {
      await client.request('DELETE', '/issues/comments/' + duplicate.id);
    } catch (cause) {
      warn('Could not delete duplicate policy comment ' + duplicate.id + ': ' + errorText(cause));
    }
  }
  return result;
}

const MAX_SHOWN_NAME = 120;

/** Renders untrusted text as an inert Markdown code span: no mentions, links, HTML or fence breakouts. */
export function inlineCode(value: string): string {
  const characters = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '\ufffd'));
  const shown = characters.length > MAX_SHOWN_NAME ? characters.slice(0, MAX_SHOWN_NAME).join('') + '…' : characters.join('');
  const longestRun = Math.max(0, ...Array.from(shown.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = shown.startsWith('`') || shown.endsWith('`') ? ' ' : '';
  return fence + padding + shown + padding + fence;
}

export function truncate(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : characters.slice(0, max - 1).join('') + '…';
}

export function branchRuleText(): string {
  const code = (value: string) => '`' + value + '`';
  return '브랜치 이름은 ' + code('<종류>/<설명>') + ' 형식입니다. 종류는 ' + BRANCH_TYPES.map(code).join(', ')
    + ' 중 하나이고, 설명은 영문 소문자·숫자로 된 단어를 ' + ['-', '.', '_'].map(code).join(', ') + ' 중 하나로 이은 1–'
    + BRANCH_DESCRIPTION_MAX + '자입니다. 예: ' + BRANCH_EXAMPLES.map(code).join(', ');
}

const PROBLEM_TEXT: Record<BranchProblem, string> = {
  'protected-head': '`main`·`dev` 브랜치는 PR의 원본(head)으로 쓸 수 없습니다. 예외는 유지보수자가 이 저장소에서 여는 `dev` → `main` 배포 PR과 `main` → `dev` 역병합 PR뿐입니다.',
  'missing-type': '브랜치 이름이 허용된 `<종류>/`로 시작하지 않습니다.',
  'invalid-description': '브랜치 이름의 설명 부분에 허용되지 않는 문자나 형식이 있습니다(대문자·한글·공백, 추가 `/`, 연속되거나 앞뒤에 오는 구분 기호 등).',
  'description-too-long': '브랜치 이름의 설명이 ' + BRANCH_DESCRIPTION_MAX + '자를 넘습니다.',
};

const ALLOWED_STATUS: Record<'topic' | 'release' | 'back-merge', string> = {
  topic: '규칙에 맞는 주제 브랜치의 dev 대상 PR입니다.',
  release: '유지보수자의 dev → main 배포 PR입니다.',
  'back-merge': '유지보수자의 main → dev 역병합 PR입니다.',
};

const REJECTED_STATUS: Record<BranchProblem, string> = {
  'protected-head': 'main·dev 브랜치에서 연 PR은 받을 수 없습니다. 주제 브랜치에서 dev 대상 새 PR을 여세요.',
  'missing-type': '브랜치 이름이 <종류>/<설명> 규칙에 맞지 않습니다(허용된 종류 없음). PR 코멘트를 확인하세요.',
  'invalid-description': '브랜치 이름의 설명 형식이 규칙에 맞지 않습니다. PR 코멘트를 확인하세요.',
  'description-too-long': '브랜치 이름의 설명이 ' + BRANCH_DESCRIPTION_MAX + '자를 넘습니다. PR 코멘트를 확인하세요.',
};

export interface PolicyOutcome {
  headRef: string;
  /** Base of the PR when the run started. */
  originalBase: string;
  /** Base the verdict applies to (dev after a successful retarget). */
  base: string;
  retargeted: boolean;
  /** Set when GitHub refused to move the PR to dev; the check then fails regardless of the verdict. */
  retargetError?: { status?: number };
  verdict: Verdict;
}

export function policyStatus(outcome: PolicyOutcome): { state: 'success' | 'failure'; description: string } {
  if (outcome.retargetError) return { state: 'failure', description: '대상 브랜치를 dev로 옮기지 못했습니다. PR 코멘트와 실행 로그를 확인하세요.' };
  const prefix = outcome.retargeted ? '대상을 dev로 옮겼습니다. ' : '';
  const { verdict } = outcome;
  const text = verdict.allowed ? ALLOWED_STATUS[verdict.reason] : REJECTED_STATUS[verdict.problem];
  return { state: verdict.allowed ? 'success' : 'failure', description: truncate(prefix + text, STATUS_DESCRIPTION_MAX) };
}

export function policyComment(outcome: PolicyOutcome, contributingUrl: string): { body: string; mode: CommentMode } {
  const guide = '자세한 절차는 [CONTRIBUTING.md](' + contributingUrl + ')를 확인해 주세요.';
  const moved = '이 PR의 대상(base)을 ' + inlineCode(outcome.originalBase) + '에서 `dev`로 옮겼습니다. 기여 PR은 `dev`로만 받고, `main`은 유지보수자가 이 저장소에서 여는 `dev` → `main` 배포 PR만 받습니다.';
  if (outcome.retargetError) {
    const status = outcome.retargetError.status ? '(HTTP ' + outcome.retargetError.status + ')' : '';
    return {
      mode: 'upsert',
      body: [
        COMMENT_MARKER,
        '### ❌ 대상 브랜치를 `dev`로 옮기지 못했습니다',
        '',
        '기여 PR은 `dev`로만 받지만 GitHub가 이 PR의 대상을 ' + inlineCode(outcome.originalBase) + '에서 `dev`로 바꾸는 요청을 거부했습니다' + status + '. `dev`와 비교해 새 커밋이 없거나 저장소 설정 문제일 수 있습니다.',
        '',
        '**고치는 방법**: PR 제목 옆 **Edit**에서 대상(base)을 `dev`로 바꾸거나, `dev`에서 만든 주제 브랜치로 `dev` 대상 새 PR을 열고 이 PR은 닫아 주세요.',
        '',
        branchRuleText(),
        guide,
      ].join('\n'),
    };
  }
  const { verdict } = outcome;
  if (verdict.allowed && !outcome.retargeted) {
    return {
      mode: 'update-only',
      body: COMMENT_MARKER + '\n✅ 이제 대상 브랜치와 브랜치 이름이 규칙에 맞습니다(대상: ' + inlineCode(outcome.base) + ', 원본: ' + inlineCode(outcome.headRef) + '). 이전 안내는 더 이상 해당하지 않습니다.',
    };
  }
  if (verdict.allowed) {
    return {
      mode: 'upsert',
      body: [
        COMMENT_MARKER,
        '### ↪️ 대상 브랜치를 `dev`로 옮겼습니다',
        '',
        moved,
        '',
        '✅ 옮긴 뒤 `dev` 기준으로 확인했습니다. 원본 브랜치 ' + inlineCode(outcome.headRef) + ' — 규칙에 맞으므로 추가 조치는 필요 없습니다.',
        '',
        '브랜치를 `main`에서 만들었다면 **Files changed**에 의도하지 않은 커밋이 섞이지 않았는지 확인하고, 필요하면 `git rebase upstream/dev` 후 다시 push해 주세요.',
        '',
        guide,
      ].join('\n'),
    };
  }
  return {
    mode: 'upsert',
    body: [
      COMMENT_MARKER,
      outcome.retargeted ? '### ❌ 대상을 `dev`로 옮겼지만 브랜치 규칙에 맞지 않습니다' : '### ❌ PR 브랜치 규칙에 맞지 않습니다',
      '',
      ...(outcome.retargeted ? [moved, ''] : []),
      '**문제**: ' + PROBLEM_TEXT[verdict.problem],
      '현재 원본 브랜치: ' + inlineCode(outcome.headRef),
      '',
      '**고치는 방법** — 열린 PR의 원본 브랜치는 바꿀 수 없으므로 새 PR을 엽니다.',
      '',
      '1. 원본 저장소의 최신 `dev`를 받습니다: `git fetch upstream dev`',
      '2. 규칙에 맞는 새 브랜치를 만들고 `dev` 위로 옮깁니다(이름은 예시): `git switch -c fix/tray-restore` 후 `git rebase upstream/dev`',
      '3. 자신의 fork에 push합니다: `git push -u origin fix/tray-restore`',
      '4. 새 브랜치에서 `dev`를 대상으로 새 PR을 열고 이 PR은 닫습니다.',
      '',
      'fork 없이 이 저장소에서 작업한다면 `upstream` 대신 `origin`을 씁니다.',
      '',
      branchRuleText(),
      guide,
    ].join('\n'),
  };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One-line GitHub Actions error annotation; newlines and % are escaped so data cannot start a new command. */
function annotation(message: string): string {
  return '::error title=' + STATUS_CONTEXT + '::' + message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export interface RunOptions {
  env: Record<string, string | undefined>;
  fetch?: Fetch;
  readText?: (file: string) => Promise<string>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Runs the policy for one pull_request_target event and returns the process exit code. */
export async function runPolicy(options: RunOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const readText = options.readText ?? ((file: string) => readFile(file, 'utf8'));
  const loaded = await (async () => {
    const config = policyConfig(options.env);
    return { config, pr: pullRequestFacts(JSON.parse(await readText(config.eventPath)), config.repository) };
  })().catch((cause: unknown) => {
    error(annotation('PR target policy could not start: ' + errorText(cause)));
    return undefined;
  });
  if (!loaded) return 1;
  const { config, pr } = loaded;
  log('PR #' + pr.number + ': base=' + JSON.stringify(pr.baseRef) + ' head=' + JSON.stringify(pr.headRef)
    + ' (' + (pr.sameRepository ? 'this repository' : 'fork') + ') head sha=' + pr.headSha);
  if (pr.state !== 'open') {
    log('PR #' + pr.number + ' is ' + JSON.stringify(pr.state) + '; nothing to enforce.');
    return 0;
  }

  const client = gitHubClient(config, options.fetch ?? fetch);
  const decision = decideTarget(pr);
  const outcome: PolicyOutcome = { headRef: pr.headRef, originalBase: pr.baseRef, base: decision.base, retargeted: false, verdict: decision.verdict };
  let failed = false;
  if (decision.retargetFrom !== undefined) {
    try {
      const updated = await client.request('PATCH', '/pulls/' + pr.number, { base: DEV_BRANCH }) as { base?: { ref?: unknown } } | undefined;
      if (updated?.base?.ref !== DEV_BRANCH) throw new Error('GitHub did not report ' + DEV_BRANCH + ' as the new base.');
      outcome.retargeted = true;
      // Edits made with GITHUB_TOKEN do not start another workflow run, so the dev rules apply now.
      log('Moved PR #' + pr.number + ' from ' + JSON.stringify(decision.retargetFrom) + ' to "dev"; applying the dev rules in this run.');
    } catch (cause) {
      outcome.retargetError = { status: cause instanceof GitHubApiError ? cause.status : undefined };
      outcome.base = pr.baseRef;
      failed = true;
      error(annotation('Could not move PR #' + pr.number + ' to dev: ' + errorText(cause)));
    }
  }

  const comment = policyComment(outcome, config.serverUrl + '/' + config.repository + '/blob/' + DEV_BRANCH + '/CONTRIBUTING.md');
  try {
    log('Policy comment: ' + await syncPolicyComment(client, pr.number, comment.body, comment.mode, error) + '.');
  } catch (cause) {
    failed = true;
    error(annotation('Could not update the policy comment: ' + errorText(cause)));
  }

  const status = policyStatus(outcome);
  try {
    await client.request('POST', '/statuses/' + pr.headSha, {
      state: status.state,
      context: STATUS_CONTEXT,
      description: status.description,
      ...(config.runUrl ? { target_url: config.runUrl } : {}),
    });
    log('Commit status "' + STATUS_CONTEXT + '" = ' + status.state + ' on ' + pr.headSha + '.');
  } catch (cause) {
    failed = true;
    error(annotation('Could not set the "' + STATUS_CONTEXT + '" commit status: ' + errorText(cause)));
  }

  if (!outcome.retargetError && !outcome.verdict.allowed) {
    error(annotation('PR #' + pr.number + ' does not meet the branch policy: ' + status.description));
    return 1;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPolicy({ env: process.env });
}
