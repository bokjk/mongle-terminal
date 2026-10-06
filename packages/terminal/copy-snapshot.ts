/**
 * Read-only plain-text copy of a terminal's normal buffer (scrollback plus
 * viewport), built only from xterm's public buffer API so it works with both
 * the browser renderer and @xterm/headless.
 *
 * Text follows xterm's own selection semantics (SelectionService.selectionText):
 * every row is read with translateToString(true), which drops only never-written
 * trailing cells (including the empty cell left when a wide glyph wraps early)
 * and keeps written spaces; a row whose successor is wrapped is concatenated
 * with it; non-breaking spaces become regular spaces, as xterm does on copy.
 * Lines are joined with '\n'. Nothing else is inferred, repaired or added.
 */

/** Smallest structural slice of xterm's public IBufferLine used here. */
export interface CopySnapshotLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** Smallest structural slice of xterm's public Terminal used here. */
export interface CopySnapshotSource {
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate';
      readonly length: number;
      getLine(y: number): CopySnapshotLine | undefined;
    };
  };
}

export interface CopySnapshot {
  /** Logical lines joined with '\n'. A detached string: later output cannot change it. */
  readonly text: string;
  /** Number of logical (unwrapped) lines in text. */
  readonly lineCount: number;
  /**
   * True only when this helper's character budget forced it to omit the oldest
   * logical lines. Host-side history truncation is reported separately by the caller.
   */
  readonly historyTruncated?: true;
  /** Oldest logical lines omitted because of the budget (present with historyTruncated). */
  readonly omittedLineCount?: number;
}

/** At most 2,097,152 UTF-16 code units. */
export const DEFAULT_COPY_SNAPSHOT_MAX_CHARS = 2 * 1024 * 1024;

export type CopySnapshotErrorCode = 'ALTERNATE_BUFFER' | 'LINE_TOO_LONG' | 'INVALID_LIMIT';

export class CopySnapshotError extends Error {
  constructor(readonly code: CopySnapshotErrorCode, message: string) {
    super(message);
    this.name = 'CopySnapshotError';
  }
}

const NON_BREAKING_SPACE = /\u00a0/g;

/**
 * Collect the normal buffer as plain text. Throws CopySnapshotError
 * ALTERNATE_BUFFER when the alternate screen is active: a full-screen program
 * owns the screen and the normal buffer is not what the user sees.
 *
 * When the text would exceed maxChars, the newest whole logical lines that fit
 * are kept and historyTruncated/omittedLineCount say so; a line is never cut.
 * If the newest non-empty logical line alone exceeds maxChars, LINE_TOO_LONG
 * is thrown instead of returning a partial line.
 */
export function collectCopySnapshot(terminal: CopySnapshotSource, maxChars: number = DEFAULT_COPY_SNAPSHOT_MAX_CHARS): CopySnapshot {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new CopySnapshotError('INVALID_LIMIT', 'maxChars must be a positive integer.');
  }
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'normal') {
    throw new CopySnapshotError('ALTERNATE_BUFFER', 'The alternate screen is active; only the normal buffer can be captured.');
  }

  // Walk backwards so the budget keeps the newest lines and reading stops
  // growing once full. Rows of one logical line are gathered in reverse.
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  let full = false;
  let rows: string[] = [];
  let rowChars = 0;
  let overflow = false;
  // Trailing empty logical lines (unused viewport rows) are skipped.
  let seenContent = false;

  const finishLine = () => {
    const pieces = rows;
    const tooLong = overflow;
    rows = [];
    rowChars = 0;
    overflow = false;
    if (full) { omitted += 1; return; }
    if (tooLong) {
      if (lines.length === 0) {
        throw new CopySnapshotError('LINE_TOO_LONG', `The newest line exceeds the ${maxChars}-character limit.`);
      }
      full = true;
      omitted += 1;
      return;
    }
    const text = pieces.reverse().join('').replace(NON_BREAKING_SPACE, ' ');
    if (!seenContent) {
      if (text === '') return;
      seenContent = true;
    }
    const cost = text.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      if (lines.length === 0) {
        throw new CopySnapshotError('LINE_TOO_LONG', `The newest line exceeds the ${maxChars}-character limit.`);
      }
      full = true;
      omitted += 1;
      return;
    }
    lines.push(text);
    used += cost;
  };

  for (let y = buffer.length - 1; y >= 0; y -= 1) {
    const line = buffer.getLine(y);
    if (!full && !overflow) {
      const text = line ? line.translateToString(true) : '';
      rowChars += text.length;
      if (rowChars > maxChars) { overflow = true; rows = []; }
      else rows.push(text);
    }
    if (!line?.isWrapped || y === 0) finishLine();
  }

  lines.reverse();
  const text = lines.join('\n');
  const snapshot: CopySnapshot = omitted > 0
    ? { text, lineCount: lines.length, historyTruncated: true, omittedLineCount: omitted }
    : { text, lineCount: lines.length };
  return Object.freeze(snapshot);
}
