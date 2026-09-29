import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron, expect, type ElectronApplication } from '@playwright/test';
import { version } from '../../package.json';

const root = process.cwd();
const executable = process.env.MONGLE_E2E_EXE;
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_UPDATE_DESKTOP === '1';
const output = path.join(root, 'test-results/e2e/update-desktop');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('desktop update bridge and settings identify an unpacked app and reject installation without stopping its host', { skip: !enabled, timeout: 60000 }, async () => {
  await mkdir(output, { recursive: true });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-update-desktop-'));
  const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  let application: ElectronApplication | undefined;
  let electronProcess: ChildProcess | undefined;
  let hostPid: number | undefined;
  const errors: string[] = [];
  const processLogs: string[] = [];
  const proof: Record<string, unknown> = { passed: false, dataDir, executable: executable || 'development' };
  try {
    application = await _electron.launch({ executablePath: executable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: executable ? [] : [root], cwd: root, env: env as Record<string, string>, timeout: 25000 });
    electronProcess = application.process();
    electronProcess.stderr?.on('data', data => processLogs.push(String(data)));
    const page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '새 그룹', exact: true })).toBeEnabled({ timeout: 25000 });
    const readiness = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    hostPid = readiness.pid;
    assert.ok(hostPid && alive(hostPid));
    const state = await page.evaluate(() => window.mongle!.getUpdateState!());
    assert.equal(state.currentVersion, version);
    assert.equal(state.status, 'unsupported');
    assert.match(state.message!, /ZIP 실행본과 개발 모드는 수동으로 교체/);
    assert.deepEqual(await page.evaluate(() => window.mongle!.checkForUpdates!()), state);
    await assert.rejects(page.evaluate(() => window.mongle!.installUpdate!()), /설치할 업데이트가 준비되지 않았습니다/);
    const afterReject = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
    assert.equal(afterReject.pid, hostPid);
    assert.equal(afterReject.bootId, readiness.bootId);
    assert.ok(alive(hostPid), 'An unsupported update request must not stop the local host');
    await page.evaluate(() => window.mongle!.request('state.get'));
    const menu = await application.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.flatMap(item => item.submenu?.items.map(child => ({ label: child.label, enabled: child.enabled })) || []));
    assert.ok(menu.some(item => item.label === '업데이트 확인'));
    assert.ok(menu.some(item => item.label === '업데이트 설치 후 다시 시작…' && !item.enabled));
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('tab', { name: '앱 업데이트', exact: true }).click();
    await expect(page.getByRole('heading', { name: '이 기기의 앱 업데이트', exact: true })).toBeVisible();
    await expect(page.locator('.setting-row').filter({ hasText: '설치된 앱 버전' })).toContainText(version);
    await expect(page.getByRole('status').filter({ hasText: 'ZIP 실행본과 개발 모드는 수동으로 교체' })).toBeVisible();
    await expect(page.getByRole('button', { name: '업데이트 확인', exact: true })).toBeDisabled();
    await expect(page.getByText('접속한 원격 컴퓨터의 앱은 그 컴퓨터에서 업데이트합니다.', { exact: false })).toBeVisible();
    await page.screenshot({ path: path.join(output, 'unpacked-update-settings.png') });
    assert.deepEqual(errors, []);
    proof.passed = true; proof.state = state; proof.menu = menu; proof.hostPid = hostPid;
  } finally {
    if (application) {
      const page = await application.firstWindow().catch(() => undefined);
      if (page) {
        if (!proof.passed) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
        await page.evaluate(() => window.mongle!.request('host.shutdown')).catch(error => { proof.shutdownError = String(error); });
      }
      await application.close().catch(error => { proof.closeError = String(error); });
    }
    if (hostPid) {
      const deadline = Date.now() + 10000;
      while (alive(hostPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    }
    proof.cleanedUp = (!hostPid || !alive(hostPid)) && (!electronProcess || electronProcess.exitCode !== null || electronProcess.signalCode !== null);
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...proof, errors, processLogs, finishedAt: new Date().toISOString() }, null, 2));
    assert.equal(proof.cleanedUp, true, 'The isolated desktop and host must exit');
  }
});
