import test from 'node:test';
import assert from 'node:assert/strict';
import { PushNotifier, type PushTarget } from '../../packages/host/push-notifier.ts';
import type { PcPresence } from '../../packages/host/presence.ts';
import type { PushMessage, PushResult } from '../../packages/host/web-push.ts';
import type { HostState, TerminalInfo } from '../../packages/protocol/index.ts';

type Device = PushTarget & { origin: string };
const device = (deviceId: string, origin = 'https://pc.example-tailnet.ts.net'): Device => ({ deviceId, origin, subscription: { endpoint: `https://push.example.net/${deviceId}`, p256dh: 'p', auth: 'a' } });
const AWAY: PcPresence = { away: true, reason: 'locked' };
const HERE: PcPresence = { away: false, reason: 'active', idleMs: 0 };

function harness(devices: Device[] = [device('phone')]) {
  let now = 1_000_000, id = 0;
  const timers: Array<{ id: number; at: number; run: () => void }> = [];
  const h = {
    devices, presence: AWAY as PcPresence, viewing: 0, presenceCalls: 0,
    results: [] as PushResult[],
    sent: [] as Array<{ deviceId: string; message: PushMessage }>,
    forgotten: [] as string[],
    now: () => now,
    /** Runs every timer that is due, letting the async work in between finish. */
    async settle() {
      for (let round = 0; round < 50; round++) {
        await new Promise(resolve => setImmediate(resolve));
        const due = timers.filter(timer => timer.at <= now).sort((a, b) => a.at - b.at);
        if (!due.length) { await new Promise(resolve => setImmediate(resolve)); if (!timers.some(timer => timer.at <= now)) return; continue; }
        for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
      }
    },
    async advance(ms: number) { now += ms; await h.settle(); },
    nextTimer: () => Math.min(...timers.map(timer => timer.at - now)),
  };
  const notifier = new PushNotifier({
    targets: origin => h.devices.filter(item => origin === undefined || item.origin === origin),
    send: async (target, message) => { h.sent.push({ deviceId: target.deviceId, message }); return h.results.shift() ?? { status: 'sent' }; },
    forget: deviceId => { h.forgotten.push(deviceId); h.devices = h.devices.filter(item => item.deviceId !== deviceId); },
    presence: async () => { h.presenceCalls++; return h.presence; },
    viewingUntil: () => h.viewing,
    hostName: () => 'MY-PC',
    now: () => now,
    setTimer: (run, ms) => { timers.push({ id: ++id, at: now + ms, run }); return id; },
    clearTimer: timer => { const index = timers.findIndex(item => item.id === timer); if (index >= 0) timers.splice(index, 1); },
  });
  return { h, notifier };
}
const terminal = (id: string, agentStatus?: TerminalInfo['agentStatus'], extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, groupId: 'g', title: 'PowerShell', profileId: 'p', cwd: 'C:\\work', generation: 'gen-' + id, status: 'running', cols: 80, rows: 24,
  ...(agentStatus ? { agentStatus, agentProvider: 'claude' as const } : {}), ...extra,
});
const state = (...terminals: TerminalInfo[]): HostState => ({
  hostId: 'h', bootId: 'b', name: 'MY-PC', version: '0.3.21', protocolVersion: 1, terminals, profiles: [],
  groups: [{ id: 'g', name: '작업', cwd: 'C:\\work', profileId: 'p', revision: 1, layout: null }],
  settings: { name: 'MY-PC', recordHistory: false, scrollback: 1000 },
});

test('a request waiting while nobody is at the PC is sent once, with names only', async () => {
  const { h, notifier } = harness();
  notifier.observeState(state(terminal('t1', 'attention'), terminal('t2', 'attention', { agentProvider: 'codex' })));
  await h.settle();
  assert.equal(h.sent.length, 2);
  const claude = h.sent.find(item => item.message.payload && (item.message.payload as any).tag === 'attention-t1')!.message;
  assert.deepEqual({ ...(claude.payload as any), ts: 0 }, { v: 1, kind: 'attention', title: 'MY-PC', body: '작업 · PowerShell: Claude가 확인을 기다리고 있습니다.', tag: 'attention-t1', url: '/?terminal=t1', ts: 0 });
  assert.equal(claude.urgency, 'high'); assert.equal(claude.ttl, 900); assert.match(claude.topic!, /^[A-Za-z0-9_-]{32}$/);
  assert.match((h.sent.find(item => (item.message.payload as any).tag === 'attention-t2')!.message.payload as any).body, /Codex가 확인을 기다리고/);
  notifier.observeState(state(terminal('t1', 'attention'), terminal('t2', 'attention', { agentProvider: 'codex' })));
  await h.advance(30 * 60_000);
  assert.equal(h.sent.length, 2, 'one notification per request and device');
});

test('nothing is sent while someone is at the PC, and a request still waiting when they leave is sent then', async () => {
  const { h, notifier } = harness();
  h.presence = HERE;
  notifier.observeState(state(terminal('t1', 'attention')));
  await h.settle();
  assert.equal(h.sent.length, 0);
  assert.equal(h.nextTimer(), 60_000, 'checks again within a minute so a lock is noticed');
  h.presence = { away: false, reason: 'active', idleMs: 4 * 60_000 + 40_000 };
  await h.advance(60_000);
  assert.equal(h.sent.length, 0);
  assert.equal(h.nextTimer(), 20_000, 'the earliest time five minutes without input can pass');
  h.presence = { away: true, reason: 'idle', idleMs: 5 * 60_000 };
  await h.advance(20_000);
  assert.equal(h.sent.length, 1);
});

