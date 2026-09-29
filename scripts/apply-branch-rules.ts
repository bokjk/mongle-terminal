// Applies the server-side branch rules in .github/rulesets/*.json with the GitHub CLI.
//
//   node scripts/apply-branch-rules.ts --dry-run [--repo owner/name]
//   node scripts/apply-branch-rules.ts [--repo owner/name]
//
// Run it as the repository owner: the gh login needs Administration write access to the repository.
// Rulesets need a public repository (or GitHub Pro or higher for a private one); for a private
// repository on the Free plan GitHub answers 403. gh is started without a shell, with an argument
// array, and each ruleset is sent as JSON on stdin.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRepository, STATUS_CONTEXT } from './pr-target.ts';

export const RULESET_FILES = ['main.json', 'dev.json'] as const;
const API = ['api', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];

export const USAGE = [
  '사용법: node scripts/apply-branch-rules.ts [--dry-run] [--repo owner/name]',
  '저장소 Administration 쓰기 권한이 있는 소유자 계정으로 `gh auth login`한 뒤 실행합니다. 먼저 --dry-run으로 생성·갱신 계획을 확인하세요.',
  'ruleset은 공개 저장소(또는 GitHub Pro 이상)에서만 적용되며, 비공개 무료 저장소에서는 GitHub가 403을 반환합니다.',
].join('\n');

const NEXT_STEPS = '적용 응답을 받았습니다. 저장소 Settings → Rules에서 규칙, 우회 대상(저장소 관리자 역할), pull_request 규칙 값을 확인하세요. '
  + '첫 PR에서 "' + STATUS_CONTEXT + '" 상태가 필수 검사로 인정되는지 확인하고, 상태가 기록됐는데도 대기(Expected)로 남으면 '
  + '.github/rulesets/*.json의 해당 항목에서 integration_id를 지운 뒤 다시 실행하세요.';

export interface GhResult { code: number; stdout: string; stderr: string; missing?: boolean }
export type GhRunner = (args: readonly string[], input?: string) => Promise<GhResult>;

export interface RulesetPayload {
  name: string;
  target: 'branch';
  enforcement: 'active' | 'evaluate' | 'disabled';
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors?: unknown[];
}

export function validateRuleset(value: unknown, source: string): RulesetPayload {
  const ruleset = value as Partial<RulesetPayload> | null;
  const include = ruleset?.conditions?.ref_name?.include;
  const exclude = ruleset?.conditions?.ref_name?.exclude;
  const valid = !!ruleset && typeof ruleset.name === 'string' && ruleset.name.trim() !== '' && ruleset.target === 'branch'
    && (ruleset.enforcement === 'active' || ruleset.enforcement === 'evaluate' || ruleset.enforcement === 'disabled')
    && Array.isArray(include) && include.length > 0 && include.every(ref => typeof ref === 'string' && ref.startsWith('refs/heads/'))
    && Array.isArray(exclude) && Array.isArray(ruleset.rules) && ruleset.rules.length > 0
    && ruleset.rules.every(rule => !!rule && typeof rule.type === 'string');
  if (!valid) throw new Error(source + ': name, target "branch", enforcement, conditions.ref_name.include(refs/heads/...)·exclude와 rules가 필요합니다.');
  return ruleset as RulesetPayload;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadRulesets(root = repositoryRoot): Promise<RulesetPayload[]> {
  const rulesets = await Promise.all(RULESET_FILES.map(async file => {
    const source = path.posix.join('.github', 'rulesets', file);
    return validateRuleset(JSON.parse(await readFile(path.join(root, source), 'utf8')), source);
  }));
  if (new Set(rulesets.map(ruleset => ruleset.name)).size !== rulesets.length) throw new Error('.github/rulesets의 ruleset 이름이 서로 겹칩니다.');
  return rulesets;
}

export function describeRuleset(ruleset: RulesetPayload): string {
  const checks = ruleset.rules.find(rule => rule.type === 'required_status_checks')?.parameters?.required_status_checks;
  const contexts = Array.isArray(checks) ? checks.map(check => String((check as { context?: unknown }).context)).join(', ') : '없음';
  return '- ' + ruleset.name + ' (' + ruleset.conditions.ref_name.include.join(', ') + '): ' + ruleset.rules.map(rule => rule.type).join(', ') + ' / 필수 검사: ' + contexts;
}

interface ExistingRuleset { id: number; name: string }

/** Repository-level rulesets from one page of 100; a repository has far fewer. */
export function parseRulesetList(stdout: string): ExistingRuleset[] {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) throw new Error('GitHub가 배열이 아닌 응답을 반환했습니다.');
  return value.flatMap(item => {
    const ruleset = item as { id?: unknown; name?: unknown; source_type?: unknown };
    if (typeof ruleset.id !== 'number' || !Number.isSafeInteger(ruleset.id) || typeof ruleset.name !== 'string') return [];
    if (ruleset.source_type !== undefined && ruleset.source_type !== 'Repository') return [];
    return [{ id: ruleset.id, name: ruleset.name }];
  });
}

