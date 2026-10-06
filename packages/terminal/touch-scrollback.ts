import type { Terminal } from '@xterm/xterm';

export interface TouchScrollInput {
  /** Only return a context for a protocol that actually supports wheel reports. */
  context(): number | undefined;
  enabled(): boolean;
  request?(): void;
  dispatchWheel?(event: WheelEvent): void;
}

/** xterm 6 handles wheel events, but has no touch pan. */
export function attachTouchScrollback(terminal: Terminal, input?: TouchScrollInput): { dispose(): void } {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return { dispose() {} };
  let gesture: { id: number; x: number; y: number; lastY: number; pixels: number; scrolling: boolean; context?: number } | undefined;
  const start = (event: TouchEvent) => {
    gesture = undefined;
    if (event.touches.length !== 1) return;
    const context = input?.context();
    if (context === undefined && (terminal.buffer.active.type !== 'normal' || terminal.buffer.active.baseY === 0)) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, pixels: 0, scrolling: false, context };
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    // Pinch zoom, changed protocols and new input leases must not inherit a pan.
    if (event.touches.length !== 1 || (gesture.context === undefined
      ? terminal.buffer.active.type !== 'normal' || input?.context() !== undefined
      : input?.context() !== gesture.context)) { gesture = undefined; return; }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) { gesture = undefined; return; }
    if (!event.cancelable) { gesture = undefined; return; }
    if (!gesture.scrolling) {
      const dx = Math.abs(touch.clientX - gesture.x);
      const dy = Math.abs(touch.clientY - gesture.y);
      if (Math.max(dx, dy) < 6) return;
      if (dx >= dy) { gesture = undefined; return; }
      gesture.scrolling = true;
      if (gesture.context !== undefined && !input!.enabled()) input!.request?.();
    }
    event.preventDefault();
    if (gesture.context !== undefined && !input!.enabled()) {
      // Do not queue movements across acquisition/ACK or replay them later.
      gesture.lastY = touch.clientY;
      gesture.pixels = 0;
      return;
    }
    const rowHeight = screen.getBoundingClientRect().height / terminal.rows;
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
    gesture.pixels += gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.pixels / rowHeight);
    if (lines !== 0) {
      if (gesture.context === undefined) terminal.scrollLines(lines);
      else {
        const rect = screen.getBoundingClientRect();
        const Wheel = screen.ownerDocument.defaultView?.WheelEvent;
        if (!Wheel) { gesture = undefined; return; }
        // The standard xterm wheel path owns encoding (including legacy binary
        // and SGR pixels). One event reports one step, regardless of delta size.
        // Bound an individual move to a viewport; never accumulate a burst.
        for (let index = 0; index < Math.min(Math.abs(lines), terminal.rows); index += 1) {
          if (!input!.enabled() || input!.context() !== gesture.context) { gesture = undefined; return; }
          const wheel = new Wheel('wheel', {
            bubbles: true, cancelable: true, deltaMode: Wheel.DOM_DELTA_LINE, deltaY: Math.sign(lines),
            clientX: Math.max(rect.left + 1, Math.min(rect.right - 1, touch.clientX)),
            clientY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, touch.clientY)),
          });
          if (input!.dispatchWheel) input!.dispatchWheel(wheel);
          else screen.dispatchEvent(wheel);
        }
      }
      gesture.pixels -= lines * rowHeight;
    }
  };
  const end = () => { gesture = undefined; };
  screen.addEventListener('touchstart', start, { passive: true });
  screen.addEventListener('touchmove', move, { passive: false });
  screen.addEventListener('touchend', end, { passive: true });
  screen.addEventListener('touchcancel', end, { passive: true });
  screen.addEventListener('contextmenu', end);
  return { dispose() {
    gesture = undefined;
    screen.removeEventListener('touchstart', start);
    screen.removeEventListener('touchmove', move);
    screen.removeEventListener('touchend', end);
    screen.removeEventListener('touchcancel', end);
    screen.removeEventListener('contextmenu', end);
  } };
}
