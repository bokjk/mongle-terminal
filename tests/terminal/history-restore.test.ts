import assert from 'node:assert/strict';
import test from 'node:test';
import Headless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import type { PresentationSnapshot } from '../../packages/terminal/types.js';

const geometry = { cols: 60, rows: 8 };
const makeEngine = (onResponse: (data: string) => void = () => {}) => new TerminalEngine({ ...geometry, onResponse });
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));

async function readSnapshot(snapshot: PresentationSnapshot) {
  const terminal = new Headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 5000, allowProposedApi: true });
  await write(terminal, snapshot.data);
  return terminal;
}

function textOf(terminal: Terminal): string {
  const buffer = terminal.buffer.normal;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)!.translateToString(true)).join('\n');
}

test('cold history accepts old/new snapshot metadata without resuming the old RIS generation', async () => {
  const source = makeEngine();
  try {
    await source.write('\x1bc\x1bcold synthetic output');
    const saved = JSON.parse(JSON.stringify(await source.snapshot())) as PresentationSnapshot;
    assert.equal(saved.inputResetGeneration, 2);
    const { inputResetGeneration: _, ...legacy } = saved;
    for (const record of [saved, legacy]) {
      const restored = makeEngine();
      let view: Terminal | undefined;
      try {
        await restored.restoreHistory(record);
        const fresh = await restored.snapshot();
        assert.equal(fresh.inputResetGeneration, 0, 'new engine must not inherit saved live input state');
        view = await readSnapshot(fresh);
        assert.match(textOf(view), /old synthetic output/);
        await restored.write('\x1bc');
        assert.equal((await restored.snapshot()).inputResetGeneration, 1);
      } finally { view?.dispose(); await restored.dispose(); }
    }
  } finally { await source.dispose(); }
});

test('cold history is retained below an old cursor and new shell screen clears only the fresh viewport', async () => {
  const source = makeEngine();
  const restored = makeEngine();
  let view: Terminal | undefined;
  try {
    await source.write(Array.from({ length: 24 }, (_, i) => `old-output-${i}\r\n`).join('') + 'last-output\x1b[H');
    await restored.restoreHistory(await source.snapshot());
    await restored.write('\x1b[2J\x1b[HPS fresh>\r\nnext-output');
    view = await readSnapshot(await restored.snapshot());
    const text = textOf(view);
    for (let i = 0; i < 24; i += 1) assert.ok(text.includes(`old-output-${i}\n`), `retains line ${i}`);
    assert.match(text, /last-output\n\n── 이전 기록 · 새 셸 시작 ──\nPS fresh>\nnext-output/);
    assert.equal(view.buffer.active.type, 'normal');
  } finally { view?.dispose(); await source.dispose(); await restored.dispose(); }
});

test('history emits no built-in, custom CSI or OSC replies and never leaves an unfinished parser sequence', async () => {
  const source = makeEngine();
  const replies: string[] = [];
  const restored = makeEngine(data => replies.push(data));
  let view: Terminal | undefined;
  try {
    const snapshot = await source.snapshot();
    await restored.restoreHistory({ ...snapshot, data: 'saved\x1b[6n\x1b[c\x1b[>c\x1bP$qm\x1b\\' +
      '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\\x1b[18t\x1b]52;c;Y2xpcGJvYXJk\x1b\\\x1b[' });
    assert.deepEqual(replies, []);
    await restored.write('31mplain');
    view = await readSnapshot(await restored.snapshot());
    assert.match(textOf(view), /31mplain/);
    const cell = view.buffer.active.getLine(view.buffer.active.baseY)!.getCell(0)!;
    assert.equal(cell.isAttributeDefault(), true);
    await restored.write('\x1b[6n\x1b]10;?\x1b\\\x1b[18t');
    assert.equal(replies.length, 3, 'live PTY queries still receive exactly one response each');
  } finally { view?.dispose(); await source.dispose(); await restored.dispose(); }
});