export function explainGhFailure(action: string, result: GhResult): string {
  if (result.missing) return action + ' 실패: GitHub CLI(gh)를 찾을 수 없습니다. https://cli.github.com 에서 설치하고 저장소 Administration 쓰기 권한이 있는 소유자 계정으로 `gh auth login`을 실행한 뒤 다시 시도하세요.';
  const output = result.stderr + '\n' + result.stdout;
  const detail = (result.stderr.trim() || result.stdout.trim() || 'exit ' + result.code).slice(0, 500);
  if (/HTTP 403|"status"\s*:\s*"?403/.test(output)) {
    if (/upgrade to github pro|make this repository public/i.test(output)) {
      return action + ' 실패: GitHub가 403을 반환했습니다. 비공개 저장소의 무료 요금제에서는 서버 측 브랜치 규칙(ruleset)을 적용할 수 없습니다. '
        + '저장소를 공개로 전환하거나 GitHub Pro 이상으로 바꾼 뒤 다시 실행하세요. 그전까지는 PR target policy 워크플로의 자동 검사와 dev 이동이 강제 수단입니다.\n(gh: ' + detail + ')';
    }
    return action + ' 실패: GitHub가 403을 반환했습니다. 저장소 Administration 쓰기 권한이 있는 소유자 계정으로 `gh auth login`했는지 `gh auth status`로 확인하세요. '
      + '비공개 무료 저장소라면 공개 전환 뒤에만 적용할 수 있습니다.\n(gh: ' + detail + ')';
  }
  if (/HTTP 404/.test(output)) return action + ' 실패: 저장소를 찾지 못했거나 관리자 권한이 없습니다(HTTP 404). --repo 값과 `gh auth status`를 확인하세요.\n(gh: ' + detail + ')';
  return action + ' 실패: ' + detail;
}

function parseApplied(stdout: string): { id?: unknown; enforcement?: unknown } {
  try {
    return JSON.parse(stdout) as { id?: unknown; enforcement?: unknown };
  } catch {
    return {};
  }
}

export interface ApplyOptions {
  rulesets: readonly RulesetPayload[];
  repo?: string;
  dryRun: boolean;
  gh: GhRunner;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Creates or updates each ruleset by name. --dry-run reads the existing rulesets and writes nothing. */
export async function applyBranchRules(options: ApplyOptions): Promise<number> {
  const { gh, log, error } = options;
  let repo = options.repo;
  if (repo === undefined) {
    const view = await gh(['repo', 'view', '--json', 'nameWithOwner']);
    if (view.code !== 0) {
      error(explainGhFailure('저장소 확인', view));
      return 1;
    }
    repo = String((parseApplied(view.stdout) as { nameWithOwner?: unknown }).nameWithOwner ?? '');
  }
  if (!isRepository(repo)) {
    error('저장소는 owner/name 형식이어야 합니다: ' + JSON.stringify(repo) + '\n' + USAGE);
    return 1;
  }
  log('대상 저장소: ' + repo + (options.dryRun ? ' (--dry-run: 읽기만 합니다)' : ''));
  for (const ruleset of options.rulesets) log(describeRuleset(ruleset));

  const listed = await gh([...API, 'repos/' + repo + '/rulesets?per_page=100&includes_parents=false']);
  if (listed.code !== 0) {
    error(explainGhFailure('기존 ruleset 조회', listed));
    return 1;
  }
  let existing: ExistingRuleset[] = [];
  try {
    existing = parseRulesetList(listed.stdout);
  } catch (cause) {
    error('기존 ruleset 목록을 해석하지 못했습니다: ' + (cause instanceof Error ? cause.message : String(cause)));
    return 1;
  }

  const plan: Array<{ ruleset: RulesetPayload; id?: number }> = [];
  for (const ruleset of options.rulesets) {
    const matches = existing.filter(item => item.name === ruleset.name);
    if (matches.length > 1) {
      error('이름이 "' + ruleset.name + '"인 ruleset이 여러 개입니다(#' + matches.map(item => item.id).join(', #') + '). GitHub에서 하나만 남긴 뒤 다시 실행하세요.');
      return 1;
    }
    plan.push({ ruleset, id: matches[0]?.id });
  }
  for (const step of plan) log((step.id === undefined ? '생성 예정: ' : '갱신 예정(#' + step.id + '): ') + step.ruleset.name);
  if (options.dryRun) {
    log('--dry-run: GitHub의 ruleset을 바꾸지 않았습니다.');
    return 0;
  }

  for (const step of plan) {
    const route = step.id === undefined
      ? ['--method', 'POST', 'repos/' + repo + '/rulesets']
      : ['--method', 'PUT', 'repos/' + repo + '/rulesets/' + step.id];
    const result = await gh([...API, ...route, '--input', '-'], JSON.stringify(step.ruleset));
    if (result.code !== 0) {
      error(explainGhFailure(step.ruleset.name + ' 적용', result));
      return 1;
    }
    const applied = parseApplied(result.stdout);
    log((step.id === undefined ? '생성함: ' : '갱신함: ') + step.ruleset.name + ' (#' + String(applied.id ?? '?') + ', ' + String(applied.enforcement ?? '?') + ')');
  }
  log(NEXT_STEPS);
  return 0;
}

export const runGh: GhRunner = (args, input) => new Promise(resolve => {
  const child = execFile('gh', [...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (cause, stdout, stderr) => {
    resolve({
      code: cause ? (typeof cause.code === 'number' ? cause.code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
      missing: cause?.code === 'ENOENT',
    });
  });
  // gh may exit before reading stdin (for example on an authentication error); its exit code reports that.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input ?? '');
});

export interface ApplyArguments { dryRun: boolean; help: boolean; repo?: string }

export function parseArgs(argv: readonly string[]): ApplyArguments {
  const parsed: ApplyArguments = { dryRun: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--repo' && index + 1 < argv.length) parsed.repo = argv[++index];
    else if (arg.startsWith('--repo=')) parsed.repo = arg.slice('--repo='.length);
    else throw new Error('알 수 없는 인수입니다: ' + JSON.stringify(arg) + '\n' + USAGE);
  }
  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = (() => {
    try {
      return parseArgs(argv);
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  })();
  if (!args) return 2;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const rulesets = await loadRulesets().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    return undefined;
  });
  if (!rulesets) return 1;
  return applyBranchRules({ rulesets, repo: args.repo, dryRun: args.dryRun, gh: runGh, log: line => console.log(line), error: line => console.error(line) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
