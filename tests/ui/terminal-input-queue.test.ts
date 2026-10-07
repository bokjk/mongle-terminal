import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { TerminalInputQueue } from '../../apps/web/src/terminal-input-queue';

type Encoding = 'utf8' | 'binary';
type Request = { data: string; encoding: Encoding; resolve(): void; reject(error: unknown): void };

function controlledQueue(isCurrent: () => boolean = () => true) {
  const requests: Request[] = [], failures: unknown[] = [];
  const queue = new TerminalInputQueue({
    isCurrent,
    send: (data, encoding) => new Promise<void>((resolve, reject) => requests.push({ data, encoding, resolve, reject })),
    failed: error => failures.push(error),
  });
  return { queue, requests, failures };
}

async function acknowledgeAll(requests: Request[], first = 0): Promise<void> {
  for (let index = first; index < requests.length; index++) {
    assert.ok(index < 100, 'input must finish without retrying acknowledged requests');
    requests[index].resolve();
    await setImmediate();
  }
}

function encodingRuns(requests: Array<{ data: string; encoding: Encoding }>) {
  const runs: Array<{ data: string; encoding: Encoding }> = [];
  for (const { data, encoding } of requests) {
    const last = runs.at(-1);
    if (last?.encoding === encoding) last.data += data;
    else runs.push({ data, encoding });
  }
  return runs;
}

test('queued cancel keys preserve event boundaries through delayed acknowledgements',async()=>{
  const {queue,requests,failures}=controlledQueue();
  queue.enqueue('in-flight','utf8');
  for(const data of ['typing','\x03','\x1b','\x1b','\x1b[A','\x1b[27u','\x1b[99;5u','after'])queue.enqueue(data,'utf8');
  await acknowledgeAll(requests);
  assert.deepEqual(requests.map(r=>r.data),['in-flight','typing','\x03','\x1b','\x1b','\x1b[A','\x1b[27u','\x1b[99;5u','after']);
  assert.deepEqual(failures,[]);
});

test('large Korean, emoji and binary input keeps exact encoding order in UTF-8 bounded batches', async () => {
  const { queue, requests, failures } = controlledQueue();
  const input: Array<{ data: string; encoding: Encoding }> = [
    { data: '가'.repeat(2730) + '😀' + '나'.repeat(3000) + '🚀', encoding: 'utf8' },
    { data: '🙂붙여넣기 끝', encoding: 'utf8' },
    { data: String.fromCharCode(0, 127, 128, 255).repeat(2500), encoding: 'binary' },
    { data: '\r한글과 이모지 🧑‍💻 뒤의 명령\r', encoding: 'utf8' },
    { data: '\x1b\x00\xff', encoding: 'binary' },
  ];
  await queue.pause();
  for (const chunk of input) queue.enqueue(chunk.data, chunk.encoding);
  assert.equal(requests.length, 0);
  assert.equal(queue.hasPendingInput, true);

  queue.resume();
  await acknowledgeAll(requests);

  assert.deepEqual(encodingRuns(requests), encodingRuns(input));
  assert.ok(requests.filter(request => request.encoding === 'utf8').length > 2);
  assert.ok(requests.filter(request => request.encoding === 'binary').length > 2);
  for (const { data } of requests) {
    assert.ok(Buffer.byteLength(data, 'utf8') <= 8192, 'every request must fit the 8 KiB UTF-8 wire limit');
    assert.ok(data.length > 0);
    assert.doesNotMatch(data, /[\uD800-\uDFFF]/u, 'a request must not contain half a surrogate pair');
  }
  assert.deepEqual(failures, []);
  assert.equal(queue.hasPendingInput, false);
});

test('the 65536-byte pending limit accepts in-flight plus queued input exactly at the boundary', async () => {
  const { queue, requests, failures } = controlledQueue();
  const first = 'a'.repeat(8192), queued = '😀'.repeat(14336);
  assert.equal(Buffer.byteLength(first + queued), 65536);
  queue.enqueue(first, 'utf8');
  queue.enqueue(queued, 'utf8');
  assert.equal(requests.length, 1, 'only one request may be in flight');
  assert.deepEqual(failures, []);

  await acknowledgeAll(requests);

  assert.equal(requests.map(request => request.data).join(''), first + queued);
  assert.deepEqual(failures, []);
  assert.equal(queue.hasPendingInput, false);
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`one byte beyond the pending limit fails once and never replays queued input after in-flight ${outcome}`, async () => {
    const { queue, requests, failures } = controlledQueue();
    queue.enqueue('a'.repeat(8192), 'utf8');
    queue.enqueue('b'.repeat(57344), 'utf8');
    assert.equal(failures.length, 0);

    queue.enqueue('x', 'utf8');
    assert.equal(failures.length, 1, 'the in-flight 8 KiB must count against the pending limit');
    assert.ok(failures[0] instanceof Error);
    assert.match(failures[0].message, /입력.*멈췄/);
    queue.enqueue('must not be retried', 'utf8');
    queue.resume();
    if (outcome === 'resolve') requests[0].resolve();
    else requests[0].reject(new Error('late transport failure'));
    await setImmediate();
    queue.resume();

    assert.equal(requests.length, 1, 'neither queued nor rejected input may be replayed');
    assert.equal(failures.length, 1, 'a late transport error must not report another failure');
    assert.equal(queue.hasPendingInput, true, 'discarded unsent input remains visible to scope cleanup');
  });
}

