/*
 * The only Mongle module using private xterm APIs. Keep versions exact and run
 * tests/terminal before changing them. xterm's public onData loses provenance;
 * triggerDataEvent retains it. No payload-pattern filtering is used here.
 * Upstream: xterm.js 6.0.0, src/common/services/CoreService.ts (MIT).
 */
import type { TerminalModes } from './types.js';
import type { Terminal } from '@xterm/xterm';

interface CoreService {
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
  isCursorHidden: boolean;
  decPrivateModes: Record<string, unknown>;
}

interface PresentationRenderer {
  clear(): void;
  renderRows(start: number, end: number): void;
  handleResize(cols: number, rows: number): void;
  handleSelectionChanged(start: [number, number] | undefined, end: [number, number] | undefined, column: boolean): void;
}

interface SelectionModel {
  selectionStart: [number, number] | undefined;
  selectionEnd: [number, number] | undefined;
  selectionStartLength: number;
  isSelectAllActive: boolean;
}

interface SelectionService {
  _model: SelectionModel;
  _activeSelectionMode: number;
  _dragScrollIntervalTimer: number | undefined;
  _addMouseDownListeners(): void;
  _dragScroll(): void;
  _handleMouseMove(event: MouseEvent): void;
  _handleMouseUp(event: MouseEvent): void;
  refresh(): void;
}

// xterm 6 SelectionService uses a 50 ms drag-scroll interval. reset() cancels
// that timer on every full frame. Restarting a fresh interval on each restore
// starves scrolling whenever frames arrive faster than the interval.
const DRAG_SCROLL_INTERVAL = 50;
const dragScrollClocks = new WeakMap<SelectionService, { timer: number; due: number }>();

function resumeSelectionDrag(selection: SelectionService, window: Window, due: number): void {
  selection._addMouseDownListeners();
  window.clearInterval(selection._dragScrollIntervalTimer);
  const schedule = (deadline: number) => {
    const timer = window.setTimeout(() => {
      // Schedule first so xterm can cancel the next tick even from a scroll
      // callback. clearInterval also cancels timeouts (the shared DOM ID pool).
      schedule(window.performance.now() + DRAG_SCROLL_INTERVAL);
      selection._dragScroll();
    }, Math.max(0, deadline - window.performance.now()));
    selection._dragScrollIntervalTimer = timer;
    dragScrollClocks.set(selection, { timer, due: deadline });
  };
  schedule(due);
}

interface PinnedCore {
  _renderService?: { _renderer: { value: PresentationRenderer | undefined } };
  _selectionService?: SelectionService;
  coreService: CoreService;
  coreMouseService: { activeEncoding: string; activeProtocol: string };
  _bufferService: { buffers: { normal: {
    ybase: number; ydisp: number;
    lines: { trimStart(count: number): void };
  } } };
}

/** reset/select remove xterm's document drag listeners. Preserve a live gesture
 * across the frame swap, but never revive one cancelled by a new user action.
 * While the parser holds a partial buffer, keep only the latest pointer move
 * and apply it after the complete buffer and viewport have been restored.
 */
