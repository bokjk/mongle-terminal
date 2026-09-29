import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc/index.ts';
import type { HostState, SnapshotEvent, TerminalInfo } from '../../packages/protocol/index.ts';

const root = process.cwd();
const executable = process.env.MONGLE_E2E_EXE ? path.resolve(process.env.MONGLE_E2E_EXE) : undefined;
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_TAP_CONTROL === '1';
const output = path.join(root, 'test-results/tap-control/packaged');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('packaged Electron and owner IPC: deliberate clicks reclaim another controller and preserve the live PowerShell', { skip: !enabled, timeout: 60_000 }, async () => {
  await mkdir(output, { recursive: true });
  const dataParent = path.join(root, '.test-data/tap-control-e2e');
  await mkdir(dataParent, { recursive: true });
  const dataDir = await mkdtemp(path.join(dataParent, 'host-'));
  assert.equal(path.dirname(dataDir), dataParent, 'The real user profile is never used');
  const previousHelper = process.env.MONGLE_OWNER_HELPER;
  if (executable) process.env.MONGLE_OWNER_HELPER = path.join(path.dirname(executable), 'resources/hostbundle/platform/windows/OwnerPipe.exe');
  const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  let application: ElectronApplication | undefined;
  let electronProcess: ChildProcess | undefined;
  let page: Page | undefined;
  let observer: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  let hostPid: number | undefined;
  let shellPid: number | undefined;
  const errors: string[] = [];
  const processLogs: string[] = [];
  const steps: string[] = [];
  const proof: Record<string, unknown> = { passed: false, dataDir, executable: executable || 'development', steps };
  try {
    application = await _electron.launch({ executablePath: executable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: executable ? [] : [root], cwd: root, env: env as Record<string, string>, timeout: 25_000 });
    electronProcess = application.process();
    proof.desktopPid = electronProcess.pid;
    electronProcess.stderr?.on('data', data => processLogs.push(String(data)));
    page = await application.firstWindow();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '새 터미널', exact: true })).toBeEnabled({ timeout: 25_000 });
    const readiness = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    hostPid = readiness.pid;
    assert.ok(hostPid && alive(hostPid));
    observer = await connectOwnerPipe({ dataDir });
    const state = () => observer!.request<HostState>('state.get');
    const initial = await state();
    assert.equal(initial.hostId, readiness.hostId);
    assert.equal(initial.bootId, readiness.bootId);
    assert.ok(initial.capabilities?.includes('control.acquire-if-free'), 'The launched packaged host advertises atomic free acquisition');
    assert.equal(initial.terminals.length, 0);
    const profile = initial.profiles.find(item => item.kind === 'powershell');
    assert.ok(profile, 'A real installed PowerShell is required');
    const desktopConnection = await page.evaluate(() => window.mongle!.request<{ id: string }>('connection.info'));
    assert.notEqual(desktopConnection.id, observer.connectionId);
    steps.push('isolated packaged host authenticated two actual owner IPC connections and advertised conditional control');

    await page.getByRole('button', { name: '새 터미널', exact: true }).click();
    await page.getByLabel('셸', { exact: true }).selectOption(profile.id);
    await page.getByLabel('시작 폴더', { exact: true }).fill(dataDir);
    await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await page.getByText('여기서 제어 중', { exact: true }).waitFor();
    const original = (await state()).terminals[0];
    shellPid = original.pid;
    assert.ok(shellPid && alive(shellPid));
    assert.equal(original.controller?.connectionId, desktopConnection.id);
    assert.equal(original.controller?.ready, true, 'Real IPC state ordering allowed the desktop to ACK and open input');
    const ref = { id: original.id, hostId: initial.hostId, bootId: initial.bootId, generation: original.generation };
    const current = async (): Promise<TerminalInfo> => (await state()).terminals.find(item => item.id === original.id)!;
    const writeAndObserve = async (command: string, expected: string) => {
      await page!.locator('.xterm-helper-textarea').focus();
      await page!.keyboard.insertText(command);
      await page!.keyboard.press('Enter');
      await expect(page!.locator('.xterm-rows')).toContainText(expected, { timeout: 10_000 });
    };
    const otherAcquires = async () => {
      const lease = await observer!.request<{ epoch: number; frame: SnapshotEvent }>('control.acquire', { ...ref, cols: 100, rows: 30 });
      await observer!.request('terminal.ack', { ...ref, seq: lease.frame.seq, epoch: lease.epoch });
      await page!.getByRole('button', { name: '현재 컴퓨터에서 제어 · 가져오기', exact: true }).waitFor();
      return lease;
    };
    // This test shell disables PSReadLine history in memory. A sandbox may
    // display its default-history access warning before the first command;
    // clear only the test terminal screen after initialization, never user data.
    proof.historyInitialization = {
      saveStyle: 'SaveNothing',
      startupWarningObserved: /PSReadLine|ConsoleHost_history|Access.*denied|액세스.*거부/i.test(await page.locator('.xterm-rows').innerText()),
      limitation: 'The sandbox can warn about default PSReadLine history before initialization. This test disables history only in its new shell and clears that test screen.',
    };
    await writeAndObserve("Set-PSReadLineOption -HistorySaveStyle SaveNothing; Clear-Host; $monglePackageTap=41; Write-Output ('PACKAGED_A_' + $monglePackageTap)", 'PACKAGED_A_41');
    const other = await otherAcquires();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal((await current()).controller?.connectionId, observer.connectionId);
    assert.equal((await current()).controller?.epoch, other.epoch);
    steps.push('window focus kept the other connection in control without replacing its epoch');
    await page.locator('.xterm-screen').click();
    await page.getByText('여기서 제어 중', { exact: true }).waitFor();
    assert.equal((await current()).controller?.connectionId, desktopConnection.id);
    assert.notEqual((await current()).controller?.epoch, other.epoch);
    await writeAndObserve("$monglePackageTap++; Write-Output ('PACKAGED_B_' + $monglePackageTap)", 'PACKAGED_B_42');
    steps.push('deliberate terminal click reclaimed GUI input without a separate takeover button and preserved the same PowerShell variable');

    const released = await otherAcquires();
    await observer.request('control.release', { id: original.id, epoch: released.epoch });
    await page.getByText('화면을 눌러 입력', { exact: true }).waitFor();
    assert.equal((await current()).controller, undefined);
    await page.locator('.xterm-screen').click();
    await page.getByText('여기서 제어 중', { exact: true }).waitFor();
    await writeAndObserve("$monglePackageTap++; Write-Output ('PACKAGED_C_' + $monglePackageTap)", 'PACKAGED_C_43');
    const final = await current();
    assert.equal(final.controller?.connectionId, desktopConnection.id);
    assert.equal(final.controller?.ready, true);
    assert.equal(final.pid, shellPid);
    assert.equal(final.generation, original.generation);
    steps.push('free terminal click reacquired through actual IPC, ACKed its screen and preserved PID/generation/variable');
    await page.screenshot({ path: path.join(output, 'desktop-controller.png') });
    assert.deepEqual(errors, []);
    if (executable) {
      const hostBundle = path.join(path.dirname(executable), 'resources/hostbundle');
      proof.sha256 = Object.fromEntries(await Promise.all([
        path.join(hostBundle, 'dist/host/main.cjs'), path.join(hostBundle, 'dist/web/index.html'),
        path.join(path.dirname(executable), 'resources/app.asar'),
      ].map(async file => [path.relative(path.dirname(executable), file), createHash('sha256').update(await readFile(file)).digest('hex')])));
    }
    proof.passed = true;
    proof.hostPid = hostPid;
    proof.shellPid = shellPid;
    proof.capabilities = initial.capabilities;
  } catch (error) {
    proof.error = error instanceof Error ? error.stack : String(error);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
    }
    throw error;
  } finally {
    // The production owner request saves and shuts down only this isolated host.
    // Using the desktop bridge also suppresses its automatic host reconnection.
    if (page && !page.isClosed()) await page.evaluate(() => window.mongle!.request('host.shutdown')).catch(error => { proof.shutdownError = String(error); });
    await application?.close().catch(error => { proof.closeError = String(error); });
    if (!hostPid) {
      try { hostPid = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')).pid; } catch { /* No host readiness was published. */ }
    }
    if (hostPid && alive(hostPid) && !observer) observer = await connectOwnerPipe({ dataDir }).catch(() => undefined);
    if (hostPid && alive(hostPid) && observer) await observer.request('host.shutdown').catch(error => { proof.fallbackShutdownError = String(error); });
    observer?.close();
    const deadline = Date.now() + 10_000;
    while ([hostPid, shellPid].some(pid => pid && alive(pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    proof.cleanedUp = application ? ![hostPid, shellPid].some(pid => pid && alive(pid)) && (!electronProcess || electronProcess.exitCode !== null || electronProcess.signalCode !== null) : null;
    if (!application) proof.cleanupLimitation = 'Electron launch failed before a process handle was returned; external process inspection is required.';
    if (previousHelper === undefined) delete process.env.MONGLE_OWNER_HELPER;
    else process.env.MONGLE_OWNER_HELPER = previousHelper;
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...proof, errors, processLogs, finishedAt: new Date().toISOString() }, null, 2));
    assert.notEqual(proof.cleanedUp, false, 'The isolated Electron, host and PowerShell must all exit normally');
  }
});