test('acknowledging a request releases its capacity while later input is still pending', async () => {
  const { queue, requests, failures } = controlledQueue();
  queue.enqueue('a'.repeat(8192), 'utf8');
  queue.enqueue('b'.repeat(57344), 'utf8');
  requests[0].resolve();
  await setImmediate();
  assert.equal(requests.length, 2);

  queue.enqueue('c'.repeat(8192), 'utf8');
  assert.deepEqual(failures, []);
  await acknowledgeAll(requests, 1);

  assert.equal(requests.map(request => request.data).join(''), 'a'.repeat(8192) + 'b'.repeat(57344) + 'c'.repeat(8192));
  assert.equal(queue.hasPendingInput, false);
  assert.deepEqual(failures, []);
});

test('pause waits only for the in-flight request and retains unsent input until resume', async () => {
  const { queue, requests, failures } = controlledQueue();
  queue.enqueue('already sent', 'utf8');
  queue.enqueue('queued before resize', 'utf8');
  let paused = false;
  const pause = queue.pause().then(() => { paused = true; });
  queue.enqueue('\xff\x00', 'binary');
  await setImmediate();
  assert.equal(paused, false, 'resize must wait for the request already sent');
  assert.equal(requests.length, 1);

  requests[0].resolve();
  await pause;
  await setImmediate();
  assert.equal(paused, true, 'unsent input must not prevent resize from proceeding');
  assert.equal(requests.length, 1);
  assert.equal(queue.hasPendingInput, true);
  await queue.pause();
  assert.equal(requests.length, 1, 'another pause with only queued input must resolve without sending it');

  queue.resume();
  await acknowledgeAll(requests, 1);
  assert.deepEqual(requests.map(({ data, encoding }) => ({ data, encoding })), [
    { data: 'already sent', encoding: 'utf8' },
    { data: 'queued before resize', encoding: 'utf8' },
    { data: '\xff\x00', encoding: 'binary' },
  ]);
  assert.deepEqual(failures, []);
  assert.equal(queue.hasPendingInput, false);
});

for (const closeVia of ['close', 'stale enqueue', 'stale resume'] as const) {
  test(`paused unsent input remains detectable after ${closeVia} runs before scope cleanup`, async () => {
    let current = true;
    const { queue, requests, failures } = controlledQueue(() => current);
    await queue.pause();
    queue.enqueue('input waiting for resize', 'utf8');
    if (closeVia === 'close') queue.close();
    else {
      current = false;
      if (closeVia === 'stale enqueue') queue.enqueue('later keystroke', 'utf8');
      else queue.resume();
    }

    assert.equal(queue.hasPendingInput, true, 'cleanup needs to warn about unsent input even after it was discarded');
    await queue.pause();
    queue.resume();
    queue.enqueue('do not revive the closed queue', 'utf8');
    await setImmediate();
    assert.deepEqual(requests, []);
    assert.deepEqual(failures, []);
  });
}

for (const invalidation of ['closed', 'stale'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`${invalidation} queue ${outcome} cannot resume old input or affect the replacement scope`, async () => {
      let current = true;
      const old = controlledQueue(() => current);
      old.queue.enqueue('old request', 'utf8');
      old.queue.enqueue('obsolete queued input', 'utf8');
      if (invalidation === 'closed') old.queue.close();
      else current = false;

      const replacement = controlledQueue();
      replacement.queue.enqueue('new scope request', 'utf8');
      if (outcome === 'resolve') old.requests[0].resolve();
      else old.requests[0].reject(new Error('obsolete transport failure'));
      await setImmediate();
      old.queue.resume();
      old.queue.enqueue('obsolete new keystroke', 'utf8');
      await setImmediate();

      assert.deepEqual(old.requests.map(request => request.data), ['old request']);
      assert.deepEqual(old.failures, [], 'an obsolete response must not call a failure handler in the replacement scope');
      assert.deepEqual(replacement.requests.map(request => request.data), ['new scope request']);
      assert.equal(replacement.queue.hasPendingInput, true);
      assert.deepEqual(replacement.failures, []);
      replacement.requests[0].resolve();
      await setImmediate();
      assert.equal(replacement.queue.hasPendingInput, false);
    });
  }
}
