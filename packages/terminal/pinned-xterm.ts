/*
 * The only Mongle module using private xterm APIs. Keep versions exact and run
 * tests/terminal before changing them. xterm's public onData loses provenance;
 * triggerDataEvent retains it. No payload-pattern filtering is used here.
 * Upstream: xterm.js 6.0.0, src/common/services/CoreService.ts (MIT).
 */
import type { TerminalModes } from './types.js';

interface CoreService {
  triggerDataEvent(data: string, wasUserInput?: boolean): void;
  isCursorHidden: boolean;
  decPrivateModes: Record<string, unknown>;
}

interface PinnedCore {
  coreService: CoreService;
  coreMouseService: { activeEncoding: string; activeProtocol: string };
  _bufferService: { buffers: { normal: {
    ybase: number; ydisp: number;
    lines: { trimStart(count: number): void };
  } } };
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

/** Hold the previous picture while a complete serialized frame is parsed.
 * xterm 6 checks this flag again inside its queued animation-frame callback,
 * so a refresh scheduled by reset() cannot paint the empty buffer.
 */
export function setPresentationPending(terminal: unknown, pending: boolean): void {
  coreOf(terminal).coreService.decPrivateModes.synchronizedOutput = pending;
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
