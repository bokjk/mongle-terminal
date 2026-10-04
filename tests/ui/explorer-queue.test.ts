import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { explorerClient } from '../../apps/web/src/explorer-queue';
import type { Transport } from '../../packages/protocol';

test('obsolete queued explorer reads never delay a newly selected folder or exceed two active reads', async () => {
  const calls: string[] = [], finish: Array<() => void> = [];
  let active = 0, maximum = 0;
  const transport: Transport = {
    request: <T,>(method: string) => {
      calls.push(method); maximum = Math.max(maximum, ++active);
      return new Promise<T>(resolve => finish.push(() => { active--; resolve(method as T); }));
    }, subscribe: () => () => {}, close() {},
  };
  const shared = explorerClient(transport), client = explorerClient(shared), obsolete = new AbortController();
  assert.equal(client, shared, 'Nested readers must reuse the same queue');
  assert.equal(explorerClient(transport), shared, 'Reopened readers must reuse the same queue');
  const running = [client.request('first'), client.request('second')];
  const cancelled = Array.from({ length: 6 }, (_, index) => assert.rejects(client.request(`obsolete-${index}`, {}, obsolete.signal), { name: 'AbortError' }));
  await setImmediate();
  obsolete.abort();
  const latest = client.request('latest');
  await setImmediate();
  assert.deepEqual(calls, ['first', 'second'], 'cancellation must not release in-flight slots');
  finish.shift()!(); await setImmediate();
  assert.deepEqual(calls, ['first', 'second', 'latest']);
  finish.splice(0).forEach(resolve => resolve());
  await Promise.all([...running, latest, ...cancelled]);
  assert.equal(maximum, 2);
});

test('aborting active explorer reads keeps their slot until completion and skips already cancelled reads', async () => {
  const finish: Array<() => void> = [], calls: string[] = [];
  const client = explorerClient({ request: <T,>(method: string) => { calls.push(method); return new Promise<T>(resolve => finish.push(() => resolve(undefined as T))); }, subscribe: () => () => {}, close() {} });
  const controller = new AbortController();
  const first = client.request('first', {}, controller.signal), second = client.request('second');
  await setImmediate(); controller.abort();
  await assert.rejects(client.request('cancelled', {}, controller.signal), { name: 'AbortError' });
  const third = client.request('third');
  await setImmediate(); assert.deepEqual(calls, ['first', 'second']);
  finish.shift()!(); await setImmediate(); assert.deepEqual(calls, ['first', 'second', 'third']);
  finish.splice(0).forEach(resolve => resolve()); await Promise.all([first, second, third]);
});

test('synchronous transport failures release explorer slots for subsequent reads', async () => {
  const client = explorerClient({ request: <T,>(method: string) => { if (method === 'bad') throw new Error('failed read'); return Promise.resolve('ok' as T); }, subscribe: () => () => {}, close() {} });
  const failures = [assert.rejects(client.request('bad'), /failed read/), assert.rejects(client.request('bad'), /failed read/)];
  assert.equal(await client.request('good'), 'ok'); await Promise.all(failures);
});
