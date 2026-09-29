/** Capture the real UI with a disposable HostCore and explicitly labelled demo data.
 * Windows + Chrome + a built dist/web are required. Run: npx tsx scripts/capture-readme.ts
 * No user host, shell, profile, or Tailscale configuration is opened or changed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { HostCore } from '../packages/host/core.js';
import type { ConnectionContext } from '../packages/protocol/index.js';

assert.equal(process.platform, 'win32', 'This capture uses real Windows shells.');
assert.ok(existsSync('dist/web/index.html'), 'Run npm run build first.');
const root = path.resolve('.test-data/readme-demo');
await mkdir(root, { recursive: true });
const isolated = await mkdtemp(path.join(root, 'capture-'));
const workspace = path.join(isolated, 'workspace');
await mkdir(path.join(workspace, 'tests'), { recursive: true });
await mkdir(path.join(workspace, 'src'), { recursive: true });
const previousDataDir = process.env.MONGLE_DATA_DIR;
process.env.MONGLE_DATA_DIR = path.join(isolated, 'host');
const drive = ['X', 'Y', 'Z', 'W', 'V'].find(letter => !existsSync(`${letter}:\\`));
assert.ok(drive, 'A free temporary drive letter is required for anonymous demo paths.');
let driveMapped = false;
let browser: Browser | undefined;
const host = new HostCore({ dataDir: process.env.MONGLE_DATA_DIR, name: '작업용 PC' });
const contexts: ConnectionContext[] = [];
const errors: string[] = [];
const webRoot = path.resolve('dist/web');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const file = path.resolve(webRoot, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});

try {
  // This mapping contains only files created by this capture, never user data.
  execFileSync('subst.exe', [`${drive}:`, isolated], { windowsHide: true });
  driveMapped = true;
  const demoCwd = `${drive}:\\workspace`;
  await writeFile(path.join(workspace, 'src/workspace.mjs'), `// README demo: a tiny workspace model\n\nexport const workspace = {\n  name: 'Mongle project',\n  groups: ['Web', 'Tests', 'Notes'],\n  layout: 'split',\n};\n\nexport function addPanel(panels, title) {\n  return [...panels, { title }];\n}\n\nexport function renameGroup(group, name) {\n  return { ...group, name };\n}\n`);
  await writeFile(path.join(workspace, 'tests/workspace.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { addPanel, renameGroup } from '../src/workspace.mjs';\n\ntest('demo: add a panel', () => {\n  assert.equal(addPanel([], 'Web')[0].title, 'Web');\n});\ntest('demo: rename a group', () => {\n  assert.equal(renameGroup({ name: 'Old' }, 'Mongle').name, 'Mongle');\n});\n`);
  await writeFile(path.join(workspace, 'notes.txt'), `README DEMO / WORKSPACE NOTES\n\n  01  Keep each project in a group\n  02  Split panes to match your flow\n  03  Continue from your phone\n\n  Windows desktop + mobile browser\n  One host. Your own shell.\n\nThis is an isolated example workspace.\n`);
  await writeFile(path.join(workspace, 'demo.ps1'), `param([string]$View)\nSet-PSReadLineOption -HistorySaveStyle SaveNothing\nfunction global:prompt { 'PS demo> ' }\nClear-Host\nif ($View -eq 'web') {\n  Write-Host 'MONGLE / README DEMO' -ForegroundColor Cyan\n  Write-Host 'A small project, three focused panes.' -ForegroundColor DarkGray\n  Write-Host ''\n  Write-Host 'PS demo> Get-Content .\\src\\workspace.mjs' -ForegroundColor Green\n  Get-Content .\\src\\workspace.mjs\n  Write-Host ''\n  Write-Host 'Ready for your next command.' -ForegroundColor Cyan\n} elseif ($View -eq 'tests') {\n  Write-Host 'README DEMO / REAL SAMPLE TESTS' -ForegroundColor Cyan\n  Write-Host 'PS demo> node --test tests/workspace.test.mjs' -ForegroundColor Green\n  node --test tests/workspace.test.mjs\n} else {\n  Write-Host 'PS demo> Get-Content notes.txt' -ForegroundColor Green\n  Get-Content notes.txt\n}\n`);
  await host.init();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  async function openSurface(mobile: boolean) {
    const connection: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: mobile ? '데모 휴대폰' : '데모 데스크톱', owner: true };
    contexts.push(connection);
    const context = await browser!.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    let delivery = Promise.resolve();
    await page.exposeBinding('hostRequest', async (_source, method: string, params: unknown) => {
      const result = await host.handle(method, params, connection);
      await delivery;
      return result;
    });
    await page.addInitScript('window.__name = function (fn) { return fn; };');
    await page.addInitScript(() => {
      const listeners = new Set<any>();
      (window as any).__hostListeners = listeners;
      (window as any).mongle = {
        request: (method: string, params: unknown) => (window as any).hostRequest(method, params),
        subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
        onConnection: (fn: any) => { fn({ status: 'connected', owner: true }); return () => {}; },
        listHosts: async () => [{ id: 'demo', name: '작업용 PC', local: true, selected: true }],
        addHost: async () => {}, removeHost: async () => {}, selectHost: async () => ({ status: 'connected', owner: true }),
      };
    });
    host.connect(connection, event => {
      delivery = delivery.then(() => page.evaluate(value => { for (const listener of (window as any).__hostListeners || []) listener(value); }, event)).catch(() => {});
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('heading', { name: /기본 그룹|몽글 프로젝트/, exact: true }).waitFor();
    return page;
  }

  const desktop = await openSurface(false);
  await desktop.locator('summary[aria-label="기본 그룹 그룹 메뉴"]').click();
  await desktop.getByRole('button', { name: '그룹 설정', exact: true }).click();
  await desktop.getByLabel('이름', { exact: true }).fill('몽글 프로젝트');
  await desktop.getByLabel('시작 폴더', { exact: true }).fill(demoCwd);
  // Start cmd first, then PowerShell -NoProfile in that shell. This avoids
  // executing a developer's personal PowerShell startup script during capture.
  await desktop.getByRole('dialog').locator('select').selectOption('cmd');
  await desktop.getByRole('button', { name: '저장', exact: true }).click();
  await desktop.getByRole('button', { name: '설정', exact: true }).first().click();
  await desktop.getByRole('button', { name: '어둡게', exact: true }).click();
  await desktop.getByLabel('터미널 글자 크기', { exact: true }).selectOption('15');
  await desktop.getByRole('button', { name: '설정 닫기' }).click();

  async function makePane(title: string, split?: { index: number; axis: '좌우 분할' | '상하 분할' }) {
    if (split) await desktop.locator('.pane').nth(split.index).getByRole('button', { name: split.axis, exact: true }).click();
    else await desktop.getByRole('button', { name: '새 터미널', exact: true }).click();
    await desktop.getByRole('button', { name: '터미널 열기', exact: true }).click();
    const pane = desktop.locator('.pane').last();
    await pane.getByText('여기서 제어 중', { exact: true }).waitFor();
    await pane.locator('.pane-title').dblclick();
    await desktop.getByLabel('이름', { exact: true }).fill(title);
    await desktop.getByRole('button', { name: '저장', exact: true }).click();
  }
  await makePane('웹 · PowerShell');
  await makePane('테스트', { index: 0, axis: '좌우 분할' });
  await makePane('작업 노트', { index: 1, axis: '상하 분할' });
  const divider = desktop.getByRole('separator', { name: '좌우 분할 크기', exact: true });
  await divider.focus();
  await desktop.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '55');
  await desktop.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '60');

  const powershell = host.getState().profiles.find(profile => profile.kind === 'powershell');
  assert.ok(powershell);
  async function renderDemo(page: Page, index: number, view: string, initial = true) {
    const pane = page.locator('.pane').nth(index);
    await pane.locator('.xterm-screen').click();
    await pane.getByText('여기서 제어 중', { exact: true }).waitFor();
    await pane.locator('.xterm-helper-textarea').focus();
    const command = initial ? `"${powershell!.executable}" -NoLogo -NoProfile -NoExit -File .\\demo.ps1 ${view}` : `.\\demo.ps1 ${view}`;
    await page.keyboard.insertText(command);
    await page.keyboard.press('Enter');
    const marker = view === 'web' ? 'Ready for your next command.' : view === 'tests' ? 'fail 0' : 'This is an isolated example workspace.';
    await expect.poll(() => pane.locator('.xterm-rows').textContent(), { timeout: 20_000 }).toContain(marker);
  }
  await renderDemo(desktop, 0, 'web');
  await renderDemo(desktop, 1, 'tests');
  await renderDemo(desktop, 2, 'notes');
  for (const name of ['실험실', '개인 도구']) {
    await desktop.getByRole('button', { name: '새 그룹', exact: true }).click();
    await desktop.getByLabel('이름', { exact: true }).fill(name);
    await desktop.getByRole('button', { name: '저장', exact: true }).click();
    await desktop.getByRole('heading', { name, exact: true }).waitFor();
  }
  await desktop.getByRole('button', { name: '몽글 프로젝트 터미널 3개', exact: true }).click();
  await desktop.locator('.pane').first().getByText('여기서 제어 중', { exact: true }).waitFor();
  await desktop.locator('.pane').first().locator('.pane-title').click();
  await desktop.mouse.move(1400, 50);
  await desktop.evaluate(() => document.fonts.ready);
  await mkdir('docs/assets', { recursive: true });
  await desktop.screenshot({ path: 'docs/assets/desktop.png' });

  const mobile = await openSurface(true);
  await mobile.getByRole('button', { name: '설정', exact: true }).first().click();
  await mobile.getByRole('button', { name: '어둡게', exact: true }).click();
  await mobile.getByRole('dialog', { name: '설정', exact: true }).getByLabel('터미널 글자 크기', { exact: true }).selectOption('12');
  await mobile.getByRole('button', { name: '설정 닫기' }).click();
  await mobile.getByRole('button', { name: '터미널 전환', exact: true }).click();
  await mobile.locator('.panel-list .device-row').first().click();
  await renderDemo(mobile, 0, 'web', false);
  await mobile.evaluate(() => document.fonts.ready);
  assert.deepEqual(errors, []);
  for (const page of [desktop, mobile]) {
    const visibleText = await page.locator('body').innerText();
    assert.ok(!/C:\\Users\\|tail[\w-]*\.ts\.net|권한.*거부|Access.*denied/i.test(visibleText), 'Capture must not contain personal paths, real remote hosts, or shell errors');
  }
  await mobile.screenshot({ path: 'docs/assets/mobile.png' });
  console.log('Captured real UI: docs/assets/desktop.png (1440×900), docs/assets/mobile.png (390×844).');
  console.log('Three live shells; sample tests actually ran. No pixels or rendered app DOM edited.');
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) {
    await mkdir('test-results/readme-demo', { recursive: true });
    await page.screenshot({ path: 'test-results/readme-demo/failure.png' }).catch(() => {});
    console.error(await page.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  for (const context of contexts) host.disconnect(context.id);
  await browser?.close();
  await host.close();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  if (driveMapped) {
    const mappings = execFileSync('subst.exe', { encoding: 'utf8', windowsHide: true });
    assert.ok(mappings.split(/\r?\n/).some(line => line.toLowerCase().includes(`${drive!.toLowerCase()}:\\:`) && line.toLowerCase().endsWith(isolated.toLowerCase())), 'Only remove our own temporary drive mapping');
    execFileSync('subst.exe', [`${drive}:`, '/D'], { windowsHide: true });
  }
  assert.ok(path.resolve(isolated).startsWith(root + path.sep), 'Only remove the current capture data');
  await rm(isolated, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.MONGLE_DATA_DIR;
  else process.env.MONGLE_DATA_DIR = previousDataDir;
}
