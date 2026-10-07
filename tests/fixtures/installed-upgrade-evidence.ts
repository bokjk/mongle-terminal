import assert from 'node:assert/strict';
import path from 'node:path';

export const PREVIOUS_PUBLIC_VERSION = '0.3.16';
interface InstalledHostState { version: string; hostId: string; bootId: string }
interface InstalledHostInfo { pid: number; hostId: string; bootId: string }
/** One coherent readiness attempt. Failed/unverified connections never escape. */
export async function readInstalledHost<C extends {request<T>(name: string): Promise<T>;close():void}>(
  connect:()=>Promise<C>, readInfo:()=>Promise<InstalledHostInfo>,
  expected:{version:string;dataDir:string;hostId?:string},
) {
  const connection=await connect();
  try {
    const state=await connection.request<InstalledHostState>('state.get');
    assert.equal(state.version,expected.version,'Installed host version is not ready');
    const info=await readInfo();
    const identity=await connection.request<InstalledHostInfo & {dataDir:string}>('host.info');
    assert.equal(info.hostId,state.hostId);assert.equal(info.bootId,state.bootId);
    assert.equal(identity.hostId,state.hostId);assert.equal(identity.bootId,state.bootId);
    assert.equal(path.resolve(identity.dataDir),path.resolve(expected.dataDir));
    assert.ok(Number.isSafeInteger(info.pid) && info.pid>0);
    if(identity.pid!==undefined)assert.equal(identity.pid,info.pid);
    if(expected.hostId)assert.equal(state.hostId,expected.hostId,'Cleanup must connect to the same installed owner host');
    return {connection,info,state};
  } catch(error) {connection.close();throw error;}
}
/** Diagnostic data only: never replace or relax the full event assertions. */
export function boundedObserverEvents(raw: string) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  return { totalLines: lines.length, rawLines: lines.slice(-64).map(line => line.slice(0, 8192)) };
}
export function updateInstallerArgs(directory: string, legacySilent: boolean) {
  // /D must be last in NSIS; never quote it as part of the argument value.
  return [...(legacySilent ? ['/S'] : []), '--updated', '--force-run', '/currentuser', '/D=' + directory];
}
export interface WindowEvidence {
  kind: 'installer' | 'desktop'; pid: number; path: string; visible: boolean; progress: boolean;
  commandLine: string; time: string;
}
/** Cleanup discovery is independent of visibility/progress verdicts. */
export function findUpdatedDesktop(events: WindowEvidence[], executable: string, since: string) {
  return events.find(e => e.kind === 'desktop' && Number.isSafeInteger(e.pid) && e.pid > 0
    && path.win32.resolve(e.path).toLowerCase() === path.win32.resolve(executable).toLowerCase()
    && /(?:^|\s)--updated(?:\s|$)/.test(e.commandLine)
    && !/(?:^|\s)--type(?:=|\s)/.test(e.commandLine)
    && Date.parse(e.time) >= Date.parse(since));
}
export function assertUpdateWindows(events: WindowEvidence[], installer: string, executable: string, oldPids: number[]) {
  const equal = (a: string, b: string) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
  const progress = events.find(e => e.kind === 'installer' && e.visible && e.progress && equal(e.path, installer));
  assert.ok(progress, 'No visible progress control observed in the actual NSIS installer');
  const desktop = events.find(e => e.kind === 'desktop' && e.visible && equal(e.path, executable) && /(?:^|\s)--updated(?:\s|$)/.test(e.commandLine));
  assert.ok(desktop, 'No visible installed desktop automatically launched with --updated');
  // PID reuse is valid after normal exit; observe the new process after the installation starts.
  assert.ok(Number.isSafeInteger(desktop.pid) && desktop.pid > 0);
  assert.ok(Date.parse(desktop.time) >= Date.parse(progress.time), 'Desktop appeared before observed installer progress');
  return {progress, desktop, previousPids: oldPids};
}
export interface AgentFixtureRecord {provider: string; sessionId: string; resumed: boolean; cwd: string; pid: number; args: string[]}
export function assertExactAgentRestores(expected: Array<{provider:string;sessionId:string}>, records: AgentFixtureRecord[], cwd: string) {
  assert.equal(records.length, expected.length, 'Every fixture must resume once, without extra launches');
  for (const session of expected) {
    const matching = records.filter(r => r.provider === session.provider && r.sessionId === session.sessionId);
    assert.equal(matching.length, 1, 'A conversation was missing, duplicated, or replaced with another ID');
    const [record] = matching;
    assert.equal(record.resumed, true);
    assert.equal(path.win32.resolve(record.cwd).toLowerCase(), path.win32.resolve(cwd).toLowerCase());
    assert.ok(!record.args.includes('--last') && !record.args.includes('--continue'), 'Latest-session fallback is forbidden');
    if (session.provider === 'codex') assert.ok(record.args.includes('--no-daemon'));
  }
}
