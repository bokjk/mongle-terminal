import Headless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { reportedDirectory } from '../shell-profiles/integration.js';
import { clearScrollback, isPresentationPending, presentationExtras } from './pinned-xterm.js';
import { assertGeometry, PRESENTATION_VERSION } from './types.js';
import type { PresentationSnapshot, TerminalEngineOptions, TerminalModes } from './types.js';

/** The sole VT parser and automatic-response owner for a live PTY. */
export class TerminalEngine {
  private readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;
  private tail: Promise<unknown> = Promise.resolve();
  private pendingWrites: { data: Array<string | Uint8Array>; length: number; promise: Promise<void> } | undefined;
  private closing = false;
  private revision = 0;
  private inputResetGeneration = 0;
  private title = '';
  private readonly scrollback: number;
  private hasOutput = false;
  private historyRestored = false;
  private restoringHistory = false;
  private win32InputMode = false;

  constructor(options: TerminalEngineOptions) {
    assertGeometry(options.cols, options.rows);
    const scrollback = options.scrollback ?? 5000;
    if (!Number.isInteger(scrollback) || scrollback < 0 || scrollback > 5000) {
      throw new RangeError('Scrollback must be 0..5000 lines.');
    }
    this.scrollback = scrollback;
    this.terminal = new Headless.Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback,
      allowProposedApi: true,
      logLevel: 'off',
      windowOptions: { getWinSizeChars: true },
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    presentationExtras(this.terminal); // Fail closed if dependency internals changed.
    const reply = (data: string) => {
      if (!this.closing && !this.restoringHistory) options.onResponse(data);
    };
    this.terminal.onData(reply);
    this.terminal.onTitleChange(title => { this.title = title.slice(0, 512); });
    this.installHostQueries(reply);
    // ConPTY requests native modifier reporting. xterm 6 does not track 9001.
    // Return false so bundled DECSET/DECRST modes still reach xterm's parser.
    for(const final of ['h','l'])this.terminal.parser.registerCsiHandler({prefix:'?',final},params=>{
      if(params.includes(9001))this.win32InputMode=final==='h';
      return false;
    });
    this.terminal.parser.registerCsiHandler({prefix:'?',intermediates:'$',final:'p'},params=>{
      if(params.length!==1||params[0]!==9001)return false;
      reply(`\x1b[?9001;${this.win32InputMode?1:2}$y`);return true;
    });
    this.terminal.parser.registerEscHandler({final:'c'},()=>{
      this.win32InputMode=false;
      this.inputResetGeneration += 1;
      return false;
    });
    for (const osc of [7, 9] as const) {
      this.terminal.parser.registerOscHandler(osc, data => {
        const directory = reportedDirectory(data, osc);
        if (directory && !this.closing && !this.restoringHistory) options.onDirectory?.(directory);
        return true;
      });
    }
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Terminal engine is disposed.'));
    // A snapshot, resize or history operation is a fence: later output must
    // never be appended to the write batch that precedes it.
    this.pendingWrites = undefined;
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  write(data: string | Uint8Array): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Terminal engine is disposed.'));
    // Copy bytes because processing occurs asynchronously; caller may reuse memory.
    const retained = typeof data === 'string' ? data : new Uint8Array(data);
    // Bound each parser submission below xterm's pending-data watermark.
    // A large queued burst must not throw halfway through a snapshot fence.
    if (this.pendingWrites && this.pendingWrites.length + retained.length <= 1024 * 1024) {
      this.pendingWrites.data.push(retained);
      this.pendingWrites.length += retained.length;
      return this.pendingWrites.promise;
    }
    const batch = [retained];
    const promise = this.enqueue(() => new Promise<void>(resolve => {
      if (this.pendingWrites?.data === batch) this.pendingWrites = undefined;
      this.hasOutput = true;
      // Let xterm drain adjacent PTY chunks in its existing bounded parser
      // loop. Waiting for every individual callback adds one timer turn per
      // chunk (about 15 ms on Windows) and needlessly backs up live output.
      // Keep byte/string boundaries intact for xterm's incremental decoders.
      for (let index = 0; index < batch.length; index += 1) {
        this.terminal.write(batch[index], () => {
          this.revision += 1;
          if (index === batch.length - 1) resolve();
        });
      }
    }));
    this.pendingWrites = { data: batch, length: retained.length, promise };
    return promise;
  }

  /**
   * Restore a cold-boot record before spawning a new PTY. This is plain text,
   * not continuation of the old process, parser, styling or input modes.
   */
  async restoreHistory(snapshot: Pick<PresentationSnapshot, 'kind' | 'version' | 'cols' | 'rows' | 'data'>): Promise<void> {
    const { kind, version, cols, rows, data } = snapshot;
    if (kind !== 'presentation-v1' || version !== PRESENTATION_VERSION ||
        typeof data !== 'string' || data.length > 16 * 1024 * 1024 ||
        new TextEncoder().encode(data).byteLength > 16 * 1024 * 1024) {
      throw new Error('Unsupported or oversized terminal history.');
    }
    assertGeometry(cols, rows);
    return this.enqueue(async () => {
      if (this.hasOutput || this.historyRestored) {
        throw new Error('Terminal history can only be restored once, before live output.');
      }
      // Saved VT is parsed in an isolated terminal with no response callbacks.
      // Never replay it into the future PTY's parser, even with onData muted:
      // custom query handlers and a partial final sequence must not leak either.
      const reader = new Headless.Terminal({
        cols, rows, scrollback: this.scrollback, allowProposedApi: true, logLevel: 'off',
      });
      let history: string;
      try {
        await new Promise<void>(resolve => reader.write(data, resolve));
        const normal = historyText(reader.buffer.normal);
        const alternate = reader.buffer.active.type === 'alternate' ? historyText(reader.buffer.alternate) : '';
        history = normal;
        if (alternate) history += `${normal ? '\r\n' : ''}[이전 전체 화면 기록]\r\n${alternate}`;
      } finally {
        reader.dispose();
      }
      this.restoringHistory = true;
      try {
        this.terminal.reset();
        this.win32InputMode = false;
        this.title = '';
        // Move the record into scrollback before the new shell's initial ED2 /
        // cursor-home. Those startup sequences must not erase previous output.
        // ED3 (explicit clear-history) still behaves normally after startup.
        const restored = `${history}${history ? '\r\n\r\n' : ''}── 이전 기록 · 새 셸 시작 ──` +
          '\r\n'.repeat(this.terminal.rows) + '\x1b[H';
        await new Promise<void>(resolve => this.terminal.write(restored, resolve));
        this.historyRestored = true;
        this.revision += 1;
      } finally {
        this.restoringHistory = false;
      }
    });
  }

