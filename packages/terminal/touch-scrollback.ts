import type { Terminal } from '@xterm/xterm';

/** xterm 6's synthetic viewport handles wheel events, but has no touch pan. */
export function attachTouchScrollback(terminal: Terminal): { dispose(): void } {
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return { dispose() {} };
  let gesture: { id: number; x: number; y: number; lastY: number; pixels: number; scrolling: boolean } | undefined;
  const start = (event: TouchEvent) => {
    gesture = undefined;
    if (event.touches.length !== 1 || terminal.buffer.active.type !== 'normal' || terminal.buffer.active.baseY === 0) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, pixels: 0, scrolling: false };
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    // Give multi-touch to the browser (including pinch zoom), and never turn
    // an alternate-screen swipe into terminal input or a mouse wheel command.
    if (event.touches.length !== 1 || terminal.buffer.active.type !== 'normal') { gesture = undefined; return; }
    const touch = event.touches[0];
    if (touch.identifier !== gesture.id) { gesture = undefined; return; }
    if (!gesture.scrolling) {
      const dx = Math.abs(touch.clientX - gesture.x);
      const dy = Math.abs(touch.clientY - gesture.y);
      if (Math.max(dx, dy) < 6) return;
      if (dx >= dy) { gesture = undefined; return; }
      gesture.scrolling = true;
    }
    if (!event.cancelable) { gesture = undefined; return; }
    event.preventDefault();
    const rowHeight = screen.getBoundingClientRect().height / terminal.rows;
    if (rowHeight <= 0) return;
    gesture.pixels += gesture.lastY - touch.clientY;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.pixels / rowHeight);
    if (lines !== 0) {
      terminal.scrollLines(lines);
      gesture.pixels -= lines * rowHeight;
    }
  };
  const end = () => { gesture = undefined; };
  screen.addEventListener('touchstart', start, { passive: true });
  screen.addEventListener('touchmove', move, { passive: false });
  screen.addEventListener('touchend', end, { passive: true });
  screen.addEventListener('touchcancel', end, { passive: true });
  return { dispose() {
    gesture = undefined;
    screen.removeEventListener('touchstart', start);
    screen.removeEventListener('touchmove', move);
    screen.removeEventListener('touchend', end);
    screen.removeEventListener('touchcancel', end);
  } };
}
