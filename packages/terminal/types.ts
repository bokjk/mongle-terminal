/** These frames are presentation state, never a raw PTY continuation. */
export interface PresentationSnapshot {
  kind: 'presentation-v1';
  version: string;
  revision?: number;
  cols: number;
  rows: number;
  data: string;
  modes: TerminalModes;
  title?: string;
  historyTruncated?: boolean;
  historyLinesIncluded?: number;
  oversized?: boolean;
}

export interface TerminalModes {
  [key: string]: unknown;
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  bracketedPasteMode: boolean;
  insertMode: boolean;
  originMode: boolean;
  reverseWraparoundMode: boolean;
  sendFocusMode: boolean;
  wraparoundMode: boolean;
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  mouseEncoding: 'DEFAULT' | 'SGR' | 'SGR_PIXELS';
  cursorHidden: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
}

export type TerminalInputEncoding = 'utf8' | 'binary';

export interface TerminalEngineOptions {
  cols: number;
  rows: number;
  scrollback?: number;
  onResponse: (data: string) => void;
}

export const PRESENTATION_VERSION = 'xterm-6.0.0/serialize-0.14.0/presentation-1';

export function assertGeometry(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) {
    throw new RangeError('Terminal geometry must be 2..500 columns and 1..300 rows.');
  }
}
