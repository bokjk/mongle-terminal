import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';
import { attachTouchScrollback } from '../../packages/terminal/touch-scrollback.js';

// Exercise the touch listener and event routing without a browser. Real xterm
// encoding, trusted browser touch and live CLI behavior are separate checks.
class TestWheel extends Event {
  static DOM_DELTA_LINE = 1;
  deltaY: number; deltaMode: number; clientX: number; clientY: number;
  constructor(type: string, init: WheelEventInit) {
    super(type, init);
    this.deltaY = init.deltaY!; this.deltaMode = init.deltaMode!;
    this.clientX = init.clientX!; this.clientY = init.clientY!;
  }
}
function fixture({ mouse = true, enabled = true, normal = false } = {}) {
  const screen = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: { WheelEvent: TestWheel } },
    getBoundingClientRect: () => ({ left: 20, top: 10, right: 220, bottom: 110, height: 100 }),
  });
  const state = { context: mouse ? 1 : undefined as number | undefined, enabled, requests: 0 };
  const wheels: TestWheel[] = [], history: number[] = [];
  screen.addEventListener('wheel', event => wheels.push(event as TestWheel));
  const terminal = { element: { querySelector: () => screen }, rows: 10,
    buffer: { active: { type: normal ? 'normal' : 'alternate', baseY: normal ? 80 : 0 } },
    scrollLines: (lines: number) => history.push(lines) } as unknown as Terminal;
  const handler = attachTouchScrollback(terminal, {
    context: () => state.context, enabled: () => state.enabled, request: () => { state.requests++; },
  });
  function touch(type: string, y = 40, x = 100, count = 1, cancelable = true) {
    const event = new Event(type, { cancelable });
    Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, id) => ({ identifier: id, clientX: x + id * 20, clientY: y })) });
    screen.dispatchEvent(event);
    return event;
  }
  return { screen, state, wheels, history, terminal, handler, touch };
}

test('fullscreen pan reports each row in both directions through standard wheel events', () => {
  const f = fixture();
  f.touch('touchstart', 40); f.touch('touchmove', 70);
  assert.deepEqual(f.wheels.map(w => [w.deltaY, w.deltaMode, w.clientX, w.clientY]), Array.from({ length: 3 }, () => [-1, 1, 100, 70]));
  f.touch('touchmove', 50);
  assert.deepEqual(f.wheels.map(w => w.deltaY), [-1, -1, -1, 1, 1]);
  assert.deepEqual(f.history, []);
  assert.equal(f.state.requests, 0);
  f.handler.dispose();
});

test('partial rows accumulate without depending on touch event frequency', () => {
  const f = fixture();
  f.touch('touchstart', 40);
  for (const y of [44, 47, 49, 51, 55, 59, 60]) f.touch('touchmove', y);
  assert.deepEqual(f.wheels.map(w => w.deltaY), [-1, -1]);
  f.handler.dispose();
});

test('readonly application pan requests once without replaying closed-gate movement', () => {
  const f = fixture({ enabled: false });
  f.touch('touchstart', 20); f.touch('touchmove', 60); f.touch('touchmove', 80);
  assert.equal(f.state.requests, 1);
  assert.equal(f.wheels.length, 0);
  f.state.enabled = true;
  f.touch('touchmove', 84);
  assert.equal(f.wheels.length, 0);
  f.touch('touchmove', 90);
  assert.equal(f.wheels.length, 1);
  f.handler.dispose();
});

test('closed input gate discards fractional movement even if native editor stays writable', () => {
  const f = fixture();
  f.touch('touchstart', 20); f.touch('touchmove', 27);
  f.state.enabled = false; f.touch('touchmove', 70);
  f.state.enabled = true; f.touch('touchmove', 74);
  assert.equal(f.wheels.length, 0);
  f.handler.dispose();
});

test('normal history remains local in read-only mode', () => {
  const f = fixture({ mouse: false, enabled: false, normal: true });
  f.touch('touchstart', 40); f.touch('touchmove', 70); f.touch('touchmove', 50);
  assert.deepEqual(f.history, [-3, 2]);
  assert.equal(f.wheels.length, 0);
  assert.equal(f.state.requests, 0);
  f.handler.dispose();
});

test('unsupported alternate-screen protocol never becomes wheel or arrow input', () => {
  const f = fixture({ mouse: false });
  f.touch('touchstart', 40); f.touch('touchmove', 90);
  assert.equal(f.wheels.length, 0); assert.equal(f.state.requests, 0);
  assert.deepEqual(f.history, []);
  f.handler.dispose();
});

test('protocol, geometry or input-lease context change cancels an active pan', () => {
  for (const context of [undefined, 2]) {
    const f = fixture();
    f.touch('touchstart', 40); f.state.context = context; f.touch('touchmove', 90);
    f.state.context = 1; f.touch('touchmove', 100);
    assert.equal(f.wheels.length, 0);
    f.handler.dispose();
  }
});

test('changing from local history to application mode does not reuse a gesture', () => {
  const f = fixture({ mouse: false, normal: true });
  f.touch('touchstart', 40); f.state.context = 1; f.touch('touchmove', 90);
  assert.equal(f.wheels.length, 0); assert.deepEqual(f.history, []);
  f.handler.dispose();
});

test('horizontal movement, pinch, canceled events and touchcancel do not send input', () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.touch('touchmove', 43, 140),
    (f: ReturnType<typeof fixture>) => f.touch('touchmove', 80, 100, 2),
    (f: ReturnType<typeof fixture>) => f.touch('touchmove', 80, 100, 1, false),
    (f: ReturnType<typeof fixture>) => f.touch('touchcancel'),
  ]) {
    const f = fixture();
    f.touch('touchstart', 40); invalidate(f); f.touch('touchmove', 100);
    assert.equal(f.wheels.length, 0);
    f.handler.dispose();
  }
});

test('out-of-screen movement clamps coordinates and bounds work to one viewport per move', () => {
  const f = fixture();
  f.touch('touchstart', 40); f.touch('touchmove', 2000, -200);
  assert.equal(f.wheels.length, 10);
  assert.ok(f.wheels.every(w => w.clientX === 21 && w.clientY === 109));
  f.touch('touchmove', 2001, -200);
  assert.equal(f.wheels.length, 10, 'excess whole rows are discarded, not retained as a burst');
  f.handler.dispose();
});

test('disposal and touchend remove gesture input', () => {
  const f = fixture();
  f.touch('touchstart', 40); f.touch('touchend'); f.touch('touchmove', 90);
  f.handler.dispose(); f.touch('touchstart', 40); f.touch('touchmove', 90);
  assert.equal(f.wheels.length, 0);
});

test('uncancelable readonly gestures and long-press menus do not acquire control', () => {
  const f = fixture({ enabled: false });
  f.touch('touchstart', 40); f.touch('touchmove', 80, 100, 1, false);
  assert.equal(f.state.requests, 0);
  f.touch('touchstart', 40); f.screen.dispatchEvent(new Event('contextmenu')); f.touch('touchmove', 90);
  assert.equal(f.state.requests, 0);
  f.handler.dispose();
});
