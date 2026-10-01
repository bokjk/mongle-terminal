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
import type { ConnectionContext, GitListing, TerminalInfo } from '../../packages/protocol';
import { git, gitFixture } from '../helpers/git';

test('Git switch, tree decorations, grouped changes, refresh, stale responses and old-host compatibility with real Git and live shells', { skip: process.platform !== 'win32' || !existsSync('dist/web/index.html'), timeout: 90000 }, async t => {
  const fixture = await gitFixture(), repository = await realpath(fixture.repository);
  const plain = path.join(fixture.root, 'plain'); await mkdir(plain); await writeFile(path.join(plain, 'plain.txt'), 'plain file');
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 2;\n');
  await writeFile(path.join(repository, 'staged.txt'), 'staged\n'); await git(repository, 'add', '--', 'staged.txt'); await writeFile(path.join(repository, 'staged.txt'), 'staged and working content\n');
  await writeFile(path.join(repository, 'added.txt'), 'new staged'); await git(repository, 'add', '--', 'added.txt');
  await unlink(path.join(repository, 'deleted.txt')); await git(repository, 'mv', '--', '이전 이름.txt', '새 이름.txt');
  await git(repository, 'rm', '--', 'README.md'); await writeFile(path.join(repository, 'README.md'), 'recreated current file\n');
  await writeFile(path.join(repository, '새 파일.txt'), '<script>window.gitPreviewExecuted=true</script>\n안녕하세요');
  for (const folder of ['one', 'two', 'three']) { await mkdir(path.join(repository, folder)); await writeFile(path.join(repository, folder, 'nested.txt'), folder); }
  const host = new HostCore({ dataDir: fixture.data, name: 'Git UI 검증 PC' }); await host.init();
  t.after(async () => { await host.close(); assert.equal(path.dirname(fixture.root), tmpdir()); await rm(fixture.root, { recursive: true, force: true }); });
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'git-ui', deviceName: '검증 브라우저', owner: true }; host.connect(ctx, () => {});
  const groupId = host.getState().groups[0].id;
  const first: TerminalInfo = await host.handle('terminals.create', { groupId, profileId: 'cmd', cwd: repository }, ctx);
  const second: TerminalInfo = await host.handle('terminals.create', { groupId, profileId: 'cmd', cwd: plain }, ctx);
  await host.handle('terminals.rename', { id: first.id, title: 'Git 프로젝트' }, ctx); await host.handle('terminals.rename', { id: second.id, title: '일반 폴더' }, ctx);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors: string[] = [], requests: string[] = [], rpcErrors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const server = createServer(async (request, response) => {
    try { const file = path.resolve('dist/web', (request.url === '/' ? '/index.html' : request.url!).slice(1)); if (!file.startsWith(path.resolve('dist/web') + path.sep)) throw new Error(); response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let delayGit = false, releaseDelayed: (() => void) | undefined, oldHost = false;
  const compatible = (value: any) => oldHost && value?.capabilities ? { ...value, capabilities: value.capabilities.filter((capability: string) => capability !== 'git.read') } : value;
  await page.exposeBinding('hostRequest', async (_source, method: string, params: any) => {
    requests.push(method);
    try {
      const result = await host.handle(method, params, ctx);
      if (method === 'git.status' && params.root === repository && delayGit) { delayGit = false; await new Promise<void>(resolve => { releaseDelayed = resolve; }); }
      return compatible(result);
    } catch (error) { rpcErrors.push((error as Error).message); throw error; }
  });
  host.disconnect(ctx.id); host.connect(ctx, event => { void page.evaluate(event => (window as any).__listeners?.forEach((listener: any) => listener(event)), event.type === 'state' ? { ...event, state: compatible(event.state) } : event).catch(() => {}); });
  await page.addInitScript('window.__name = function(fn) { return fn; };');
  await page.addInitScript(({ connectionId }) => {
    const listeners = new Set(); (window as any).__listeners = listeners;
    (window as any).mongle = { request: (method: string, params: any) => (window as any).hostRequest(method, params), subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, onConnection: (fn: any) => { fn({ status: 'connected', owner: true, connectionId }); return () => {}; }, listHosts: async () => [{ id: 'local', name: '검증 PC', local: true, selected: true }] };
  }, { connectionId: ctx.id });
  const output = 'test-results/git-explorer'; await mkdir(output, { recursive: true });
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    const paneA = page.locator(`[data-terminal-id="${first.id}"]`), paneB = page.locator(`[data-terminal-id="${second.id}"]`);
    await paneA.locator('textarea').focus(); await page.getByRole('button', { name: '파일 탐색기', exact: true }).click();
    const explorer = page.getByRole('complementary', { name: '파일 탐색기' }), filesTab = explorer.getByRole('tab', { name: '파일', exact: true }), gitTab = explorer.getByRole('tab', { name: /^Git/ });
    const count = (await host.handle('git.status', { id: first.id, hostId: host.getState().hostId, bootId: host.getState().bootId, generation: first.generation, root: repository }, ctx) as Extract<GitListing, { state: 'repository' }>).changes.length;
    await expect(gitTab.locator('.git-count')).toHaveText(String(count));
    await expect(explorer.getByRole('button', { name: 'added.txt', exact: true })).toHaveAccessibleDescription('추가됨');
    await expect(explorer.getByRole('button', { name: '새 이름.txt', exact: true })).toHaveAccessibleDescription('이름 변경');
    await expect(explorer.getByRole('button', { name: 'src', exact: true })).toHaveAccessibleDescription('변경된 파일 포함');
    for (const folder of ['src', 'one', 'two', 'three']) await explorer.getByRole('button', { name: folder, exact: true }).click();
    await expect(explorer.getByRole('button', { name: 'modified.ts', exact: true })).toHaveAccessibleDescription('수정됨');
    await page.screenshot({ path: `${output}/files-dark.png` });
    await filesTab.focus(); await page.keyboard.press('ArrowRight'); await expect(gitTab).toHaveAttribute('aria-selected', 'true');
    const staged = explorer.getByRole('region', { name: '스테이징됨', exact: true }), working = explorer.getByRole('region', { name: '작업 폴더 변경', exact: true });
    await expect(staged.getByRole('button', { name: 'staged.txt · 수정됨' })).toBeVisible(); await expect(working.getByRole('button', { name: 'staged.txt · 수정됨' })).toBeVisible();
    await staged.getByRole('button', { name: 'staged.txt · 수정됨' }).click(); await expect(explorer.locator('pre')).toHaveText('staged and working content\n');
    await expect(staged.getByRole('button', { name: 'README.md · 삭제됨' })).toBeVisible();
    await expect(explorer.getByRole('region', { name: '새 파일', exact: true }).getByRole('button', { name: 'README.md · 새 파일', exact: false })).toBeVisible();
    await staged.getByRole('button', { name: 'README.md · 삭제됨' }).click(); await expect(explorer.locator('pre')).toHaveText('recreated current file\n');
    await explorer.getByRole('button', { name: '미리보기 닫기' }).click();
    await explorer.getByRole('button', { name: '새 파일.txt · 새 파일', exact: false }).click(); await expect(explorer.locator('pre')).toContainText('안녕하세요'); assert.equal(await page.evaluate(() => (window as any).gitPreviewExecuted), undefined);
    await explorer.getByRole('button', { name: 'deleted.txt · 삭제됨' }).click(); await expect(explorer.getByRole('alert')).toContainText('삭제된 파일');
    await explorer.getByRole('button', { name: '미리보기 닫기' }).click();
    await page.screenshot({ path: `${output}/git-dark.png` });
    await filesTab.click();
    await writeFile(path.join(repository, 'one', 'fresh.txt'), 'refresh');
    await expect(explorer.getByRole('button', { name: 'fresh.txt', exact: true })).toBeVisible({ timeout: 12000 });
    for (const folder of ['src', 'one', 'two', 'three']) await expect(explorer.getByRole('button', { name: folder, exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(explorer.getByRole('alert')).toHaveCount(0); assert.ok(!rpcErrors.some(error => error.includes('파일을 읽는 중')));
    await gitTab.click();
    delayGit = true; await explorer.getByRole('button', { name: '새로고침', exact: true }).click(); await expect.poll(() => Boolean(releaseDelayed)).toBe(true);
    await paneB.locator('textarea').focus(); await expect(explorer.getByText('이 폴더는 Git 저장소가 아닙니다.', { exact: true })).toBeVisible();
    releaseDelayed!(); await expect(explorer.locator('.git-repository')).toHaveCount(0);
    await paneA.locator('textarea').focus(); await expect(explorer.locator('.git-repository')).toContainText('main');
    await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('button', { name: '밝게', exact: true }).click(); await page.getByRole('button', { name: '설정 닫기' }).click();
    const contrast = await explorer.locator('.git-change-row').evaluateAll(rows => {
      const luminance = (color: string) => { const channels = color.match(/\d+/g)!.slice(0, 3).map(Number).map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }); return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722; };
      const background = luminance(getComputedStyle(document.querySelector('.file-explorer')!).backgroundColor);
      return rows.map(row => { const foreground = luminance(getComputedStyle(row.querySelector('.git-file-name')!).color); return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05); });
    });
    assert.ok(contrast.every(ratio => ratio >= 4.5), JSON.stringify(contrast));
    await page.screenshot({ path: `${output}/git-light.png` });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(explorer).toBeVisible(); assert.ok((await explorer.boundingBox())!.width <= 390);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: `${output}/git-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    const gitRequests = requests.filter(method => method === 'git.status').length; oldHost = true; await page.reload();
    await expect(page.getByRole('complementary', { name: '파일 탐색기' }).getByRole('tab', { name: /^Git/ })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: '파일 탐색기' }).getByRole('tab', { name: '파일', exact: true })).toHaveAttribute('aria-selected', 'true');
    assert.equal(requests.filter(method => method === 'git.status').length, gitRequests);
    assert.equal(host.getState().terminals.find(terminal => terminal.id === first.id)?.pid, first.pid); assert.equal(host.getState().terminals.find(terminal => terminal.id === second.id)?.pid, second.pid);
    assert.deepEqual(errors, []);
    await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, realGit: true, realHost: true, desktopBridge: 'test binding', scenarios: ['file/git keyboard switch', 'tree colors and folder dots', 'staged and working copies', 'read-only previews and deleted files', 'automatic refresh preserves expanded folders', 'late result after terminal switch', 'light contrast >=4.5', '390px viewport', 'old-host capability fallback', 'live shell PID preservation'], contrast, errors }, null, 2));
  } finally { releaseDelayed?.(); host.disconnect(ctx.id); }
});
