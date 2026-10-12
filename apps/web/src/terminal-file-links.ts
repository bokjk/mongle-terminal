import type { IBuffer, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

/**
 * File paths printed in a terminal (an agent's "Update(src\app.ts)", a compiler's "src/a.ts:12:5").
 * Only the rendered buffer is read: nothing is sent to the program, and opening a link stays a
 * deliberate Ctrl+click so a plain click still reaches a CLI that reports the mouse.
 */
export interface PathMatch { start: number; end: number; text: string; path: string; line?: number; column?: number }

const NAME = '\\p{L}\\p{N}\\p{M}_@+\\-';
const SEP = '[\\\\/]';
const PATH = new RegExp(
  '(?<![' + NAME + '.\\\\/:~])'
  + '((?:[A-Za-z]:' + SEP + '|\\.' + SEP + ')?(?:[' + NAME + '.]+' + SEP + ')*[' + NAME + '.]*[' + NAME + ']\\.[A-Za-z0-9]{1,10})'
  + '(?::(\\d{1,7})(?::(\\d{1,5}))?|\\((\\d{1,7})(?:,(\\d{1,5}))?\\))?'
  + '(?![' + NAME + '\\\\/])',
  'gu',
);
/** A file name written without a folder is a link only for these extensions: console.log and v1.2 stay text. */
const BARE_EXTENSIONS = new Set(('md markdown txt pdf json jsonc yml yaml toml ini cfg conf env lock xml csv tsv html htm css scss less '
  + 'js mjs cjs jsx ts mts cts tsx vue svelte py rs go java kt kts cs fs swift rb php c h cc cpp hpp sh bash zsh ps1 psm1 bat cmd '
  + 'sql graphql proto gradle svg').split(' '));
const MAX_LINE = 4096;

/** Every path in one line of text, with its optional :line:column. Web addresses are skipped. */
export function findPaths(text: string): PathMatch[] {
  if (text.length > MAX_LINE) return [];
  const urls = [...text.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g)].map(match => [match.index, match.index + match[0].length] as const);
  const found: PathMatch[] = [];
  for (const match of text.matchAll(PATH)) {
    const path = match[1]!, start = match.index, end = start + match[0].length;
    if (urls.some(([from, to]) => start < to && end > from)) continue;
    const segments = path.split(/[\\/]/);
    const name = segments.at(-1)!, extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    if (!/[a-z]/.test(extension) || segments.some(part => part === '..')) continue;
    if (segments.length === 1 && !BARE_EXTENSIONS.has(extension)) continue;
    if (!/\p{L}/u.test(path.slice(0, path.length - extension.length - 1))) continue;
    const line = match[2] ?? match[4], column = match[3] ?? match[5];
    found.push({ start, end, text: match[0], path, ...(line ? { line: Number(line) } : {}), ...(column ? { column: Number(column) } : {}) });
  }
  return found;
}

export type ResolvedPath = { ok: true; path: string } | { ok: false; reason: string };
export const OUTSIDE_FOLDER = '현재 터미널 폴더 안의 파일만 열 수 있습니다. 그 폴더로 이동한 터미널에서 다시 열어 주세요.';

/** A printed path as the folder-relative path the file tabs open, inside the terminal's current folder only. */
export function resolveTerminalPath(root: string, printed: string): ResolvedPath {
  const base = root.replaceAll('/', '\\').replace(/\\+$/, '');
  let target = printed.replaceAll('/', '\\');
  if (/^[A-Za-z]:\\/.test(target)) {
    if (!/^[A-Za-z]:/.test(base) || !target.toLowerCase().startsWith(base.toLowerCase() + '\\')) return { ok: false, reason: OUTSIDE_FOLDER };
    target = target.slice(base.length + 1);
  }
  target = target.replace(/^\.\\/, '');
  const segments = target.split('\\');
  if (!target || segments.some(part => !part || part === '.' || part === '..') || /[:\x00-\x1f]/.test(target)) return { ok: false, reason: OUTSIDE_FOLDER };
  return { ok: true, path: target };
}

