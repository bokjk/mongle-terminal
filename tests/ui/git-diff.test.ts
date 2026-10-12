import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { HostCore } from '../../packages/host/core';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol';
import { git, gitFixture } from '../helpers/git';

const lines = (count: number, change: (index: number) => string | undefined = () => undefined) => Array.from({ length: count }, (_, index) => change(index) ?? `export const line${index + 1} = ${index + 1};`).join('\n') + '\n';

test('Git review shows every branch change on one page, moves by file and change, and opens side-by-side comparisons', { skip: process.platform !== 'win32' || !existsSync('dist/web/index.html'), timeout: 120000 }, async t => {
  const fixture = await gitFixture(), repository = await realpath(fixture.repository);
  await writeFile(path.join(repository, 'src', 'long.ts'), lines(60)); await git(repository, 'add', '--', '.'); await git(repository, 'commit', '-qm', 'long file');
  await git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(repository, 'checkout', '-qb', 'feature');
  await writeFile(path.join(repository, 'src', 'long.ts'), lines(60, index => index === 44 ? 'export const line45 = "committed";' : undefined));
  await writeFile(path.join(repository, 'committed.txt'), 'committed on the branch\n'); await git(repository, 'add', '--', '.'); await git(repository, 'commit', '-qm', 'branch work');
  await writeFile(path.join(repository, 'src', 'long.ts'), lines(60, index => index === 9 ? 'export const line10 = "changed";' : index === 44 ? 'export const line45 = "committed";' : undefined));
  await writeFile(path.join(repository, 'staged.txt'), 'staged\n'); await git(repository, 'add', '--', 'staged.txt'); await writeFile(path.join(repository, 'staged.txt'), 'staged and working content\n');
  await unlink(path.join(repository, 'deleted.txt')); await git(repository, 'mv', '--', '이전 이름.txt', '새 이름.txt');
  await writeFile(path.join(repository, '새 파일.txt'), '<script>window.gitDiffExecuted=true</script>\n안녕하세요\n');
  await writeFile(path.join(repository, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const host = new HostCore({ dataDir: fixture.data, name: 'Git 비교 검증 PC' }); await host.init();
  t.after(async () => { await host.close(); assert.equal(path.dirname(fixture.root), tmpdir()); await rm(fixture.root, { recursive: true, force: true }); });
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'git-diff-ui', deviceName: '검증 브라우저', owner: true }; host.connect(ctx, () => {});
  const terminal: TerminalInfo = await host.handle('terminals.create', { groupId: host.getState().groups[0].id, profileId: 'cmd', cwd: repository }, ctx);
  await host.handle('terminals.rename', { id: terminal.id, title: 'Git 프로젝트' }, ctx);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = createServer(async (request, response) => {
    try { const file = path.resolve('dist/web', (request.url === '/' ? '/index.html' : request.url!).slice(1)); if (!file.startsWith(path.resolve('dist/web') + path.sep)) throw new Error(); response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  await page.exposeBinding('hostRequest', async (_source, method: string, params: any) => { requests.push(method); return host.handle(method, params, ctx); });
  host.disconnect(ctx.id); host.connect(ctx, event => { void page.evaluate(event => (window as any).__listeners?.forEach((listener: any) => listener(event)), event).catch(() => {}); });
  await page.addInitScript('window.__name = function(fn) { return fn; };');
  await page.addInitScript(({ connectionId }) => {
    const listeners = new Set(); (window as any).__listeners = listeners;
    (window as any).mongle = { request: (method: string, params: any) => (window as any).hostRequest(method, params), subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, onConnection: (fn: any) => { fn({ status: 'connected', owner: true, connectionId }); return () => {}; }, listHosts: async () => [{ id: 'local', name: '검증 PC', local: true, selected: true }] };
  }, { connectionId: ctx.id });
  const output = 'test-results/git-diff'; await mkdir(output, { recursive: true });
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator(`[data-terminal-id="${terminal.id}"] textarea`).focus(); await page.getByRole('button', { name: '파일 탐색기', exact: true }).click();
    const explorer = page.getByRole('complementary', { name: '파일 탐색기' }), editor = page.getByRole('region', { name: '파일 편집기', exact: true });
    await explorer.getByRole('tab', { name: /^Git/ }).click();
    await expect(explorer.locator('.git-footnote')).toContainText('변경 검토');
    const working = explorer.getByRole('region', { name: '작업 폴더 변경', exact: true });
    const review = editor.locator('.document-body:not([hidden]) .git-review'), position = review.locator('.diff-position');
    const section = (file: string) => review.locator(`.review-section[data-path="${file}"]`);

    // Clicking a Git row opens the review on that file; the default base is where the branch left origin/main.
    await working.getByRole('button', { name: 'src/long.ts · 수정됨' }).click();
    await expect(editor.getByRole('tab', { name: /^변경 검토 · 작업 프로젝트/ })).toHaveAttribute('aria-selected', 'true');
    await expect(review.getByRole('button', { name: '브랜치 전체' })).toHaveAttribute('aria-pressed', 'true');
    await expect(review.locator('.review-base')).toContainText('origin/main 이후');
    const branchFiles = ['committed.txt', 'deleted.txt', 'image.bin', 'src/long.ts', 'staged.txt', '새 이름.txt', '새 파일.txt'];
    await expect(review.locator('.review-section')).toHaveCount(branchFiles.length);
    assert.deepEqual(await review.locator('.review-section').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.path)), branchFiles);
    const list = review.getByRole('navigation', { name: '변경 파일 목록' });
    if (!(await list.isVisible())) await review.getByRole('button', { name: '파일 목록 보기' }).click();
    await expect(list.getByRole('button')).toHaveCount(branchFiles.length);
    await list.getByRole('button').filter({ hasText: 'committed.txt' }).click();
    await expect(review.locator('.review-section.current')).toHaveAttribute('data-path', 'committed.txt');
    await working.getByRole('button', { name: 'src/long.ts · 수정됨' }).click(); await expect(review.locator('.review-section.current')).toHaveAttribute('data-path', 'src/long.ts');
    await expect(section('src/long.ts').locator('.cm-deletedChunk').first()).toContainText('export const line10 = 10;');
    await expect(section('src/long.ts').locator('.cm-content')).toContainText('line45 = "committed"');
    await expect(section('src/long.ts').locator('.review-count')).toHaveText('+2 −2');
    await expect(section('src/long.ts').locator('.cm-collapsedLines').first()).toContainText('바뀌지 않은 줄');
    await expect(section('committed.txt').locator('.cm-content')).toContainText('committed on the branch');
    await expect(section('deleted.txt').locator('.cm-deletedChunk')).toContainText('delete me');
    await expect(section('새 이름.txt').locator('.review-path')).toContainText('이전 이름.txt → 새 이름.txt');
    await expect(section('image.bin').locator('.review-message')).toContainText('바이너리');
    await expect(section('새 파일.txt').locator('.cm-content')).toContainText('안녕하세요');
    assert.equal(await page.evaluate(() => (window as any).gitDiffExecuted), undefined);
    await page.screenshot({ path: `${output}/review-dark.png` });

    // n/p move through changes across files, j/k through files.
    await section('src/long.ts').locator('.review-path').click();
    await page.keyboard.press('n'); await expect(position).toHaveText(/^\d+ \/ \d+$/);
    const first = Number((await position.textContent())!.split(' / ')[0]);
    await page.keyboard.press('n'); await expect(position).toHaveText(new RegExp('^' + (first + 1) + ' / '));
    await page.keyboard.press('p'); await expect(position).toHaveText(new RegExp('^' + first + ' / '));
    await page.keyboard.press('j'); await expect(review.locator('.review-section.current')).toHaveAttribute('data-path', 'staged.txt');
    await page.keyboard.press('k'); await expect(review.locator('.review-section.current')).toHaveAttribute('data-path', 'src/long.ts');
    await review.getByRole('button', { name: '변경 부분만' }).click(); await expect(section('src/long.ts').locator('.cm-collapsedLines')).toHaveCount(0);
    await review.getByRole('button', { name: '변경 부분만' }).click(); await expect(section('src/long.ts').locator('.cm-collapsedLines').first()).toBeVisible();
    await review.getByRole('button', { name: '모든 파일 접기' }).click(); await expect(review.locator('.review-diff')).toHaveCount(0);
    await review.getByRole('button', { name: '모든 파일 펼치기' }).click(); await expect(section('src/long.ts').locator('.review-diff')).toBeVisible();

    // A file opens side by side against the same base, or as an editable file.
    await section('src/long.ts').getByRole('button', { name: 'src/long.ts 비교 탭 열기' }).click();
    await expect(editor.getByRole('tab', { name: 'long.ts · 기준 비교' })).toHaveAttribute('aria-selected', 'true');
    const split = editor.locator('.document-body:not([hidden]) .diff-view');
    // Like Orca's diff tab: inline, whole file, an overview strip of change positions.
    await expect(split.getByRole('button', { name: '한 화면' })).toHaveAttribute('aria-pressed', 'true'); await expect(split.locator('.cm-deletedChunk').first()).toContainText('export const line10 = 10;');
    await expect(split.locator('.cm-collapsedLines')).toHaveCount(0); await expect(split.locator('.diff-overview-mark')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/git-diff/inline-dark.png' });
    await split.locator('.diff-overview-mark').nth(1).click(); await expect(split.locator('.diff-position')).toHaveText('2 / 2');
    await split.getByRole('button', { name: '나란히' }).click();
    await expect(split.locator('.cm-mergeView')).toBeVisible(); await expect(split.locator('.diff-sides')).toContainText('기준 커밋');
    await expect(split.locator('.cm-merge-a .cm-content')).toContainText('export const line10 = 10;'); await expect(split.locator('.cm-merge-b .cm-content')).toContainText('line10 = "changed"');
    await page.keyboard.press('F7'); await expect(split.locator('.diff-position')).toHaveText(/^\d \/ 2$/);
    await page.screenshot({ path: `${output}/split-dark.png` });
    await editor.getByRole('tab', { name: /^변경 검토/ }).click();
    await section('staged.txt').getByRole('button', { name: 'staged.txt 파일 열기' }).click();
    await expect(editor.getByRole('tab', { name: 'staged.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.getByRole('button', { name: '파일 저장' })).toBeVisible();

    // Switching to uncommitted changes drops the committed branch work.
    await editor.getByRole('tab', { name: /^변경 검토/ }).click();
    await review.getByRole('button', { name: '커밋 안 한 변경' }).click();
    await expect(review.locator('.review-base')).toContainText('HEAD 이후');
    await expect(section('committed.txt')).toHaveCount(0); await expect(review.locator('.review-section')).toHaveCount(branchFiles.length - 1);
    await expect(section('src/long.ts').locator('.review-count')).toHaveText('+1 −1');

    // Background refresh follows edits to visible files.
    await writeFile(path.join(repository, 'src', 'long.ts'), lines(60, index => index === 9 ? 'export const line10 = "edited again";' : index === 44 ? 'export const line45 = "committed";' : undefined));
    await expect(section('src/long.ts').locator('.cm-content')).toContainText('edited again', { timeout: 12000 });

    // Light theme and a phone-width viewport.
    await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('button', { name: '밝게', exact: true }).click(); await page.getByRole('button', { name: '설정 닫기' }).click();
    await review.getByRole('button', { name: '브랜치 전체' }).click(); await expect(section('committed.txt')).toBeVisible();
    await page.screenshot({ path: `${output}/review-light.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await explorer.getByRole('button', { name: '파일 탐색기 닫기' }).click();
    await expect(review.getByRole('navigation', { name: '변경 파일 목록' })).toBeHidden();
    await expect(section('src/long.ts').locator('.cm-content')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: `${output}/review-mobile.png` });
    assert.ok(requests.includes('git.review') && requests.includes('git.diff'));
    assert.equal(host.getState().terminals.find(item => item.id === terminal.id)?.pid, terminal.pid);
    assert.deepEqual(errors, []);
    await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, realGit: true, realHost: true, desktopBridge: 'test binding', scenarios: ['row opens review at file', 'branch base from origin/HEAD', 'committed and uncommitted changes together', 'rename/delete/new/binary sections', 'n/p change and j/k file keys', 'collapse/expand all', 'side-by-side against same base', 'open editable file', 'uncommitted-only mode', 'background refresh', 'light theme', '390px viewport'], errors }, null, 2));
  } finally {
    host.disconnect(ctx.id); await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

