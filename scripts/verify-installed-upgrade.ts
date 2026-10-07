/** Destructive installer smoke test: run ONLY on disposable GitHub-hosted Windows. */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, access, readdir, copyFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { connectOwnerPipe } from '../packages/local-ipc/index';
import type { HostState, TerminalInfo } from '../packages/protocol/index';
import { PREVIOUS_PUBLIC_VERSION, updateInstallerArgs, assertUpdateWindows, assertExactAgentRestores, findUpdatedDesktop, boundedObserverEvents, type WindowEvidence, type AgentFixtureRecord } from '../tests/fixtures/installed-upgrade-evidence';
import { version } from '../package.json';

assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Never install over a developer/user installation');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable hosted runner is mandatory');
const run = promisify(execFile);
const output = path.resolve('test-results/installed-upgrade');
await mkdir(output, { recursive: true });
// Expand actual 8.3 aliases (e.g. RUNNER~1) before deriving /D and observer
// targets. Get-Process.Path reports long paths; string resolution cannot do this.
const root = await promisify(realpath.native)(await mkdtemp(path.join(tmpdir(), 'mongle-installed-upgrade-')));
// Explorer's automatic shortcut launch does not inherit our temporary env. The
// disposable runner's empty DEFAULT profile is the isolated test profile here.
const dataDir = path.join(process.env.LOCALAPPDATA!, 'MongleTerminal'), workspace = path.join(root, 'workspace');
const claudeHome = path.join(process.env.USERPROFILE!, '.claude'), codexHome = path.join(process.env.USERPROFILE!, '.codex');
const fixtureBin = path.join(root, 'fixture-bin'), agentLog = path.join(root, 'agents.jsonl');
const windowsFixture = path.resolve('tests/fixtures/installed-upgrade-windows.ps1');
const installDir = path.join(root, 'application');
const exe = path.join(installDir, 'MongleTerminal.exe');
const helper = path.resolve('release/win-unpacked/resources/hostbundle/platform/windows/OwnerPipe.exe');
const newInstaller = path.resolve(`release/MongleTerminal-Setup-${version}-x64.exe`);
const oldVersion = PREVIOUS_PUBLIC_VERSION;
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
  return { files: entries.length, sha256: sha(Buffer.from(JSON.stringify(entries))), entries };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const proof: Record<string, any> = { passed: false, oldVersion, newVersion: version, stages: [] };
