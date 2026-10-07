import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import { HostStore } from '../../packages/storage/index.js';
import type { ConnectionContext, HostState, ServerMessage, ShellProfile, TerminalInfo } from '../../packages/protocol/index.js';
import type { TerminalEngine } from '../../packages/terminal/engine.js';

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'notification fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t: test.TestContext, recordHistory = false) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-notifications-'));
  const core = new HostCore({ dataDir });
  t.after(async () => {
    await core.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('mongle-notifications-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  await core.init();
  const internal = core as any;
  // Own isolated process only: no user shell profiles, commands or sessions.
  // Synthetic VT is injected at the engine boundary to avoid ConPTY filtering
  // escape sequences before they reach the host. Native CLI checks are separate.
  const profile: ShellProfile = { id: 'notification-fixture', name: 'Notification fixture', kind: 'cmd',
    executable: process.execPath, args: ['-e', "process.stdout.write('NOTIFICATION_FIXTURE_READY');setInterval(()=>{},1000)"] };
  internal.profiles.push(profile);
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Notification test', owner: true };
  const events: ServerMessage[] = [];
  core.connect(ctx, event => events.push(event));
  await core.handle('settings.update', { recordHistory }, ctx);
  const created: TerminalInfo = await core.handle('terminals.create', { groupId: core.getState().groups[0].id, profileId: profile.id, cwd: dataDir }, ctx);
  const info: TerminalInfo = internal.terminals.find((item: TerminalInfo) => item.id === created.id);
  const runtime = internal.runtimes.get(info.id) as { engine: TerminalEngine; timer?: ReturnType<typeof setTimeout>; framePending?: boolean; disposed: boolean; checkpointAt: number };
  await until(async () => (await runtime.engine.snapshot()).data.includes('NOTIFICATION_FIXTURE_READY'));
  await until(() => !runtime.framePending);
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = undefined;
  events.length = 0;
  const ref = () => ({ id: info.id, generation: info.generation, hostId: core.getState().hostId, bootId: core.getState().bootId });
  const states = () => events.filter((event): event is { type: 'state'; state: HostState } => 'type' in event && event.type === 'state');
  const emit = async (data: string) => { await runtime.engine.write(data); internal.scheduleFrame(runtime); };
  return { core, internal, ctx, events, info, runtime, states, emit, ref, dataDir, profile };
}

test('unattached notification bursts update live state immediately but coalesce broadcasts without metadata writes', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  const save = t.mock.method(h.internal.store as HostStore, 'save');
  await h.emit('\x07'.repeat(200) + '\x1b]9;SYNTHETIC_PRIVATE_MESSAGE\x07');
  assert.equal(h.core.getState().terminals[0].notificationCount, 201);
  assert.equal(h.states().length, 0, 'parsing a burst must not broadcast per signal');
  assert.equal(save.mock.callCount(), 0, 'parsing does not persist per signal');
  await until(() => h.states().length > 0);
  assert.equal(h.states().length, 1);
  assert.equal(h.states()[0].state.terminals[0].notificationCount, 201);
  assert.equal(save.mock.callCount(), 0, 'history-disabled metadata uses existing lifecycle persistence');
  assert.ok(!JSON.stringify(h.events).includes('SYNTHETIC_PRIVATE_MESSAGE'));
  h.core.disconnect(h.ctx.id);
  await h.emit('\x07');
  h.core.connect({ ...h.ctx, id: randomUUID() }, event => h.events.push(event));
  assert.equal(h.states().at(-1)!.state.terminals[0].notificationCount, 202, 'reconnect does not reset or depend on an attached pane');
  save.mock.restore();
});

test('an older captured frame never acknowledges notifications arriving during delivery', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  await h.emit('first\x07');
  const first = await h.core.handle('terminals.attach', h.ref(), h.ctx);
  assert.equal(first.snapshot.notificationCount, 1);
  await h.emit('second\x07');
  assert.equal(h.core.getState().terminals[0].notificationCount, 2);
  assert.equal(first.snapshot.notificationCount, 1);
  await h.core.handle('terminal.ack', { ...h.ref(), seq: first.seq }, h.ctx);
  const latest = await h.core.handle('terminals.attach', h.ref(), h.ctx);
  assert.equal(latest.snapshot.notificationCount, 2);
  await h.runtime.engine.resize(81, 24); await h.runtime.engine.clearHistory(); await h.emit('\x1bc');
  assert.equal(h.info.notificationCount, 2);
});

