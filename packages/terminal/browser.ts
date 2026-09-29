import type { Terminal } from '@xterm/xterm';
import { applyPresentationModes, suppressRendererResponses } from './pinned-xterm.js';
import { assertGeometry, PRESENTATION_VERSION } from './types.js';
import { attachTouchScrollback } from './touch-scrollback.js';
import type { TerminalInputEncoding, TerminalModes } from './types.js';

interface Frame {
  kind: 'presentation-v1'; version: string; data: string;
  cols: number; rows: number; modes: Record<string, unknown>;
}

interface PendingFrame {
  frame: Frame; modes: TerminalModes; promise: Promise<void>;
  resolve(): void; reject(error: unknown): void;
}

function parseModes(raw: Record<string, unknown>): TerminalModes {
  const booleans = ['applicationCursorKeysMode', 'applicationKeypadMode', 'bracketedPasteMode',
    'insertMode', 'originMode', 'reverseWraparoundMode', 'sendFocusMode', 'wraparoundMode',
    'cursorHidden', 'cursorBlink'];
  if (!raw || booleans.some(key => typeof raw[key] !== 'boolean') ||
      !['none', 'x10', 'vt200', 'drag', 'any'].includes(String(raw.mouseTrackingMode)) ||
      !['DEFAULT', 'SGR', 'SGR_PIXELS'].includes(String(raw.mouseEncoding)) ||
      !['block', 'underline', 'bar'].includes(String(raw.cursorStyle))) {
    throw new Error('Unsupported terminal presentation modes.');
  }
  return { ...raw } as TerminalModes;
}

/**
 * Renders complete host frames. Never call terminal.write(rawPty) beside this
 * adapter. The host answers terminal queries even when every UI is closed.
 * Construct after terminal.open() to protect native IME composition events.
 */