export function captureSelectionDrag(terminal: Terminal): { finish(commit: boolean): void } | undefined {
  const selection = coreOf(terminal)._selectionService;
  const document = terminal.element?.ownerDocument;
  const window = document?.defaultView;
  if (!selection || !document || !window || selection._dragScrollIntervalTimer === undefined) return undefined;
  if (!selection._model || typeof selection._addMouseDownListeners !== 'function' ||
      typeof selection._handleMouseMove !== 'function' || typeof selection._handleMouseUp !== 'function' ||
      typeof selection.refresh !== 'function' || typeof selection._dragScroll !== 'function') throw new Error('Unsupported xterm selection internals.');
  const clock = dragScrollClocks.get(selection);
  const scrollDue = clock?.timer === selection._dragScrollIntervalTimer
    ? clock.due : window.performance.now() + DRAG_SCROLL_INTERVAL;
  const model: SelectionModel = {
    selectionStart: selection._model.selectionStart?.slice() as [number, number] | undefined,
    selectionEnd: selection._model.selectionEnd?.slice() as [number, number] | undefined,
    selectionStartLength: selection._model.selectionStartLength,
    isSelectAllActive: selection._model.isSelectAllActive,
  };
  const mode = selection._activeSelectionMode;
  const buffer = terminal.buffer.active;
  const cols = terminal.cols, rows = terminal.rows;
  const text = terminal.getSelection();
  const anchorLine = model.selectionStart && buffer.getLine(model.selectionStart[1])?.translateToString();
  let cancelled = false, ended = false, finished = false;
  let lastMove: MouseEvent | undefined, mouseUp: MouseEvent | undefined;
  const cancel = () => { cancelled = true; };
  const move = (event: MouseEvent) => {
    if (cancelled || ended) return;
    if (!(event.buttons & 1)) { ended = true; return; }
    lastMove = event;
    event.stopImmediatePropagation();
  };
  const up = (event: MouseEvent) => { if (event.button === 0) { ended = true; mouseUp = event; } };
  const input = terminal.onData(cancel);
  const binary = terminal.onBinary(cancel);
  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', up, true);
  document.addEventListener('mousedown', cancel, true);
  return { finish(commit) {
    if (finished) return;
    finished = true;
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', up, true);
    document.removeEventListener('mousedown', cancel, true);
    input.dispose(); binary.dispose();
    if (!commit || cancelled || terminal.cols !== cols || terminal.rows !== rows || terminal.buffer.active.type !== buffer.type) return;
    Object.assign(selection._model, model);
    selection._activeSelectionMode = mode;
    // A click may not yet have a nonempty range. In that case validate its
    // anchor row; for a real range, preserve only the exact selected text.
    if (terminal.getSelection() !== text || (!text && model.selectionStart &&
        terminal.buffer.active.getLine(model.selectionStart[1])?.translateToString() !== anchorLine)) {
      terminal.clearSelection();
      return;
    }
    if (lastMove) selection._handleMouseMove(lastMove);
    if (mouseUp) selection._handleMouseUp(mouseUp);
    else if (!ended) resumeSelectionDrag(selection, window, scrollDue);
    selection.refresh();
  } };
}

/** Unlike terminal.clear(), preserve every visible line and a pending parser. */
export function clearScrollback(terminal: unknown): void {
  const buffer = coreOf(terminal)._bufferService?.buffers?.normal;
  if (!buffer || typeof buffer.lines?.trimStart !== 'function') {
    throw new Error('Unsupported xterm scrollback internals.');
  }
  const count = buffer.ybase;
  if (count > 0) {
    buffer.lines.trimStart(count);
    buffer.ybase = 0;
    buffer.ydisp = Math.max(0, buffer.ydisp - count);
  }
}

function coreOf(terminal: unknown): PinnedCore {
  const core = (terminal as { _core?: PinnedCore })._core;
  if (!core || typeof core.coreService?.triggerDataEvent !== 'function' ||
      typeof core.coreService.isCursorHidden !== 'boolean' ||
      !['DEFAULT', 'SGR', 'SGR_PIXELS'].includes(core.coreMouseService?.activeEncoding)) {
    throw new Error('Unsupported xterm internals. Refusing to enable terminal input.');
  }
  return core;
}

export function presentationExtras(terminal: unknown): Pick<TerminalModes, 'cursorHidden' | 'mouseEncoding' | 'cursorStyle' | 'cursorBlink'> {
  const core = coreOf(terminal);
  return {
    cursorHidden: core.coreService.isCursorHidden,
    mouseEncoding: core.coreMouseService.activeEncoding as TerminalModes['mouseEncoding'],
    cursorStyle: (core.coreService.decPrivateModes.cursorStyle ?? 'block') as TerminalModes['cursorStyle'],
    cursorBlink: Boolean(core.coreService.decPrivateModes.cursorBlink),
  };
}

/** Gate xterm's scheduled refreshes while a complete frame is parsed.
 * Direct renderer calls need beginPresentation() as well.
 */
