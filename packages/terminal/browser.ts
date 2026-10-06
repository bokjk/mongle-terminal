import type { Terminal } from '@xterm/xterm';
import { applyPresentationModes, beginMousePresentation, beginPresentation, captureSelectionDrag, setPresentationPending, suppressRendererResponses } from './pinned-xterm.js';
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
      !['block', 'underline', 'bar'].includes(String(raw.cursorStyle)) ||
      (raw.win32InputMode!==undefined&&typeof raw.win32InputMode!=='boolean')) {
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
  private renderTask: Promise<void> | undefined;
  private pending: PendingFrame | undefined;
  private enabled = false;
  private disposed = false;
  private modes: TerminalModes | undefined;
  private readonly subscriptions: Array<{ dispose(): void }> = [];
  private readonly removeBoundary: () => void;
  private compositionEndTimer: ReturnType<typeof setTimeout> | undefined;
  private compositionActive = false;
  private compositionBlocked = false;
  private pendingModifiedEnter: string | undefined;
  private deferredKeyTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredKeyBlocked = false;
  private readonly composing = () => this.beginComposition();
  // xterm commits composition in its own setTimeout(0). Keep a blocked
  // composition quarantined until that callback has had a chance to run.
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
      terminal.onData(data => {
        if (!this.acceptsTerminalInput()) return;
        onInput(data, 'utf8');
        // A following key can force xterm's deferred composition to commit
        // before our timer. Emit the queued Enter immediately after that text,
        // before xterm proceeds with the following key.
        if (this.compositionEndTimer !== undefined) this.flushModifiedEnter();
      }),
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

  /** A mouse release must read selection after the active frame swap, before
   * any future frame starts. Undefined keeps the usual copy path immediate. */
  get pendingPresentation(): Promise<void> | undefined { return this.renderTask; }

  /** Run after application shortcuts and before xterm's legacy Enter encoder. */
  handleKeyEvent(event: KeyboardEvent): boolean {
    const enter=event.key==='Enter'||event.code==='Enter'||event.code==='NumpadEnter';
    if(event.type!=='keydown'){
      if(event.type==='keypress'&&enter&&this.pendingModifiedEnter){event.preventDefault();return false;}
      return true;
    }
    if(!enter&&!['Shift','Control','Alt'].includes(event.key)&&this.compositionEndTimer===undefined)this.pendingModifiedEnter=undefined;
    if(!enter||event.metaKey||!(event.shiftKey||event.ctrlKey||event.altKey)||!this.modes?.win32InputMode)return true;
    const modifiers=(event.shiftKey?16:0)|(event.ctrlKey?8:0)|(event.altKey?2:0)|(event.code==='NumpadEnter'?256:0);
    const character=event.ctrlKey?10:13;
    const input=`\x1b[13;28;${character};1;${modifiers};1_\x1b[13;28;${character};0;${modifiers};1_`;
    if(event.isComposing||this.compositionActive){
      // Windows Korean IME reports Process/229, with physical code Enter.
      // Keep native composition commit, but bypass xterm's unmodified Enter.
      // Its compositionend listener commits text before our completion timer.
      this.pendingModifiedEnter=this.acceptsTerminalInput()?input:undefined;
      return false;
    }
    event.preventDefault();
    if(this.acceptsTerminalInput()) {
      // KEY_EVENT_RECORD: virtual key, scan code, character, down, modifiers, repeat.
      // Send a complete pair so a blur/control transfer cannot leave Enter held down.
      this.terminal.input(input,true);
    }
    return false;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        // Let native editor events and xterm's deferred commit finish this turn,
        // but never wait for an entire composition: Korean IMEs can keep the
        // next syllable composing while the host echoes the preceding one.
        // reset() resets VT state, not xterm's textarea or CompositionHelper.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const pending = this.pending;
        if (!pending) break;
        this.pending = undefined;
        try {
          if (this.disposed) throw new Error('Terminal renderer is disposed.');
          const rendering = this.render(pending.frame, pending.modes);
          this.renderTask = rendering;
          try { await rendering; }
          finally { this.renderTask = undefined; }
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
    const finishPresentation = beginPresentation(this.terminal);
    let selectionDrag: ReturnType<typeof captureSelectionDrag>;
    let finishMousePresentation: (() => void) | undefined;
    let complete = false;
    try {
      finishMousePresentation = beginMousePresentation(this.terminal, modes);
      selectionDrag = captureSelectionDrag(this.terminal);
      this.terminal.reset();
      setPresentationPending(this.terminal, true);
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
      if (selectionDrag) selectionDrag.finish(sameGeometry && this.terminal.buffer.active.type === old.type);
      else if (selection && this.terminal.buffer.active.type === old.type) {
        const length = (selection.end.y - selection.start.y) * frame.cols + selection.end.x - selection.start.x;
        if (length > 0) this.terminal.select(selection.start.x, selection.start.y, length);
        // History trimming or a repaint can move different text under identical
        // coordinates. Never retain a selection that silently selects new text.
        if (this.terminal.getSelection() !== selectedText) this.terminal.clearSelection();
      }
      complete = true;
    } finally {
      finishMousePresentation?.();
      selectionDrag?.finish(false);
      setPresentationPending(this.terminal, false);
      finishPresentation(complete && !this.disposed, frame.rows, this.terminal.getSelectionPosition?.());
      if (!this.disposed) this.terminal.refresh?.(0, frame.rows - 1);
    }
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
      this.pendingModifiedEnter=undefined;
      this.compositionBlocked ||= this.compositionActive;
      this.deferredKeyBlocked ||= this.deferredKeyTimer !== undefined;
    }
    const editable = !this.disposed && (this.enabled || options.preserveKeyboard === true);
    this.terminal.options.disableStdin = !editable;
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
    if(!focused)this.pendingModifiedEnter=undefined;
    if (this.enabled && !this.disposed && this.modes?.sendFocusMode) {
      this.onInput(focused ? '\x1b[I' : '\x1b[O', 'utf8');
    }
  }

  beginComposition(): void {
    this.pendingModifiedEnter=undefined;
    if (this.compositionEndTimer) clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = undefined;
    this.compositionActive = true;
    this.compositionBlocked ||= !this.enabled;
  }

  endComposition(): void {
    if (this.compositionEndTimer) clearTimeout(this.compositionEndTimer);
    this.compositionEndTimer = undefined;
    this.flushModifiedEnter();
    this.compositionActive = false;
    this.compositionBlocked = false;
  }

  private flushModifiedEnter(): void {
    const input=this.pendingModifiedEnter;
    this.pendingModifiedEnter=undefined;
    if(input&&this.acceptsTerminalInput()&&this.modes?.win32InputMode)this.terminal.input(input,true);
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
