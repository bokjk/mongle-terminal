import assert from 'node:assert/strict';
import test from 'node:test';
import headless from '@xterm/headless';
import { applyPresentationModes, beginMousePresentation } from '../../packages/terminal/pinned-xterm.js';
import { TerminalEngine } from '../../packages/terminal/engine.js';

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
