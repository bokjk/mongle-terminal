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

test('Git diff tab compares staged, working, renamed, deleted, new and binary changes side by side and inline', { skip: process.platform !== 'win32' || !existsSync('dist/web/index.html'), timeout: 120000 }, async t => {
  const fixture = await gitFixture(), repository = await realpath(fixture.repository);
  await writeFile(path.join(repository, 'src', 'long.ts'), lines(60)); await git(repository, 'add', '--', '.'); await git(repository, 'commit', '-qm', 'long file');
  await writeFile(path.join(repository, 'src', 'long.ts'), lines(60, index => index === 9 ? 'export const line10 = "changed";' : index === 44 ? 'export const line45 = "also changed";' : undefined));
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
    await expect(explorer.locator('.git-footnote')).toContainText('나란히 비교');
    const staged = explorer.getByRole('region', { name: '스테이징됨', exact: true }), working = explorer.getByRole('region', { name: '작업 폴더 변경', exact: true });
    const view = editor.locator('.document-body:not([hidden]) .diff-view'), position = view.locator('.diff-position');

    // Working-copy change: side by side, collapsed unchanged lines, F7 navigation.
    await working.getByRole('button', { name: 'src/long.ts · 수정됨' }).click();
    await expect(editor.getByRole('tab', { name: 'long.ts · 작업 중 비교' })).toHaveAttribute('aria-selected', 'true');
    await expect(view.locator('.cm-mergeView')).toBeVisible();
    await expect(view.locator('.diff-sides')).toContainText('스테이징'); await expect(view.locator('.diff-sides')).toContainText('작업 폴더');
    await expect(view.locator('.cm-merge-a .cm-content')).toContainText('export const line10 = 10;');
    await expect(view.locator('.cm-merge-b .cm-content')).toContainText('export const line10 = "changed";');
    await expect(view.locator('.cm-merge-b .cm-changedText').first()).toBeVisible();
    await expect(view.locator('.diff-stats')).toHaveAccessibleName('추가 2줄, 삭제 2줄');
    await expect(position).toHaveText('1 / 2');
    await expect(view.locator('.cm-merge-b .cm-collapsedLines').first()).toContainText('바뀌지 않은 줄');
    await page.screenshot({ path: `${output}/split-dark.png` });
    await view.getByRole('button', { name: '다음 변경' }).click(); await expect(position).toHaveText('2 / 2');
    await expect(view.locator('.cm-merge-b .cm-activeLine')).toContainText('line45');
    await page.keyboard.press('F7'); await expect(position).toHaveText('1 / 2');
    await page.keyboard.press('Shift+F7'); await expect(position).toHaveText('2 / 2');
    await view.getByRole('button', { name: '변경 부분만' }).click();
    await expect(view.locator('.cm-collapsedLines')).toHaveCount(0); await expect(view.getByRole('button', { name: '변경 부분만' })).toHaveAttribute('aria-pressed', 'false');
    await view.getByRole('button', { name: '변경 부분만' }).click();

    // The same comparison inline, remembered for the next diff.
    await view.getByRole('button', { name: '한 화면' }).click();
    await expect(view.locator('.cm-mergeView')).toHaveCount(0);
    await expect(view.locator('.cm-deletedChunk').first()).toContainText('export const line10 = 10;');
    await expect(view.locator('.cm-content')).toContainText('export const line10 = "changed";');
    await page.screenshot({ path: `${output}/unified-dark.png` });

    // Staged and working versions of one file stay separate tabs.
    await staged.getByRole('button', { name: 'staged.txt · 수정됨' }).click();
    await expect(editor.getByRole('tab', { name: 'staged.txt · 스테이징 비교' })).toHaveAttribute('aria-selected', 'true');
    await expect(view.locator('.cm-deletedChunk')).toContainText('before'); await expect(view.locator('.cm-content')).toContainText('staged');
    await view.getByRole('button', { name: '나란히' }).click();
    await working.getByRole('button', { name: 'staged.txt · 수정됨' }).click();
    await expect(editor.getByRole('tab', { name: 'staged.txt · 작업 중 비교' })).toHaveAttribute('aria-selected', 'true');
    await expect(view.locator('.cm-merge-a .cm-content')).toHaveText('staged'); await expect(view.locator('.cm-merge-b .cm-content')).toHaveText('staged and working content');

    // Rename, deletion, new file and binary content.
    await staged.getByRole('button', { name: '새 이름.txt · 이름 변경' }).click();
    await expect(view.locator('.diff-sides')).toContainText('이전 이름.txt'); await expect(editor.locator('.editor-breadcrumb')).toHaveText('이전 이름.txt → 새 이름.txt');
    await expect(position).toHaveText('내용 차이 없음');
    await working.getByRole('button', { name: 'deleted.txt · 삭제됨' }).click();
    await expect(view.locator('.diff-sides')).toContainText('작업 폴더 · 현재 파일 · 파일 없음'); await expect(view.locator('.cm-merge-a .cm-content')).toContainText('delete me');
    await expect(editor.getByRole('button', { name: '파일 열기' })).toHaveCount(0);
    await explorer.getByRole('button', { name: '새 파일.txt · 새 파일', exact: false }).click();
    await expect(view.locator('.diff-sides')).toContainText('스테이징 · 파일 없음'); await expect(view.locator('.cm-merge-b .cm-content')).toContainText('안녕하세요');
    assert.equal(await page.evaluate(() => (window as any).gitDiffExecuted), undefined);
    await explorer.getByRole('button', { name: 'image.bin · 새 파일', exact: false }).click();
    await expect(editor.locator('.editor-notice')).toContainText('바이너리'); await expect(view).toHaveCount(0);

    // Background refresh picks up a new edit; "파일 열기" opens the editable file.
    await working.getByRole('button', { name: 'src/long.ts · 수정됨' }).click();
    await writeFile(path.join(repository, 'src', 'long.ts'), lines(60, index => index === 9 ? 'export const line10 = "edited again";' : undefined));
    await expect(view.locator('.cm-merge-b .cm-content')).toContainText('edited again', { timeout: 12000 }); await expect(position).toHaveText('1 / 1');
    await editor.getByRole('button', { name: '파일 열기' }).click();
    await expect(editor.getByRole('tab', { name: 'long.ts', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('.document-body:not([hidden]) .source-pane .cm-content')).toContainText('edited again');
    await expect(editor.getByRole('button', { name: '파일 저장' })).toBeVisible();

    // Light theme and a phone-width viewport.
    await editor.getByRole('tab', { name: 'long.ts · 작업 중 비교' }).click();
    await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('button', { name: '밝게', exact: true }).click(); await page.getByRole('button', { name: '설정 닫기' }).click();
    await view.getByRole('button', { name: '나란히' }).click(); await expect(view.locator('.cm-mergeView')).toBeVisible();
    await page.screenshot({ path: `${output}/split-light.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await explorer.getByRole('button', { name: '파일 탐색기 닫기' }).click();
    await view.getByRole('button', { name: '한 화면' }).click(); await expect(view.locator('.cm-deletedChunk').first()).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: `${output}/unified-mobile.png` });
    assert.ok(requests.includes('git.diff'));
    assert.equal(host.getState().terminals.find(item => item.id === terminal.id)?.pid, terminal.pid);
    assert.deepEqual(errors, []);
    await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, realGit: true, realHost: true, desktopBridge: 'test binding', scenarios: ['working diff side by side', 'collapsed unchanged lines', 'next/previous and F7 navigation', 'inline layout', 'staged vs working tabs', 'rename', 'deleted file', 'new file without script execution', 'binary notice', 'background refresh', 'open editable file', 'light theme', '390px viewport'], errors }, null, 2));
  } finally {
    host.disconnect(ctx.id); await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

