import assert from 'node:assert/strict';
import test from 'node:test';
import Headless from '@xterm/headless';
import Browser from '@xterm/xterm';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { BrowserPresentationAdapter } from '../../packages/terminal/browser.js';
import { PRESENTATION_VERSION } from '../../packages/terminal/types.js';

const geometry = { cols: 40, rows: 8 };

test('synchronized output waits across PTY chunks without blocking the parser', async () => {
  const engine = new TerminalEngine({ ...geometry, onResponse() {} });
  try {
    await engine.write('old screen');
    await engine.write('\x1b[?2026h\x1b[2J\x1b[Hpartial');
    let resolved = false;
    const pending = engine.snapshot().then(frame => { resolved = true; return frame; });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(resolved, false, 'an incomplete synchronized update must not be published');
    await engine.write('\r\x1b[2Kcomplete screen\x1b[?2026l');
    const frame = await pending;
    assert.ok(frame.data.includes('complete screen'));
    assert.ok(!frame.data.includes('partial'));
    await engine.write('\x1b[?2026h');
    const started = Date.now();
    await engine.snapshot();
    assert.ok(Date.now() - started < 2000, 'a missing end marker cannot freeze snapshots forever');
  } finally { await engine.dispose(); }
});
const write = (terminal: HeadlessTerminal, data: string | Uint8Array) =>
  new Promise<void>(resolve => terminal.write(data, resolve));

function cells(terminal: HeadlessTerminal) {
  const b = terminal.buffer.active;
  return {
    type: b.type, x: b.cursorX, y: b.cursorY,
    lines: Array.from({ length: b.length }, (_, y) => {
      const line = b.getLine(y)!;
      return Array.from({ length: terminal.cols }, (_, x) => {
        const c = line.getCell(x)!;
        return [c.getChars(), c.getWidth(), c.getFgColor(), c.getBgColor(),
          c.getFgColorMode(), c.getBgColorMode(), c.isBold(), c.isUnderline(), c.isInverse()];
      });
    }),
  };
}

function setup() {
  const responses: string[] = [];
  const engine = new TerminalEngine({ ...geometry, onResponse: d => responses.push(d) });
  const baseline = new Headless.Terminal({ ...geometry, allowProposedApi: true });
  const client = new Browser.Terminal({ ...geometry, allowProposedApi: true });
  const inputs: Array<[string, string]> = [];
  const adapter = new BrowserPresentationAdapter(client, (d, e) => inputs.push([d, e]));
  return { engine, baseline, client, adapter, responses, inputs,
    async dispose() { adapter.dispose(); await engine.dispose(); baseline.dispose(); client.dispose(); } };
}

for (const [name, data] of [
  ['CSI/SGR', '\x1b[38;2;210;40;90m몽글\x1b[0m end'],
  ['OSC title', '\x1b]0;몽글 제목\x1b\\after'],
  ['DCS status query', '\x1bP$qm\x1b\\after'],
  ['UTF-8 and wide glyphs', '한글 😀 e\u0301 끝'],
] as const) {
  test(`every byte boundary: ${name} survives an intervening presentation`, async () => {
    const bytes = new TextEncoder().encode(data);
    for (let split = 1; split < bytes.length; split += 1) {
      const s = setup();
      try {
        await Promise.all([s.engine.write(bytes.slice(0, split)), write(s.baseline, bytes.slice(0, split))]);
        await s.adapter.applySnapshot(await s.engine.snapshot());
        assert.deepEqual(cells(s.client), cells(s.baseline), `partial ${name} @${split}`);
        await Promise.all([s.engine.write(bytes.slice(split)), write(s.baseline, bytes.slice(split))]);
        await s.adapter.applySnapshot(await s.engine.snapshot());
        assert.deepEqual(cells(s.client), cells(s.baseline), `complete ${name} @${split}`);
        assert.deepEqual(s.inputs, [], 'presentation never sends input');
      } finally { await s.dispose(); }
    }
  });
}

test('alternate screen, cursor, origin region, color and normal-screen return', async () => {
  const s = setup();
  try {
    for (const data of ['normal\r\nsecond', '\x1b[?1049h\x1b[2;6r\x1b[?6h\x1b[3;4H\x1b[44mTUI',
      '\x1b[?25l\x1b[5 q', '\x1b[?1049l\x1b[0m\x1b[?6l\x1b[r\r\nback']) {
      await Promise.all([s.engine.write(data), write(s.baseline, data)]);
      await s.adapter.applySnapshot(await s.engine.snapshot());
      assert.deepEqual(cells(s.client), cells(s.baseline));
    }
  } finally { await s.dispose(); }
});

