import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../apps/web/src/render-markdown';
import { MarkdownRenderQueue, type MarkdownRequest, type MarkdownResult } from '../../apps/web/src/markdown-render-queue';

test('Markdown keeps GFM output but removes executable content and automatic resource loads', () => {
  const html = renderMarkdown('# 제목\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n[실행](javascript:alert(1))\n\n![이미지](https://example.com/tracker.png)\n\n- [x] 완료\n\n| 이름 | 값 |\n| --- | --- |\n| 한글 | 1 |');
  assert.match(html, /<h1>제목<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /<(?:script|iframe|img|a|link)\b/i);
  assert.doesNotMatch(html, /javascript:|tracker\.png|alert\(1\)/i);
});

test('Markdown link attributes and code examples are escaped rather than interpreted', () => {
  const html = renderMarkdown('[주소](https://example.com/"onmouseover="alert)\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.match(html, /data-markdown-url=/);
  assert.match(html, /%22onmouseover=%22alert/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img| onmouseover="alert| onerror="/);
  assert.match(renderMarkdown('[메일](mailto:test@example.com)'), /data-markdown-url="mailto:/);
});

test('Markdown processing rejects oversized input before parsing', () => {
  assert.throws(() => renderMarkdown('가'.repeat(22000)), /64 KiB/);
  assert.match(renderMarkdown(''), /왼쪽에 마크다운/);
});

function fakeWorker() {
  return {
    sent: [] as MarkdownRequest[], terminated: false,
    onmessage: null as ((event: MessageEvent<MarkdownResult>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(request: MarkdownRequest) { this.sent.push(request); },
    terminate() { this.terminated = true; },
    reply(id: number, html: string) { this.onmessage?.({ data: { id, html } } as MessageEvent<MarkdownResult>); },
  };
}

test('slow worker coalesces rapid edits and cannot publish an obsolete preview', () => {
  const worker = fakeWorker(), output: MarkdownResult[] = [];
  const queue = new MarkdownRenderQueue(worker, result => output.push(result));
  try {
    queue.render('first');
    for (let i = 0; i < 100; i++) queue.render(`newest-${i}`);
    assert.equal(worker.sent.length, 1);
    worker.reply(1, 'stale');
    assert.deepEqual(output, []);
    assert.deepEqual(worker.sent[1], { id: 101, text: 'newest-99' });
    worker.reply(1, 'duplicate');
    worker.reply(101, 'latest');
    assert.deepEqual(output, [{ id: 101, html: 'latest' }]);
  } finally { queue.dispose(); }
});

test('closing a preview terminates its worker and suppresses late results', () => {
  const worker = fakeWorker(), output: MarkdownResult[] = [];
  const queue = new MarkdownRenderQueue(worker, result => output.push(result));
  queue.render('draft'); const late = worker.onmessage!;
  queue.dispose(); late({ data: { id: 1, html: 'late' } } as MessageEvent<MarkdownResult>);
  queue.render('ignored');
  assert.equal(worker.terminated, true); assert.equal(worker.sent.length, 1); assert.deepEqual(output, []);
});

test('a document render error does not prevent rendering the next valid draft', () => {
  const worker = fakeWorker(), output: MarkdownResult[] = [];
  const queue = new MarkdownRenderQueue(worker, result => output.push(result));
  try {
    queue.render('oversized');
    worker.onmessage!({ data: { id: 1, error: '64 KiB' } } as MessageEvent<MarkdownResult>);
    queue.render('valid'); worker.reply(2, '<p>valid</p>');
    assert.deepEqual(output, [{ id: 1, error: '64 KiB' }, { id: 2, html: '<p>valid</p>' }]);
    assert.equal(worker.terminated, false);
  } finally { queue.dispose(); }
});

test('worker failure stops processing and reports an error instead of dropping the draft silently', () => {
  const worker = fakeWorker(), output: MarkdownResult[] = [];
  const queue = new MarkdownRenderQueue(worker, result => output.push(result));
  queue.render('draft'); worker.onerror!({ preventDefault() {} } as ErrorEvent);
  assert.equal(worker.terminated, true); assert.match(output[0].error!, /편집 내용은 유지/);
});

test('a stuck worker has a bounded lifetime', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = fakeWorker(), output: MarkdownResult[] = [];
  const queue = new MarkdownRenderQueue(worker, result => output.push(result));
  queue.render('draft'); t.mock.timers.tick(10000);
  assert.equal(worker.terminated, true); assert.match(output[0].error!, /다시 시도/);
});
