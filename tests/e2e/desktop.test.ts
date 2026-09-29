import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { _electron, chromium, expect, type ElectronApplication, type Page, type Browser } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc/index.ts';
import type { HostState, SnapshotEvent, TerminalInfo } from '../../packages/protocol/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packagedExecutable = process.env.MONGLE_E2E_EXE ? path.resolve(process.env.MONGLE_E2E_EXE) : undefined;
const reportLabel = process.env.MONGLE_E2E_REPORT;
if (reportLabel && !/^[a-z0-9-]+$/.test(reportLabel)) throw new Error('MONGLE_E2E_REPORT must be a simple directory label.');
const output = path.join(root, 'test-results/e2e', ...(reportLabel ? [reportLabel] : packagedExecutable ? ['packaged'] : []));
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E === '1';

async function until<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T | undefined;
  let error: unknown;
  do {
    try { value = await fn(); if (predicate(value)) return value; } catch (caught) { error = caught; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}: timed out${error ? ` (${String(error)})` : ''}`);
}

test('real Electron + ConPTY: split, group, durable live session, authenticated mobile browser', { skip: enabled ? false : 'Set MONGLE_E2E=1 after npm run build on Windows.', timeout: 180000 }, async () => {
  await mkdir(output, { recursive: true });
  const dataParent = path.resolve(process.env.MONGLE_E2E_DATA_ROOT || path.join(root, '.test-data'));
  await mkdir(dataParent, { recursive: true });
  const dataDir = await mkdtemp(path.join(dataParent, 'desktop-e2e-'));
  if (packagedExecutable) process.env.MONGLE_OWNER_HELPER = path.join(path.dirname(packagedExecutable), 'resources/hostbundle/platform/windows/OwnerPipe.exe');
  assert.equal(path.dirname(dataDir), dataParent, 'Never use the user default data directory');
  const logs: Array<{ surface: string; type: string; text: string }> = [];
  const steps: string[] = [];
  const findings: string[] = [];
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let browser: Browser | undefined;
  let mobile: Page | undefined;
  let owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  let hostPid: number | undefined;
  let result: Record<string, unknown> = { dataDir, executable: packagedExecutable || 'development Electron', startedAt: new Date().toISOString(), passed: false };
  const logPage = (target: Page, surface: string) => {
    target.on('console', event => logs.push({ surface, type: event.type(), text: event.text() }));
    target.on('pageerror', error => logs.push({ surface, type: 'pageerror', text: error.message }));
  };
  const startApp = async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: packagedExecutable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packagedExecutable ? [] : [root], cwd: root, env: { ...env, MONGLE_DATA_DIR: dataDir }, timeout: 30000 });
    application.process().stderr?.on('data', data => logs.push({ surface: 'electron-process', type: 'stderr', text: String(data) }));
    page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    logPage(page, 'desktop');
    await expect(page.getByRole('button', { name: '새 그룹', exact: true })).toBeEnabled({ timeout: 30000 });
    return page;
  };
  const state = () => owner!.request<HostState>('state.get');
  const ref = (host: HostState, terminal: TerminalInfo) => ({ id: terminal.id, hostId: host.hostId, bootId: host.bootId, generation: terminal.generation });
  const outputContains = async (id: string, text: string) => until(async () => {
    const current = await state();
    const terminal = current.terminals.find(item => item.id === id)!;
    const snapshot = await owner!.request<SnapshotEvent>('terminals.attach', ref(current, terminal));
    await owner!.request('terminal.ack', { ...ref(current, terminal), seq: snapshot.seq });
    return snapshot.snapshot.data;
  }, value => value.includes(text), `terminal output contains ${text}`, 20000);
  const typeCommand = async (target: Page, index: number, command: string) => {
    const input = target.locator('.pane').nth(index).locator('textarea.xterm-helper-textarea');
    await input.focus();
    await target.keyboard.type(command, { delay: 10 });
    await target.keyboard.press('Enter');
  };
  try {
    const buildRoot = packagedExecutable ? path.join(path.dirname(packagedExecutable), 'resources/hostbundle') : root;
    if (packagedExecutable) {
      // A package inside the repository can silently resolve missing dependencies
      // from the workspace's ancestor node_modules. Such a package is not portable.
      for (const required of ['node_modules/node-pty/package.json', 'node_modules/node-pty/lib/index.js', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll', 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe']) {
        assert.ok(existsSync(path.join(buildRoot, required)), `Packaged dependency is missing: ${required}; ancestor workspace resolution is not a valid release.`);
      }
    }
    await startApp();
    const buildFiles = [path.join(buildRoot, 'dist/host/main.cjs'), path.join(buildRoot, 'dist/web/index.html'), path.join(buildRoot, 'platform/windows/OwnerPipe.exe'), packagedExecutable ? path.join(path.dirname(packagedExecutable), 'resources/app.asar') : path.join(root, 'dist/desktop/main.cjs')];
    for (const asset of await readdir(path.join(buildRoot, 'dist/web/assets'))) if (/\.(js|css)$/.test(asset)) buildFiles.push(path.join(buildRoot, 'dist/web/assets', asset));
    if (packagedExecutable) buildFiles.push(packagedExecutable, ...['node_modules/node-pty/package.json', 'node_modules/node-pty/lib/index.js', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node', 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll', 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe'].map(file => path.join(buildRoot, file)));
    result.buildSha256 = Object.fromEntries(await Promise.all(buildFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
    result.versions = await application!.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
    if (process.env.MONGLE_E2E_BRANDING === '1') {
      const brand = page!.locator('.sidebar-brand img');
      await expect(brand).toBeVisible();
      await expect.poll(() => brand.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
      const image = await brand.evaluate(element => { const image = element as HTMLImageElement; return { src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight }; });
      const shellIcon = await application!.evaluate(async ({ app }) => { const icon = await app.getFileIcon(process.execPath, { size: 'large' }); return { png: icon.toPNG().toString('base64'), size: icon.getSize(), appPath: app.getAppPath() }; });
      assert.ok(shellIcon.size.width > 0 && shellIcon.size.height > 0);
      await writeFile(path.join(output, 'executable-icon.png'), Buffer.from(shellIcon.png, 'base64'));
      await page!.screenshot({ path: path.join(output, 'desktop-branding.png'), fullPage: true });
      result.branding = { image, shellIconSize: shellIcon.size, appPath: shellIcon.appPath, limitation: 'The Windows shell file icon and loaded UI image are checked; the live taskbar icon is not inspected.' };
      steps.push('packaged sidebar brand image loaded and Windows shell executable icon captured');
    }
    owner = await connectOwnerPipe({ dataDir });
    const initial = await state();
    const hostInfo = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    hostPid = hostInfo.pid;
    assert.equal(initial.terminals.length, 0);
    const powershell = initial.profiles.find(profile => profile.kind === 'powershell');
    assert.ok(powershell, 'A real installed PowerShell profile is required');
    steps.push('fresh isolated GUI started an independent host through the production launcher');

    await page!.getByRole('button', { name: '새 그룹', exact: true }).click();
    await page!.getByRole('dialog', { name: '새 작업 그룹' }).getByLabel('이름', { exact: true }).fill('몽글 E2E 작업');
    await page!.getByRole('dialog', { name: '새 작업 그룹' }).getByRole('combobox').selectOption(powershell.id);
    await page!.getByLabel('시작 폴더', { exact: true }).fill(root);
    await page!.getByRole('button', { name: '저장', exact: true }).click();
    await page!.getByRole('button', { name: '새 터미널', exact: true }).click();
    await page!.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page!.locator('.pane')).toHaveCount(1);
    await expect(page!.locator('.control-chip')).toContainText('여기서 제어 중');
    let current = await state();
    const original = current.terminals[0];
    const groupId = original.groupId;
    const marker = `MONGLE_E2E_${Date.now()}`;
    await typeCommand(page!, 0, `$mongleProof='${marker}'; Write-Output ('READY:'+$mongleProof); Write-Output ('SHELLPID:'+$PID)`);
    await outputContains(original.id, `READY:${marker}`);
    await outputContains(original.id, `SHELLPID:${original.pid}`);
    steps.push('real PowerShell accepted typed variable assignment and returned its actual PID');

    await page!.getByRole('button', { name: '좌우 분할', exact: true }).click();
    await page!.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page!.locator('.pane')).toHaveCount(2);
    const separator = page!.getByRole('separator', { name: '좌우 분할 크기' });
    await separator.focus();
    await page!.keyboard.press('ArrowRight');
    await until(state, value => { const layout=value.groups.find(item=>item.id===groupId)?.layout;return layout?.type==='split'&&layout.ratio>.5; }, 'split ratio saved');
    await separator.dblclick();
    try {
      await until(state, value => { const layout=value.groups.find(item=>item.id===groupId)?.layout;return layout?.type==='split'&&layout.ratio===.5; }, 'split ratio equalized', 3000);
    } catch {
      findings.push('Double clicking the split separator did not restore ratio 0.5. Used keyboard Home to continue the remaining scenarios.');
      await separator.focus(); await page!.keyboard.press('Home');
      await until(state, value => { const layout=value.groups.find(item=>item.id===groupId)?.layout;return layout?.type==='split'&&layout.ratio===.5; }, 'keyboard equalize fallback');
    }
    await page!.locator('.pane').first().getByRole('button', { name: '최대화', exact: true }).click();
    await expect(page!.locator('.pane')).toHaveCount(1);
    await page!.getByRole('button', { name: '분할로 돌아가기', exact: true }).click();
    await expect(page!.locator('.pane')).toHaveCount(2);
    steps.push('created a second real shell with split; keyboard resize, maximize and restore passed; double-click equalize recorded separately if it failed');

    await page!.getByRole('button', { name: '새 그룹', exact: true }).click();
    await page!.getByRole('dialog', { name: '새 작업 그룹' }).getByLabel('이름', { exact: true }).fill('다른 그룹');
    await page!.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page!.getByRole('heading', { name: '다른 그룹', exact: true })).toBeVisible();
    await page!.locator('.group-main').filter({ hasText: '몽글 E2E 작업' }).click();
    await expect(page!.locator('.pane')).toHaveCount(2);
    await page!.screenshot({ path: path.join(output, 'desktop-split.png'), fullPage: true });
    steps.push('group switching preserves both existing terminal sessions');

    if (process.env.MONGLE_E2E_PANE_DRAG === '1') {
      const beforeDrag = await state();
      const other = beforeDrag.terminals.find(item => item.id !== original.id && item.groupId === groupId)!;
      const source = page!.locator(`.pane[data-terminal-id="${original.id}"] .pane-drag-handle`);
      const target = page!.locator(`.pane[data-terminal-id="${other.id}"]`);
      const from = await source.boundingBox(), to = await target.boundingBox(); assert.ok(from && to);
      await page!.mouse.move(from.x + from.width/2, from.y + from.height/2); await page!.mouse.down();
      await page!.mouse.move(from.x + from.width/2 + 12, from.y + from.height/2 + 12, { steps: 3 });
      await page!.mouse.move(to.x + to.width/2, to.y + to.height*.1, { steps: 10 });
      await page!.mouse.move(to.x + to.width/2 + 1, to.y + to.height*.1 + 1);
      await expect(target.locator('.pane-drop-preview[data-drop-position="top"]')).toBeVisible();
      await page!.mouse.up();
      await until(state, value => value.groups.find(item => item.id === groupId)?.layout?.type === 'split' && (value.groups.find(item => item.id === groupId)!.layout as {axis:string}).axis === 'vertical', 'packaged native drag commits vertical split');
      assert.deepEqual((await state()).terminals.map(item => ({ id:item.id, pid:item.pid, generation:item.generation })), beforeDrag.terminals.map(item => ({ id:item.id, pid:item.pid, generation:item.generation })));
      await typeCommand(page!, 0, "Write-Output ('PACKAGED_DRAG:'+$mongleProof)");
      await outputContains(original.id, `PACKAGED_DRAG:${marker}`);
      await page!.screenshot({ path: path.join(output, 'desktop-drag.png'), fullPage: true });
      steps.push('packaged Electron native mouse drag shows top preview, changes to vertical layout and preserves both shell identities and immediate live-variable input');
    }

    current = await state();
    const beforeClose = { hostPid, bootId: current.bootId, pids: current.terminals.map(item => ({ id: item.id, pid: item.pid, generation: item.generation })), layout: current.groups.find(item => item.id === groupId)!.layout };
    // Disconnect the test observer as well, so the host has zero attached clients.
    owner.close(); owner = undefined;
    await application!.close(); application = undefined;
    await new Promise(resolve => setTimeout(resolve, 500));
    process.kill(hostPid!, 0);
    await startApp();
    owner = await connectOwnerPipe({ dataDir });
    await expect(page!.locator('.pane')).toHaveCount(2);
    current = await state();
    const resumedInfo = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    assert.equal(resumedInfo.pid, beforeClose.hostPid);
    assert.equal(current.bootId, beforeClose.bootId);
    assert.deepEqual(current.terminals.map(item => ({ id: item.id, pid: item.pid, generation: item.generation })), beforeClose.pids);
    assert.deepEqual(current.groups.find(item => item.id === groupId)!.layout, beforeClose.layout);
    await expect(page!.locator('.pane').first().locator('.control-chip')).toContainText('여기서 제어 중');
    await typeCommand(page!, 0, "Write-Output ('RESUMED:'+$mongleProof)");
    await outputContains(original.id, `RESUMED:${marker}`);
    await page!.screenshot({ path: path.join(output, 'desktop-resumed.png'), fullPage: true });
    steps.push('closed and reopened GUI; host PID, shell PIDs, generation, layout and in-memory shell variable stayed identical');

    browser = await chromium.launch({ channel: existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'chrome' : undefined, headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    mobile = await context.newPage();
    mobile.setDefaultTimeout(15000);
    logPage(mobile, 'mobile-chromium');
    await mobile.goto(`http://127.0.0.1:${resumedInfo.port}`);
    await expect(mobile.getByRole('heading', { name: '이 기기를 연결하세요' })).toBeVisible();
    const pairCode = await owner.request<{ code: string }>('pairing.create');
    await mobile.getByLabel('이 기기의 이름').fill('E2E 모바일');
    await mobile.getByLabel('일회용 연결 코드').fill(pairCode.code);
    const requested = mobile.waitForResponse(response => response.url().endsWith('/v1/pairings/request') && response.request().method() === 'POST');
    await mobile.getByRole('button', { name: '연결 요청', exact: true }).click();
    const pending = await (await requested).json();
    assert.ok(pending.requestId);
    await owner.request('pairing.approve', { requestId: pending.requestId });
    await expect(mobile.locator('.status-bar')).toContainText('세션 연결됨');
    await mobile.getByRole('button', { name: '그룹 메뉴 열기', exact: true }).click();
    await mobile.locator('.group-main').filter({ hasText: '몽글 E2E 작업' }).click();
    await expect(mobile.locator('.pane')).toHaveCount(1, { timeout: 15000 });
    await expect(mobile.locator('.mobile-keys')).toBeVisible();
    assert.deepEqual((await state()).groups.find(item => item.id === groupId)!.layout, beforeClose.layout, 'Mobile viewing must not overwrite the desktop split tree');
    await mobile.locator('.control-chip').click();
    await expect(mobile.locator('.control-chip')).toContainText('여기서 제어 중');
    await until(state, value => value.terminals.find(item => item.id === original.id)?.controller?.deviceName === 'E2E 모바일', 'mobile obtained the controller lease');
    await typeCommand(mobile, 0, "Write-Output ('MOBILE:'+$mongleProof)");
    await outputContains(original.id, `MOBILE:${marker}`);
    await expect(page!.locator('.pane').first().locator('.control-chip')).toContainText('E2E 모바일에서 제어');
    await mobile.screenshot({ path: path.join(output, 'mobile-terminal.png'), fullPage: true });
    await mobile.locator('.mobile-panel-switcher').click();
    await expect(mobile.getByRole('dialog', { name: '터미널 전환' }).locator('.device-row')).toHaveCount(2);
    await mobile.screenshot({ path: path.join(output, 'mobile-panel-switcher.png'), fullPage: true });
    await mobile.getByRole('dialog', { name: '터미널 전환' }).locator('.device-row').nth(1).click();
    await expect(mobile.locator('.mobile-panel-switcher')).toContainText(/2\s*\/\s*2/);
    steps.push('real authenticated loopback web gateway paired a mobile viewport, transferred control, and resumed the same shell variable; single-pane switcher preserved the desktop layout');
    await mobile.reload();
    await expect(mobile.locator('.pane')).toHaveCount(1);
    await expect(mobile.locator('.status-bar')).toContainText('세션 연결됨');
    steps.push('authenticated browser reload reconnected without pairing again');

    assert.equal(logs.filter(entry => entry.type === 'pageerror').length, 0, 'No renderer JavaScript crashes');
    assert.deepEqual(findings, [], 'All end-to-end scenarios must pass without fallback');
    result = { ...result, passed: true, beforeClose, hostPid: resumedInfo.pid, steps, finishedAt: new Date().toISOString(), limitations: ['Mobile viewport is desktop Chromium emulation; physical iOS/Android keyboards and Tailscale network are not exercised.', 'Loopback gateway uses authenticated HTTP; deployed Tailscale Serve HTTPS is outside this test.'] };
  } catch (error) {
    if (page && !page.isClosed()) await writeFile(path.join(output, 'desktop-failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
    if (mobile && !mobile.isClosed()) await writeFile(path.join(output, 'mobile-failure.txt'), await mobile.locator('body').innerText().catch(() => 'Page unavailable'));
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'desktop-failure.png'), fullPage: true }).catch(() => {});
    if (mobile && !mobile.isClosed()) await mobile.screenshot({ path: path.join(output, 'mobile-failure.png'), fullPage: true }).catch(() => {});
    result = { ...result, error: error instanceof Error ? error.stack : String(error), steps, findings, finishedAt: new Date().toISOString() };
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await application?.close().catch(() => {});
    if (!owner) owner = await connectOwnerPipe({ dataDir }).catch(() => undefined);
    if (owner) { await owner.request('host.shutdown').catch(() => {}); owner.close(); }
    if (hostPid) await until(async () => { try { process.kill(hostPid!, 0); return false; } catch { return true; } }, value => value, 'isolated test host shut down', 10000).catch(error => { result.cleanupError = String(error); });
    result.cleanedUp = !result.cleanupError;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(output, 'console.json'), JSON.stringify(logs, null, 2));
  }
});
