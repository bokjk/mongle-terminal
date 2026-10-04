import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifiedClipboardWriter } from '../../apps/desktop/clipboard';

test('clipboard copy rejects silently discarded writes without leaking or replacing clipboard data', async () => {
  const writes: string[] = [];
  const write = createVerifiedClipboardWriter({
    async writeText(text) { writes.push(text); },
    async readText() { return 'different clipboard contents'; },
  });
  await assert.rejects(write('selected text'), { message: '클립보드에 내용을 저장하지 못했습니다.' });
  assert.deepEqual(writes, ['selected text'], 'Never retry over a newer clipboard value.');
});

test('clipboard copy recovers after denied access and verifies Unicode and multiple lines', async () => {
  let contents = '', denied = true;
  const write = createVerifiedClipboardWriter({
    async writeText(text) { if (!denied) contents = text; },
    async readText() { return contents; },
  });
  await assert.rejects(write('first'));
  denied = false;
  await write('한글 🐱\nsecond\r\nthird');
  assert.equal(contents, '한글 🐱\nsecond\r\nthird');
});

test('overlapping clipboard copies preserve request order through native verification', async () => {
  let contents = '', finishFirst!: () => void;
  const firstReady = new Promise<void>(resolve => { finishFirst = resolve; });
  const calls: string[] = [];
  const write = createVerifiedClipboardWriter({
    async writeText(text) { calls.push(text); if (text === 'first') await firstReady; contents = text; },
    async readText() { calls.push('read'); return contents; },
  });
  const first = write('first'), second = write('second');
  await Promise.resolve();
  assert.deepEqual(calls, ['first']);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first', 'read', 'second', 'read']);
  assert.equal(contents, 'second');
});

test('clipboard copy propagates a read failure and allows another copy', async () => {
  let contents = '', fail = true;
  const write = createVerifiedClipboardWriter({
    async writeText(text) { contents = text; },
    async readText() { if (fail) throw new Error('read failed'); return contents; },
  });
  await assert.rejects(write('first'), /read failed/);
  fail = false;
  await write('next');
  assert.equal(contents, 'next');
});