test('a request answered before anyone left is never sent', async () => {
  const { h, notifier } = harness();
  h.presence = HERE;
  notifier.observeState(state(terminal('t1', 'attention')));
  await h.settle();
  notifier.observeState(state(terminal('t1', 'working')));
  h.presence = AWAY;
  await h.advance(60_000);
  assert.equal(h.sent.length, 0);
  notifier.observeState(state(terminal('t1', 'attention')));
  await h.settle();
  assert.equal(h.sent.length, 1, 'the next request of the same terminal is new');
});

test('completions, errors and other work are not sent, and no presence is read without a subscribed device', async () => {
  const { h, notifier } = harness();
  notifier.observeState(state(terminal('a', 'completed'), terminal('b', 'error'), terminal('c', 'working'), terminal('d', 'attention', { status: 'exited' })));
  await h.advance(60_000);
  assert.equal(h.sent.length, 0); assert.equal(h.presenceCalls, 0);
  const lonely = harness([]);
  lonely.notifier.observeState(state(terminal('t1', 'attention')));
  await lonely.h.advance(60_000);
  assert.equal(lonely.h.presenceCalls, 0, 'nobody to notify, so the PC is not asked');
});

test('a device looking at this PC holds notifications until five minutes after it stops', async () => {
  const { h, notifier } = harness();
  h.viewing = Infinity;
  notifier.observeState(state(terminal('t1', 'attention')));
  await h.settle();
  assert.equal(h.sent.length, 0); assert.equal(h.presenceCalls, 0);
  h.viewing = h.now() + 5 * 60_000;
  notifier.presenceChanged();
  await h.advance(4 * 60_000);
  assert.equal(h.sent.length, 0);
  await h.advance(60_000);
  assert.equal(h.sent.length, 1);
});

test('a pairing request reaches only devices paired through its address, until it is decided or expires', async () => {
  const office = 'https://office.example-tailnet.ts.net';
  const { h, notifier } = harness([device('phone'), device('tablet', office)]);
  notifier.pairingRequested({ requestId: 'r1', name: '새 휴대폰', origin: 'https://pc.example-tailnet.ts.net', expiresAt: h.now() + 180_000 });
  await h.settle();
  assert.deepEqual(h.sent.map(item => item.deviceId), ['phone']);
  const payload = h.sent[0].message.payload as any;
  assert.equal(payload.kind, 'pairing'); assert.equal(payload.url, '/?open=pairing');
  assert.match(payload.body, /새 휴대폰/);
  assert.ok(h.sent[0].message.ttl <= 180 && h.sent[0].message.ttl > 0);
  await h.advance(11_000); // past the short presence cache
  h.presence = HERE;
  notifier.pairingRequested({ requestId: 'r2', name: 'Laptop', origin: 'https://pc.example-tailnet.ts.net', expiresAt: h.now() + 180_000 });
  notifier.pairingRequested({ requestId: 'r3', name: 'Old', origin: 'https://pc.example-tailnet.ts.net', expiresAt: h.now() + 30_000 });
  await h.settle();
  notifier.pairingsPending(['r1', 'r3']);
  h.presence = AWAY;
  await h.advance(60_000);
  assert.deepEqual(h.sent.map(item => (item.message.payload as any).tag), ['pairing-r1'], 'decided r2 and expired r3 are never sent');
});

test('a dropped subscription is forgotten and a failing push service is tried three times', async () => {
  const { h, notifier } = harness();
  h.results.push({ status: 'gone', httpStatus: 410 });
  notifier.observeState(state(terminal('t1', 'attention')));
  await h.settle();
  assert.deepEqual(h.forgotten, ['phone']);
  const retry = harness();
  retry.h.results.push({ status: 'failed', httpStatus: 500 }, { status: 'failed' }, { status: 'failed', httpStatus: 503 });
  retry.notifier.observeState(state(terminal('t1', 'attention')));
  await retry.h.settle();
  assert.equal(retry.h.sent.length, 1);
  await retry.h.advance(30_000);
  await retry.h.advance(30_000);
  await retry.h.advance(30_000);
  await retry.h.advance(30 * 60_000);
  assert.equal(retry.h.sent.length, 3);
});

test('the settings test notification goes out right away and explains a failure', async () => {
  const { h, notifier } = harness();
  h.presence = HERE; h.viewing = Infinity;
  assert.deepEqual(await notifier.sendTest('phone'), { ok: true });
  assert.equal((h.sent[0].message.payload as any).kind, 'test');
  await assert.rejects(notifier.sendTest('nobody'), (error: any) => error.code === 'PUSH_NOT_SUBSCRIBED');
  h.results.push({ status: 'failed', httpStatus: 403 });
  await assert.rejects(notifier.sendTest('phone'), (error: any) => error.code === 'PUSH_FAILED' && /403/.test(error.message));
  h.results.push({ status: 'gone', httpStatus: 410 });
  await assert.rejects(notifier.sendTest('phone'), (error: any) => error.code === 'PUSH_EXPIRED');
  assert.deepEqual(h.forgotten, ['phone']);
});

test('closing stops waiting requests', async () => {
  const { h, notifier } = harness();
  h.presence = HERE;
  notifier.observeState(state(terminal('t1', 'attention')));
  await h.settle();
  notifier.close();
  h.presence = AWAY;
  await h.advance(10 * 60_000);
  assert.equal(h.sent.length, 0);
});
