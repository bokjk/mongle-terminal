import type { Terminal } from '@xterm/xterm';

export const TOUCH_SCROLL_SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;
export const DEFAULT_TOUCH_SCROLL_SPEED = 0.5;
export function touchScrollSpeed(value: unknown): number {
  return typeof value === 'number' && (TOUCH_SCROLL_SPEEDS as readonly number[]).includes(value) ? value : DEFAULT_TOUCH_SCROLL_SPEED;
}

export interface TouchScrollInput {
  /** Only return a context for a protocol that actually supports wheel reports. */
  context(): number | undefined;
  enabled(): boolean;
  /** Inertia must not build up behind unacknowledged terminal input. */
  momentumReady?(): boolean;
  request?(): void;
  dispatchWheel?(event: WheelEvent): void;
}

interface Pan {
  id: number; x: number; y: number; lastX: number; lastY: number; lastTime: number;
  pixels: number; scrolling: boolean; speed: number; context?: number;
  cols: number; rows: number; width: number; height: number; scale: number;
  samples: Array<{ time: number; y: number }>;
  direction: number;
}

// Application wheel reports are detents, not rows: many CLIs move several rows
// for each report. Keep their physical threshold independent of terminal fonts.
const WHEEL_PIXELS = 24; // 48 CSS px per report at the default 0.5 setting.
const DECAY_MS = 170;

/** xterm 6 paints whole rows and has no native touch pan. Keep fractional
 * distance here, never transform its renderer or synthesize keyboard arrows. */
