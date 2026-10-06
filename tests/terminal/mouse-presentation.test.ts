import assert from 'node:assert/strict';
import test from 'node:test';
import headless from '@xterm/headless';
import Browser from '@xterm/xterm';
import { BrowserPresentationAdapter } from '../../packages/terminal/browser.js';
import { applyPresentationModes, beginMousePresentation } from '../../packages/terminal/pinned-xterm.js';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import type { TerminalModes } from '../../packages/terminal/types.js';

async function withMouseTerminal(run: (terminal: headless.Terminal, service: any, modes: TerminalModes, reports: string[]) => Promise<void>) {
  const terminal = new headless.Terminal({ allowProposedApi: true, cols: 40, rows: 8 });
  const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse: () => {} });
  try {
    await engine.write('\x1b[?1006h\x1b[?1003h');
    const { modes } = await engine.snapshot();
    const service = (terminal as any)._core.coreMouseService;
    applyPresentationModes(terminal, modes);
    const reports: string[] = [];
    terminal.onData(data => reports.push(data));
    terminal.onBinary(data => reports.push(data));
    await run(terminal, service, modes, reports);
  } finally { terminal.dispose(); engine.dispose(); }
}

function move(service: any, col = 4, x = 45) {
  return service.triggerMouseEvent({ col, row: 3, x, y: 35, button: 0, action: 32, ctrl: false, alt: false, shift: false });
}

// Node has no WheelEvent. Only its standard delta-mode constants are needed by
// the actual xterm consumeWheelEvent implementation; no mouse logic is mocked.
function wheel(service: any): number {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WheelEvent');
  Object.defineProperty(globalThis, 'WheelEvent', { configurable: true, value: { DOM_DELTA_PIXEL: 0, DOM_DELTA_PAGE: 2 } });
  try {
    return service.consumeWheelEvent({ deltaY: 20, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false }, 10, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'WheelEvent', descriptor);
    else Reflect.deleteProperty(globalThis, 'WheelEvent');
  }
}

async function present(terminal: headless.Terminal, modes: TerminalModes, duringWrite?: () => void) {
  const finish = beginMousePresentation(terminal, modes);
  let release!: (handled: boolean) => void;
  let entered!: () => void;
  const enteredParser = new Promise<void>(resolve => { entered = resolve; });
  const blockedParser = new Promise<boolean>(resolve => { release = resolve; });
  // Headless 6's declaration omits the Promise return supported by its shared
  // EscapeSequenceParser/WriteBuffer (and declared by browser xterm 6).
  const parser = terminal.parser as unknown as Browser.Terminal['parser'];
  const handler = parser.registerOscHandler(777, () => { entered(); return blockedParser; });
  let pending: Promise<void> | undefined;
  try {
    terminal.reset();
    applyPresentationModes(terminal, modes);
    let completed = false;
    pending = new Promise<void>(resolve => terminal.write('\x1b]777;test-only-parser-gate\x07frame', () => { completed = true; resolve(); }));
    await enteredParser;
    assert.equal(completed, false, 'the actual xterm parser must still be blocked');
    duringWrite?.();
    release(true);
    await pending;
    applyPresentationModes(terminal, modes);
  } finally { release(true); await pending; handler.dispose(); finish(); }
}

test('real RIS survives coalesced snapshots and clears mouse state like direct VT', async () => {
  const options = { cols: 40, rows: 8, allowProposedApi: true };
  const client = new Browser.Terminal(options), live = new headless.Terminal(options);
  const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
  const adapter = new BrowserPresentationAdapter(client, () => {});
  const mode = '\x1b[?1006h\x1b[?1003h';
  const writeLive = (data: string) => new Promise<void>(resolve => live.write(data, resolve));
  const clientMouse = (client as any)._core.coreMouseService, liveMouse = (live as any)._core.coreMouseService;
  try {
    await engine.write(mode); await writeLive(mode);
    const initial = await engine.snapshot();
    assert.equal(initial.inputResetGeneration, 0);
    await adapter.applySnapshot(initial);
    move(clientMouse); move(liveMouse); wheel(clientMouse); wheel(liveMouse);
    await adapter.applySnapshot(await engine.snapshot());
    assert.equal(move(clientMouse), false, 'ordinary pictures still preserve deduplication');
    // Split RIS at the byte boundary: only the completed escape counts.
    await engine.write('\x1b');
    assert.equal((await engine.snapshot()).inputResetGeneration, 0);
    await engine.write('c' + mode); await writeLive('\x1bc' + mode);
    const reset = await engine.snapshot();
    assert.equal(reset.inputResetGeneration, 1);
    assert.deepEqual(reset.modes, initial.modes);
    const superseded = adapter.applySnapshot(reset);
    await adapter.applySnapshot(JSON.parse(JSON.stringify(reset)));
    await superseded;
    assert.equal(move(liveMouse), true);
    assert.equal(move(clientMouse), true, 'first post-RIS move must reach the CLI');
    assert.equal(move(clientMouse), false);
    assert.equal(wheel(clientMouse), wheel(liveMouse), 'RIS discards the pre-reset wheel fraction');
    await adapter.applySnapshot(await engine.snapshot());
    assert.equal(move(clientMouse), false, 'a repeated generation must not keep clearing state');
  } finally { adapter.dispose(); client.dispose(); live.dispose(); await engine.dispose(); }
});

