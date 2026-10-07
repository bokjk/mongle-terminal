import assert from 'node:assert/strict';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';
import { attachTouchScrollback, touchScrollSpeed, TOUCH_SCROLL_SPEEDS } from '../../packages/terminal/touch-scrollback.js';
import { TerminalInputQueue } from '../../apps/web/src/terminal-input-queue.js';

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
function fixture({ mouse = true, enabled = true, normal = false, speed = 1, height = 100 } = {}) {
  let time = 0, nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const state = { context: mouse ? 1 : undefined as number | undefined, enabled, requests: 0, speed, momentumReady: true, reducedMotion: false, height };
  const window = Object.assign(new EventTarget(), {
    WheelEvent: TestWheel, performance: { now: () => time },
    matchMedia: () => ({ matches: state.reducedMotion }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const document = Object.assign(new EventTarget(), { defaultView: window, hidden: false });
  const screen = Object.assign(new EventTarget(), {
    ownerDocument: document,
    getBoundingClientRect: () => ({ left: 20, top: 10, right: 220, bottom: 10 + state.height, height: state.height, width: 200 }),
  });
  const wheels: TestWheel[] = [], history: number[] = [];
  screen.addEventListener('wheel', event => wheels.push(event as TestWheel));
  const buffer = { type: normal ? 'normal' : 'alternate', baseY: normal ? 80 : 0, viewportY: normal ? 40 : 0 };
  const terminal = { element: { querySelector: () => screen }, rows: 10, cols: 20,
    buffer: { active: buffer },
    scrollLines: (lines: number) => { history.push(lines); buffer.viewportY = Math.max(0, Math.min(buffer.baseY, buffer.viewportY + lines)); } } as unknown as Terminal;
  const handler = attachTouchScrollback(terminal, {
    context: () => state.context, enabled: () => state.enabled, request: () => { state.requests++; },
    momentumReady: () => state.momentumReady,
  }, () => state.speed);
  function touch(type: string, y = 40, x = 100, count = type === 'touchend' ? 0 : 1, cancelable = true) {
    const event = new Event(type, { cancelable });
    Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, (_, id) => ({ identifier: id, clientX: x + id * 20, clientY: y })) });
    if (type === 'touchstart') document.dispatchEvent(new Event(type));
    screen.dispatchEvent(event);
    return event;
  }
  function advance(ms: number, paint = false) {
    time += ms;
    if (paint) { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(time); }
  }
  return { screen, document, window, state, wheels, history, buffer, terminal, handler, touch, advance, frames };
}

test('touch speed scales both local history and application reports by distance, not event count', () => {
  for (const speed of TOUCH_SCROLL_SPEEDS) {
    for (const mouse of [false, true]) {
      for (const points of [[80], [47, 51, 58, 65, 71, 80]]) {
        const f = fixture({ speed, mouse, normal: !mouse });
        f.touch('touchstart', 40);
        for (const point of points) f.touch('touchmove', point);
        const steps = mouse ? f.wheels.reduce((sum, wheel) => sum + wheel.deltaY, 0) : f.history.reduce((sum, lines) => sum + lines, 0);
        assert.equal(steps, -Math.trunc(mouse ? 40 * speed / 24 : 40 * speed / 0.5 / 10) || 0, `speed=${speed}, mouse=${mouse}, events=${points.length}`);
        f.touch('touchend'); f.touch('touchstart', 80); f.touch('touchmove', 40);
        const total = mouse ? f.wheels.reduce((sum, wheel) => sum + wheel.deltaY, 0) : f.history.reduce((sum, lines) => sum + lines, 0);
        assert.equal(total, 0, 'The same distance in the opposite direction has the same magnitude');
        f.handler.dispose();
      }
    }
  }
});

test('a changed speed applies on the next swipe without replaying fractional movement', () => {
  const f = fixture({ speed: 0.25 });
  f.touch('touchstart', 40); f.touch('touchmove', 60);
  assert.equal(f.wheels.length, 0);
  f.state.speed = 2;
  f.touch('touchmove', 140);
  assert.equal(f.wheels.length, 1, 'Active swipe keeps its original speed');
  f.touch('touchend'); f.touch('touchstart', 40); f.touch('touchmove', 88);
  assert.equal(f.wheels.length, 5, 'The next swipe uses the new speed without restarting the terminal');
  f.handler.dispose();
});

