import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateStore } from '../../apps/web/src/update-store';
import type { UpdateState } from '../../apps/desktop/contracts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const ready: UpdateState = { status: 'ready', currentVersion: '0.1.0', availableVersion: '0.2.0' };

function bridge() {
  const listeners = new Set<(state: UpdateState) => void>();
  const gets: Array<ReturnType<typeof deferred<UpdateState>>> = [];
  const installs: Array<ReturnType<typeof deferred<void>>> = [];
  const calls: string[] = [];
  const value = {
    getUpdateState: () => { calls.push('get'); const d = deferred<UpdateState>(); gets.push(d); return d.promise; },
    checkForUpdates: async () => { calls.push('check'); return ready; },
    installUpdate: () => { calls.push('install'); const d = deferred<void>(); installs.push(d); return d.promise; },
    onUpdate: (listener: (state: UpdateState) => void) => { calls.push('subscribe'); listeners.add(listener); return () => { calls.push('unsubscribe'); listeners.delete(listener); }; },
  };
  return { value, listeners, gets, installs, calls, emit: (state: UpdateState) => listeners.forEach(listener => listener(state)) };
}

test('the sidebar and settings share one bridge subscription and one busy state', async () => {
  const b = bridge();
  const store = new UpdateStore(b.value as any);
  const seen: string[] = [];
  const offA = store.subscribe(() => seen.push('sidebar'));
  const offB = store.subscribe(() => seen.push('settings'));
  assert.deepEqual(b.calls, ['subscribe', 'get'], 'only one IPC subscription for every view');
  b.emit(ready);
  b.gets.shift()!.resolve({ status: 'idle', currentVersion: '0.1.0' });
  await flush();
  assert.equal(store.getSnapshot().state?.status, 'ready', 'a slower initial response does not replace a newer event');
  const first = store.install();
  const second = store.install();
  assert.equal(store.getSnapshot().busy, true);
  assert.equal(b.calls.filter(call => call === 'install').length, 1, 'repeated clicks from either view install once');
  b.installs.shift()!.reject(new Error('설치 준비에 실패했습니다.'));
  await first; await second;
  assert.equal(store.getSnapshot().busy, false);
  assert.equal(store.getSnapshot().error, '설치 준비에 실패했습니다.');
  offA(); offB();
  assert.ok(seen.includes('sidebar') && seen.includes('settings'));
  store.dispose();
});

test('disposing the store ignores pending responses and events from the old bridge', async () => {
  const b = bridge();
  const store = new UpdateStore(b.value as any);
  store.subscribe(() => {});
  const before = store.getSnapshot();
  store.dispose();
  b.gets.shift()!.resolve(ready);
  await flush();
  assert.equal(store.getSnapshot(), before);
  assert.ok(b.calls.includes('unsubscribe'));
});

test('browsers and older bridges report unsupported without subscribing', () => {
  for (const value of [undefined, {}]) {
    const store = new UpdateStore(value as any);
    store.subscribe(() => {});
    assert.equal(store.getSnapshot().supported, false);
  }
});