test('alternate screen content becomes plain normal history without previous TUI input modes or style', async () => {
  const source = makeEngine();
  const restored = makeEngine();
  let view: Terminal | undefined;
  try {
    await source.write('normal-before-tui\r\nsecond-normal\x1b[?1049h\x1b[32;44mTUI visible\r\n한글 화면');
    const snapshot = await source.snapshot();
    await restored.restoreHistory({ ...snapshot, data: snapshot.data +
      '\x1b[?1003;1006;1004;1;66;2004;6;45h\x1b[4h\x1b[?7l\x1b[?25l\x1b[5 q' });
    const restoredState = await restored.snapshot();
    const defaults = await (async () => { const engine = makeEngine(); try { return await engine.snapshot(); } finally { await engine.dispose(); } })();
    assert.deepEqual(restoredState.modes, defaults.modes);
    assert.equal(restoredState.title, '');
    await restored.write('\x1b[2J\x1b[Hnew-shell');
    view = await readSnapshot(await restored.snapshot());
    const text = textOf(view);
    assert.ok(text.indexOf('normal-before-tui') < text.indexOf('[이전 전체 화면 기록]'));
    assert.ok(text.indexOf('TUI visible') < text.indexOf('이전 기록 · 새 셸 시작'));
    assert.ok(text.indexOf('한글 화면') < text.indexOf('new-shell'));
    assert.equal(view.buffer.active.type, 'normal');
    assert.equal(view.buffer.active.getLine(view.buffer.active.baseY)!.getCell(0)!.isAttributeDefault(), true);
  } finally { view?.dispose(); await source.dispose(); await restored.dispose(); }
});

test('repeated cold boots preserve preceding shell output instead of overwriting its cursor position', async () => {
  let engine = makeEngine();
  let view: Terminal | undefined;
  try {
    await engine.write('original-output');
    for (let boot = 1; boot <= 3; boot += 1) {
      const snapshot = await engine.snapshot();
      await engine.dispose();
      engine = makeEngine();
      await engine.restoreHistory(snapshot);
      await engine.write(`\x1b[2J\x1b[Hboot-${boot}-output`);
    }
    view = await readSnapshot(await engine.snapshot());
    const text = textOf(view);
    assert.match(text, /original-output/);
    for (let boot = 1; boot <= 3; boot += 1) assert.match(text, new RegExp(`boot-${boot}-output`));
    assert.equal(text.split('이전 기록 · 새 셸 시작').length - 1, 3);
  } finally { view?.dispose(); await engine.dispose(); }
});

test('restoration reflows wrapped text and stays within the 5000-row history bound and snapshot budget', async () => {
  const source = new TerminalEngine({ cols: 20, rows: 8, onResponse() {} });
  const restored = makeEngine();
  let view: Terminal | undefined;
  try {
    const wrapped = 'long-line-with-abcdefghijklmnopqrstuvwxyz-and-한글';
    await source.write(Array.from({ length: 5100 }, (_, i) => `bounded-${i}\r\n`).join('') + wrapped);
    await restored.restoreHistory(await source.snapshot());
    const snapshot = await restored.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1536 * 1024);
    view = await readSnapshot(snapshot);
    assert.ok(view.buffer.normal.baseY <= 5000);
    assert.match(textOf(view), /bounded-5099/);
    assert.ok(textOf(view).includes(wrapped));
    assert.ok(!textOf(view).includes('bounded-0\n'));
  } finally { view?.dispose(); await source.dispose(); await restored.dispose(); }
});

test('unsupported, oversized and late restoration fail without replacing live output', async () => {
  const source = makeEngine();
  const restored = makeEngine();
  let view: Terminal | undefined;
  try {
    const snapshot = await source.snapshot();
    await assert.rejects(restored.restoreHistory({ ...snapshot, version: 'older' }), /Unsupported/);
    await assert.rejects(restored.restoreHistory({ ...snapshot, cols: 501 }), /geometry/);
    await assert.rejects(restored.restoreHistory({ ...snapshot, data: '한'.repeat(Math.ceil(16 * 1024 * 1024 / 3)) }), /oversized/);
    await restored.restoreHistory({ ...snapshot, data: 'saved-output' });
    await assert.rejects(restored.restoreHistory(snapshot), /only be restored once/);
    await restored.write('live-output');
    await assert.rejects(restored.restoreHistory(snapshot), /before live output/);
    view = await readSnapshot(await restored.snapshot());
    assert.match(textOf(view), /saved-output/);
    assert.match(textOf(view), /live-output/);
    await source.write('already-live');
    await assert.rejects(source.restoreHistory(snapshot), /before live output/);
  } finally { view?.dispose(); await source.dispose(); await restored.dispose(); }
});
