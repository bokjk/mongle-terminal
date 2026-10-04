/** Destructive installer smoke test: run ONLY on disposable GitHub-hosted Windows. */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { connectOwnerPipe } from '../packages/local-ipc/index';
import type { HostState } from '../packages/protocol/index';
import { version } from '../package.json';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Never install over a developer/user installation');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable hosted runner is mandatory');
const run = promisify(execFile);
const output = path.resolve('test-results/installed-upgrade');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'mongle-installed-upgrade-'));
const dataDir = path.join(root, 'profile'), workspace = path.join(root, 'workspace');
const installDir = path.join(root, 'application');
const exe = path.join(installDir, 'MongleTerminal.exe');
const helper = path.resolve('release/win-unpacked/resources/hostbundle/platform/windows/OwnerPipe.exe');
const newInstaller = path.resolve(`release/MongleTerminal-Setup-${version}-x64.exe`);
const oldVersion = '0.3.8';
const oldName = `MongleTerminal-Setup-${oldVersion}-x64.exe`;
const oldInstaller = path.join(root, oldName);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function bundleFingerprint(directory: string) {
  const entries: Array<[string, string]> = [];
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else { assert.ok(entry.isFile(), 'Unexpected link in installed bundle'); entries.push([name.replaceAll('\\', '/'), sha(await readFile(path.join(directory, name)))]); }
    }
  }
  await visit(''); entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { files: entries.length, sha256: sha(Buffer.from(JSON.stringify(entries))) };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const proof: Record<string, any> = { passed: false, oldVersion, newVersion: version, stages: [] };