test('invalid saved touch speeds use the slower default rather than unsafe or infinite movement', () => {
  for (const value of [undefined, null, '0.5', false, 0, -1, 100, NaN, Infinity, {}]) assert.equal(touchScrollSpeed(value), 0.5);
  for (const value of TOUCH_SCROLL_SPEEDS) assert.equal(touchScrollSpeed(value), value);
});

test('reversing a slow swipe offsets its fractional remainder without sending the wrong direction', () => {
  const f = fixture({ speed: 0.5 });
  f.touch('touchstart', 40); f.touch('touchmove', 58);
  assert.equal(f.wheels.length, 0, 'Nine scaled pixels are less than one row');
  f.touch('touchmove', 40);
  assert.equal(f.wheels.length, 0, 'Returning to the start cancels the fraction');
  f.touch('touchmove', -8);
  assert.deepEqual(f.wheels.map(w => w.deltaY), [1]);
  f.handler.dispose();
});

test('fullscreen pan reports physical detents in both directions through standard wheel events', () => {
  const f = fixture();
  f.touch('touchstart', 10); f.touch('touchmove', 82);
  assert.deepEqual(f.wheels.map(w => [w.deltaY, w.deltaMode, w.clientX, w.clientY]), Array.from({ length: 3 }, () => [-1, 1, 100, 82]));
  f.touch('touchmove', 34);
  assert.deepEqual(f.wheels.map(w => w.deltaY), [-1, -1, -1, 1, 1]);
  assert.deepEqual(f.history, []);
  assert.equal(f.state.requests, 0);
  f.handler.dispose();
});

test('partial rows accumulate without depending on touch event frequency', () => {
  const f = fixture();
  f.touch('touchstart', 40);
  for (const y of [44, 47, 49, 51, 55, 59, 88]) f.touch('touchmove', y);
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
  f.touch('touchmove', 104);
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
  const f = fixture({ mouse: false, enabled: false, normal: true, speed: 0.5 });
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
  f.touch('touchstart', 40); f.document.dispatchEvent(new Event('contextmenu')); f.touch('touchmove', 90);
  assert.equal(f.state.requests, 0);
  f.handler.dispose();
});

function flick(f: ReturnType<typeof fixture>) {
  f.touch('touchstart', 10);
  for (const y of [30, 50, 70]) { f.advance(20); f.touch('touchmove', y); }
  f.touch('touchend');
}

test('font size does not amplify application detents; default local distance follows the finger within one row', () => {
  for (const height of [110, 140, 240]) {
    const cli = fixture({ height, speed: 0.5 });
    cli.touch('touchstart', 10); cli.touch('touchmove', 106);
    assert.equal(cli.wheels.length, 2, '96 CSS px always sends two detents regardless of font');
    const local = fixture({ height, speed: 0.5, mouse: false, normal: true });
    local.touch('touchstart', 10); local.touch('touchmove', 106);
    const painted = Math.abs(local.history.reduce((sum, lines) => sum + lines, 0)) * height / 10;
    assert.ok(painted <= 96 && 96 - painted < height / 10);
    cli.handler.dispose(); local.handler.dispose();
  }
});

test('quick swipes decelerate with bounded travel independent of animation frame rate', () => {
  const distances: number[] = [];
  for (const interval of [8, 16, 32]) {
    for (const speed of [0.25, 0.5, 2]) {
      const f = fixture({ mouse: false, normal: true, speed, height: 200 });
      flick(f);
      const before = f.buffer.viewportY;
      const increments: number[] = [];
      for (let index = 0; index < Math.ceil(700 / interval); index++) {
        const last = f.buffer.viewportY; f.advance(interval, true);
        increments.push(last - f.buffer.viewportY);
      }
      const extraPixels = (before - f.buffer.viewportY) * 20;
      assert.ok(extraPixels > 0 && extraPixels <= 140, `speed ${speed}: ${extraPixels}px <= 120px cap plus a row remainder`);
      assert.ok(increments.every(amount => amount >= 0));
      assert.ok(Math.max(...increments) <= 4, 'no large catch-up burst');
      assert.equal(f.frames.size, 0, 'fling is finished within 600 ms');
      if (speed === 0.5) distances.push(extraPixels);
      f.handler.dispose();
    }
  }
  assert.ok(Math.max(...distances) - Math.min(...distances) <= 20, '8/16/32 ms clocks agree within one painted row');
});