export function attachTouchScrollback(terminal: Terminal, input?: TouchScrollInput, getSpeed: () => number = () => DEFAULT_TOUCH_SCROLL_SPEED) {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  const document = screen?.ownerDocument, window = document?.defaultView;
  if (!screen || !document || !window) return { dispose() {}, cancel() {}, beginPresentation: () => (_commit: boolean) => {} };
  let gesture: Pan | undefined;
  let animation: number | undefined;
  let dispatchingWheel = false;
  // Full frames temporarily clear the buffer. Hold only bounded local viewport
  // deltas until the restored picture is ready; never queue PTY input here.
  let presentation: { type: string; baseY: number; lines: number; pan?: Pan; started: number } | undefined;
  const now = () => window.performance.now();
  const cancel = () => {
    gesture = undefined;
    if (animation !== undefined) window.cancelAnimationFrame(animation);
    animation = undefined;
    if (presentation) { presentation.lines = 0; presentation.pan = undefined; }
  };
  const valid = (pan: Pan) => {
    const rect = screen.getBoundingClientRect();
    return !document.hidden && terminal.cols === pan.cols && terminal.rows === pan.rows &&
      rect.width === pan.width && rect.height === pan.height &&
      (window.visualViewport?.scale ?? 1) === pan.scale && input?.context() === pan.context &&
      (pan.context !== undefined || (presentation?.type ?? terminal.buffer.active.type) === 'normal');
  };
  const atEdge = (lines: number) => {
    const buffer = terminal.buffer.active;
    return lines < 0 ? buffer.viewportY === 0 : buffer.viewportY === buffer.baseY;
  };
  const scroll = (pan: Pan, distance: number, momentum = false): boolean => {
    if (!valid(pan) || (pan.context !== undefined && !input!.enabled())) return false;
    if (momentum && presentation && now() - presentation.started > 80) return false;
    const unit = pan.context === undefined ? pan.height / pan.rows : WHEEL_PIXELS;
    const gain = pan.context === undefined ? pan.speed / DEFAULT_TOUCH_SCROLL_SPEED : pan.speed;
    pan.pixels += distance * gain;
    const lines = Math.trunc(pan.pixels / unit);
    if (!lines) return true;
    pan.pixels -= lines * unit;
    if (pan.context === undefined) {
      if (presentation) {
        presentation.pan = pan;
        presentation.lines = Math.max(-pan.rows, Math.min(pan.rows, presentation.lines + lines));
      } else {
        if (atEdge(lines)) { pan.pixels = 0; return false; }
        terminal.scrollLines(lines);
        if (atEdge(lines)) { pan.pixels = 0; return false; }
      }
    } else {
      const rect = screen.getBoundingClientRect();
      // xterm owns legacy binary, SGR and pixel encoding. Bound one move to a
      // viewport and discard overflow instead of retaining a later input burst.
      for (let index = 0; index < Math.min(Math.abs(lines), pan.rows); index += 1) {
        if (!input!.enabled() || input!.context() !== pan.context) return false;
        if (momentum && input?.momentumReady?.() === false) { pan.pixels = 0; return true; }
        const wheel = new window.WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaMode: 1, deltaY: Math.sign(lines),
          clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, pan.lastX)),
          clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, pan.lastY)),
        });
        dispatchingWheel = true;
        try {
          if (input!.dispatchWheel) input!.dispatchWheel(wheel);
          else screen.dispatchEvent(wheel);
        } finally { dispatchingWheel = false; }
      }
    }
    return true;
  };
  const start = (event: TouchEvent) => {
    cancel();
    if (event.touches.length !== 1 || document.hidden) return;
    const context = input?.context();
    if (context === undefined && ((presentation?.type ?? terminal.buffer.active.type) !== 'normal' ||
        (presentation?.baseY ?? terminal.buffer.active.baseY) === 0)) return;
    const touch = event.touches[0], rect = screen.getBoundingClientRect(), time = now();
    if (!(rect.height > 0) || !(terminal.rows > 0)) return;
    gesture = {
      id: touch.identifier, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY, lastTime: time,
      pixels: 0, scrolling: false, speed: touchScrollSpeed(getSpeed()), context,
      cols: terminal.cols, rows: terminal.rows, width: rect.width, height: rect.height, scale: window.visualViewport?.scale ?? 1,
      samples: [{ time, y: touch.clientY }], direction: 0,
    };
  };
  const move = (event: TouchEvent) => {
    const pan = gesture;
    if (!pan) return;
    if (event.touches.length !== 1 || !valid(pan) || !event.cancelable) { cancel(); return; }
    const touch = event.touches[0];
    if (touch.identifier !== pan.id) { cancel(); return; }
    if (!pan.scrolling) {
      const dx = Math.abs(touch.clientX - pan.x), dy = Math.abs(touch.clientY - pan.y);
      if (Math.max(dx, dy) < 6) return;
      if (dx >= dy) { cancel(); return; }
      pan.scrolling = true;
      if (pan.context !== undefined && !input!.enabled()) input!.request?.();
    }
    event.preventDefault();
    const time = now(), distance = pan.lastY - touch.clientY;
    const direction = Math.sign(distance);
    if (time - pan.lastTime > 80) {
      // A stationary finger must not dilute the next flick's recent velocity.
      pan.samples = [];
    } else if (direction && direction !== pan.direction) {
      pan.samples = [{ time: pan.lastTime, y: pan.lastY }];
    }
    if (direction) pan.direction = direction;
    pan.lastX = touch.clientX; pan.lastY = touch.clientY; pan.lastTime = time;
    if (pan.context !== undefined && !input!.enabled()) {
      // Closed-gate movement and velocity must never be replayed after an ACK.
      pan.pixels = 0; pan.samples = []; return;
    }
    pan.samples.push({ time, y: touch.clientY });
    while (pan.samples.length > 2 && pan.samples[0].time < time - 80) pan.samples.shift();
    if (!scroll(pan, distance)) pan.samples = [];
  };
  const end = (event: TouchEvent) => {
    const pan = gesture;
    gesture = undefined;
    if (!pan?.scrolling || event.touches.length || !valid(pan) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const time = now(), first = pan.samples[0], last = pan.samples.at(-1);
    if (!first || !last || time - last.time > 80 || last.time - first.time < 16) return;
    const gain = pan.speed / DEFAULT_TOUCH_SCROLL_SPEED;
    let velocity = Math.max(-1.2, Math.min(1.2, gain * (first.y - last.y) / (last.time - first.time))) / gain * Math.exp(-(time - last.time) / 80);
    if (Math.abs(velocity) * gain < 0.25) return;
    let previous = time, travel = 0;
    let blockedSince: number | undefined;
    // Bound the *scaled* continuation, including at the fastest setting.
    const limit = Math.min(200, pan.height * 0.6) / gain;
    const tick = (stamp: number) => {
      animation = undefined;
      const elapsed = stamp - previous;
      // Backgrounding or a stalled main thread cancels momentum, never catches
      // up with a burst of old wheel input when the page becomes responsive.
      if (elapsed > 80 || stamp - time > 600 || !valid(pan) ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const decay = Math.exp(-Math.max(0, elapsed) / DECAY_MS);
      const distance = Math.sign(velocity) * Math.min(Math.abs(velocity * DECAY_MS * (1 - decay)), limit - travel);
      previous = stamp; travel += Math.abs(distance); velocity *= decay;
      // The ACK may become ready between ticks, after this wait has expired.
      if (blockedSince !== undefined && stamp - blockedSince >= 80) return;
      if (pan.context !== undefined && input?.momentumReady?.() === false) {
        // A normal short ACK can straddle the first animation frame. Continue
        // decaying in wall time, but discard this frame's distance entirely.
        // Never queue it for catch-up, or wait through a genuinely slow link.
        pan.pixels = 0;
        blockedSince ??= stamp;
      } else {
        blockedSince = undefined;
        if (!scroll(pan, distance, true)) return;
      }
      if (travel >= limit || Math.abs(velocity) * gain < 0.035) return;
      animation = window.requestAnimationFrame(tick);
    };
    animation = window.requestAnimationFrame(tick);
  };
  const wheel = () => { if (!dispatchingWheel) cancel(); };
  const visibility = () => { if (document.hidden) cancel(); };
  screen.addEventListener('touchstart', start, { passive: true });
  screen.addEventListener('touchmove', move, { passive: false });
  screen.addEventListener('touchend', end, { passive: true });
  screen.addEventListener('touchcancel', cancel, { passive: true });
  // A new action anywhere (including settings and the mobile key bar) stops a fling.
  for (const type of ['touchstart', 'pointerdown', 'keydown', 'compositionstart', 'contextmenu']) document.addEventListener(type, cancel, true);
  document.addEventListener('wheel', wheel, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', cancel);
  return {
    cancel,
    beginPresentation() {
      const held = { type: terminal.buffer.active.type, baseY: terminal.buffer.active.baseY, lines: 0, pan: undefined as Pan | undefined, started: now() };
      presentation = held;
      return (commit: boolean) => {
        if (presentation !== held) return;
        presentation = undefined;
        if (!commit || terminal.buffer.active.type !== held.type) { cancel(); return; }
        if (held.lines && held.pan && valid(held.pan) && now() - held.started <= 80) terminal.scrollLines(held.lines);
      };
    },
    dispose() {
      cancel(); presentation = undefined;
      screen.removeEventListener('touchstart', start);
      screen.removeEventListener('touchmove', move);
      screen.removeEventListener('touchend', end);
      screen.removeEventListener('touchcancel', cancel);
      for (const type of ['touchstart', 'pointerdown', 'keydown', 'compositionstart', 'contextmenu']) document.removeEventListener(type, cancel, true);
      document.removeEventListener('wheel', wheel, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', cancel);
    },
  };
}