export function setPresentationPending(terminal: unknown, pending: boolean): void {
  coreOf(terminal).coreService.decPrivateModes.synchronizedOutput = pending;
}

/** xterm 6's DEC 2026 gate does not cover renderer.clear() on buffer activation
 * or direct paints from selection/focus. Fence those entry points BEFORE reset
 * so the existing DOM remains visible until the full frame can be committed.
 * No cloned screenshot/overlay is used: text selection and the editor stay live.
 */
export function beginPresentation(terminal: unknown): (commit: boolean, rows: number, position?: {start:{x:number;y:number};end:{x:number;y:number}}) => void {
  const renderer = coreOf(terminal)._renderService?._renderer.value;
  // Browser terminals used without open() have a parser but no renderer.
  if (!renderer) {
    if ((terminal as { element?: unknown }).element) throw new Error('Unsupported xterm renderer internals.');
    return () => {};
  }
  for (const name of ['clear', 'renderRows', 'handleResize', 'handleSelectionChanged'] as const) {
    if (typeof renderer[name] !== 'function') throw new Error('Unsupported xterm renderer internals.');
  }
  const clear = renderer.clear;
  const renderRows = renderer.renderRows;
  const resize = renderer.handleResize;
  const selection = renderer.handleSelectionChanged;
  let clearPending = false;
  let size: Parameters<PresentationRenderer['handleResize']> | undefined;
  renderer.clear = () => { clearPending = true; };
  renderer.renderRows = () => {};
  renderer.handleResize = (...args) => { size = args; };
  renderer.handleSelectionChanged = () => {};
  let finished = false;
  return (commit, rows, position) => {
    if (finished) return;
    finished = true;
    try {
      if (commit) {
        // All DOM changes below run in one JS turn, before the browser paints.
        // Keep renderRows fenced through resize/selection to avoid extra paints.
        if (clearPending) clear.call(renderer);
        if (size) resize.call(renderer, ...size);
        // SelectionService refreshes asynchronously. Its last renderer call may
        // still describe reset's empty selection; commit the restored public
        // selection now instead of flashing an empty highlight for one RAF.
        selection.call(renderer, position ? [position.start.x, position.start.y] : undefined,
          position ? [position.end.x, position.end.y] : undefined, coreOf(terminal)._selectionService?._activeSelectionMode === 3);
      }
    } finally {
      renderer.clear = clear;
      renderer.renderRows = renderRows;
      renderer.handleResize = resize;
      renderer.handleSelectionChanged = selection;
    }
    if (commit) renderRows.call(renderer, 0, rows - 1);
  };
}

export function isPresentationPending(terminal: unknown): boolean {
  return coreOf(terminal).coreService.decPrivateModes.synchronizedOutput === true;
}

/** Restore only state used by input encoding and cursor drawing, never parser state. */
export function applyPresentationModes(terminal: unknown, modes: TerminalModes): void {
  const core = coreOf(terminal);
  Object.assign(core.coreService.decPrivateModes, {
    applicationCursorKeys: modes.applicationCursorKeysMode,
    applicationKeypad: modes.applicationKeypadMode,
    bracketedPasteMode: modes.bracketedPasteMode,
    sendFocus: modes.sendFocusMode,
    cursorStyle: modes.cursorStyle,
    cursorBlink: modes.cursorBlink,
  });
  core.coreService.isCursorHidden = modes.cursorHidden;
  core.coreMouseService.activeEncoding = modes.mouseEncoding;
  core.coreMouseService.activeProtocol = {
    none: 'NONE', x10: 'X10', vt200: 'VT200', drag: 'DRAG', any: 'ANY',
  }[modes.mouseTrackingMode];
}

/** Install before registering any input callback or processing any frame. */
export function suppressRendererResponses(terminal: unknown): () => void {
  const service = coreOf(terminal).coreService;
  const original = service.triggerDataEvent;
  const replacement = function (this: CoreService, data: string, wasUserInput = false): void {
    if (wasUserInput) original.call(this, data, true);
  };
  service.triggerDataEvent = replacement;
  return () => {
    if (service.triggerDataEvent === replacement) service.triggerDataEvent = original;
  };
}
