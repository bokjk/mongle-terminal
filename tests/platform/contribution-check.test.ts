import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkContribution, pullRequestDetails } from '../../scripts/check-contribution';

const body = `## 변경 내용
모바일과 데스크톱의 입력 제어 전환을 동일하게 수정했습니다.
## 검증 결과
node --import tsx --test tests/ui/tap-control.test.ts: 13개 통과. 실제 모바일은 미확인입니다.
## 문서 영향
사용 안내와 변경 이력에 새 조작 방법 및 검증 범위를 반영했습니다.
- [x] 사용자 동작 변경
- [ ] 내부 구현·개발 도구
- [ ] 문서·이미지
- [ ] 사용법·종료·복원·원격·개인 데이터·업데이트 동작 변경
- [ ] 배포·자동 업데이트 방식 변경
## 확인
- [x] CONTRIBUTING.md를 읽고 이 변경에 적용했습니다.
- [x] 실사용 세션·인증 정보를 건드리지 않고 격리된 시험 데이터를 사용했습니다.
- [x] 검증한 범위와 확인하지 못한 범위를 구분하고 비밀 정보가 없음을 확인했습니다.
`;
const docs = ['README.md', 'CHANGELOG.md'];

test('documented user-facing changes satisfy the contribution contract', () => {
  assert.deepEqual(checkContribution(body, [...docs, 'apps/web/TerminalPane.tsx']), []);
});

test('user-facing changes require both README and changelog updates', () => {
  const errors = checkContribution(body, ['apps/web/TerminalPane.tsx']);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /README\.md/);
  assert.match(errors.join('\n'), /CHANGELOG\.md/);
});

test('internal refactors and documentation-only changes need explanations, not unrelated product edits', () => {
  for (const category of ['내부 구현·개발 도구', '문서·이미지']) {
    const internal = body.replace('[x] 사용자 동작 변경', '[ ] 사용자 동작 변경').replace(`[ ] ${category}`, `[x] ${category}`);
    assert.deepEqual(checkContribution(internal, ['scripts/example.ts']), []);
    assert.ok(checkContribution(internal.replace('사용 안내와 변경 이력에 새 조작 방법 및 검증 범위를 반영했습니다.', ''), []).some(error => error.includes('문서 영향')));
  }
});

test('usage and release changes require their focused guides', () => {
  const changed = body.replace('[ ] 사용법·', '[x] 사용법·').replace('[ ] 배포·', '[x] 배포·');
  assert.equal(checkContribution(changed, docs).length, 2);
  assert.deepEqual(checkContribution(changed, [...docs, 'docs/USER-GUIDE.md', 'docs/RELEASING.md']), []);
});

test('empty descriptions, unchecked confirmations and ambiguous impact are rejected', () => {
  assert.ok(checkContribution('', []).length >= 7);
  assert.ok(checkContribution(body.replace('[ ] 내부 구현·개발 도구', '[x] 내부 구현·개발 도구'), docs).some(error => error.includes('정확히 하나')));
  assert.ok(checkContribution(body.replace('[x] CONTRIBUTING', '[ ] CONTRIBUTING'), docs).some(error => error.includes('확인 항목')));
  assert.ok(checkContribution(body.replace(/## 검증 결과[\s\S]*?## 문서 영향/, '## 검증 결과\n<!-- 모든 검사 완료 -->\n## 문서 영향'), docs).some(error => error.includes('검증 결과')));
});

test('a copied blank PR template or a code-fenced template cannot satisfy the check', async () => {
  const template = await readFile('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');
  assert.ok(checkContribution(template, docs).length >= 7);
  assert.ok(checkContribution('```markdown\n' + body + '\n```', docs).length >= 7);
});

test('event parsing keeps PR text inert and rejects option or shell-like commit values', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const untrustedBody = '$(Write-Output SECRET) `command`';
  assert.deepEqual(pullRequestDetails({ pull_request: { body: untrustedBody, base: { sha: base }, head: { sha: head } } }), { body: untrustedBody, base, head });
  for (const sha of ['--output=secret', 'main; echo bad', 'a'.repeat(39), null]) {
    assert.throws(() => pullRequestDetails({ pull_request: { body, base: { sha }, head: { sha: head } } }), /full commit SHAs/);
  }
  assert.throws(() => pullRequestDetails({}), /pull_request/);
  assert.throws(() => pullRequestDetails({ pull_request: { body: {}, base: { sha: base }, head: { sha: head } } }), /body must be text/);
});

test('focused guide paths must match, including normalized Windows separators', () => {
  // Git supplies POSIX paths; tolerate Windows separators for local callers.
  const usage = body.replace('[ ] 사용법·', '[x] 사용법·');
  assert.deepEqual(checkContribution(usage, [...docs, 'docs\\USER-GUIDE.md']), []);
  assert.ok(checkContribution(usage, [...docs, 'docs/OLD-USER-GUIDE.md']).some(error => error.includes('USER-GUIDE.md')));
});

test('the CLI reads the event file and rejects deleting a required guide in a real git diff', async () => {
  const exec = promisify(execFile);
  const parent = path.resolve('.test-data/contribution-check');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'repo-'));
  assert.ok(directory.startsWith(parent + path.sep));
  const git = async (...args: string[]) => (await exec('git', args, { cwd: directory, windowsHide: true })).stdout.trim();
  const commit = async () => {
    await git('add', '.');
    await git('-c', 'user.name=Contribution test', '-c', 'user.email=contribution-test@example.invalid', 'commit', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  try {
    await git('init');
    await writeFile(path.join(directory, 'README.md'), 'Before\n');
    await writeFile(path.join(directory, 'CHANGELOG.md'), 'Before\n');
    const base = await commit();
    await writeFile(path.join(directory, 'README.md'), 'After\n');
    await writeFile(path.join(directory, 'CHANGELOG.md'), 'After\n');
    const head = await commit();
    const eventPath = path.join(directory, 'event.json');
    const writeEvent = (sha: string) => writeFile(eventPath, JSON.stringify({ pull_request: { body, base: { sha: base }, head: { sha } } }));
    const run = () => exec(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../scripts/check-contribution.ts', import.meta.url))], {
      cwd: directory, env: { ...process.env, GITHUB_EVENT_PATH: eventPath }, windowsHide: true,
    });
    await writeEvent(head);
    assert.match((await run()).stdout, /documentation impact verified/);
    await git('rm', 'README.md');
    await writeEvent(await commit());
    await assert.rejects(run(), (error: unknown) => {
      assert.match(String((error as { stderr: string }).stderr), /README\.md/);
      return true;
    });
  } finally {
    assert.ok(path.resolve(directory).startsWith(parent + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
