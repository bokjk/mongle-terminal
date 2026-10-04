import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron, expect, type ElectronApplication } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc/index';
import type { HostState, TerminalInfo } from '../../packages/protocol/index';
import { git } from '../helpers/git';

const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_RESPONSIVENESS === '1';

test('real Electron explorer stays usable during continuous ConPTY output and preserves shell identity across scope changes', {
  skip: enabled ? false : 'Set MONGLE_E2E_RESPONSIVENESS=1 after npm run build on Windows.', timeout: 120_000,
}, async () => {
  const root = process.cwd(), packaged = process.env.MONGLE_E2E_EXE;
  const output = path.resolve(`test-results/e2e/responsiveness${packaged ? '-packaged' : ''}`);
  await mkdir(output, { recursive: true });
  const parent = path.resolve(process.env.MONGLE_E2E_DATA_ROOT || tmpdir());
  const relative = path.relative(path.resolve(tmpdir()), parent);
  assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'OwnerPipe E2E data must stay under TEMP');
  await mkdir(parent, { recursive: true });
  const isolated = await mkdtemp(path.join(parent, 'mongle-responsive-'));
  assert.equal(path.dirname(isolated), parent);
  const dataDir = path.join(isolated, 'host'), projectA = path.join(isolated, 'project-a'), projectB = path.join(isolated, 'project-b');
  await mkdir(projectA); await mkdir(projectB);
  for (let index = 0; index < 12; index++) {
    const directory = path.join(projectA, `folder-${String(index).padStart(2, '0')}`);
    await mkdir(directory); await writeFile(path.join(directory, 'nested.txt'), `Folder ${index} fixture\n`);
  }
  await writeFile(path.join(projectA, 'first.txt'), 'FIRST_PREVIEW\n');
  await writeFile(path.join(projectA, 'latest.txt'), 'LATEST_PREVIEW\n');
  await writeFile(path.join(projectB, 'second.txt'), 'SECOND_PROJECT_PREVIEW\n');
  const stream = path.join(projectA, 'stream.cjs');
  await writeFile(stream, `const fs = require('node:fs');const path = require('node:path');fs.writeFileSync(path.join(__dirname,'stream.started'),'started');let round=0;const timer=setInterval(()=>{process.stdout.write(Array.from({length:30},(_,line)=>'MONGLE_BURST_'+round+'_'+line+'\\r\\n').join(''));if(++round>=600||fs.existsSync(path.join(__dirname,'stream.stop'))){clearInterval(timer);fs.writeFileSync(path.join(__dirname,'stream.done'),'done');process.stdout.write('MONGLE_STREAM_DONE\\r\\n');}},100);`);
  await git(projectA, 'init', '-q', '--initial-branch=dev');
  await git(projectA, 'add', '.'); await git(projectA, 'commit', '-qm', 'isolated responsiveness fixture');
  await writeFile(path.join(projectA, 'latest.txt'), 'LATEST_PREVIEW_CHANGED\n');
  const helper = process.env.MONGLE_OWNER_HELPER;
  if (packaged) process.env.MONGLE_OWNER_HELPER = path.join(path.dirname(path.resolve(packaged)), 'resources/hostbundle/platform/windows/OwnerPipe.exe');
  let app: ElectronApplication | undefined, owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  const errors: string[] = [], steps: string[] = [];
  const proof: { passed: boolean; steps: string[]; errors: string[]; limitations: string[]; versions?: unknown; error?: string; cleanupError?: string } = {
    passed: false, steps, errors, limitations: [packaged ? 'Packaged executable, not an installed update.' : 'Development Electron build, not the installed release.', 'Local synthetic files and actual cmd/ConPTY; remote networks and physical mobile devices are not exercised.', 'A concurrent interaction regression, not a latency benchmark.'],
  };
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : [root], cwd: root, env: { ...env, MONGLE_DATA_DIR: dataDir }, timeout: 30_000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: '프로젝트 열기', exact: true })).toBeEnabled({ timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    proof.versions = await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }));
    owner = await connectOwnerPipe({ dataDir });
    const state = () => owner!.request<HostState>('state.get');
    const initial = await state(), group = initial.groups[0], cmd = initial.profiles.find(profile => profile.kind === 'cmd');
    assert.ok(cmd); assert.equal(initial.terminals.length, 0);
    await owner.request('groups.update', { id: group.id, revision: group.revision, name: '응답성 검증', cwd: projectA, profileId: cmd.id });
    const first = await owner.request<TerminalInfo>('terminals.create', { groupId: group.id, profileId: cmd.id, cwd: projectA });
    const second = await owner.request<TerminalInfo>('terminals.create', { groupId: group.id, tabTarget: first.id, profileId: cmd.id, cwd: projectB });
    await owner.request('terminals.rename', { id: first.id, title: '출력 중인 터미널' });
    await owner.request('terminals.rename', { id: second.id, title: '두 번째 터미널' });
    const identity = (value: HostState) => value.terminals.map(({ id, pid, generation }) => ({ id, pid, generation }));
    const before = identity(await state());
    const pane = (id: string) => page.locator(`.pane[data-terminal-id="${id}"]`);
    await page.getByRole('tab', { name: '출력 중인 터미널', exact: true }).click();
    await expect(pane(first.id).getByText('여기서 제어 중', { exact: true })).toBeVisible();
    await page.evaluate(() => { (window as any).__responsivenessNodes = new Map(Array.from(document.querySelectorAll('.pane')).map(pane => [pane.getAttribute('data-terminal-id'), pane.querySelector('.xterm')])); });
    const command = async (id: string, text: string) => { await pane(id).locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText(text); await page.keyboard.press('Enter'); };
    await command(first.id, `set MONGLE_RESPONSE_PROOF=SESSION_OK& "${process.execPath}" "${stream}"`);
    await expect.poll(() => existsSync(path.join(projectA, 'stream.started'))).toBe(true);
    await expect(pane(first.id).locator('.xterm-rows')).toContainText('MONGLE_BURST_');
    await page.getByRole('button', { name: '파일 탐색기', exact: true }).click();
    const explorer = page.getByRole('complementary', { name: '파일 탐색기' });
    await expect(explorer.getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
    for (let index = 0; index < 6; index++) await explorer.getByRole('button', { name: `folder-${String(index).padStart(2, '0')}`, exact: true }).click();
    for (let index = 0; index < 6; index++) await explorer.getByRole('button', { name: `folder-${String(index).padStart(2, '0')}`, exact: true }).click();
    await explorer.getByRole('button', { name: 'first.txt', exact: true }).click();
    await explorer.getByRole('button', { name: 'latest.txt', exact: true }).click();
    await expect(explorer.locator('pre')).toHaveText('LATEST_PREVIEW_CHANGED\n');
    assert.equal(existsSync(path.join(projectA, 'stream.done')), false, 'The explorer interactions completed while the actual shell was still producing output');
    steps.push('Expanded and collapsed six folders, changed previews, and rendered the latest file while actual cmd/Node output continued through ConPTY.');
    await explorer.getByRole('tab', { name: /^Git/ }).click();
    await explorer.getByRole('button', { name: 'latest.txt · 수정됨', exact: true }).click();
    await expect(explorer.locator('pre')).toHaveText('LATEST_PREVIEW_CHANGED\n');
    await explorer.getByRole('tab', { name: '파일', exact: true }).click();
    await page.getByRole('tab', { name: '두 번째 터미널', exact: true }).click();
    await expect(explorer.getByRole('button', { name: 'second.txt', exact: true })).toBeVisible();
    await explorer.getByRole('button', { name: 'second.txt', exact: true }).click();
    await expect(explorer.locator('pre')).toHaveText('SECOND_PROJECT_PREVIEW\n');
    assert.equal(existsSync(path.join(projectA, 'stream.done')), false, 'Tab navigation completed before releasing the continuous-output fixture');
    await page.screenshot({ path: path.join(output, 'scope-switch-during-output.png') });
    await page.getByRole('tab', { name: '출력 중인 터미널', exact: true }).click();
    await expect(explorer.getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
    await writeFile(path.join(projectA, 'stream.stop'), 'stop after UI interactions');
    await expect.poll(() => existsSync(path.join(projectA, 'stream.done')), { timeout: 20_000 }).toBe(true);
    await expect(pane(first.id).locator('.xterm-rows')).toContainText('MONGLE_STREAM_DONE');
    steps.push('Git modified-file preview and terminal selection used their current folders; continuous output reached completion after returning to the original terminal.');
    await command(first.id, 'echo MONGLE_ALIVE_%MONGLE_RESPONSE_PROOF%');
    await expect(pane(first.id).locator('.xterm-rows')).toContainText('MONGLE_ALIVE_SESSION_OK');
    const nested = path.join(projectA, 'folder-00');
    await command(first.id, `cd /d "${nested}"`);
    await expect.poll(async () => realpath(await explorer.locator('.file-root').innerText())).toBe(await realpath(nested));
    await explorer.getByRole('button', { name: 'nested.txt', exact: true }).click();
    await expect(explorer.locator('pre')).toHaveText('Folder 0 fixture\n');
    assert.deepEqual(identity(await state()), before);
    assert.equal(await page.evaluate(() => Array.from((window as any).__responsivenessNodes as Map<string, Element>).every(([id, node]) => document.querySelector(`.pane[data-terminal-id="${id}"] .xterm`) === node)), true);
    await expect(explorer.getByRole('alert')).toHaveCount(0);
    assert.deepEqual(errors, []);
    steps.push('Original shell variables, both PIDs/generations and xterm DOM nodes survived; an actual cd updated the tree and nested preview.');
    await page.screenshot({ path: path.join(output, 'current-folder-and-live-shell.png') });
    proof.passed = true;
  } catch (error) {
    proof.error = error instanceof Error ? error.stack : String(error);
    await app?.windows()[0]?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (!owner) owner = await connectOwnerPipe({ dataDir }).catch(() => undefined);
    if (owner) { try { await owner.request('host.shutdown'); } catch (error) { proof.cleanupError = String(error); proof.passed = false; } owner.close(); }
    await app?.close().catch(() => {});
    if (helper === undefined) delete process.env.MONGLE_OWNER_HELPER; else process.env.MONGLE_OWNER_HELPER = helper;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(proof, null, 2));
    assert.equal(proof.cleanupError, undefined, 'The isolated host must accept normal shutdown');
  }
});