test('only host answers DSR/DA, DCS and color/character geometry queries', async () => {
  const s = setup();
  try {
    await s.engine.write('abc\x1b[6n\x1b[c\x1b[>c\x1bP$qm\x1b\\\x1b]10;?\x1b\\\x1b[18t');
    assert.equal(s.responses.length, 6, JSON.stringify(s.responses));
    assert.ok(s.responses.includes('\x1b[1;4R'));
    assert.ok(s.responses.includes('\x1b[8;8;40t'));
    const frame = await s.engine.snapshot();
    await s.adapter.applySnapshot(frame);
    await s.adapter.applySnapshot(frame);
    assert.equal(s.responses.length, 6);
    assert.deepEqual(s.inputs, []);
    s.adapter.setInputEnabled(true);
    // Defense in depth: even an accidental query in a frame cannot respond.
    await s.adapter.applySnapshot({ ...frame, data: '\x1b[6n\x1b[c' });
    assert.deepEqual(s.inputs, []);
  } finally { await s.dispose(); }
});

test('input is not lost while an asynchronous frame is being applied', async () => {
  const s = setup();
  try {
    await s.engine.write('\x1b[?1h\x1b[?2004hhello');
    const frame = await s.engine.snapshot();
    s.adapter.setInputEnabled(true);
    const rendered = s.adapter.applySnapshot(frame);
    await Promise.resolve(); // Frame has reset, but its write callback is pending.
    s.client.input('한글', true);
    s.client.input('\x03', true);
    await rendered;
    s.adapter.paste('first\nsecond');
    assert.deepEqual(s.inputs, [['한글', 'utf8'], ['\x03', 'utf8'], ['\x1b[200~first\rsecond\x1b[201~', 'utf8']]);
    assert.equal(s.client.modes.applicationCursorKeysMode, true);
    s.adapter.setInputEnabled(false);
    s.client.input('must not leak', true);
    s.adapter.sendInput('\x03');
    assert.equal(s.inputs.length, 3);
  } finally { await s.dispose(); }
});

test('input modes, SGR mouse, cursor visibility/style and deliberate focus', async () => {
  const s = setup();
  try {
    await s.engine.write('\x1b[?1002;1006;1004;1;66;2004h\x1b[?25l\x1b[5 q');
    const frame = await s.engine.snapshot();
    assert.equal(frame.modes.mouseEncoding, 'SGR');
    assert.equal(frame.modes.cursorStyle, 'bar');
    assert.equal(frame.modes.cursorHidden, true);
    await s.adapter.applySnapshot(frame);
    s.adapter.setInputEnabled(true);
    s.adapter.setFocused(true);
    s.adapter.setFocused(false);
    const core = (s.client as any)._core;
    core.coreMouseService.triggerMouseEvent({ col: 2, row: 3, x: 16, y: 48, button: 0, action: 1, ctrl: false, alt: false, shift: false });
    assert.deepEqual(s.inputs, [['\x1b[I', 'utf8'], ['\x1b[O', 'utf8'], ['\x1b[<0;3;4M', 'utf8']]);
    assert.equal(core.coreService.isCursorHidden, true);
    assert.equal(core.coreService.decPrivateModes.cursorStyle, 'bar');
  } finally { await s.dispose(); }
});

test('legacy mouse is kept as binary, including non-ASCII coordinate bytes', async () => {
  const s = setup();
  try {
    await s.engine.resize(200, 8);
    await s.engine.write('\x1b[?1000h');
    await s.adapter.applySnapshot(await s.engine.snapshot());
    s.adapter.setInputEnabled(true);
    (s.client as any)._core.coreMouseService.triggerMouseEvent({ col: 150, row: 2, x: 0, y: 0, button: 0, action: 1, ctrl: false, alt: false, shift: false });
    assert.equal(s.inputs[0]?.[1], 'binary');
    assert.equal(s.inputs[0]?.[0].charCodeAt(4), 183);
  } finally { await s.dispose(); }
});

test('snapshot fence orders concurrent writes and resize; bounded history stays intact', async () => {
  const s = setup();
  try {
    const first = s.engine.write('before');
    const fence = s.engine.snapshot();
    const resize = s.engine.resize(50, 10);
    const after = s.engine.write('after');
    await Promise.all([first, resize, after]);
    const original = await fence;
    assert.equal(original.cols, 40);
    assert.equal(original.data, 'before');
    const latest = await s.engine.snapshot();
    assert.equal(latest.cols, 50);
    assert.match(latest.data, /beforeafter/);
    assert.ok(latest.revision! > original.revision!);
  } finally { await s.dispose(); }
});

