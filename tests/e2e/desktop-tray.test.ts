import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc/index.ts';
import type { HostState, SnapshotEvent } from '../../packages/protocol/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_TRAY === '1';
const executable = path.resolve(process.env.MONGLE_E2E_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'));
const packaged = Boolean(process.env.MONGLE_E2E_EXE);
const report = process.env.MONGLE_E2E_REPORT || 'tray';
if (!/^[a-z0-9-]+$/.test(report)) throw new Error('MONGLE_E2E_REPORT must be a simple directory label.');
const output = path.join(root, 'test-results/e2e', report);

async function until<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    try { const value = await fn(); if (predicate(value)) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}: timed out${lastError ? ` (${String(lastError)})` : ''}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
type TrayAction = 'inspect' | 'click' | 'double-click' | 'menu-open' | 'menu-quit' | 'app-menu-quit';

// Inspect real production objects via the already-authorized main-process debugger.
// No product exports, extra IPC handlers, constructor replacements or mocks are used.
async function trayAction(application: ElectronApplication, action: TrayAction) {
  return application.evaluate(async (electron, selectedAction) => {
    const inspector = process.getBuiltinModule('node:inspector/promises') as typeof import('node:inspector/promises');
    const session = new inspector.Session();
    const temporary = '__mongleTrayE2E';
    const globals = globalThis as unknown as Record<string, unknown>;
    if (temporary in globals) throw new Error('Unexpected existing tray test reference');
    globals[temporary] = { Tray: electron.Tray, Menu: electron.Menu, BrowserWindow: electron.BrowserWindow };
    session.connect();
    const post = session.post.bind(session) as (method: string, params: object) => Promise<any>;
    try {
      const trayPrototype = await post('Runtime.evaluate', { expression: 'globalThis.__mongleTrayE2E.Tray.prototype', objectGroup: 'mongle-tray-e2e' });
      const trays = await post('Runtime.queryObjects', { prototypeObjectId: trayPrototype.result.objectId, objectGroup: 'mongle-tray-e2e' });
      const menuPrototype = await post('Runtime.evaluate', { expression: 'globalThis.__mongleTrayE2E.Menu.prototype', objectGroup: 'mongle-tray-e2e' });
      const menus = await post('Runtime.queryObjects', { prototypeObjectId: menuPrototype.result.objectId, objectGroup: 'mongle-tray-e2e' });
      const response = await post('Runtime.callFunctionOn', {
        objectId: trays.objects.objectId,
        arguments: [{ value: selectedAction }, { objectId: menus.objects.objectId }],
        returnByValue: true,
        functionDeclaration: `function(action, allMenus) {
          const trays = this.filter(value => { try { return !value.isDestroyed(); } catch { return false; } });
          if (trays.length !== 1) throw new Error('Expected exactly one live Tray, found ' + trays.length);
          const tray = trays[0];
          const candidates = allMenus.filter(menu => { try { return menu.items[0]?.label === '몽글터미널 열기' && menu.items[1]?.type === 'separator' && menu.items.some(item => item.label === '앱 종료 · 터미널 유지'); } catch { return false; } });
          if (candidates.length !== 1) throw new Error('Expected exactly one tray menu, found ' + candidates.length);
          const menu = candidates[0];
          const focused = globalThis.__mongleTrayE2E.BrowserWindow.getFocusedWindow();
          const info = { trayCount: trays.length, bounds: tray.getBounds(), destroyed: tray.isDestroyed(), clickListeners: tray.listenerCount('click'), doubleClickListeners: tray.listenerCount('double-click'), menuLabels: menu.items.map(item => item.label) };
          if (action === 'click' || action === 'double-click') {
            if (!tray.listenerCount(action)) throw new Error('Missing tray listener ' + action);
            tray.emit(action, {}, tray.getBounds(), { x: 0, y: 0 });
          } else if (action === 'menu-open' || action === 'menu-quit') {
            const item = menu.items.find(item => item.label.includes(action === 'menu-open' ? '열기' : '앱 종료'));
            if (typeof item?.click !== 'function') throw new Error('Missing tray menu callback');
            if (action === 'menu-quit') setTimeout(() => item.click({}, focused, focused?.webContents), 50);
            else item.click({}, focused, focused?.webContents);
          } else if (action === 'app-menu-quit') {
            const items = globalThis.__mongleTrayE2E.Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []);
            const item = items.find(item => item.label.includes('앱 종료'));
            if (typeof item?.click !== 'function') throw new Error('Missing application quit callback');
            setTimeout(() => item.click({}, focused, focused?.webContents), 50);
          }
          return info;
        }`,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value as { trayCount: number; bounds: { x: number; y: number; width: number; height: number }; destroyed: boolean; clickListeners: number; doubleClickListeners: number; menuLabels: string[] };
    } finally {
      await post('Runtime.releaseObjectGroup', { objectGroup: 'mongle-tray-e2e' }).catch(() => {});
      session.disconnect();
      delete globals[temporary];
    }
  }, action);
}

async function windowState(application: ElectronApplication) {
  return application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), destroyed: window.isDestroyed() })));
}

