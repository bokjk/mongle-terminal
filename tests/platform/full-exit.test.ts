import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FullExitController, type FullExitDependencies, type FullExitSummary, type HostReadiness } from '../../apps/desktop/full-exit';
import { writeResumeManifest } from '../../apps/desktop/resume-manifest';
import { AppError, type HostState, type Transport } from '../../packages/protocol/index';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(overrides: Partial<FullExitDependencies> = {}) {
  const state = { hostId: 'local-host', bootId: 'local-boot', protocolVersion: 1, terminals: [{ status: 'running' }, { status: 'running' }, { status: 'interrupted' }], settings: { recordHistory: true } } as HostState;
  let readiness: HostReadiness | undefined = { pid: 123, hostId: state.hostId, bootId: state.bootId };
  let alive = true;
  let closed = () => {};
  const calls: string[] = [];
  const errors: string[] = [];
  const summaries: FullExitSummary[] = [];
  const owner: Transport = {
    async request<T>(method: string) { calls.push(method); return (method === 'state.get' ? state : { ok: true }) as T; },
    subscribe: () => () => {}, close: () => { calls.push('owner.close'); },
  };
  const d: FullExitDependencies = {
    connectLocal: async onClose => { calls.push('connect.local'); closed = onClose; return owner; },
    readReadiness: async () => readiness,
    isProcessAlive: () => alive,
    confirm: async summary => { summaries.push(summary); calls.push('confirm'); return true; },
    suspendDesktop: async () => { calls.push('suspend'); },
    keepDesktop: () => { calls.push('keep'); },
    quitDesktop: () => { calls.push('quit'); },
    showError: message => { errors.push(message); },
    timeoutMs: 250, pollMs: 1,
    ...overrides,
  };
  return {
    controller: new FullExitController(d), d, state, owner, calls, errors, summaries,
    closePipe: () => closed(),
    setAlive: (value: boolean) => { alive = value; },
    setReadiness: (value: HostReadiness | undefined) => { readiness = value; },
  };
}

test('cancel does not suspend, request shutdown, or quit; confirmation reflects only local state', async () => {
  const f = fixture({ confirm: async summary => { assert.deepEqual(summary, { runningTerminals: 2, recordHistory: true }); return false; } });
  await f.controller.run();
  assert.deepEqual(f.calls, ['connect.local', 'state.get', 'owner.close']);
  assert.deepEqual(f.errors, []);
});

test('coalesces concurrent menu calls; acknowledgement alone never quits', async () => {
  const confirm = deferred<boolean>();
  const f = fixture({ confirm: () => confirm.promise });
  const first = f.controller.run();
  assert.equal(f.controller.run(), first);
  await flush();
  assert.equal(f.calls.filter(c => c === 'connect.local').length, 1);
  confirm.resolve(true);
  await flush();
  assert.ok(f.calls.includes('host.shutdown'));
  assert.ok(!f.calls.includes('quit'));
  f.closePipe();
  f.setReadiness(undefined);
  await flush();
  assert.ok(!f.calls.includes('quit'), 'pipe close and removed readiness are insufficient while the host PID lives');
  f.setAlive(false);
  await first;
  assert.deepEqual(f.errors, []);
  assert.ok(f.calls.indexOf('suspend') < f.calls.indexOf('host.shutdown'));
  assert.equal(f.calls.filter(c => c === 'quit').length, 1);
});

test('waits for readiness removal even after authenticated close and PID exit', async () => {
  const f = fixture();
  const run = f.controller.run(); await flush();
  f.closePipe(); f.setAlive(false);
  await flush(); assert.ok(!f.calls.includes('quit'));
  f.setReadiness(undefined); await run;
  assert.ok(f.calls.includes('quit'));
});

test('drains older connection attempts before issuing local shutdown', async () => {
  const drain = deferred<void>();
  const f = fixture({ suspendDesktop: () => drain.promise });
  const run = f.controller.run(); await flush();
  assert.ok(!f.calls.includes('host.shutdown'));
  drain.resolve(); await flush();
  assert.ok(f.calls.includes('host.shutdown'));
  f.closePipe(); f.setAlive(false); f.setReadiness(undefined); await run;
  assert.ok(f.calls.includes('quit'));
});

test('authentication failure never quits, freezes, or invokes host shutdown', async () => {
  const f = fixture({ connectLocal: async () => { throw new AppError('AUTH_FAILED', 'Owner IPC server authentication failed.'); } });
  await f.controller.run();
  assert.deepEqual(f.calls, []);
  assert.match(f.errors[0]!, /authentication failed/);
});

test('a host persistence failure keeps the desktop and never treats IPC close as success', async () => {
  const f = fixture();
  f.owner.request = async <T>(method: string) => { f.calls.push(method); if (method === 'host.shutdown') throw new AppError('STORAGE_ERROR', '저장할 수 없습니다.'); return f.state as T; };
  await f.controller.run();
  assert.ok(f.calls.includes('keep'));
  assert.ok(!f.calls.includes('quit'));
  assert.match(f.errors[0]!, /저장할 수 없습니다/);
});

test('bounded completion timeout leaves the app available instead of trusting acknowledgement', async () => {
  const f = fixture({ timeoutMs: 25 });
  await f.controller.run();
  assert.ok(f.calls.includes('host.shutdown'));
  assert.ok(f.calls.includes('keep'));
  assert.ok(!f.calls.includes('quit'));
  assert.match(f.errors[0]!, /시간이 초과/);
});

