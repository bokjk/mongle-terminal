import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const geometry = { cols: 60, rows: 8 };

test('BEL, OSC 9 and OSC 777 produce one count per complete signal without retaining payloads', async () => {
  const counts: number[] = [], replies: string[] = [], directories: string[] = [];
  const engine = new TerminalEngine({ ...geometry, onResponse: value => replies.push(value),
    onNotification: count => counts.push(count), onDirectory: value => directories.push(value) });
  try {
    await engine.write('visible\x07\x1b]9;PRIVATE_NOTICE\x07\x1b]777;notify;PRIVATE_TITLE;PRIVATE_BODY\x1b\\');
    assert.deepEqual(counts, [1, 2, 3]);
    const snapshot = await engine.snapshot();
    assert.equal(snapshot.notificationCount, 3);
    assert.equal(snapshot.data, 'visible');
    assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_'));
    assert.deepEqual(replies, []);
    assert.deepEqual(directories, []);
  } finally { await engine.dispose(); }
});

test('empty notifications and numeric ConEmu extensions are ignored; OSC terminator BEL is not a bell', async () => {
  const counts: number[] = [], directories: string[] = [];
  const engine = new TerminalEngine({ ...geometry, onResponse() {}, onNotification: n => counts.push(n), onDirectory: d => directories.push(d) });
  try {
    for (const payload of ['', '  ', '9;C:\\synthetic', '4;1;50', '6;DoNotExecute()', '7;DoNotRun.exe', '99;future', '10', '0004;0']) {
      await engine.write(`\x1b]9;${payload}\x07`);
    }
    for (const payload of ['notify', 'notify;title', 'notify;;', 'notify; ; ', 'other;title;body']) {
      await engine.write(`\x1b]777;${payload}\x07`);
    }
    await engine.write('\x1b]0;window title\x07\x1b]52;c;U1lOVEhFVElD\x07\x1b]12345;ignored\x07');
    assert.deepEqual(counts, []);
    assert.deepEqual(directories, ['C:\\synthetic']);
    assert.equal((await engine.snapshot()).notificationCount, 0);
    await engine.write('\x1b]9;2 jobs finished\x1b\\\x1b]777;notify;;body\x07');
    assert.deepEqual(counts, [1, 2], 'text starting with a digit is not a numeric subcommand');
  } finally { await engine.dispose(); }
});

test('fragmented strings and UTF-8 bytes wait for the OSC terminator and do not double count BEL', async () => {
  const counts: number[] = [];
  const engine = new TerminalEngine({ ...geometry, onResponse() {}, onNotification: n => counts.push(n) });
  try {
    for (const part of ['\x1b', ']9;', '완료']) await engine.write(part);
    assert.deepEqual(counts, []);
    await engine.write('\x07');
    assert.deepEqual(counts, [1]);
    const bytes = new TextEncoder().encode('\x1b]777;notify;한글;끝\x1b\\');
    for (const byte of bytes.slice(0, -2)) await engine.write(new Uint8Array([byte]));
    assert.deepEqual(counts, [1]);
    // xterm ends OSC at ESC; the following backslash completes ST without
    // dispatching the notification a second time.
    await engine.write(bytes.slice(-2, -1));
    assert.deepEqual(counts, [1, 2]);
    await engine.write(bytes.slice(-1));
    assert.deepEqual(counts, [1, 2]);
    await engine.write('\x1b]9;cancelled\x18');
    assert.deepEqual(counts, [1, 2]);
    await engine.write('\x07');
    assert.deepEqual(counts, [1, 2, 3]);
  } finally { await engine.dispose(); }
});

test('snapshot count is captured at its parser fence, including without a callback', async () => {
  const engine = new TerminalEngine({ ...geometry, onResponse() {} });
  try {
    const first = engine.write('first\x07');
    const captured = engine.snapshot();
    const second = engine.write('\r\nsecond\x07');
    const snapshot = await captured;
    await Promise.all([first, second]);
    assert.equal(snapshot.notificationCount, 1);
    assert.ok(!snapshot.data.includes('second'));
    assert.equal((await engine.snapshot()).notificationCount, 2);
    assert.equal(snapshot.notificationCount, 1, 'a retained frame never inherits a newer count');
    await engine.resize(70, 9); await engine.clearHistory(); await engine.write('\x1bc');
    assert.equal((await engine.snapshot()).notificationCount, 2, 'RIS/history clear do not start a new process generation');
  } finally { await engine.dispose(); }
});

test('snapshot replay and cold history neither replay notifications nor inherit their count', async () => {
  const source = new TerminalEngine({ ...geometry, onResponse() {} });
  const counts: number[] = [];
  const restored = new TerminalEngine({ ...geometry, onResponse() {}, onNotification: n => counts.push(n) });
  const replay = new TerminalEngine({ ...geometry, onResponse() {}, onNotification: n => counts.push(n) });
  try {
    await source.write('saved\x07\x1b]9;signal\x07');
    const snapshot = await source.snapshot();
    assert.equal(snapshot.notificationCount, 2);
    await replay.write(snapshot.data); await replay.write(snapshot.data);
    assert.equal((await replay.snapshot()).notificationCount, 0);
    await restored.restoreHistory({ ...snapshot, data: snapshot.data + '\x07\x1b]9;old signal\x07\x1b]777;notify;t;b\x1b\\\x1b]9;partial' });
    assert.deepEqual(counts, []);
    assert.equal((await restored.snapshot()).notificationCount, 0);
    await restored.write('plain\x07');
    assert.deepEqual(counts, [1]);
  } finally { await source.dispose(); await restored.dispose(); await replay.dispose(); }
});

test('host lifetime gate and disposal suppress count changes while queued output settles', async () => {
  const counts: number[] = [];
  let enabled = false;
  const engine = new TerminalEngine({ ...geometry, onResponse() {}, notificationsEnabled: () => enabled, onNotification: n => counts.push(n) });
  await engine.write('last output\x07\x1b]9;ignored\x07');
  assert.equal((await engine.snapshot()).notificationCount, 0);
  enabled = true;
  await engine.write('\x07');
  assert.deepEqual(counts, [1]);
  const pending = engine.write('\x07\x1b]9;too late\x07');
  await Promise.all([pending, engine.dispose()]);
  assert.deepEqual(counts, [1]);
  await assert.rejects(engine.write('\x07'), /disposed/);
});