proof.profile = 'empty default LOCALAPPDATA profile on disposable GitHub-hosted VM (not a developer profile)';
proof.agentScope = 'isolated CLI test doubles invoking packaged hooks; no vendor CLI authentication, model calls or Codex hook-trust validation';
proof.updateRuns = [];
let child: ChildProcess | undefined, endpoint = '', owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
let desktopPid = 0, restoreEnvironment: string | undefined;
let watcher: ChildProcess | undefined, watcherStop = '';
let updateSince = '', expectedHostId = '';
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
async function native(mode: 'exit' | 'environment' | 'discover' | 'diagnose', config: unknown) {
  const file = path.join(root, mode + '-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(config));
  return run('pwsh.exe', ['-NoProfile', '-File', windowsFixture, '-Mode', mode, '-Config', file], {windowsHide:true, timeout:60000});
}
async function connectInstalled(expectedVersion: string) {
  try {
  process.env.MONGLE_OWNER_HELPER = path.join(installDir, 'resources/hostbundle/platform/windows/OwnerPipe.exe');
  const state = await until(async () => { owner?.close(); owner = await connectOwnerPipe({ dataDir }); return owner.request<HostState>('state.get'); }, s => s.version === expectedVersion, 'authenticated installed host');
  const info = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
  const identity = await owner!.request<{hostId:string;bootId:string;pid?:number;dataDir:string}>('host.info');
  assert.equal(info.hostId, state.hostId); assert.equal(info.bootId, state.bootId);
  assert.equal(identity.hostId, state.hostId); assert.equal(identity.bootId, state.bootId);
  assert.equal(path.resolve(identity.dataDir), path.resolve(dataDir));
  if (expectedHostId) assert.equal(state.hostId, expectedHostId, 'Cleanup must connect to the same installed owner host');
  else expectedHostId = state.hostId;
  pids.add(info.pid);
  return info;
  } catch (error) {
    // An authenticated pipe with a mismatched host/boot/data-directory is not
    // authorised for cleanup. Never retain it for the finally shutdown path.
    owner?.close(); owner = undefined;
    throw error;
  }
}
async function start(expectedVersion: string) {
  // Every previous stage completed fullExit; do not track reusable numeric
  // PIDs from an earlier installation in the next stage's cleanup assertion.
  pids.clear();
  endpoint = '';
  const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(exe, ['--inspect=127.0.0.1:0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  desktopPid = child.pid!;
  pids.add(child.pid!);
  child.stderr!.on('data', bytes => { endpoint ||= String(bytes).match(/ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+/)?.[0] || ''; });
  await until(async () => endpoint, Boolean, 'main inspector');
  // The inspector can accept requests before Electron has read package.json.
  // At that point getVersion() may still return the four-part Windows resource
  // version. Wait for real startup, then verify both versions without coercion.
  const started = await evaluate("(async()=>{const require=process.getBuiltinModule('node:module').createRequire(process.execPath);globalThis.upgradeElectron=require('electron');const app=upgradeElectron.app;const beforeReady=app.getVersion();await app.whenReady();return {ready:app.isReady(),beforeReady,appVersion:app.getVersion(),manifestVersion:require(app.getAppPath()+'/package.json').version};})()");
  (proof.startup ??= []).push({ expectedVersion, ...started });
  assert.equal(started.ready, true);
  assert.equal(started.manifestVersion, expectedVersion);
  assert.equal(started.appVersion, expectedVersion);
  return connectInstalled(expectedVersion);
}
async function fullExit() {
  const state = await owner!.request<HostState>('state.get');
  const shellPids = state.terminals.flatMap(t => t.pid ? [t.pid] : []); shellPids.forEach(pid => pids.add(pid));
  const info = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8'));
  // Only the confirmation answer is automated. Production menu, host shutdown,
  // durable storage, process exit and restart are exercised without replacements.
  if (endpoint) {
    await evaluate("(()=>{upgradeElectron.dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});const item=upgradeElectron.Menu.getApplicationMenu().items.flatMap(i=>i.submenu?.items||[]).find(i=>i.label==='완전 종료…');if(!item)throw Error('Missing full exit menu');setTimeout(()=>item.click({},upgradeElectron.BrowserWindow.getAllWindows()[0]),30);return true;})()");
  } else {
    const confirmation = JSON.parse((await native('exit', {pid:desktopPid,exe})).stdout.replace(/^\uFEFF/, '').trim());
    assert.equal(confirmation.menuInvoked, true); assert.equal(confirmation.confirmationClicked, true);
  }
  await until(async () => !alive(desktopPid), Boolean, 'normal desktop full exit');
  await until(async () => [info.pid, ...shellPids].every(pid => !alive(pid)), Boolean, 'host and shell shutdown');
  await until(async () => [...pids].every(pid => !alive(pid)), Boolean, 'all owned processes including fixture agents exited');
  await assert.rejects(access(path.join(dataDir, 'host-info.json')), { code: 'ENOENT' });
  owner?.close(); owner = undefined;
  endpoint = ''; child = undefined;
}

async function stopWatcher() {
  if (!watcher) return;
  await writeFile(watcherStop, 'stop');
  await until(async () => watcher!.exitCode, code => code !== null, 'native observer stop', 15000);
  assert.equal(watcher.exitCode, 0, 'Native window observer failed');
  watcher = undefined;
}
async function observedUpdate(legacySilent: boolean) {
  assert.ok(!alive(desktopPid), 'Desktop must exit normally before replacement');
  assert.ok([...pids].every(pid => !alive(pid)), 'Owned host, shells and fixture agents must exit before replacement');
  const previousPids = [...pids]; pids.clear(); endpoint = ''; child = undefined;
  desktopPid = 0; updateSince = new Date().toISOString();
  const stage = legacySilent ? 'legacy-silent-update' : 'visible-candidate-reinstall';
  const config = {installer:newInstaller, exe, ready:path.join(root, stage+'.ready'), stop:path.join(root, stage+'.stop'), events:path.join(root, stage+'.jsonl')};
  watcherStop = config.stop;
  const configPath = path.join(root, stage+'.json');
  await writeFile(configPath, JSON.stringify(config));
  watcher = spawn('pwsh.exe', ['-NoProfile','-File',windowsFixture,'-Mode','watch','-Config',configPath], {windowsHide:true, stdio:'ignore'});
  watcher.on('error', error => { proof.observerError = String(error); });
  await until(async () => {await access(config.ready);return true;}, Boolean, 'native window observer readiness', 20000);
  const args = updateInstallerArgs(installDir, legacySilent);
  const stageProof: Record<string, any> = {stage,args,reinstall:!legacySilent,automaticRelaunch:false,progressVisible:false};
  proof.updateRuns.push(stageProof);
  try {
    // These are the real updater NSIS arguments, not a plain /S installation.
    // Never start the candidate manually: the shortcut launch is the assertion.
    // Both Explorer and its fallback use the guarded, empty default profile.
    // MONGLE_DATA_DIR would disable production integration setup in launchHost.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['MONGLE_DATA_DIR','MONGLE_CLAUDE_CONFIG_DIR','MONGLE_CODEX_HOME','CLAUDE_CONFIG_DIR','CODEX_HOME','ELECTRON_RUN_AS_NODE']) delete env[key];
    await run(newInstaller, args, {env, windowsHide:false, timeout:180000});
    stageProof.installerExitCode = 0;
    await until(async () => {
      const raw = await readFile(config.events,'utf8');
      stageProof.observedEvents = boundedObserverEvents(raw);
      const events: WindowEvidence[] = raw.replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
      const desktop = findUpdatedDesktop(events,exe,updateSince);
      if (desktop) { desktopPid=desktop.pid; pids.add(desktopPid); }
      return assertUpdateWindows(events,newInstaller,exe,previousPids);
    }, Boolean, 'visible NSIS progress and automatic --updated desktop', 45000).then(evidence=>{
      Object.assign(stageProof,evidence,{automaticRelaunch:true,progressVisible:true});
      desktopPid=evidence.desktop.pid;pids.add(desktopPid);
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(installDir,'resources/mongle-installed.json'),'utf8')), {installed:true});
    return await connectInstalled(version);
  } catch (error) {
    // Diagnostics never select a cleanup target or substitute for launch proof.
    try { stageProof.failureProcesses = JSON.parse((await native('diagnose',{installer:newInstaller,exe})).stdout.replace(/^\uFEFF/,'').trim()); }
    catch (diagnosticError) { stageProof.processDiagnosticError = String(diagnosticError); }
    try {
      const info=JSON.parse(await readFile(path.join(dataDir,'host-info.json'),'utf8'));
      stageProof.failureHostInfo={pid:info.pid,hostId:info.hostId,bootId:info.bootId,port:info.port,protocolVersion:info.protocolVersion};
    } catch (diagnosticError) { stageProof.hostInfoDiagnosticError = String(diagnosticError); }
    try { stageProof.failureMarker=JSON.parse(await readFile(path.join(installDir,'resources/mongle-installed.json'),'utf8')); }
    catch (diagnosticError) { stageProof.markerDiagnosticError = String(diagnosticError); }
    try { await assertCandidateBytes(); }
    catch (diagnosticError) { stageProof.bytesDiagnosticError = String(diagnosticError); }
    // List only the guarded installation root and one level of child directories;
    // this exposes accidental APP_FILENAME nesting without accepting that path.
    try {
      stageProof.installationEntries=(await readdir(installDir,{withFileTypes:true})).slice(0,32).map(e=>({name:e.name,directory:e.isDirectory()}));
      stageProof.nestedExecutables=[];
      for(const entry of stageProof.installationEntries.filter((e:any)=>e.directory)) {
        const candidate=path.join(installDir,entry.name,'MongleTerminal.exe');
        try { await access(candidate);stageProof.nestedExecutables.push(candidate); } catch {}
      }
    } catch (diagnosticError) { stageProof.directoryDiagnosticError = String(diagnosticError); }
    throw error;
  } finally {
    try { await stopWatcher(); }
    finally {
      // Preserve raw observations even when installer/window assertions fail.
      try { stageProof.observedEvents = boundedObserverEvents(await readFile(config.events,'utf8')); }
      catch (error) { stageProof.observerReadError = String(error); }
    }
  }
}
async function assertCandidateBytes() {
  const installedAsar = sha(await readFile(path.join(installDir, 'resources/app.asar')));
  proof.installedAsarSha256 = installedAsar;
  assert.equal(installedAsar, sha(await readFile('release/win-unpacked/resources/app.asar')));
  const installedBundle = await bundleFingerprint(path.join(installDir, 'resources/hostbundle'));
  proof.installedHostBundle = { files: installedBundle.files, sha256: installedBundle.sha256 };
  const candidateBundle = await bundleFingerprint('release/win-unpacked/resources/hostbundle');
  const installedFiles = new Map(installedBundle.entries), candidateFiles = new Map(candidateBundle.entries);
  proof.bundleDifference = {
    missing: candidateBundle.entries.filter(([file]) => !installedFiles.has(file)).map(([file]) => file),
    extra: installedBundle.entries.filter(([file]) => !candidateFiles.has(file)).map(([file]) => file),
    changed: candidateBundle.entries.filter(([file, hash]) => installedFiles.has(file) && installedFiles.get(file) !== hash).map(([file]) => file),
  };
  assert.deepEqual(proof.bundleDifference, { missing: [], extra: [], changed: [] });
  proof.installedAsarSha256 = installedAsar;
  proof.installedHostBundle = { files: installedBundle.files, sha256: installedBundle.sha256 };
  proof.updateRuns.at(-1).candidateBytesVerified = true;
}
async function prepareAgentFixtures() {
  // Both vendor config directories must be absent on this disposable VM.
  // This does not copy auth/session data or grant trust to the real Codex CLI.
  await assert.rejects(access(claudeHome), {code:'ENOENT'});
  await assert.rejects(access(codexHome), {code:'ENOENT'});
  await mkdir(fixtureBin);
  await copyFile('tests/fixtures/installed-upgrade-agent.cjs',path.join(fixtureBin,'agent.cjs'));
  await writeFile(path.join(fixtureBin,'node.path'),path.resolve('release/win-unpacked/resources/hostbundle/runtime/node.exe'));
  const csc=path.join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await run(csc,['/nologo','/out:'+path.join(fixtureBin,'claude.exe'),path.resolve('tests/fixtures/InstalledUpgradeAgent.cs')],{windowsHide:true,timeout:30000});
  await copyFile(path.join(fixtureBin,'claude.exe'),path.join(fixtureBin,'codex.exe'));
  const sessions = ['claude','claude','codex','codex'].map(provider=>({provider,sessionId:randomUUID()}));
  await writeFile(path.join(fixtureBin,'fixture.json'),JSON.stringify({sessions,claudeHome,codexHome,log:agentLog}));
  // ExecShellAsUser may use Explorer's environment. Update only the disposable
  // user's PATH, notify Explorer, and restore it in finally. Keep a single PATH key.
  const before=await run('powershell.exe',['-NoProfile','-Command',"[pscustomobject]@{Path=[Environment]::GetEnvironmentVariable('Path','User')} | ConvertTo-Json -Compress"],{windowsHide:true});
  restoreEnvironment=path.join(root,'original-environment.json');await writeFile(restoreEnvironment,before.stdout.trim());
  const originalPath=Object.entries(process.env).find(([key])=>key.toUpperCase()==='PATH')?.[1]||'';
  await native('environment',{Path:fixtureBin+';'+originalPath});
  for(const key of Object.keys(process.env))if(key.toUpperCase()==='PATH')delete process.env[key];
  process.env.Path=fixtureBin+';'+originalPath;
  return sessions;
}
async function input(terminal: TerminalInfo, command: string) {
  const state=await owner!.request<HostState>('state.get');
  const target={id:terminal.id,generation:terminal.generation,hostId:state.hostId,bootId:state.bootId};
  const lease=await owner!.request<any>('control.acquire',{...target,cols:100,rows:30});
  await owner!.request('terminal.ack',{...target,seq:lease.frame.seq,epoch:lease.epoch});
  await owner!.request('terminal.input',{...target,epoch:lease.epoch,inputId:randomUUID(),clientInputSeq:0,data:command+'\r'});
}
async function agentRecords(): Promise<AgentFixtureRecord[]> {
  return (await readFile(agentLog,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}
function savedAgents() {
  const db=new DatabaseSync(path.join(dataDir,'sessions.sqlite'),{readOnly:true});
  try {const row=db.prepare("SELECT value FROM metadata WHERE key='host'").get() as {value:string};return JSON.parse(row.value).agentSessions||{};}
  finally {db.close();}
}

const metadata = (state: HostState) => ({ groups: state.groups, terminals: state.terminals.map(({ id, groupId, title, cwd, profileId }) => ({ id, groupId, title, cwd, profileId })) });
try {
  await assert.rejects(access(path.join(process.env.LOCALAPPDATA!, 'Programs/MongleTerminal/MongleTerminal.exe')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(process.env.LOCALAPPDATA!, 'MongleTerminal/host-info.json')), { code: 'ENOENT' });
  await assert.rejects(access(dataDir), {code:'ENOENT'});
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
  const sessions = await prepareAgentFixtures();
  const newInfo = await observedUpdate(true);
  await assertCandidateBytes();
  proof.stages.push('0.3.16 to candidate: legacy /S --updated --force-run showed progress and automatically relaunched installed desktop');
  const restored = await until(() => owner!.request<HostState>('state.get'), s => s.terminals.length === 2 && s.terminals.every(t => t.status === 'running' && !!t.pid), 'automatic workspace restore');
  assert.deepEqual(metadata(restored), expectedMetadata); assert.equal(restored.hostId, before.hostId); assert.notEqual(newInfo.bootId, oldInfo.bootId);
  // fullExit already proved the old OS processes exited. Windows may reuse a
  // numeric PID for a new process; the host's session generation must be fresh.
  for (const terminal of restored.terminals) {
    assert.notEqual(terminal.generation, before.terminals.find(t => t.id === terminal.id)!.generation);
    assert.ok(terminal.pid && alive(terminal.pid), 'Restored shell must be a live process');
  }
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), '# 설치 교체 검증\n\n보존할 문서입니다.\n');
  proof.stages.push('same workspace metadata and document restored automatically with fresh host and shells');
  assert.equal(restored.claudeIntegration?.status, 'ready');
  assert.equal(restored.codexIntegration?.status, 'installed');
  const powershell = restored.profiles.find(p => p.kind === 'powershell'); assert.ok(powershell);
  const agentTerminals: Array<{terminal:TerminalInfo;session:{provider:string;sessionId:string}}> = [];
  for (const session of sessions) {
    const terminal = await owner!.request<TerminalInfo>('terminals.create',{groupId:restored.groups[0].id,profileId:powershell.id,cwd:workspace});
    // PowerShell prompt hook must have completed before typing a real command.
    await until(() => owner!.request<HostState>('state.get'), s => s.terminals.some(t => t.id===terminal.id && t.currentCwd===workspace), 'fixture shell prompt');
    await input(terminal,session.provider+' --fixture-session '+session.sessionId);
    agentTerminals.push({terminal,session});
  }
  await until(agentRecords, records=>records.length===sessions.length,'four live exact-ID fixtures');
  const seededRecords=await agentRecords();
  for(const record of seededRecords){assert.equal(record.resumed,false);pids.add(record.pid);}
  await until(async()=>savedAgents(), map=>agentTerminals.every(({terminal,session})=>map[terminal.id]?.session.sessionId===session.sessionId&&map[terminal.id]?.session.provider===session.provider),'packaged host persisted per-terminal identities');
  const seeded=await owner!.request<HostState>('state.get');
  const publicState=JSON.stringify(seeded);
  for(const session of sessions)assert.ok(!publicState.includes(session.sessionId),'private identity leaked in state');
  await fullExit();
  const checkpoint=savedAgents();
  for(const {terminal,session} of agentTerminals)assert.equal(checkpoint[terminal.id]?.session.sessionId,session.sessionId);
  const reinstalledInfo=await observedUpdate(false);
  await assertCandidateBytes();
  const finalState=await until(()=>owner!.request<HostState>('state.get'),s=>s.terminals.length===seeded.terminals.length&&s.terminals.every(t=>t.status==='running'&&!!t.pid),'same-candidate automatic terminal restore');
  assert.deepEqual(metadata(finalState),metadata(seeded));
  assert.equal(finalState.hostId,seeded.hostId);assert.notEqual(reinstalledInfo.bootId,newInfo.bootId);
  for(const terminal of finalState.terminals) {
    assert.notEqual(terminal.generation,seeded.terminals.find(t=>t.id===terminal.id)!.generation);
    assert.ok(terminal.pid&&alive(terminal.pid));
  }
  const allRecords=await until(agentRecords,records=>records.length>=sessions.length*2,'automatic exact agent resumes after NSIS replacement');
  assertExactAgentRestores(sessions,allRecords.slice(seededRecords.length),workspace);
  for(const record of allRecords.slice(seededRecords.length)){assert.ok(alive(record.pid));pids.add(record.pid);}
  await until(async()=>savedAgents(), map=>agentTerminals.every(({terminal,session})=>map[terminal.id]?.session.sessionId===session.sessionId&&map[terminal.id]?.generation===finalState.terminals.find(t=>t.id===terminal.id)!.generation),'exact identity metadata preserved after resume with new terminal generations');
  // Observe beyond startup to reject accidental duplicate automatic dispatches.
  await new Promise(r=>setTimeout(r,2000));
  assertExactAgentRestores(sessions,(await agentRecords()).slice(seededRecords.length),workspace);
  proof.agentRestore={sameCandidateReinstall:true,providers:['claude','codex'],terminals:sessions.length,exactOnce:true,metadataPreservedAfterResume:true,realVendorCli:false};
  proof.stages.push('candidate reinstall: visible --updated --force-run, automatic desktop and four exact-ID fixture conversations restored with identity metadata preserved');
  assert.equal(await readFile(path.join(workspace,'README.md'),'utf8'),'# 설치 교체 검증\n\n보존할 문서입니다.\n');

  await fullExit(); proof.cleanedUp = [...pids].every(pid => !alive(pid)); assert.equal(proof.cleanedUp, true);
  proof.passed = true;
} catch (error) {
  proof.error = String(error); throw error;
} finally {
  await stopWatcher().catch(error=>{proof.observerCleanupError=String(error);proof.passed=false;});
  if (updateSince && !owner) {
    try {
      // The observer can fail or miss progress while NSIS still launches the app.
      // Discovery never turns missing visual evidence into a passing verdict.
      const found: WindowEvidence[] = JSON.parse((await native('discover',{exe,since:updateSince})).stdout.trim());
      const desktop = findUpdatedDesktop(found,exe,updateSince);
      if (desktop) {
        desktopPid=desktop.pid; pids.add(desktopPid);
        proof.failureCleanupDesktop={pid:desktopPid,path:desktop.path};
        await connectInstalled(version);
      }
    } catch(error) {proof.desktopDiscoveryCleanupError=String(error);proof.passed=false;}
  }
  if (!owner && desktopPid && alive(desktopPid)) {
    await connectInstalled(version).catch(error=>{proof.ownerCleanupError=String(error);proof.passed=false;});
  }
  if (owner && desktopPid && alive(desktopPid)) await fullExit().catch(error=>{proof.fullExitCleanupError=String(error);proof.passed=false;});
  if (owner) { await owner.request('host.shutdown').catch(() => {}); owner.close(); }
  if (child && child.exitCode === null && endpoint) await evaluate('setTimeout(()=>upgradeElectron.app.quit(),30);true').catch(() => {});
  if (restoreEnvironment) {
    await native('environment',JSON.parse(await readFile(restoreEnvironment,'utf8'))).catch(error=>{proof.environmentCleanupError=String(error);proof.passed=false;});
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
  if (!proof.passed) process.exitCode=1;
}
