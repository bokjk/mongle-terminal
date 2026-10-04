import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('built Markdown worker runs without a DOM or Node globals', { skip: !existsSync('dist/web/assets') }, async () => {
  const file = (await readdir('dist/web/assets')).find(name => /^markdown-preview\.worker-.*\.js$/.test(name));
  assert.ok(file, 'Build before running the worker bundle check.');
  const results: any[] = [];
  const worker: any = { postMessage: (value: unknown) => results.push(value) };
  const channels: MessageChannel[] = [];
  class TrackedChannel extends MessageChannel { constructor() { super(); channels.push(this); } }
  try {
    runInNewContext(await readFile(`dist/web/assets/${file}`, 'utf8'), {
      self: worker, TextEncoder, TextDecoder, ReadableStream, TransformStream,
      MessageChannel: TrackedChannel, performance, setTimeout, clearTimeout, queueMicrotask,
    }, { timeout: 5000 });
    worker.onmessage({ data: { id: 7, text: '# Worker &amp; 한글\n\n<script>alert(1)</script>' } });
    assert.equal(results[0].id, 7); assert.equal(results[0].error, undefined);
    assert.match(results[0].html, /<h1>Worker &amp; 한글<\/h1>/);
    assert.doesNotMatch(results[0].html, /script|alert/);
  } finally { for (const channel of channels) { channel.port1.close(); channel.port2.close(); } }
});