test('legacy frames remain accepted without assuming an unreported reset generation', async () => {
  const client = new Browser.Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
  const adapter = new BrowserPresentationAdapter(client, () => {});
  try {
    await engine.write('\x1b[?1006h\x1b[?1003h');
    const current = await engine.snapshot();
    const { inputResetGeneration: _, ...legacy } = current;
    const service = (client as any)._core.coreMouseService;
    await adapter.applySnapshot(current); move(service);
    await adapter.applySnapshot(legacy);
    assert.equal(move(service), true);
    await adapter.applySnapshot(legacy);
    assert.equal(move(service), true, 'unknown generation retains the legacy per-frame invalidation');
    await adapter.applySnapshot(current);
    assert.equal(move(service), true, 'learning a generation starts a fresh context');
    await adapter.applySnapshot(current);
    assert.equal(move(service), false);
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
      await assert.rejects(adapter.applySnapshot({ ...current, inputResetGeneration: invalid as number }), /presentation/i);
    }
    assert.equal(move(service), false, 'rejected frames cannot disturb the valid context');
  } finally { adapter.dispose(); client.dispose(); await engine.dispose(); }
});

test('same-cell movement remains suppressed across repeated pictures', async () => {
  await withMouseTerminal(async (terminal, service, modes, reports) => {
    assert.equal(move(service), true);
    for (let i = 0; i < 3; i++) {
      await present(terminal, modes);
      assert.equal(move(service), false);
    }
    assert.deepEqual(reports, ['\x1b[<32;5;4M']);
    assert.equal(move(service, 5), true, 'a genuinely new cell still reaches the CLI');
  });
});

test('fractional wheel movement accumulates like live xterm across pictures', async () => {
  await withMouseTerminal(async (terminal, service, modes) => {
    const live = new headless.Terminal({ cols: 40, rows: 8 });
    try {
      const control = (live as any)._core.coreMouseService;
      const actual: number[] = [], expected: number[] = [];
      for (let i = 0; i < 6; i++) {
        actual.push(wheel(service));
        expected.push(wheel(control));
        await present(terminal, modes);
      }
      assert.deepEqual(actual, expected);
      assert.ok(actual.reduce((a, b) => a + b, 0) >= 3);
    } finally { live.dispose(); }
  });
});

test('input during an asynchronous picture is not overwritten at finish or the next reset', async () => {
  await withMouseTerminal(async (terminal, service, modes, reports) => {
    move(service);
    assert.equal(wheel(service), 0);
    await present(terminal, modes, () => {
      assert.equal(move(service, 6), true);
      assert.equal(wheel(service), 1, 'pre-frame fraction must be available before write completes');
    });
    assert.equal(move(service, 6), false, 'finish must keep the new cell');
    await present(terminal, modes);
    assert.equal(move(service, 6), false);
    assert.equal(wheel(service), 0, 'finish must keep the consumed fraction, not restore the old one');
    assert.deepEqual(reports, ['\x1b[<32;5;4M', '\x1b[<32;7;4M']);
  });
});

for (const change of ['protocol', 'encoding', 'resize'] as const) {
  test(`${change} invalidates old movement and fractional wheel state before more input`, async () => {
    await withMouseTerminal(async (terminal, service, modes) => {
      move(service);
      assert.equal(wheel(service), 0);
      const next = { ...modes };
      if (change === 'protocol') next.mouseTrackingMode = 'drag';
      if (change === 'encoding') next.mouseEncoding = 'SGR_PIXELS';
      const finish = beginMousePresentation(terminal, next);
      try {
        terminal.reset();
        if (change === 'resize') terminal.resize(41, 8);
        applyPresentationModes(terminal, next);
        assert.equal(move(service), true, 'first move in the new coordinate/mode context must be sent');
        assert.equal(wheel(service), 0, 'old fractional scroll must not enter the new context');
        await new Promise<void>(resolve => terminal.write('new geometry', resolve));
        applyPresentationModes(terminal, next);
      } finally { finish(); }
      assert.equal(move(service), false, 'new input must survive finish');
    });
  });
}