  resize(cols: number, rows: number): Promise<void> {
    assertGeometry(cols, rows);
    return this.enqueue(() => {
      this.terminal.resize(cols, rows);
      this.revision += 1;
    });
  }

  async snapshot(options: { maxBytes?: number } = {}): Promise<PresentationSnapshot> {
    const budget = options.maxBytes ?? 1536 * 1024;
    if (!Number.isSafeInteger(budget) || budget < 1024 || budget > 16 * 1024 * 1024) {
      return Promise.reject(new RangeError('Snapshot budget must be 1 KiB..16 MiB.'));
    }
    // Applications such as GJC split a synchronized update across PTY chunks.
    // Wait outside the parser queue so the closing sequence can still arrive.
    // Bound the wait for applications that forget to end DEC mode 2026.
    const deadline = Date.now() + 1000;
    for (;;) {
      const snapshot = await this.enqueue(() => {
        if (isPresentationPending(this.terminal) && Date.now() < deadline) return undefined;
        const modes: TerminalModes = { ...this.terminal.modes, ...presentationExtras(this.terminal), win32InputMode:this.win32InputMode };
        // Exclude serializer modes: origin-mode changes move the cursor. The client
        // handles input modes separately and never consumes future raw VT output.
        const available = this.terminal.buffer.normal.baseY;
        const make = (scrollback: number): PresentationSnapshot => ({
          kind: 'presentation-v1', version: PRESENTATION_VERSION,
          inputResetGeneration: this.inputResetGeneration,
          revision: this.revision, cols: this.terminal.cols, rows: this.terminal.rows,
          data: this.serializer.serialize({ excludeModes: true, scrollback })
          // SerializeAddon ends normal-buffer serialization with the *active*
          // rendition. Reset it before entering alternate buffer; otherwise BCE
          // fills untouched alternate cells with that rendition's background.
            .replace('\x1b[?1049h\x1b[H', '\x1b[0m\x1b[?1049h\x1b[H'),
          modes, title: this.title, historyTruncated: scrollback < available,
          historyLinesIncluded: scrollback,
        });
        const byteSize = (frame: PresentationSnapshot) => new TextEncoder().encode(JSON.stringify(frame)).byteLength;
        const full = make(available);
        if (byteSize(full) <= budget) return full;
        let best = make(0);
        // A soft history budget must never remove current-screen cells. The
        // transport supports this marked larger frame up to its hard limit.
        if (byteSize(best) > budget) return { ...best, oversized: true };
        let low = 1;
        let high = available - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = make(middle);
          if (byteSize(candidate) <= budget) { best = candidate; low = middle + 1; }
          else high = middle - 1;
        }
        return best;
      });
      if (snapshot) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  }

  clearHistory(): Promise<void> {
    return this.enqueue(() => { clearScrollback(this.terminal); this.revision += 1; });
  }

  /** Wait for pending parser work before disposing, so write promises settle. */
  dispose(): Promise<void> {
    if (this.closing) return this.tail.then(() => undefined);
    this.closing = true;
    this.pendingWrites = undefined;
    this.tail = this.tail.then(() => this.terminal.dispose());
    return this.tail.then(() => undefined);
  }

  private installHostQueries(reply: (data: string) => void): void {
    // Headless has no browser window/theme service. Declare a fixed capability
    // theme and answer character geometry without claiming real pixel geometry.
    this.terminal.parser.registerCsiHandler({ final: 't' }, params => {
      if (params[0] === 18) {
        reply(`\x1b[8;${this.terminal.rows};${this.terminal.cols}t`);
        return true;
      }
      return false;
    });
    const colors: Record<number, string> = {
      10: 'rgb:d4d4/d4d4/d8d8', 11: 'rgb:1818/1818/1b1b', 12: 'rgb:d4d4/d4d4/d8d8',
    };
    for (const [code, color] of Object.entries(colors)) {
      this.terminal.parser.registerOscHandler(Number(code), payload => {
        if (payload !== '?') return true; // App-selected global colors are unsupported.
        reply(`\x1b]${code};${color}\x1b\\`);
        return true;
      });
    }
    // Clipboard escape sequences must never become browser clipboard actions.
    this.terminal.parser.registerOscHandler(52, () => true);
  }
}

/** Read cells through public APIs; only our own CRLF can become control input. */
function historyText(buffer: Terminal['buffer']['normal']): string {
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y)!;
    // Keep spaces on wrapped rows so content does not shift when reflowed into
    // a differently sized terminal. Empty trailing viewport rows are omitted.
    const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped)
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\r\n');
}