test('missing local host can quit only after draining attempts and rechecking absence', async () => {
  let attempts = 0;
  const f = fixture({ connectLocal: async () => { attempts++; throw new AppError('NO_HOST', 'No host'); } });
  f.setReadiness(undefined); f.setAlive(false);
  await f.controller.run();
  assert.equal(attempts, 2);
  assert.deepEqual(f.calls, ['confirm', 'suspend', 'quit']);
  assert.equal(f.summaries[0]!.runningTerminals, 0);
});

test('missing IPC with live readiness PID cannot be mistaken for complete exit', async () => {
  const f = fixture({ connectLocal: async () => { throw new AppError('NO_HOST', 'No host'); } });
  await f.controller.run();
  assert.ok(!f.calls.includes('quit'));
  assert.ok(!f.calls.includes('confirm'));
  assert.match(f.errors[0]!, /백그라운드 실행이 남아/);
});

test('a host started by an older attempt during confirmation is not shut down under an empty-host confirmation', async () => {
  let attempts = 0;
  const f = fixture(); f.setReadiness(undefined); f.setAlive(false);
  f.d.connectLocal = async onClose => { attempts++; if (attempts === 1) throw new AppError('NO_HOST', 'No host'); return f.owner; };
  await f.controller.run();
  assert.ok(!f.calls.includes('quit'));
  assert.ok(!f.calls.includes('host.shutdown'));
  assert.ok(f.calls.includes('keep'));
  assert.match(f.errors[0]!, /백그라운드 실행이 시작/);
});

test('changed boot identity after confirmation prevents shutdown', async () => {
  const f = fixture();
  f.d.confirm = async () => { f.setReadiness({ pid: 123, hostId: 'local-host', bootId: 'new-boot' }); return true; };
  await f.controller.run();
  assert.ok(!f.calls.includes('host.shutdown'));
  assert.ok(!f.calls.includes('quit'));
  assert.match(f.errors[0]!, /실행 상태가 바뀌었습니다/);
});

test('new host readiness during shutdown leaves desktop open and does not target the replacement', async () => {
  const f = fixture();
  const run = f.controller.run(); await flush();
  f.closePipe(); f.setAlive(false);
  f.setReadiness({ pid: 456, hostId: 'local-host', bootId: 'next-boot' });
  await run;
  assert.ok(!f.calls.includes('quit'));
  assert.equal(f.calls.filter(c => c === 'host.shutdown').length, 1);
  assert.match(f.errors[0]!, /다른 백그라운드 실행/);
});

test('lost acknowledgement is accepted only after authenticated close and actual completion', async () => {
  const f = fixture();
  f.owner.request = async <T>(method: string) => {
    f.calls.push(method);
    if (method === 'host.shutdown') { f.closePipe(); f.setAlive(false); f.setReadiness(undefined); throw new AppError('IPC_CLOSED', 'Closed'); }
    return f.state as T;
  };
  await f.controller.run();
  assert.ok(f.calls.includes('quit'));
  assert.deepEqual(f.errors, []);
});

test('late connection after timeout is closed and cannot issue shutdown', async () => {
  const attached = deferred<Transport>();
  const f = fixture({ connectLocal: () => attached.promise, timeoutMs: 10 });
  await f.controller.run();
  attached.resolve(f.owner); await flush();
  assert.deepEqual(f.calls, ['owner.close']);
  assert.equal(f.errors.length, 1);
});

test('resume manifest is written only after actual host completion, before GUI quit', async () => {
  const f = fixture({ writeResumeManifest: async state => { assert.equal(state.hostId, 'local-host'); f.calls.push('manifest'); } });
  const run = f.controller.run(); await flush();
  assert.ok(!f.calls.includes('manifest'));
  f.closePipe(); f.setAlive(false); f.setReadiness(undefined); await run;
  assert.ok(f.calls.indexOf('manifest') < f.calls.indexOf('quit'));
  assert.deepEqual(f.errors, []);
});

test('resume manifest write failure reports that the host has stopped and keeps the GUI', async () => {
  const f = fixture({ writeResumeManifest: async () => { throw new Error('disk full'); } });
  const run = f.controller.run(); await flush();
  f.closePipe(); f.setAlive(false); f.setReadiness(undefined); await run;
  assert.ok(!f.calls.includes('quit'));
  assert.ok(f.calls.includes('keep'));
  assert.match(f.errors[0]!, /백그라운드 작업은 종료됐지만 다음 실행 복원 정보를 저장하지 못했습니다/);
});

test('legacy resume manifest stores only authenticated running identities and atomically replaces prior hints', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mongle-resume-'));
  try {
    const state = { hostId: randomUUID(), bootId: randomUUID(), terminals: [
      { id: randomUUID(), generation: randomUUID(), status: 'running', title: 'must-not-copy', cwd: 'must-not-copy' },
      { id: randomUUID(), generation: randomUUID(), status: 'exited' },
    ] } as HostState;
    await writeResumeManifest(directory, state);
    const target = path.join(directory, 'workspace-resume.json');
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 1, hostId: state.hostId, bootId: state.bootId, terminals: [{ id: state.terminals[0]!.id, generation: state.terminals[0]!.generation }] });
    state.terminals = [];
    await writeResumeManifest(directory, state);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).terminals, []);
    assert.deepEqual(await readdir(directory), ['workspace-resume.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
