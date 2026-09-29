import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc/index.ts';
import type { HostState, PresentationSnapshot, SnapshotEvent, TerminalInfo } from '../../packages/protocol/index.ts';
import type { PersistedHost } from '../../packages/storage/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_FULL_EXIT === '1';
const executable = path.resolve(process.env.MONGLE_E2E_EXE || path.join(root, 'node_modules/electron/dist/electron.exe'));
const packaged = Boolean(process.env.MONGLE_E2E_EXE);
const legacyHostEntry = process.env.MONGLE_E2E_LEGACY_HOST_ENTRY ? path.resolve(process.env.MONGLE_E2E_LEGACY_HOST_ENTRY) : undefined;
const report = process.env.MONGLE_E2E_REPORT || 'full-exit';
if (!/^[a-z0-9-]+$/.test(report)) throw new Error('MONGLE_E2E_REPORT must be a simple directory label.');
const output = path.join(root, 'test-results/e2e', report);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 20000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    try { const value = await fn(); if (predicate(value)) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label}: timed out${lastError ? ` (${String(lastError)})` : ''}`);
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (open: boolean) => { if (done) return; done = true; socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

// Read only the descendants of the isolated host. Do not expose unrelated
// command lines, stop unrelated processes or inspect the user's real data.
async function descendants(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const script = `$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $changed = $false; foreach ($row in $rows) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed = $true } } } while ($changed); @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.ProcessId -ne ${pid} }) | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
}

type DialogProof = { type?: string; title?: string; message?: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number };

async function installDialogInterceptor(application: ElectronApplication) {
  await application.evaluate(({ dialog }) => {
    const globals = globalThis as unknown as Record<string, any>;
    if (globals.__mongleFullExitDialog) throw new Error('Unexpected existing full-exit dialog interceptor');
    const capture: { calls: any[]; errors: any[]; resolve?: (result: any) => void } = { calls: [], errors: [] };
    globals.__mongleFullExitDialog = capture;
    // Native confirmation presentation alone is intercepted. Production Menu
    // callbacks, IPC authentication, host shutdown, storage and PTYs are real.
    (dialog.showMessageBox as any) = (...args: any[]) => {
      if (capture.resolve) throw new Error('Concurrent native dialogs');
      const options = args[args.length - 1];
      capture.calls.push({ type: options.type, title: options.title, message: options.message, detail: options.detail, buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId });
      return new Promise(resolve => { capture.resolve = resolve; });
    };
    dialog.showErrorBox = (title, content) => { capture.errors.push({ title, content }); };
  });
}

async function invokeMenu(application: ElectronApplication, surface: 'tray' | 'application') {
  return application.evaluate(async (electron, selectedSurface) => {
    const inspector = process.getBuiltinModule('node:inspector/promises') as typeof import('node:inspector/promises');
    const session = new inspector.Session();
    const globals = globalThis as unknown as Record<string, unknown>;
    if (globals.__mongleFullExitMenu) throw new Error('Unexpected existing full-exit menu reference');
    globals.__mongleFullExitMenu = { Tray: electron.Tray, Menu: electron.Menu, BrowserWindow: electron.BrowserWindow };
    session.connect();
    const post = session.post.bind(session) as (method: string, params: object) => Promise<any>;
    try {
      const trayPrototype = await post('Runtime.evaluate', { expression: 'globalThis.__mongleFullExitMenu.Tray.prototype', objectGroup: 'mongle-full-exit' });
      const trays = await post('Runtime.queryObjects', { prototypeObjectId: trayPrototype.result.objectId, objectGroup: 'mongle-full-exit' });
      const menuPrototype = await post('Runtime.evaluate', { expression: 'globalThis.__mongleFullExitMenu.Menu.prototype', objectGroup: 'mongle-full-exit' });
      const menus = await post('Runtime.queryObjects', { prototypeObjectId: menuPrototype.result.objectId, objectGroup: 'mongle-full-exit' });
      const response = await post('Runtime.callFunctionOn', {
        objectId: trays.objects.objectId,
        arguments: [{ value: selectedSurface }, { objectId: menus.objects.objectId }], returnByValue: true,
        functionDeclaration: `function(surface, allMenus) {
          const liveTrays = this.filter(value => { try { return !value.isDestroyed(); } catch { return false; } });
          if (liveTrays.length !== 1) throw new Error('Expected exactly one live Tray');
          const trayMenus = allMenus.filter(menu => { try { return menu.items[0]?.label === '몽글터미널 열기' && menu.items.some(item => item.label === '완전 종료…'); } catch { return false; } });
          if (trayMenus.length !== 1) throw new Error('Expected exactly one full-exit tray menu');
          const appItems = globalThis.__mongleFullExitMenu.Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []);
          const appExit = appItems.find(item => item.label === '완전 종료…');
          const trayExit = trayMenus[0].items.find(item => item.label === '완전 종료…');
          if (typeof appExit?.click !== 'function' || typeof trayExit?.click !== 'function') throw new Error('Both full-exit menu callbacks must exist');
          if (!appExit.enabled || !trayExit.enabled) throw new Error('Full-exit menu unexpectedly disabled');
          const item = surface === 'tray' ? trayExit : appExit;
          const focused = globalThis.__mongleFullExitMenu.BrowserWindow.getFocusedWindow();
          setTimeout(() => item.click({}, focused, focused?.webContents), 25);
          return { trayCount: liveTrays.length, trayBounds: liveTrays[0].getBounds(), trayLabels: trayMenus[0].items.map(item => item.label), applicationLabels: appItems.map(item => item.label), invoked: surface };
        }`,
      });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    } finally {
      await post('Runtime.releaseObjectGroup', { objectGroup: 'mongle-full-exit' }).catch(() => {});
      session.disconnect(); delete globals.__mongleFullExitMenu;
    }
  }, surface);
}