export class BrowserPresentationAdapter {
  private draining = false;
  private drainTask: Promise<void> = Promise.resolve();
  private pending: PendingFrame | undefined;
  private enabled = false;
  private disposed = false;
  private modes: TerminalModes | undefined;
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly removeBoundary: () => void;
  private compositionWait: Promise<void> | undefined;
  private finishComposition: (() => void) | undefined;
  private compositionEndTimer: ReturnType<typeof setTimeout> | undefined;
  private compositionActive = false;
  private compositionBlocked = false;
  private deferredKeyTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredKeyBlocked = false;
  private readonly composing = () => this.beginComposition();
  // xterm commits composition in its own setTimeout(0). Resume after that
  // callback, otherwise reset can erase the final Korean syllable.
  private readonly composed = () => {
    if (this.compositionEndTimer) clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = setTimeout(() => this.endComposition(), 0);
  };
  private readonly focused = () => this.setFocused(true);
  private readonly blurred = () => { this.setFocused(false); this.composed(); };
  // xterm also defers textarea diffs for IME punctuation (keyCode 229), even
  // without compositionstart. Register after its listener so our timer runs
  // after that diff, and remember a closed gate through a same-turn reopen.
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.keyCode !== 229 || this.compositionActive) return;
    if (this.deferredKeyTimer) clearTimeout(this.deferredKeyTimer);
    this.deferredKeyBlocked ||= !this.enabled;
    this.deferredKeyTimer = setTimeout(() => {
      this.deferredKeyTimer = undefined;
      this.deferredKeyBlocked = false;
    }, 0);
  };

  constructor(
    private readonly terminal: Terminal,
    private readonly onInput: (data: string, encoding: TerminalInputEncoding) => void,
  ) {
    this.removeBoundary = suppressRendererResponses(terminal);
    terminal.options.disableStdin = true;
    this.subscriptions.push(
      attachTouchScrollback(terminal),
      terminal.onData(data => { if (this.acceptsTerminalInput()) onInput(data, 'utf8'); }),
      terminal.onBinary(data => { if (this.acceptsTerminalInput()) onInput(data, 'binary'); }),
    );
    terminal.textarea?.addEventListener('compositionstart', this.composing);
    terminal.textarea?.addEventListener('compositionend', this.composed);
    terminal.textarea?.addEventListener('focus', this.focused);
    terminal.textarea?.addEventListener('blur', this.blurred);
    terminal.textarea?.addEventListener('keydown', this.keydown);
  }

  applySnapshot(frame: Frame): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Terminal renderer is disposed.'));
    if (frame.kind !== 'presentation-v1' || frame.version !== PRESENTATION_VERSION ||
        typeof frame.data !== 'string' || frame.data.length > 16 * 1024 * 1024) {
      return Promise.reject(new Error('Unsupported or oversized terminal presentation.'));
    }
    assertGeometry(frame.cols, frame.rows);
    const modes = parseModes(frame.modes);
    if (this.pending) {
      // Full frames supersede earlier full frames. All callers in this batch
      // receive the same completion fence after the newest picture is applied.
      this.pending.frame = frame;
      this.pending.modes = modes;
      return this.pending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.pending = { frame, modes, promise, resolve, reject };
    if (!this.draining) {
      this.draining = true;
      this.drainTask = this.drain();
    }
    return promise;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        // Leave the pending slot replaceable while an IME composition is open.
        if (this.compositionWait) await this.compositionWait;
        const pending = this.pending;
        if (!pending) break;
        this.pending = undefined;
        try {
          if (this.disposed) throw new Error('Terminal renderer is disposed.');
          await this.render(pending.frame, pending.modes);
          pending.resolve();
        } catch (error) { pending.reject(error); }
      }
    } finally { this.draining = false; }
  }

  private async render(frame: Frame, modes: TerminalModes): Promise<void> {
    const old = this.terminal.buffer.active;
    const atBottom = old.viewportY === old.baseY;
    const oldOffset = old.baseY - old.viewportY;
    const oldViewportY = old.viewportY;
    const sameGeometry = this.terminal.cols === frame.cols && this.terminal.rows === frame.rows;
    const viewedLines = !atBottom && sameGeometry && old.type === 'normal'
      ? Array.from({ length: frame.rows }, (_, row) => old.getLine(oldViewportY + row)?.translateToString()) : undefined;
    const selection = sameGeometry ? this.terminal.getSelectionPosition?.() : undefined;
    const selectedText = selection ? this.terminal.getSelection() : '';
    this.terminal.reset();
    this.terminal.resize(frame.cols, frame.rows);
    this.modes = modes;
    // Restore input modes synchronously before yielding to another key event.
    applyPresentationModes(this.terminal, modes);
    await new Promise<void>(resolve => this.terminal.write(frame.data, resolve));
    if (this.disposed) throw new Error('Terminal renderer is disposed.');
    applyPresentationModes(this.terminal, modes);
    if (atBottom) this.terminal.scrollToBottom();
    // Appended output should not move the text somebody is reading. If history
    // was trimmed or changed, retain the previous distance from the live tail.
    else if (viewedLines && this.terminal.buffer.active.type === 'normal' &&
        viewedLines.every((line, row) => line === this.terminal.buffer.active.getLine(oldViewportY + row)?.translateToString())) {
      this.terminal.scrollToLine(oldViewportY);
    }
    else this.terminal.scrollToLine(Math.max(0, this.terminal.buffer.active.baseY - oldOffset));
    if (selection && this.terminal.buffer.active.type === old.type) {
      const length = (selection.end.y - selection.start.y) * frame.cols + selection.end.x - selection.start.x;
      if (length > 0) this.terminal.select(selection.start.x, selection.start.y, length);
      // History trimming or a repaint can move different text under identical
      // coordinates. Never retain a selection that silently selects new text.
      if (this.terminal.getSelection() !== selectedText) this.terminal.clearSelection();
    }
    this.terminal.refresh?.(0, frame.rows - 1);
  }

  /**
   * Gate transport separately from the native editor. xterm 6 maps disableStdin
   * to textarea.readOnly, which can dismiss a phone keyboard during a resize ACK.
   * Preserve the editor only for a temporary fence or a trusted focus gesture;
   * lease loss, disconnect and uncertain input use the default hard disable.
   * Input during a closed gate is discarded, never buffered for later replay.
   */
  setInputEnabled(enabled: boolean, options: { preserveKeyboard?: boolean } = {}): void {
    this.enabled = enabled && !this.disposed;
    if (!this.enabled) {
      this.compositionBlocked ||= this.compositionActive;
      this.deferredKeyBlocked ||= this.deferredKeyTimer !== undefined;
    }
    const editable = !this.disposed && (this.enabled || options.preserveKeyboard === true);
    this.terminal.options.disableStdin = !editable;
    if (!editable) this.releaseCompositionWait();
  }

  private acceptsTerminalInput(): boolean {
    return this.enabled && !this.disposed && !this.compositionBlocked && !this.deferredKeyBlocked;
  }

  /** For explicit UI controls such as Esc, Ctrl-C and direction buttons. */
  sendInput(data: string): void {
    if (this.enabled && !this.disposed) this.onInput(data, 'utf8');
  }

  sendKey(key: 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End'): void {
    const suffix = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' }[key];
    this.sendInput(`\x1b${this.modes?.applicationCursorKeysMode ? 'O' : '['}${suffix}`);
  }

  paste(text: string): void {
    if (!this.enabled || this.disposed) return;
    const normalized = text.replace(/\r?\n/g, '\r');
    const bracketed = this.modes?.bracketedPasteMode && this.terminal.options.ignoreBracketedPasteMode !== true;
    this.terminal.input(bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized, true);
    if (this.terminal.textarea) this.terminal.textarea.value = '';
  }

  setFocused(focused: boolean): void {
    if (this.enabled && !this.disposed && this.modes?.sendFocusMode) {
      this.onInput(focused ? '\x1b[I' : '\x1b[O', 'utf8');
    }
  }

  beginComposition(): void {
    if (this.compositionEndTimer) clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = undefined;
    this.compositionActive = true;
    this.compositionBlocked ||= !this.enabled;
    if (!this.compositionWait && !this.disposed) {
      this.compositionWait = new Promise<void>(resolve => { this.finishComposition = resolve; });
    }
  }

  endComposition(): void {
    if (this.compositionEndTimer) clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = undefined;
    this.compositionActive = false;
    this.compositionBlocked = false;
    this.releaseCompositionWait();
  }

  private releaseCompositionWait(): void {
    this.finishComposition?.();
    this.finishComposition = undefined;
    this.compositionWait = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.setInputEnabled(false);
    this.disposed = true;
    this.endComposition();
    this.terminal.textarea?.removeEventListener('compositionstart', this.composing);
    this.terminal.textarea?.removeEventListener('compositionend', this.composed);
    this.terminal.textarea?.removeEventListener('focus', this.focused);
    this.terminal.textarea?.removeEventListener('blur', this.blurred);
    this.terminal.textarea?.removeEventListener('keydown', this.keydown);
    if (this.deferredKeyTimer) clearTimeout(this.deferredKeyTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    // Keep responses suppressed until any already-enqueued write completes.
    void this.drainTask.finally(this.removeBoundary);
  }
}