test('clearHistory retains all visible rows, cursor and a partial CSI parser', async () => {
  const s = setup();
  try {
    await s.engine.write(Array.from({ length: 20 }, (_, i) => `line${i}\r\n`).join('') + '\x1b[');
    const before = await s.engine.snapshot();
    await s.adapter.applySnapshot(before);
    const visible = cells(s.client).lines.slice(-8);
    const cursor = s.client.buffer.active.cursorY;
    await s.engine.clearHistory();
    await s.adapter.applySnapshot(await s.engine.snapshot());
    assert.deepEqual(cells(s.client).lines, visible);
    assert.equal(s.client.buffer.active.cursorY, cursor);
    await s.engine.write('31mred');
    await s.adapter.applySnapshot(await s.engine.snapshot());
    assert.equal(s.client.buffer.active.getLine(cursor)!.getCell(0)!.getFgColor(), 1);
  } finally { await s.dispose(); }
});

test('IME composition does not stall echoed output or frame acknowledgement', async () => {
  const s = setup();
  try {
    await s.engine.write('new picture');
    s.adapter.beginComposition();
    let settled = false;
    const apply = s.adapter.applySnapshot(await s.engine.snapshot()).then(() => { settled = true; });
    await apply;
    assert.equal(settled, true);
    assert.equal(s.client.buffer.active.getLine(0)!.translateToString(true), 'new picture');
    s.adapter.endComposition();
    await apply;
    assert.equal(s.client.buffer.active.getLine(0)!.translateToString(true), 'new picture');
  } finally { await s.dispose(); }
});

test('dependency, geometry and lifecycle contracts reject invalid operations', async () => {
  const s = setup();
  await assert.rejects(s.adapter.applySnapshot({ kind: 'presentation-v1', version: 'wrong', cols: 40, rows: 8, data: '', modes: {} }));
  assert.throws(() => new TerminalEngine({ cols: 0, rows: 0, onResponse() {} }));
  assert.throws(() => s.adapter.applySnapshot({ kind: 'presentation-v1', version: PRESENTATION_VERSION, cols: 40, rows: 8, data: '', modes: {} }));
  await s.dispose();
  await assert.rejects(s.engine.write('late'));
});

test('3000 colorful lines fit the history byte budget without changing the live parser or viewport', async () => {
  const s = setup();
  try {
    const line = Array.from({ length: 39 }, (_, i) => `\x1b[38;2;${i * 5};${255 - i * 3};${i * 2}mX`).join('');
    await s.engine.write(Array.from({ length: 3000 }, () => line + '\r\n').join('') + '\x1b[');
    const live = (s.engine as any).terminal as HeadlessTerminal;
    const historyBefore = live.buffer.normal.baseY;
    const snapshot = await s.engine.snapshot();
    assert.equal(snapshot.historyTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1536 * 1024);
    assert.ok(snapshot.historyLinesIncluded! > 0);
    assert.equal(live.buffer.normal.baseY, historyBefore, 'presentation budget must not erase live history');
    await s.adapter.applySnapshot(snapshot);
    const visible = (terminal: HeadlessTerminal) => Array.from({ length: terminal.rows }, (_, row) =>
      terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)!.translateToString(false));
    assert.deepEqual(visible(s.client), visible(live));
    await s.engine.write('31mred');
    assert.equal(live.buffer.active.getLine(live.buffer.active.baseY + live.buffer.active.cursorY)!.getCell(0)!.getFgColor(), 1);
  } finally { await s.dispose(); }
});

test('an oversized current viewport is reported and preserved instead of truncating visible cells', async () => {
  const s = setup();
  try {
    const data = Array.from({ length: 39 * 7 }, (_, i) => `\x1b[38;2;${i % 256};${(i * 3) % 256};${(i * 7) % 256}mX`).join('');
    await s.engine.write(data);
    const snapshot = await s.engine.snapshot({ maxBytes: 1024 });
    assert.equal(snapshot.oversized, true);
    await s.adapter.applySnapshot(snapshot);
    assert.deepEqual(cells(s.client), cells((s.engine as any).terminal));
  } finally { await s.dispose(); }
});

test('many frames use one pending slot and acknowledge only after newest is applied', async () => {
  const s = setup();
  try {
    s.adapter.beginComposition();
    const base = await s.engine.snapshot();
    const first = s.adapter.applySnapshot({ ...base, data: 'old' });
    let settled = false;
    void first.then(() => { settled = true; });
    for (let i = 0; i < 1000; i += 1) {
      const next = s.adapter.applySnapshot({ ...base, data: `latest-${i}` });
      assert.equal(next, first, 'one shared promise, not 1000 retained frame tasks');
    }
    await Promise.resolve();
    assert.equal(settled, false);
    s.adapter.endComposition();
    await first;
    assert.equal(s.client.buffer.active.getLine(0)!.translateToString(true), 'latest-999');
  } finally { await s.dispose(); }
});