test('resize during a pending picture, even resized back, invalidates old coordinates', async () => {
  await withMouseTerminal(async (terminal, service, modes) => {
    await present(terminal, modes, () => {
      move(service);
      wheel(service);
      terminal.resize(41, 8);
      terminal.resize(40, 8);
      assert.equal(move(service), true);
      assert.equal(wheel(service), 0);
    });
    assert.equal(move(service), false);
  });
});

test('pixel encoding preserves pixel-level movement suppression without suppressing within-cell motion', async () => {
  await withMouseTerminal(async (terminal, service, modes, reports) => {
    const pixels = { ...modes, mouseEncoding: 'SGR_PIXELS' as const };
    applyPresentationModes(terminal, pixels);
    move(service);
    await present(terminal, pixels);
    assert.equal(move(service), false);
    assert.equal(move(service, 4, 46), true);
    assert.deepEqual(reports, ['\x1b[<32;45;35M', '\x1b[<32;46;35M']);
  });
});

test('failed presentation clears stale input state and restores ordinary reset behavior', async () => {
  await withMouseTerminal(async (terminal, service, modes) => {
    const originalReset = service.reset;
    const originalFire = service._onProtocolChange.fire;
    move(service);
    wheel(service);
    const finish = beginMousePresentation(terminal, modes);
    terminal.reset(); // Failure before the authoritative modes are reapplied.
    finish(); finish();
    assert.equal(service.reset, originalReset);
    assert.equal(service._onProtocolChange.fire, originalFire);
    applyPresentationModes(terminal, modes);
    assert.equal(move(service), true);
    assert.equal(wheel(service), 0);
    terminal.reset(); // Outside a presentation this remains a real reset.
    applyPresentationModes(terminal, modes);
    assert.equal(move(service), true);
    assert.equal(wheel(service), 0);
  });
});

for (const protocol of ['drag', 'any'] as const) {
  test(`presentation resets do not unbind an active ${protocol} mouse gesture`, async () => {
    const terminal = new headless.Terminal({ allowProposedApi: true });
    const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse: () => {} });
    try {
      await engine.write(`\x1b[?1006h\x1b[?${protocol === 'drag' ? 1002 : 1003}h`);
      const frame = await engine.snapshot();
      const service = (terminal as any)._core.coreMouseService;
      applyPresentationModes(terminal, frame.modes);
      const changes: number[] = [];
      service.onProtocolChange((events: number) => changes.push(events));
      for (let i = 0; i < 3; i++) {
        const finish = beginMousePresentation(terminal, frame.modes);
        terminal.reset();
        applyPresentationModes(terminal, frame.modes);
        await new Promise<void>(resolve => terminal.write(frame.data, resolve));
        applyPresentationModes(terminal, frame.modes);
        finish(); finish();
      }
      assert.deepEqual(changes, [], 'temporary NONE must never remove document drag/release listeners');
      assert.equal(service.activeProtocol, protocol.toUpperCase());
      service.activeProtocol = 'NONE';
      assert.deepEqual(changes, [0], 'real protocol changes must still notify after the frame');
    } finally { terminal.dispose(); engine.dispose(); }
  });
}

test('real mouse-mode changes are published once and failed frames restore notifications', async () => {
  const terminal = new headless.Terminal({ allowProposedApi: true });
  const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse: () => {} });
  try {
    await engine.write('\x1b[?1003h');
    const frame = await engine.snapshot();
    const service = (terminal as any)._core.coreMouseService;
    const changes: number[] = [];
    service.onProtocolChange((events: number) => changes.push(events));
    const finish = beginMousePresentation(terminal, frame.modes);
    assert.equal(changes.length, 1, 'new authoritative mode is published before yielding');
    assert.notEqual(changes[0], 0);
    terminal.reset(); // Simulate a failed frame before modes are restored.
    finish(); finish();
    assert.deepEqual(changes.slice(1), [0]);
    service.activeProtocol = 'ANY';
    assert.equal(changes.length, 3, 'failure must not leave the emitter suppressed');
  } finally { terminal.dispose(); engine.dispose(); }
});
