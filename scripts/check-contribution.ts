import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const categories = ['사용자 동작 변경', '내부 구현·개발 도구', '문서·이미지'] as const;
const confirmations = [
  'CONTRIBUTING.md를 읽고 이 변경에 적용했습니다.',
  '실사용 세션·인증 정보를 건드리지 않고 격리된 시험 데이터를 사용했습니다.',
  '검증한 범위와 확인하지 못한 범위를 구분하고 비밀 정보가 없음을 확인했습니다.',
] as const;

function sections(body: string): Map<string, string> {
  const result = new Map<string, string>();
  let heading: string | undefined;
  let fenced = false;
  // Comments and code samples cannot satisfy the required headings or checkboxes.
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) { heading = match[1]; if (!result.has(heading)) result.set(heading, ''); }
    else if (heading) result.set(heading, result.get(heading) + '\n' + line);
  }
  return result;
}

function checked(content: string, label: string): boolean {
  return content.split(/\r?\n/).some(line => /^\s*- \[[xX]\] /.test(line) && line.replace(/^\s*- \[[xX]\] /, '').trim() === label);
}

function hasExplanation(content: string): boolean {
  return content.split(/\r?\n/).filter(line => !/^\s*- \[[ xX]\]/.test(line)).join('\n').replace(/[\s#>*_`-]/g, '').length >= 8;
}

/** Self-reported impact is reviewed by a maintainer; this verifies the agreed PR contract. */
export function checkContribution(body: string, changedFiles: readonly string[]): string[] {
  const errors: string[] = [];
  const parts = sections(body);
  for (const name of ['변경 내용', '검증 결과', '문서 영향']) {
    if (!hasExplanation(parts.get(name) || '')) errors.push(`'${name}' 섹션에 구체적인 설명을 적어 주세요. 주석·체크박스만으로는 충족되지 않습니다.`);
  }
  const impact = parts.get('문서 영향') || '';
  const selected = categories.filter(label => checked(impact, label));
  if (selected.length !== 1) errors.push('문서 영향에서 변경 분류를 정확히 하나 선택해 주세요.');
  const confirmationsSection = parts.get('확인') || '';
  for (const label of confirmations) {
    if (!checked(confirmationsSection, label)) errors.push(`확인 항목을 완료해 주세요: ${label}`);
  }
  const files = new Set(changedFiles.map(file => file.replaceAll('\\', '/')));
  const requireFile = (file: string, reason: string) => {
    if (!files.has(file)) errors.push(`${reason}: ${file}도 같은 PR에서 갱신해 주세요.`);
  };
  if (selected.includes('사용자 동작 변경')) {
    requireFile('README.md', '사용자에게 보이는 동작 변경');
    requireFile('CHANGELOG.md', '사용자에게 보이는 동작 변경');
  }
  if (checked(impact, '사용법·종료·복원·원격·개인 데이터·업데이트 동작 변경')) {
    requireFile('docs/USER-GUIDE.md', '사용 흐름 변경');
  }
  if (checked(impact, '배포·자동 업데이트 방식 변경')) {
    requireFile('docs/RELEASING.md', '배포 방식 변경');
  }
  return errors;
}

export function pullRequestDetails(event: unknown): { body: string; base: string; head: string } {
  if (!event || typeof event !== 'object') throw new Error('Invalid GitHub event payload.');
  const pr = (event as { pull_request?: unknown }).pull_request;
  if (!pr || typeof pr !== 'object') throw new Error('A pull_request event is required.');
  const value = pr as { body?: unknown; base?: { sha?: unknown }; head?: { sha?: unknown } };
  const base = value.base?.sha, head = value.head?.sha;
  if (typeof base !== 'string' || typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('Pull request base/head must be full commit SHAs.');
  }
  if (value.body != null && typeof value.body !== 'string') throw new Error('Pull request body must be text.');
  return { body: value.body || '', base, head };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required; this check reads the pull_request JSON event.');
  const { body, base, head } = pullRequestDetails(JSON.parse(await readFile(eventPath, 'utf8')));
  // Never interpolate PR text, paths or titles into shell code. Only validated
  // SHAs are passed as execFile arguments, with no shell and no API credentials.
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=ACMRT', '-z', `${base}...${head}`, '--'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const errors = checkContribution(body, stdout.split('\0').filter(Boolean));
  if (errors.length) {
    console.error(errors.map(error => `- ${error}`).join('\n'));
    process.exitCode = 1;
  } else console.log('PR description, confirmations and documentation impact verified.');
}