test('real packaged tray: hide, restore, single instance, GUI quit and live shell resume', { skip: enabled ? false : 'Set MONGLE_E2E_TRAY=1 with a built tray package on Windows.', timeout: 180000 }, async () => {
  await mkdir(output, { recursive: true });
  const parent = path.resolve(process.env.MONGLE_E2E_DATA_ROOT || path.join(os.tmpdir(), 'mongle-tray-e2e'));
  await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'desktop-tray-'));
  assert.equal(path.dirname(dataDir), parent);
  const buildRoot = packaged ? path.join(path.dirname(executable), 'resources/hostbundle') : root;
  if (packaged) process.env.MONGLE_OWNER_HELPER = path.join(buildRoot, 'platform/windows/OwnerPipe.exe');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.MONGLE_DATA_DIR = dataDir;
  const args = packaged ? [] : [root];
  const steps: string[] = [];
  const logs: Array<{ type: string; text: string }> = [];
  const snapshots: Record<string, unknown> = {};
  let result: Record<string, unknown> = { startedAt: new Date().toISOString(), executable, dataDir, passed: false };
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  let secondary: ChildProcess | undefined;
  let hostPid: number | undefined;
  let shellPids: number[] = [];
  const state = () => owner!.request<HostState>('state.get');
  const start = async () => {
    application = await _electron.launch({ executablePath: executable, args, cwd: root, env, timeout: 30000 });
    application.process().stderr?.on('data', chunk => logs.push({ type: 'stderr', text: String(chunk) }));
    page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => logs.push({ type: 'pageerror', text: error.message }));
    await expect(page.getByRole('button', { name: '새 그룹', exact: true })).toBeEnabled({ timeout: 30000 });
  };
  const command = async (line: string) => { await page!.locator('textarea.xterm-helper-textarea').first().focus(); await page!.keyboard.type(line, { delay: 5 }); await page!.keyboard.press('Enter'); };
  const assertOutput = async (id: string, text: string) => until(async () => {
    const current = await state(); const terminal = current.terminals.find(item => item.id === id)!;
    const ref = { id, hostId: current.hostId, bootId: current.bootId, generation: terminal.generation };
    const snapshot = await owner!.request<SnapshotEvent>('terminals.attach', ref);
    await owner!.request('terminal.ack', { ...ref, seq: snapshot.seq });
    return snapshot.snapshot.data;
  }, value => value.includes(text), text);
  const hide = async () => {
    await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    return until(() => windowState(application!), windows => windows.length === 1 && !windows[0].visible && !windows[0].destroyed, 'close preserves a hidden window');
  };
  const assertVisible = async () => until(() => windowState(application!), windows => windows.length === 1 && windows[0].visible && !windows[0].minimized && windows[0].focused, 'existing window restored and focused');
  try {
    result.buildSha256 = Object.fromEntries(await Promise.all([executable, packaged ? path.join(path.dirname(executable), 'resources/app.asar') : path.join(root, 'dist/desktop/main.cjs'), path.join(buildRoot, 'platform/windows/icon.ico'), path.join(buildRoot, 'dist/host/main.cjs')].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
    await start();
    const guiPid = application!.process().pid!;
    result.guiPid = guiPid;
    owner = await connectOwnerPipe({ dataDir });
    const initial = await state();
    const hostInfo = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    hostPid = hostInfo.pid;
    const profile = initial.profiles.find(item => item.kind === 'powershell'); assert.ok(profile);
    const icon = await application!.evaluate(({ nativeImage }, filename) => { const image = nativeImage.createFromPath(filename); return { empty: image.isEmpty(), size: image.getSize() }; }, path.join(buildRoot, 'platform/windows/icon.ico'));
    assert.equal(icon.empty, false);
    snapshots.iconSource = icon;
    const tray = await trayAction(application!, 'inspect');
    assert.equal(tray.trayCount, 1); assert.equal(tray.destroyed, false);
    assert.ok(tray.bounds.width > 0 && tray.bounds.height > 0, 'Native Windows tray reports an actual icon rectangle');
    assert.ok(tray.clickListeners > 0 && tray.doubleClickListeners > 0);
    snapshots.tray = tray;
    steps.push('one actual native Tray has nonzero screen bounds and its packaged source icon decodes to a nonempty image');
    await page!.getByRole('button', { name: '새 그룹', exact: true }).click();
    const dialog = page!.getByRole('dialog', { name: '새 작업 그룹' });
    await dialog.getByLabel('이름', { exact: true }).fill('트레이 검증');
    await dialog.getByRole('combobox').selectOption(profile.id);
    await page!.getByLabel('시작 폴더', { exact: true }).fill(root);
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await page!.getByRole('button', { name: '새 터미널', exact: true }).click();
    await page!.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page!.locator('.control-chip')).toContainText('여기서 제어 중');
    const before = await state(); const terminal = before.terminals[0]; shellPids = before.terminals.map(item => item.pid!);
    const identity = (current: HostState) => ({ bootId: current.bootId, terminals: current.terminals.map(item => ({ id: item.id, pid: item.pid, generation: item.generation })), groups: current.groups });
    const expected = identity(before);
    const marker = `TRAY_${Date.now()}`;
    await command(`$mongleTrayProof='${marker}'; Write-Output ('READY:'+$mongleTrayProof)`);
    await assertOutput(terminal.id, `READY:${marker}`);
    snapshots.before = { guiPid, hostPid, ...expected };
    snapshots.hidden = await hide();
    assert.ok(alive(guiPid) && alive(hostPid!)); assert.deepEqual(identity(await state()), expected);
    await trayAction(application!, 'click'); await assertVisible();
    await command("Write-Output ('CLICK:'+$mongleTrayProof)"); await assertOutput(terminal.id, `CLICK:${marker}`);
    await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await until(() => windowState(application!), windows => windows[0].minimized, 'window minimized');
    await trayAction(application!, 'double-click'); await assertVisible();
    await hide(); await trayAction(application!, 'menu-open'); await assertVisible();
    assert.deepEqual(identity(await state()), expected);
    steps.push('real close handler hides without destroying window; tray click, double-click and menu callbacks restore and focus the same live shell');

    const hiddenWindow = (await hide())[0];
    secondary = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    secondary.stderr?.on('data', chunk => logs.push({ type: 'second-instance-stderr', text: String(chunk) }));
    const secondPid = secondary.pid; assert.ok(secondPid);
    await until(async () => secondary!.exitCode, code => code !== null, 'second instance exits');
    assert.equal(secondary.exitCode, 0);
    snapshots.singleInstance = { secondPid, secondExitCode: secondary.exitCode, windows: await assertVisible() };
    assert.equal((await windowState(application!))[0].id, hiddenWindow.id);
    assert.equal(application!.process().pid, guiPid);
    assert.deepEqual(identity(await state()), expected);
    steps.push('a second actual executable invocation exits successfully and restores the original hidden window without another GUI or host');
    await page!.screenshot({ path: path.join(output, 'tray-restored.png'), fullPage: true });

    owner.close(); owner = undefined;
    const closed = application!.waitForEvent('close');
    await trayAction(application!, 'menu-quit'); await closed;
    application = undefined;
    await until(async () => alive(guiPid), value => !value, 'tray quit ends only the isolated GUI process');
    assert.ok(alive(hostPid!)); for (const pid of shellPids) assert.ok(alive(pid));
    await start(); owner = await connectOwnerPipe({ dataDir });
    assert.deepEqual(identity(await state()), expected);
    const afterInfo = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    assert.equal(afterInfo.pid, hostPid);
    await expect(page!.locator('.control-chip')).toContainText('여기서 제어 중');
    await command("Write-Output ('RESTARTED:'+$mongleTrayProof)"); await assertOutput(terminal.id, `RESTARTED:${marker}`);
    await page!.screenshot({ path: path.join(output, 'tray-restarted.png'), fullPage: true });
    snapshots.restarted = { guiPid: application!.process().pid, hostPid: afterInfo.pid, ...identity(await state()), tray: await trayAction(application!, 'inspect') };
    steps.push('tray quit closes the GUI while host and PowerShell remain alive with zero clients; restarting reuses the same host, shell generation and in-memory variable');
    const restartedGuiPid = application!.process().pid!;
    owner.close(); owner = undefined;
    const menuClosed = application!.waitForEvent('close');
    await trayAction(application!, 'app-menu-quit'); await menuClosed;
    application = undefined;
    await until(async () => alive(restartedGuiPid), value => !value, 'application menu quits the GUI');
    assert.ok(alive(hostPid!)); for (const pid of shellPids) assert.ok(alive(pid));
    steps.push('application menu quit also closes only the GUI and keeps the isolated host and shell alive');
    assert.equal(logs.filter(item => item.type === 'pageerror').length, 0);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'tray-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await application?.close().catch(() => {});
    if (secondary && secondary.exitCode === null) secondary.kill();
    if (!owner) owner = await connectOwnerPipe({ dataDir }).catch(() => undefined);
    if (owner) { await owner.request('host.shutdown').catch(() => {}); owner.close(); }
    if (!hostPid) { try { hostPid = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')).pid; } catch {} }
    if (hostPid) await until(async () => !alive(hostPid!) && shellPids.every(pid => !alive(pid)), Boolean, 'isolated host and all test shells cleaned up', 10000).catch(error => { result.cleanupError = String(error); });
    result = { ...result, hostPid, shellPids, snapshots, steps, cleanedUp: !result.cleanupError, finishedAt: new Date().toISOString(), limitations: ['Tray events and menu callbacks are invoked on the real production objects through main-process debugging; physical clicks in the Windows notification area are not automated.', 'The packaged icon file is decoded and native Tray bounds are checked; Electron exposes no Tray image getter.'] };
    await writeFile(path.join(output, 'tray-result.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(output, 'tray-console.json'), JSON.stringify(logs, null, 2));
    assert.equal(result.cleanedUp, true, 'All processes owned by this isolated test must stop');
  }
});
