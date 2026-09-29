import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron, expect, type ElectronApplication } from '@playwright/test';
import type { HostState } from '../../packages/protocol/index';

const root = process.cwd();
const executable = process.env.MONGLE_E2E_EXE;
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_START_FOLDER === '1';
const output = path.join(root, 'test-results/e2e/start-folder');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('desktop folder picker: cancel, selected cwd, split inheritance, validation and remote UI', { skip: !enabled, timeout: 90000 }, async () => {
  await mkdir(output, { recursive: true });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-start-folder-'));
  const groupFolder = path.join(dataDir, '그룹 폴더');
  const terminalFolder = path.join(dataDir, '개별 터미널');
  await mkdir(groupFolder); await mkdir(terminalFolder);
  const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
  let application: ElectronApplication | undefined;
  let hostPid: number | undefined;
  let shellPids: number[] = [];
  const errors: string[] = [];
  const processLogs: string[] = [];
  const proof: Record<string, unknown> = { passed: false, dataDir, executable: executable || 'development' };
  try {
    application = await _electron.launch({ executablePath: executable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: executable ? [] : [root], cwd: root, env: env as Record<string, string>, timeout: 30000 });
    application.process().stderr?.on('data', data => processLogs.push(String(data)));
    const page = await application.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '새 그룹', exact: true })).toBeEnabled({ timeout: 30000 });
    hostPid = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')).pid;
    // Intercept only the OS dialog response. The real button, preload, trusted
    // IPC handler, host validation, persistence and ConPTY launch still run.
    await application.evaluate(({ dialog }) => {
      const state = (globalThis as any).__folderTest = { next: null as string | null, calls: [] as any[] };
      (dialog.showOpenDialog as any) = async (...args: any[]) => {
        state.calls.push(args.at(-1));
        return { canceled: state.next === null, filePaths: state.next === null ? [] : [state.next] };
      };
    });
    const choice = (value: string | null) => application!.evaluate((_electron, value) => { (globalThis as any).__folderTest.next = value; }, value);
    const state = () => page.evaluate(() => window.mongle!.request<HostState>('state.get'));
    await page.getByRole('button', { name: '새 그룹', exact: true }).click();
    const initialPath = await page.getByLabel('시작 폴더', { exact: true }).inputValue();
    await page.getByRole('button', { name: '찾아보기', exact: true }).click();
    await expect(page.getByLabel('시작 폴더', { exact: true })).toHaveValue(initialPath);
    await choice(groupFolder); await page.getByRole('button', { name: '찾아보기', exact: true }).click();
    await expect(page.getByLabel('시작 폴더', { exact: true })).toHaveValue(groupFolder);
    await page.getByLabel('이름', { exact: true }).fill('시작 폴더 검증');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('heading', { name: '시작 폴더 검증', exact: true }).waitFor();
    assert.equal((await state()).groups.find(group => group.name === '시작 폴더 검증')?.cwd, groupFolder);
    await page.getByRole('button', { name: '새 터미널', exact: true }).click();
    await expect(page.getByLabel('시작 폴더', { exact: true })).toHaveValue(groupFolder);
    await choice(terminalFolder); await page.getByRole('button', { name: '찾아보기', exact: true }).click();
    await expect(page.getByLabel('시작 폴더', { exact: true })).toHaveValue(terminalFolder);
    await page.screenshot({ path: path.join(output, 'folder-selected.png') });
    await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await page.getByText('여기서 제어 중', { exact: true }).waitFor();
    assert.equal((await state()).terminals[0].cwd, terminalFolder);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("[Console]::WriteLine('CWD_PROOF='+(Get-Location).Path)"); await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-rows')).toContainText(`CWD_PROOF=${terminalFolder}`);
    await page.getByRole('button', { name: '좌우 분할', exact: true }).click();
    await expect(page.getByLabel('시작 폴더', { exact: true })).toHaveValue(terminalFolder);
    await choice(null); await page.getByRole('button', { name: '찾아보기', exact: true }).click();
    await expect(page.getByLabel('시작 폴더', { exact: true })).toHaveValue(terminalFolder);
    await page.getByLabel('시작 폴더', { exact: true }).fill(path.join(dataDir, 'missing-folder'));
    await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible(); assert.equal((await state()).terminals.length, 1);
    await page.getByLabel('시작 폴더', { exact: true }).fill(terminalFolder);
    await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await expect(page.locator('.pane')).toHaveCount(2);
    const before = await state(); shellPids = before.terminals.map(terminal => terminal.pid!);
    assert.ok(before.terminals.every(terminal => terminal.cwd === terminalFolder));
    await page.reload(); await expect(page.locator('.pane')).toHaveCount(2);
    assert.deepEqual((await state()).terminals.map(terminal => ({ cwd: terminal.cwd, pid: terminal.pid })), before.terminals.map(terminal => ({ cwd: terminal.cwd, pid: terminal.pid })));
    await assert.rejects(page.evaluate(() => window.mongle!.selectDirectory!('bad\0path')));
    const nativeCalls = await application.evaluate(() => (globalThis as any).__folderTest.calls);
    assert.equal(nativeCalls.length, 4); assert.deepEqual(nativeCalls[0].properties, ['openDirectory']);
    assert.equal(nativeCalls[0].defaultPath, initialPath); assert.equal(nativeCalls[3].defaultPath, terminalFolder);
    // A remote connection must not offer the viewer computer's local chooser.
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('mongle:connection', { status: 'connected', owner: false }); });
    await page.keyboard.press('Control+Shift+T');
    await expect(page.getByRole('button', { name: '찾아보기', exact: true })).toHaveCount(0);
    await expect(page.getByText('접속한 컴퓨터의 폴더 경로를 입력하세요.', { exact: false })).toBeVisible();
    assert.deepEqual(errors, []);
    proof.passed = true; proof.nativeCalls = nativeCalls; proof.shellPids = shellPids;
  } finally {
    if (application) {
      const page = await application.firstWindow().catch(() => undefined);
      if (page) {
        if (!proof.passed) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
        await page.evaluate(() => window.mongle!.request('host.shutdown')).catch(() => {});
      }
      await application.close().catch(() => {});
    }
    if (hostPid) {
      const deadline = Date.now() + 10000;
      while ((alive(hostPid) || shellPids.some(alive)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      proof.cleanedUp = !alive(hostPid) && !shellPids.some(alive);
    }
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...proof, errors, processLogs, finishedAt: new Date().toISOString() }, null, 2));
    assert.notEqual(proof.cleanedUp, false, 'Isolated test processes must exit');
  }
});