type Cell = { x: number; y: number; width: number };
/** The whole wrapped line that buffer row (0-based) belongs to, with the cell of each UTF-16 unit. */
function logicalLine(buffer: IBuffer, row: number): { text: string; cells: Cell[] } | undefined {
  let first = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = '';
  const cells: Cell[] = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    const next = buffer.getLine(y + 1);
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      const width = cell?.getWidth() ?? 1;
      if (!cell || width === 0) continue;
      const chars = cell.getChars();
      // A wide character that did not fit leaves the row's last cell empty before it wraps.
      if (!chars && x === line.length - 1 && next?.isWrapped) continue;
      const value = chars || ' ';
      text += value;
      for (let unit = 0; unit < value.length; unit++) cells.push({ x, y, width });
    }
    if (text.length > MAX_LINE) return undefined;
  }
  return { text, cells };
}

type Located = { match: PathMatch; first: Cell; last: Cell; cells: Cell[] };
function locate(buffer: IBuffer, row: number): Located[] {
  const line = logicalLine(buffer, row);
  if (!line) return [];
  return findPaths(line.text).map(match => ({ match, first: line.cells[match.start]!, last: line.cells[match.end - 1]!, cells: line.cells.slice(match.start, match.end) }))
    .filter(item => item.first && item.last);
}

/** The path under one buffer cell (0-based column and row), if any. */
export function pathAtCell(buffer: IBuffer, column: number, row: number): PathMatch | undefined {
  return locate(buffer, row).find(item => item.cells.some(cell => cell.y === row && column >= cell.x && column < cell.x + cell.width))?.match;
}

/** The path under a mouse position over the rendered terminal. */
export function pathAtPoint(terminal: Terminal, clientX: number, clientY: number): PathMatch | undefined {
  const rect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height || clientX < rect.left || clientY < rect.top || clientX >= rect.right || clientY >= rect.bottom) return undefined;
  const column = Math.floor((clientX - rect.left) * terminal.cols / rect.width);
  const row = Math.floor((clientY - rect.top) * terminal.rows / rect.height);
  const buffer = terminal.buffer.active;
  return pathAtCell(buffer, column, buffer.viewportY + row);
}

/** Underlines paths on hover. Opening is left to the pane's Ctrl+click handler, so a plain click never opens one. */
export function terminalPathLinks(terminal: Terminal, hover: (shown: boolean) => void): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const row = lineNumber - 1;
      const links: ILink[] = locate(terminal.buffer.active, row)
        .filter(({ first, last }) => first.y <= row && last.y >= row)
        .map(({ match, first, last }) => ({
          range: { start: { x: first.x + 1, y: first.y + 1 }, end: { x: last.x + last.width, y: last.y + 1 } },
          text: match.text,
          decorations: { underline: true, pointerCursor: false },
          activate: () => {},
          hover: () => hover(true),
          leave: () => hover(false),
        }));
      callback(links.length ? links : undefined);
    },
  };
}

/**
 * Paths in the output open with Ctrl+click (Cmd+click on a Mac). Register before every other mouse
 * handler on `element`: an opening press then never reaches a mouse-reporting CLI, never starts a
 * selection and never takes control of the terminal. `open` answers false to leave the press alone.
 */
export function attachTerminalPathLinks(terminal: Terminal, element: HTMLElement, open: (path: string) => boolean): () => void {
  const links = terminal.registerLinkProvider(terminalPathLinks(terminal, shown => {
    if (shown) element.setAttribute('title', 'Ctrl+클릭하여 파일 열기'); else element.removeAttribute('title');
  }));
  let swallow = false;
  const press = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const hit = pathAtPoint(terminal, event.clientX, event.clientY);
    if (!hit || !open(hit.path)) return;
    event.preventDefault(); event.stopImmediatePropagation(); swallow = true;
  };
  const release = (event: MouseEvent) => {
    if (!swallow) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'click') swallow = false;
  };
  element.addEventListener('mousedown', press, true);
  element.addEventListener('mouseup', release, true);
  element.addEventListener('click', release, true);
  return () => {
    links.dispose();
    element.removeEventListener('mousedown', press, true);
    element.removeEventListener('mouseup', release, true);
    element.removeEventListener('click', release, true);
    element.removeAttribute('title');
  };
}