async function pendingDialog(application: ElectronApplication, count: number): Promise<DialogProof> {
  return until(async () => {
    const status = await application.evaluate(() => {
      const capture = (globalThis as any).__mongleFullExitDialog;
      return { calls: capture.calls, errors: capture.errors, pending: Boolean(capture.resolve) };
    });
    assert.deepEqual(status.errors, [], 'Production full-exit must not show an error dialog');
    return status;
  }, value => value.calls.length === count && value.pending, 'native confirmation requested').then(value => value.calls[count - 1]);
}

async function answerDialog(application: ElectronApplication, response: 0 | 1) {
  await application.evaluate((_, selectedResponse) => {
    const capture = (globalThis as any).__mongleFullExitDialog;
    if (!capture.resolve) throw new Error('No pending native confirmation');
    const resolve = capture.resolve; capture.resolve = undefined;
    setTimeout(() => resolve({ response: selectedResponse, checkboxChecked: false }), 25);
  }, response);
}

test('real packaged full exit: cancel, durable shutdown and automatic workspace restoration', { skip: enabled ? false : 'Set MONGLE_E2E_FULL_EXIT=1 with a built package on Windows.', timeout: 180000 }, async () => {
  await mkdir(output, { recursive: true });
  const parent = path.resolve(process.env.MONGLE_E2E_DATA_ROOT || path.join(os.tmpdir(), 'mongle-full-exit-e2e'));
  await mkdir(parent, { recursive: true });
  const dataDir = await mkdtemp(path.join(parent, 'desktop-full-exit-'));
  assert.equal(path.dirname(dataDir), parent, 'Always use unique isolated data, never the user default data directory');
  const buildRoot = packaged ? path.join(path.dirname(executable), 'resources/hostbundle') : root;
  if (packaged) process.env.MONGLE_OWNER_HELPER = path.join(buildRoot, 'platform/windows/OwnerPipe.exe');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; env.MONGLE_DATA_DIR = dataDir;
  const args = packaged ? [] : [root];
  const steps: string[] = [];
  const snapshots: Record<string, unknown> = {};
  const logs: Array<{ type: string; text: string }> = [];
  const hostPids = new Set<number>(), shellPids = new Set<number>(), guiPids = new Set<number>();
  let application: ElectronApplication | undefined, page: Page | undefined;
  let owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  let legacyTarget: string | undefined, upgradedHostBytes: Buffer | undefined;
  let result: Record<string, unknown> = { startedAt: new Date().toISOString(), executable, dataDir, passed: false };
  const state = () => owner!.request<HostState>('state.get');
  const ref = (current: HostState, terminal: TerminalInfo) => ({ id: terminal.id, hostId: current.hostId, bootId: current.bootId, generation: terminal.generation });
  const snapshot = async (id: string) => {
    const current = await state(), terminal = current.terminals.find(item => item.id === id)!;
    const frame = await owner!.request<SnapshotEvent>('terminals.attach', ref(current, terminal));
    await owner!.request('terminal.ack', { ...ref(current, terminal), seq: frame.seq });
    return frame.snapshot;
  };
  const command = async (id: string, line: string) => {
    const pane = page!.locator(`.pane[data-terminal-id="${id}"]`);
    await expect(pane.locator('.control-chip')).toContainText('여기서 제어 중');
    await pane.locator('textarea.xterm-helper-textarea').focus();
    await page!.keyboard.type(line, { delay: 5 }); await page!.keyboard.press('Enter');
  };
  const start = async () => {
    application = await _electron.launch({ executablePath: executable, args, cwd: root, env, timeout: 30000 });
    guiPids.add(application.process().pid!);
    application.process().stderr?.on('data', chunk => logs.push({ type: 'stderr', text: String(chunk) }));
    page = await application.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => logs.push({ type: 'pageerror', text: error.message }));
    await expect(page.getByRole('button', { name: '새 그룹', exact: true })).toBeEnabled({ timeout: 30000 });
    owner = await connectOwnerPipe({ dataDir });
    const info = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')) as { pid: number; port: number; bootId: string };
    hostPids.add(info.pid); return info;
  };
  const metadata = (current: Pick<HostState, 'groups' | 'terminals'>) => ({ groups: current.groups, terminals: current.terminals.map(({ id, groupId, title, cwd, profileId }) => ({ id, groupId, title, cwd, profileId })) });
  try {
    if (legacyHostEntry) {
      // This deliberately replaces ONE host entry only in a separately copied,
      // explicitly owned test package. Never mutate shared release directories.
      assert.ok(packaged, 'Legacy upgrade requires a copied packaged executable');
      const testRoot = await realpath(path.join(root, '.test-data'));
      const fixtureExecutable = await realpath(executable);
      const relative = path.relative(testRoot, fixtureExecutable);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
      const segments = relative.split(path.sep);
      assert.equal(segments.length, 3);
      assert.match(segments[0], /^full-exit-legacy-[a-z0-9-]+$/);
      assert.equal(segments[1], 'win-unpacked'); assert.equal(segments[2], 'MongleTerminal.exe');
      const fixture = path.join(testRoot, segments[0]);
      const marker = JSON.parse(await readFile(path.join(fixture, 'full-exit-fixture.json'), 'utf8'));
      assert.equal(marker.kind, 'mongle-full-exit-legacy'); assert.equal(marker.allowHostEntrySwap, true);
      assert.equal(path.resolve(marker.executable).toLowerCase(), fixtureExecutable.toLowerCase());
      legacyTarget = await realpath(path.join(buildRoot, 'dist/host/main.cjs'));
      assert.ok(legacyTarget.toLowerCase().startsWith((fixture + path.sep).toLowerCase()));
      assert.notEqual(legacyTarget.toLowerCase(), legacyHostEntry.toLowerCase());
      upgradedHostBytes = await readFile(legacyTarget);
      const oldBytes = await readFile(legacyHostEntry);
      const oldSha256 = createHash('sha256').update(oldBytes).digest('hex');
      const newSha256 = createHash('sha256').update(upgradedHostBytes).digest('hex');
      assert.notEqual(oldSha256, newSha256, 'The fixture must exercise genuinely different old and new host builds');
      result.legacyUpgrade = { oldHostEntry: legacyHostEntry, fixtureHostEntry: legacyTarget, oldSha256, newSha256 };
      await writeFile(legacyTarget, oldBytes);
    }
    result.buildSha256 = Object.fromEntries(await Promise.all([executable, packaged ? path.join(path.dirname(executable), 'resources/app.asar') : path.join(root, 'dist/desktop/main.cjs'), path.join(buildRoot, 'dist/host/main.cjs'), path.join(buildRoot, 'platform/windows/OwnerPipe.exe')].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
    const info = await start();
    const firstGuiPid = application!.process().pid!;
    const initial = await state(); assert.equal(initial.terminals.length, 0); assert.equal(initial.settings.recordHistory, true);
    const profile = initial.profiles.find(item => item.kind === 'powershell'); assert.ok(profile);
    await page!.getByRole('button', { name: '새 그룹', exact: true }).click();
    const groupDialog = page!.getByRole('dialog', { name: '새 작업 그룹' });
    await groupDialog.getByLabel('이름', { exact: true }).fill('완전 종료 복원 검증');
    await groupDialog.getByRole('combobox').selectOption(profile.id);
    await groupDialog.getByLabel('시작 폴더', { exact: true }).fill(root);
    await groupDialog.getByRole('button', { name: '저장', exact: true }).click();
    await page!.getByRole('button', { name: '새 터미널', exact: true }).click();
    await page!.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page!.locator('.pane')).toHaveCount(1);
    await page!.getByRole('button', { name: '좌우 분할', exact: true }).click();
    await page!.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page!.locator('.pane')).toHaveCount(2);
    const split = page!.getByRole('separator', { name: '좌우 분할 크기' });
    await split.focus(); await page!.keyboard.press('ArrowRight');
    await until(state, value => value.groups.some(group => group.layout?.type === 'split' && group.layout.ratio > 0.5), 'nondefault split ratio persisted');
    const terminals = (await state()).terminals;
    const markers = new Map<string, string>();
    const executionFile = path.join(dataDir, 'command-executions.txt');
    const quotedExecutionFile = executionFile.replaceAll("'", "''");
    for (const [index, terminal] of terminals.entries()) {
      assert.ok(terminal.pid); shellPids.add(terminal.pid);
      const pane = page!.locator(`.pane[data-terminal-id="${terminal.id}"]`);
      await pane.locator('.pane-title').dblclick();
      const rename = page!.getByRole('dialog', { name: '터미널 이름 변경' });
      await rename.getByLabel('이름', { exact: true }).fill(`복원할 셸 ${index + 1}`);
      await rename.getByRole('button', { name: '저장', exact: true }).click();
      const marker = `SAVED_OUTPUT_${index}_${Date.now()}`; markers.set(terminal.id, marker);
      await command(terminal.id, `$mongleExitProof='${marker}'; Add-Content -LiteralPath '${quotedExecutionFile}' -Value '${marker}'; Write-Output ('READY:'+$mongleExitProof)`);
      await until(() => snapshot(terminal.id), value => value.data.includes(`READY:${marker}`), 'real PowerShell emitted output marker');
    }
    const before = await state(), expected = metadata(before);
    const initialExecutions = await readFile(executionFile, 'utf8');
    assert.equal(initialExecutions.trim().split(/\r?\n/).length, 2);
    await page!.locator(`.pane[data-terminal-id="${terminals[1].id}"] .pane-title`).click();
    await expect(page!.locator(`.pane[data-terminal-id="${terminals[1].id}"]`)).toHaveClass(/active/);
    snapshots.before = { guiPid: firstGuiPid, host: info, state: before };
    await page!.screenshot({ path: path.join(output, 'before-full-exit.png'), fullPage: true });
    await installDialogInterceptor(application!);
    snapshots.cancelMenu = await invokeMenu(application!, 'application');
    const cancelDialog = await pendingDialog(application!, 1);
    assert.deepEqual(cancelDialog.buttons, ['취소', '완전 종료']); assert.equal(cancelDialog.defaultId, 0); assert.equal(cancelDialog.cancelId, 0);
    assert.match(`${cancelDialog.message} ${cancelDialog.detail}`, /2/);
    snapshots.cancelDialog = cancelDialog;
    await answerDialog(application!, 0);
    // A round trip plus subsequent live input checks cancellation retained the
    // original host/leases; no passive screenshot-only success is accepted.
    await until(async () => application!.evaluate(() => Boolean((globalThis as any).__mongleFullExitDialog.resolve)), value => !value, 'cancel delivered');
    assert.ok(alive(firstGuiPid) && alive(info.pid)); for (const pid of shellPids) assert.ok(alive(pid));
    const afterCancel = await state(); assert.equal(afterCancel.bootId, before.bootId); assert.deepEqual(metadata(afterCancel), expected);
    assert.deepEqual(afterCancel.terminals.map(item => item.pid), before.terminals.map(item => item.pid));
    assert.deepEqual(afterCancel.terminals.map(item => item.generation), before.terminals.map(item => item.generation));
    await command(terminals[0].id, "Write-Output ('CANCELLED:'+$mongleExitProof)");
    await until(() => snapshot(terminals[0].id), value => value.data.includes(`CANCELLED:${markers.get(terminals[0].id)}`), 'cancel retained in-memory variable and interactive shell');
    await page!.locator(`.pane[data-terminal-id="${terminals[1].id}"] .pane-title`).click();
    steps.push('application-menu full exit opens safe-default confirmation; Cancel preserves GUI, exact host/shell PIDs and live variable');

    snapshots.confirmMenu = await invokeMenu(application!, 'tray');
    const confirmDialog = await pendingDialog(application!, 2); snapshots.confirmDialog = confirmDialog;
    assert.deepEqual(confirmDialog.buttons, ['취소', '완전 종료']);
    assert.equal(confirmDialog.cancelId, 0); assert.equal(confirmDialog.defaultId, 0);
    const closing = application!.waitForEvent('close');
    await answerDialog(application!, 1); await closing; application = undefined;
    owner!.close(); owner = undefined;
    await until(async () => !alive(firstGuiPid) && !alive(info.pid) && [...shellPids].every(pid => !alive(pid)), Boolean, 'full exit stopped isolated GUI, host and both shells');
    await until(() => portOpen(info.port), value => !value, 'full exit stopped loopback gateway');
    await assert.rejects(readFile(path.join(dataDir, 'host-info.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    const db = new DatabaseSync(path.join(dataDir, 'sessions.sqlite'), { readOnly: true });
    let saved: PersistedHost;
    const savedFrames = new Map<string, PresentationSnapshot>();
    try {
      assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      saved = JSON.parse((db.prepare("SELECT value FROM metadata WHERE key='host'").get() as { value: string }).value) as PersistedHost;
      assert.deepEqual(metadata(saved), expected);
      for (const terminal of terminals) {
        const row = db.prepare('SELECT generation, payload FROM snapshots WHERE terminal_id=?').get(terminal.id) as { generation: string; payload: string };
        assert.ok(row); assert.equal(row.generation, terminal.generation);
        const frame = JSON.parse(row.payload) as PresentationSnapshot; savedFrames.set(terminal.id, frame);
        assert.ok(frame.data.includes(`READY:${markers.get(terminal.id)}`));
      }
      assert.ok(savedFrames.get(terminals[0].id)!.data.includes(`CANCELLED:${markers.get(terminals[0].id)}`));
    } finally { db.close(); }
    snapshots.stopped = { guiPid: firstGuiPid, hostPid: info.pid, shellPids: [...shellPids], port: info.port, portOpen: false, sqliteIntegrity: 'ok', metadata: metadata(saved), savedSnapshotBytes: Object.fromEntries([...savedFrames].map(([id, frame]) => [id, Buffer.byteLength(frame.data)])) };
    steps.push('tray-menu confirmation closes real GUI/tray process, host, both PowerShell processes and loopback listener; SQLite integrity, exact metadata and both saved output markers verified after all processes stopped');

    if (legacyTarget && upgradedHostBytes) {
      assert.ok(saved.terminals.every(terminal => terminal.status === 'exited' && terminal.resumeOnBoot !== true), 'Old host wrote exited terminal records with no new auto-resume flag');
      const manifest = JSON.parse(await readFile(path.join(dataDir, 'workspace-resume.json'), 'utf8'));
      assert.deepEqual(manifest, { version: 1, hostId: before.hostId, bootId: before.bootId, terminals: terminals.map(({ id, generation }) => ({ id, generation })) });
      snapshots.legacyResumeManifest = manifest;
      // No process remains for the old test boot, so swap to the new host in the
      // same owned fixture for the first upgrade/cold launch compatibility case.
      await writeFile(legacyTarget, upgradedHostBytes);
      steps.push('new GUI safely stopped a real old host, left its exited legacy records and wrote the generation-bound one-shot resume manifest before installing the new fixture host');
    }

    const reopenedInfo = await start();
    assert.notEqual(reopenedInfo.pid, info.pid); assert.notEqual(reopenedInfo.bootId, info.bootId);
    const restored = await until(state, current => current.terminals.length === 2 && current.terminals.every(terminal => terminal.status === 'running' && Boolean(terminal.pid)), 'saved workspace automatically starts fresh shells');
    assert.equal(restored.hostId, before.hostId); assert.deepEqual(metadata(restored), expected);
    await expect(page!.locator('.pane')).toHaveCount(2);
    await expect(page!.locator(`.pane[data-terminal-id="${terminals[1].id}"]`)).toHaveClass(/active/);
    for (const terminal of terminals) {
      const fresh = restored.terminals.find(item => item.id === terminal.id)!;
      assert.ok(fresh.pid && alive(fresh.pid)); shellPids.add(fresh.pid);
      assert.notEqual(fresh.pid, terminal.pid); assert.notEqual(fresh.generation, terminal.generation);
      const pane = page!.locator(`.pane[data-terminal-id="${terminal.id}"]`);
      await expect(pane.locator('.pane-title')).toHaveText(expected.terminals.find(item => item.id === terminal.id)!.title);
      await expect(pane.locator('.pane-footer')).toContainText(terminal.cwd);
      await expect(pane.locator('.control-chip')).toContainText('여기서 제어 중');
      await until(() => snapshot(terminal.id), frame => frame.data.includes(`READY:${markers.get(terminal.id)}`), 'new terminal retains the prior saved output marker');
    }
    const childProcesses = await descendants(reopenedInfo.pid);
    for (const terminal of restored.terminals) assert.ok(childProcesses.some(item => item.ProcessId === terminal.pid), 'each restored shell is a real descendant of the new isolated host');
    assert.equal(await readFile(executionFile, 'utf8'), initialExecutions, 'Automatically reopening shells must not replay old commands or side effects');
    if (legacyTarget) await assert.rejects(readFile(path.join(dataDir, 'workspace-resume.json')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    snapshots.restored = { host: reopenedInfo, state: restored, childProcesses };
    await page!.screenshot({ path: path.join(output, 'restored-saved-output.png'), fullPage: true });
    steps.push('same data relaunch restores exact group/name/cwd/layout/selected panel and saved output into two automatic fresh PowerShell processes; original commands were not replayed');

    const freshProof: Array<{ id: string; generation: string; pid: number; oldVariableEmpty: boolean }> = [];
    for (const terminal of restored.terminals) {
      const freshMarker = `FRESH_PROCESS_${Date.now()}`;
      await command(terminal.id, `Write-Output ('${freshMarker}:'+[string]::IsNullOrEmpty($mongleExitProof)); Write-Output ('CWD:'+((Get-Location).Path))`);
      await until(() => snapshot(terminal.id), value => value.data.includes(`${freshMarker}:True`), 'automatic new shell is interactive and does not preserve old in-memory variable');
      await until(() => snapshot(terminal.id), value => value.data.includes(`CWD:${terminal.cwd}`), 'automatic new shell opened in the saved working directory');
      freshProof.push({ id: terminal.id, generation: terminal.generation, pid: terminal.pid!, oldVariableEmpty: true });
    }
    snapshots.automaticNewShells = freshProof;
    steps.push('both restored shells accept real commands, report saved working directory, and have no old in-memory variable');
    assert.equal(logs.filter(item => item.type === 'pageerror').length, 0);
    result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'full-exit-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await application?.close().catch(() => {});
    if (!owner) owner = await connectOwnerPipe({ dataDir }).catch(() => undefined);
    if (owner) {
      const last = await owner.request<HostState>('state.get').catch(() => undefined);
      for (const terminal of last?.terminals || []) if (terminal.pid) shellPids.add(terminal.pid);
      await owner.request('host.shutdown').catch(() => {}); owner.close();
    }
    try { hostPids.add(JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')).pid); } catch {}
    await until(async () => [...guiPids, ...hostPids, ...shellPids].every(pid => !alive(pid)), Boolean, 'all isolated full-exit test processes cleaned up', 15000).catch(error => { result.cleanupError = String(error); });
    if (legacyTarget && upgradedHostBytes) await writeFile(legacyTarget, upgradedHostBytes).catch(error => { result.cleanupError = `${result.cleanupError || ''} Failed to restore owned fixture host: ${String(error)}`; });
    result = { ...result, hostPids: [...hostPids], shellPids: [...shellPids], guiPids: [...guiPids], steps, snapshots, cleanedUp: !result.cleanupError, finishedAt: new Date().toISOString(), limitations: ['Native dialog rendering and physical Windows tray clicks are not automated: dialog responses are intercepted and real production native menu callbacks are invoked through main-process debugging.', 'The test uses unique isolated data and does not terminate or alter the user live host, shells, remote devices or Tailscale settings.'] };
    await writeFile(path.join(output, 'full-exit-result.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(output, 'full-exit-console.json'), JSON.stringify(logs, null, 2));
    assert.equal(result.cleanedUp, true, 'All processes owned by this isolated test must stop');
  }
});