test('lifecycle persistence keeps counts, while restart and cold history restore start a new count', { timeout: 30000 }, async t => {
  const h = await fixture(t, true);
  await h.emit('retained\x07\x1b]9;finished\x07');
  await h.core.handle('terminals.rename', { id: h.info.id, title: 'Saved count' }, h.ctx);
  const saved = (h.internal.store as HostStore).load()!.terminals.find(info => info.id === h.info.id)!;
  assert.equal(saved.notificationCount, 2);
  const oldGeneration = h.info.generation;
  const oldSnapshot = await h.runtime.engine.snapshot();
  const restarted: TerminalInfo = await h.core.handle('terminals.restart', { ...h.ref(), confirmed: true }, h.ctx);
  assert.notEqual(restarted.generation, oldGeneration);
  assert.equal(restarted.notificationCount, 0);
  let runtime = h.internal.runtimes.get(h.info.id);
  assert.equal((await runtime.engine.snapshot()).notificationCount, 0);
  await runtime.engine.write('\x07');
  assert.equal(h.info.notificationCount, 1);
  await h.internal.disposeRuntime(h.info.id);
  h.info.status = 'interrupted'; h.info.notificationCount = 20;
  // Same path as a cold boot, with a stored payload deliberately containing
  // old signals and a stale count. Restoration must be presentation-only.
  (h.internal.store as HostStore).saveSnapshot(h.info.id, h.info.generation,
    { ...oldSnapshot, notificationCount: 20, data: oldSnapshot.data + '\x07\x1b]9;old\x07' });
  await h.internal.restoreTerminal(h.info);
  runtime = h.internal.runtimes.get(h.info.id);
  assert.equal(h.info.notificationCount, 0);
  const restored = await runtime.engine.snapshot();
  assert.equal(restored.notificationCount, 0);
  assert.ok(restored.data.includes('retained'));
  await runtime.engine.write('\x07');
  assert.equal(h.info.notificationCount, 1);
});

test('exiting without a signal is not a notification; shutdown and retired runtimes cannot notify', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  await h.emit('ordinary output');
  await h.core.handle('terminals.terminate', h.ref(), h.ctx);
  assert.equal(h.info.status, 'exited');
  assert.equal(h.info.notificationCount, 0);
  await h.internal.queue;
  await h.core.handle('terminals.restart', h.ref(), h.ctx);
  const runtime = h.internal.runtimes.get(h.info.id);
  await runtime.engine.write('\x07');
  assert.equal(h.info.notificationCount, 1);
  runtime.disposed = true;
  try {
    await runtime.engine.write('\x07');
    assert.equal((await runtime.engine.snapshot()).notificationCount, 1);
  } finally { runtime.disposed = false; }
  const state = await h.core.handle('host.shutdown', {}, h.ctx);
  assert.deepEqual(state, { ok: true });
  await runtime.engine.write('\x07\x1b]9;late\x07');
  assert.equal(h.info.notificationCount, 1);
  assert.equal((await runtime.engine.snapshot()).notificationCount, 1);
});

test('a stopped generation without saved history retains an acknowledgeable count after host restart', { timeout: 20000 }, async t => {
  const h = await fixture(t);
  await h.emit('\x07\x07');
  await h.core.handle('terminals.terminate', h.ref(), h.ctx);
  await h.core.close();
  const reopened = new HostCore({ dataDir: h.dataDir });
  try {
    await reopened.init();
    const state = reopened.getState(), info = state.terminals.find(item => item.id === h.info.id)!;
    assert.equal(info.status, 'exited');
    assert.equal(info.generation, h.info.generation);
    assert.equal(info.notificationCount, 2);
    assert.equal(info.historyAvailable, false);
    reopened.connect(h.ctx, () => {});
    const frame = await reopened.handle('terminals.attach', {
      id: info.id, generation: info.generation, hostId: state.hostId, bootId: state.bootId,
    }, h.ctx);
    assert.equal(frame.snapshot.notificationCount, 2);
    assert.equal(frame.snapshot.data, '');
  } finally { await reopened.close(); }
});