test('slow swipes, a held finger, and reduced-motion preference do not coast', () => {
  for (const kind of ['slow', 'hold', 'reduced']) {
    const f = fixture();
    f.touch('touchstart', 10);
    f.advance(kind === 'slow' ? 500 : 20); f.touch('touchmove', 30);
    f.advance(kind === 'slow' ? 500 : 20); f.touch('touchmove', 50);
    if (kind === 'hold') f.advance(100);
    if (kind === 'reduced') f.state.reducedMotion = true;
    f.touch('touchend');
    assert.equal(f.frames.size, 0, kind);
    f.handler.dispose();
  }
});

test('touch, keys, menus, external wheel, hiding, blur and disposal stop inertia immediately', () => {
  for (const reason of ['touchstart', 'pointerdown', 'keydown', 'compositionstart', 'contextmenu', 'wheel', 'hidden', 'blur', 'dispose']) {
    const f = fixture({ height: 200 });
    flick(f); f.advance(16, true);
    assert.ok(f.frames.size > 0);
    if (reason === 'hidden') { f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange')); }
    else if (reason === 'blur') f.window.dispatchEvent(new Event('blur'));
    else if (reason === 'dispose') f.handler.dispose();
    else f.document.dispatchEvent(new Event(reason));
    const count = f.wheels.length;
    for (let i = 0; i < 40; i++) f.advance(16, true);
    assert.equal(f.wheels.length, count, reason); assert.equal(f.frames.size, 0);
    f.handler.dispose();
  }
});

test('inertia never catches up after stalled rendering, a font change, input fencing or a slow transport', () => {
  for (const reason of ['stall', 'font', 'context', 'gate', 'pending']) {
    const f = fixture({ height: 200 });
    flick(f);
    const count = f.wheels.length;
    if (reason === 'font') f.state.height = 220;
    if (reason === 'context') f.state.context = 2;
    if (reason === 'gate') f.state.enabled = false;
    if (reason === 'pending') f.state.momentumReady = false;
    if (reason === 'pending') { for (let i = 0; i < 7; i++) f.advance(16, true); }
    else f.advance(reason === 'stall' ? 1000 : 16, true);
    f.state.enabled = true; f.state.context = 1; f.state.height = 200; f.state.momentumReady = true;
    for (let i = 0; i < 40; i++) f.advance(16, true);
    assert.equal(f.wheels.length, count, reason); assert.equal(f.frames.size, 0);
    f.handler.dispose();
  }
});

test('a reversal cannot launch momentum in the previous direction and a local edge clears leftover motion', () => {
  const f = fixture({ height: 200 });
  f.touch('touchstart', 10); f.advance(20); f.touch('touchmove', 70);
  f.advance(20); f.touch('touchmove', 40); f.advance(20); f.touch('touchmove', 10); f.touch('touchend');
  const count = f.wheels.length;
  for (let i = 0; i < 40; i++) f.advance(16, true);
  assert.ok(f.wheels.length > count); assert.ok(f.wheels.slice(count).every(wheel => wheel.deltaY === 1));
  f.handler.dispose();
  const local = fixture({ mouse: false, normal: true, speed: 0.5 });
  local.buffer.viewportY = 1;
  local.touch('touchstart', 10); local.advance(20); local.touch('touchmove', 29);
  assert.equal(local.buffer.viewportY, 0);
  local.advance(20); local.touch('touchmove', 19);
  assert.equal(local.buffer.viewportY, 1, 'a reversal at the edge does not wait for the old fractional remainder');
  local.handler.dispose();
});

test('local motion during full-frame parsing is applied after restoration; failed or stale frames discard it', () => {
  for (const outcome of ['success', 'failed', 'stale', 'new-action', 'mode-change']) {
    const f = fixture({ mouse: false, normal: true, speed: 0.5 });
    f.touch('touchstart', 10);
    const finish = f.handler.beginPresentation();
    f.buffer.baseY = 0; f.buffer.viewportY = 0; // partial reset buffer must not eat a swipe
    f.advance(20); f.touch('touchmove', 40);
    assert.deepEqual(f.history, []);
    f.buffer.baseY = 80; f.buffer.viewportY = 40;
    if (outcome === 'stale') f.advance(100);
    if (outcome === 'new-action') f.document.dispatchEvent(new Event('pointerdown'));
    if (outcome === 'mode-change') f.buffer.type = 'alternate';
    finish(outcome !== 'failed');
    assert.equal(f.buffer.viewportY, outcome === 'success' ? 37 : 40, outcome);
    assert.deepEqual(f.wheels, []);
    f.handler.dispose();
  }
});

test('holding a finger still then flicking uses only the renewed movement velocity', () => {
  const f = fixture({ mouse: false, normal: true, height: 200, speed: 0.5 });
  f.touch('touchstart', 10); f.advance(20); f.touch('touchmove', 30);
  f.advance(1000); f.touch('touchmove', 50);
  f.advance(20); f.touch('touchmove', 70); f.advance(20); f.touch('touchmove', 90);
  f.touch('touchend');
  const before = f.buffer.viewportY;
  for (let i = 0; i < 40; i++) f.advance(16, true);
  assert.ok(f.buffer.viewportY < before, 'the long pause is not part of release velocity');
  f.handler.dispose();
});

test('a real input queue does not accumulate inertia behind a pending request or paused resize', async () => {
  for (const paused of [false, true]) {
    const f = fixture({ height: 200 });
    const pending: Array<() => void> = [];
    let reports = 0;
    const queue = new TerminalInputQueue({ isCurrent: () => true,
      send: data => { reports += data.length; return new Promise<void>(resolve => pending.push(resolve)); },
      failed: error => { throw error; },
    });
    let resizing = false;
    Object.defineProperty(f.state, 'momentumReady', { get: () => !resizing && !queue.hasPendingInput });
    f.screen.addEventListener('wheel', () => queue.enqueue('w', 'utf8'));
    flick(f);
    const fingerReports = f.wheels.length;
    if (paused) { resizing = true; void queue.pause(); }
    for (let i = 0; i < 40; i++) f.advance(16, true);
    assert.equal(f.wheels.length, fingerReports);
    assert.equal(f.frames.size, 0);
    queue.resume(); resizing = false;
    while (pending.length) { pending.shift()!(); await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.equal(reports, fingerReports, 'after ACK/resume only the original finger input is sent');
    f.advance(16, true); assert.equal(f.wheels.length, fingerReports);
    queue.close(); f.handler.dispose();
  }
});

test('a short normal ACK discards blocked frames without killing all remaining CLI momentum', () => {
  const f = fixture({ height: 400, speed: 0.5 });
  flick(f);
  const fingerReports = f.wheels.length;
  f.state.momentumReady = false;
  for (let i = 0; i < 2; i++) f.advance(16, true);
  assert.equal(f.wheels.length, fingerReports, 'nothing is sent while input is pending');
  f.state.momentumReady = true;
  f.advance(16, true);
  assert.equal(f.wheels.length, fingerReports, 'blocked distance and the old fraction are discarded, not caught up');
  for (let i = 0; i < 40; i++) f.advance(16, true);
  assert.ok(f.wheels.length > fingerReports, 'new motion can continue after a short ACK');
  assert.ok(f.wheels.length - fingerReports <= 3, 'waiting does not create extra travel or reports');
  f.handler.dispose();
});

test('an ACK that clears between late frames cannot revive expired momentum', () => {
  const f = fixture({ height: 400, speed: 0.5 });
  flick(f);
  f.state.momentumReady = false;
  f.advance(16, true); f.advance(64, true);
  f.advance(63); f.state.momentumReady = true;
  const count = f.wheels.length;
  f.advance(1, true); // ready at 144ms, but the wait started at 16ms
  for (let i = 0; i < 40; i++) f.advance(16, true);
  assert.equal(f.wheels.length, count);
  assert.equal(f.frames.size, 0);
  f.handler.dispose();
});
