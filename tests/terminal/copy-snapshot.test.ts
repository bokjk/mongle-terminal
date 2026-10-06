import assert from 'node:assert/strict';
import test from 'node:test';
import Headless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';
import { collectCopySnapshot, CopySnapshotError, type CopySnapshotSource } from '../../packages/terminal/copy-snapshot.js';

// The app passes the browser renderer's public Terminal; keep both xterm builds accepted.
export const acceptsBrowserTerminal: (terminal: BrowserTerminal) => CopySnapshotSource = terminal => terminal;

async function terminal(cols: number, rows: number, data: string, scrollback = 1000): Promise<Terminal> {
  const term = new Headless.Terminal({ cols, rows, scrollback, allowProposedApi: true, logLevel: 'off' });
  await new Promise<void>(resolve => term.write(data, resolve));
  return term;
}

const write = (term: Terminal, data: string) => new Promise<void>(resolve => term.write(data, resolve));

function rejects(code: string) {
  return (error: unknown) => error instanceof CopySnapshotError && error.code === code;
}

test('wrapped Korean rows join into one logical line, including the early wrap of a wide glyph', async () => {
  // 10 columns: 'a' + four wide glyphs fill nine cells; the fifth glyph cannot
  // split, so it wraps and leaves an unwritten last cell on the first row.
  const term = await terminal(10, 4, 'a가나다라마바\r\n가나다라마바사\r\nend');
  try {
    assert.equal(term.buffer.active.getLine(1)?.isWrapped, true);
    const snapshot = collectCopySnapshot(term);
    assert.deepEqual(snapshot.text.split('\n'), ['a가나다라마바', '가나다라마바사', 'end']);
    assert.equal(snapshot.lineCount, 3);
    assert.equal(snapshot.historyTruncated, undefined);
  } finally { term.dispose(); }
});

test('written trailing spaces and blank lines stay; unused viewport rows and SGR styling do not appear', async () => {
  const term = await terminal(20, 8, 'ab  \r\n\r\n\x1b[1;31m빨강\x1b[0m \x1b[44mplain\x1b[0m\r\nx\u00a0y\r\n');
  try {
    const snapshot = collectCopySnapshot(term);
    assert.equal(snapshot.text, 'ab  \n\n빨강 plain\nx y');
    assert.equal(snapshot.lineCount, 4);
    assert.doesNotMatch(snapshot.text, /\x1b/);
  } finally { term.dispose(); }
});

test('scrollback above the viewport is included in order', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `LIVE-${String(i + 1).padStart(3, '0')} 가나다 END-${i + 1}`);
  const term = await terminal(40, 5, lines.join('\r\n'));
  try {
    assert.ok(term.buffer.active.length > term.rows);
    assert.equal(collectCopySnapshot(term).text, lines.join('\n'));
  } finally { term.dispose(); }
});

test('the alternate screen is refused explicitly and the normal buffer is readable again after it exits', async () => {
  const term = await terminal(20, 4, 'normal line\r\n\x1b[?1049hfull screen');
  try {
    assert.equal(term.buffer.active.type, 'alternate');
    assert.throws(() => collectCopySnapshot(term), rejects('ALTERNATE_BUFFER'));
    await write(term, '\x1b[?1049l');
    assert.equal(collectCopySnapshot(term).text, 'normal line');
  } finally { term.dispose(); }
});

test('capture leaves the terminal untouched and the result is detached from later output', async () => {
  const term = await terminal(12, 4, 'first 가나다라마\r\nsecond');
  try {
    const rows = () => Array.from({ length: term.buffer.active.length }, (_, y) => {
      const line = term.buffer.active.getLine(y)!;
      return [line.isWrapped, line.translateToString(false)] as const;
    });
    const before = { rows: rows(), x: term.buffer.active.cursorX, y: term.buffer.active.cursorY, viewport: term.buffer.active.viewportY };
    const snapshot = collectCopySnapshot(term);
    assert.deepEqual({ rows: rows(), x: term.buffer.active.cursorX, y: term.buffer.active.cursorY, viewport: term.buffer.active.viewportY }, before);
    assert.ok(Object.isFrozen(snapshot));

    const captured = snapshot.text;
    await write(term, '\x1b[2J\x1b[Hreplaced\r\nmore output');
    assert.equal(snapshot.text, captured);
    assert.equal(captured, 'first 가나다라마\nsecond');
  } finally { term.dispose(); }
});

test('the character budget keeps the newest whole lines and reports what was omitted', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
  const term = await terminal(20, 4, lines.join('\r\n'));
  try {
    assert.deepEqual(collectCopySnapshot(term, 15), { text: 'L07\nL08\nL09\nL10', lineCount: 4, historyTruncated: true, omittedLineCount: 6 });
    // One character short of four lines: never a partial line.
    assert.deepEqual(collectCopySnapshot(term, 14), { text: 'L08\nL09\nL10', lineCount: 3, historyTruncated: true, omittedLineCount: 7 });
    assert.equal(collectCopySnapshot(term, 39).historyTruncated, undefined);
    assert.throws(() => collectCopySnapshot(term, 2), rejects('LINE_TOO_LONG'));
    assert.throws(() => collectCopySnapshot(term, 0), rejects('INVALID_LIMIT'));
  } finally { term.dispose(); }
});

test('a wrapped newest line longer than the budget is refused instead of cut', async () => {
  const term = await terminal(10, 4, 'short\r\n' + '가'.repeat(30));
  try {
    assert.equal(collectCopySnapshot(term).text, 'short\n' + '가'.repeat(30));
    assert.throws(() => collectCopySnapshot(term, 29), rejects('LINE_TOO_LONG'));
    // An older over-long line is omitted whole, with the newer line kept.
    await write(term, '\r\nnewest');
    assert.deepEqual(collectCopySnapshot(term, 10), { text: 'newest', lineCount: 1, historyTruncated: true, omittedLineCount: 2 });
  } finally { term.dispose(); }
});