let child: ChildProcess | undefined, endpoint = '', owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
const pids = new Set<number>();
async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean, label: string, timeout = 45000): Promise<T> {
  const deadline = Date.now() + timeout; let last: unknown;
  do { try { const value = await read(); if (valid(value)) return value; } catch (e) { last = e; } await new Promise(r => setTimeout(r, 200)); } while (Date.now() < deadline);
  throw new Error(`${label}: timed out (${String(last)})`);
}
async function evaluate(expression: string) {
  const ws = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject, { once: true }); });
  try {
    const result = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Main process inspection timed out')), 15000); ws.addEventListener('message', event => { const value = JSON.parse(String(event.data)); if (value.id === 1) { clearTimeout(timer); resolve(value); } }); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const response = await result;
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description);
    return response.result.result.value;
  } finally { ws.close(); }
}
async function install(file: string) {
  assert.ok(!child || child.exitCode !== null, 'Desktop must exit normally before replacement');
  await run(file, ['/S', '/currentuser', `/D=${installDir}`], { windowsHide: true, timeout: 180000 });
  assert.deepEqual(JSON.parse(await readFile(path.join(installDir, 'resources/mongle-installed.json'), 'utf8')), { installed: true });
}
async function start(expectedVersion: string) {
  endpoint = '';
  const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, ['--inspect=127.0.0.1:0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  pids.add(child.pid!);
  child.stderr!.on('data', bytes => { endpoint ||= String(bytes).match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)?.[0] || ''; });
  await until(async () => endpoint, Boolean, 'main inspector');
  const actualVersion = await evaluate("(()=>{globalThis.upgradeElectron=process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');return upgradeElectron.app.getVersion();})()");
  assert.equal(actualVersion, expectedVersion);
  process.env.MONGLE_OWNER_HELPER = path.join(installDir, 'resources/hostbundle/platform/windows/OwnerPipe.exe');
  await until(async () => { owner?.close(); owner = await connectOwnerPipe({ dataDir }); return owner.request<HostState>('state.get'); }, () => true, 'authenticated installed host');
  const info = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')); pids.add(info.pid);
  return info;
}
async function fullExit() {
  const state = await owner!.request<HostState>('state.get');
  const shellPids = state.terminals.flatMap(t => t.pid ? [t.pid] : []); shellPids.forEach(pid => pids.add(pid));
  const info = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
  // Only the confirmation answer is automated. Production menu, host shutdown,
  // durable storage, process exit and restart are exercised without replacements.
  await evaluate("(()=>{upgradeElectron.dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});const item=upgradeElectron.Menu.getApplicationMenu().items.flatMap(i=>i.submenu?.items||[]).find(i=>i.label==='완전 종료…');if(!item)throw Error('Missing full exit menu');setTimeout(()=>item.click({},upgradeElectron.BrowserWindow.getAllWindows()[0]),30);return true;})()");
  await until(async () => child!.exitCode, code => code !== null, 'normal desktop full exit');
  await until(async () => [info.pid, ...shellPids].every(pid => !alive(pid)), Boolean, 'host and shell shutdown');
  await assert.rejects(access(path.join(dataDir, 'host-info.json')), { code: 'ENOENT' });
  owner?.close(); owner = undefined;
}
const metadata = (state: HostState) => ({ groups: state.groups, terminals: state.terminals.map(({ id, groupId, title, cwd, profileId }) => ({ id, groupId, title, cwd, profileId })) });
try {
  await assert.rejects(access(path.join(process.env.LOCALAPPDATA!, 'Programs/MongleTerminal/MongleTerminal.exe')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(process.env.LOCALAPPDATA!, 'MongleTerminal/host-info.json')), { code: 'ENOENT' });
  await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), '# 설치 교체 검증\n\n보존할 문서입니다.\n');
  const base = `https://github.com/bokjk/mongle-terminal-releases/releases/download/v${oldVersion}`;
  const sumsResponse = await fetch(`${base}/SHA256SUMS.txt`); assert.ok(sumsResponse.ok);
  const sums = await sumsResponse.text(); const expected = sums.split(/\r?\n/).find(line => line.endsWith(oldName))?.split(/\s+/)[0]; assert.match(expected || '', /^[a-f\d]{64}$/i);
  const oldResponse = await fetch(`${base}/${oldName}`); assert.ok(oldResponse.ok); const oldBytes = Buffer.from(await oldResponse.arrayBuffer());
  assert.equal(sha(oldBytes), expected!.toLowerCase()); await writeFile(oldInstaller, oldBytes);
  proof.oldInstallerSha256 = sha(oldBytes); proof.newInstallerSha256 = sha(await readFile(newInstaller));
  await install(oldInstaller); proof.stages.push('real old NSIS installed and marker verified');
  await run(helper, ['prepare', dataDir], { windowsHide: true, timeout: 15000 });
  const oldInfo = await start(oldVersion); const initial = await owner!.request<HostState>('state.get');
  const profile = initial.profiles.find(p => p.kind === 'cmd'); assert.ok(profile);
  for (let i = 0; i < 2; i++) await owner!.request('terminals.create', { groupId: initial.groups[0].id, profileId: profile.id, cwd: workspace });
  const before = await until(() => owner!.request<HostState>('state.get'), s => s.terminals.length === 2 && s.terminals.every(t => t.status === 'running' && !!t.pid), 'old real shells');
  const expectedMetadata = metadata(before); proof.stages.push('old installed desktop, authenticated host and two real shells started');
  await fullExit(); proof.stages.push('old full exit preserved workspace and stopped owned processes');
  await install(newInstaller);
  const installedAsar = sha(await readFile(path.join(installDir, 'resources/app.asar')));
  assert.equal(installedAsar, sha(await readFile('release/win-unpacked/resources/app.asar')));
  const installedBundle = await bundleFingerprint(path.join(installDir, 'resources/hostbundle'));
  assert.deepEqual(installedBundle, await bundleFingerprint('release/win-unpacked/resources/hostbundle'));
  proof.installedAsarSha256 = installedAsar; proof.installedHostBundle = installedBundle;
  proof.stages.push('new real NSIS replaced desktop archive and complete host/web bundle with exact candidate bytes');
  const newInfo = await start(version);
  const restored = await until(() => owner!.request<HostState>('state.get'), s => s.terminals.length === 2 && s.terminals.every(t => t.status === 'running' && !!t.pid), 'automatic workspace restore');
  assert.deepEqual(metadata(restored), expectedMetadata); assert.equal(restored.hostId, before.hostId); assert.notEqual(newInfo.bootId, oldInfo.bootId);
  for (const terminal of restored.terminals) assert.notEqual(terminal.pid, before.terminals.find(t => t.id === terminal.id)!.pid);
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), '# 설치 교체 검증\n\n보존할 문서입니다.\n');
  proof.stages.push('same workspace metadata and document restored automatically with fresh host and shells');
  await fullExit(); proof.cleanedUp = [...pids].every(pid => !alive(pid)); assert.equal(proof.cleanedUp, true);
  proof.passed = true;
} catch (error) {
  proof.error = String(error); throw error;
} finally {
  if (owner) { await owner.request('host.shutdown').catch(() => {}); owner.close(); }
  if (child && child.exitCode === null && endpoint) await evaluate('setTimeout(()=>upgradeElectron.app.quit(),30);true').catch(() => {});
  await writeFile(path.join(output, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
}
