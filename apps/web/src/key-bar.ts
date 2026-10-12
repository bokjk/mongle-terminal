/**
 * The phone key bar above the on-screen keyboard: which keys it shows and in what order.
 * The choice is kept per device (like the touch scroll speed); the keyboard button stays at the end.
 */
export type KeyBarModifier = 'ctrl' | 'alt';
export type KeyBarArrow = 'left' | 'down' | 'up' | 'right';
export type KeyBarKey = { id: string; label: string; name: string; /** spoken name when the label is only a symbol */ aria?: string } & ({ kind: 'key'; data: string; arrow?: KeyBarArrow } | { kind: 'modifier'; modifier: KeyBarModifier });

export const KEY_BAR_KEYS: readonly KeyBarKey[] = [
  { id: 'esc', label: 'Esc', name: 'Esc', kind: 'key', data: '\x1b' },
  { id: 'tab', label: 'Tab', name: 'Tab', kind: 'key', data: '\t' },
  { id: 'shift-tab', label: '⇧Tab', name: 'Shift+Tab', aria: 'Shift+Tab', kind: 'key', data: '\x1b[Z' },
  { id: 'ctrl', label: 'Ctrl', name: 'Ctrl (다음 키와 함께)', kind: 'modifier', modifier: 'ctrl' },
  { id: 'alt', label: 'Alt', name: 'Alt (다음 키와 함께)', kind: 'modifier', modifier: 'alt' },
  { id: 'ctrl-c', label: '^C', name: 'Ctrl+C', kind: 'key', data: '\x03' },
  { id: 'ctrl-d', label: '^D', name: 'Ctrl+D', kind: 'key', data: '\x04' },
  { id: 'ctrl-z', label: '^Z', name: 'Ctrl+Z', kind: 'key', data: '\x1a' },
  { id: 'ctrl-l', label: '^L', name: 'Ctrl+L', kind: 'key', data: '\x0c' },
  { id: 'ctrl-r', label: '^R', name: 'Ctrl+R', kind: 'key', data: '\x12' },
  { id: 'left', label: '←', name: '왼쪽', aria: '왼쪽', kind: 'key', data: '\x1b[D', arrow: 'left' },
  { id: 'down', label: '↓', name: '아래', aria: '아래', kind: 'key', data: '\x1b[B', arrow: 'down' },
  { id: 'up', label: '↑', name: '위', aria: '위', kind: 'key', data: '\x1b[A', arrow: 'up' },
  { id: 'right', label: '→', name: '오른쪽', aria: '오른쪽', kind: 'key', data: '\x1b[C', arrow: 'right' },
  { id: 'home', label: 'Home', name: 'Home', kind: 'key', data: '\x1b[H' },
  { id: 'end', label: 'End', name: 'End', kind: 'key', data: '\x1b[F' },
  { id: 'page-up', label: 'PgUp', name: 'Page Up', kind: 'key', data: '\x1b[5~' },
  { id: 'page-down', label: 'PgDn', name: 'Page Down', kind: 'key', data: '\x1b[6~' },
  { id: 'enter', label: '⏎', name: 'Enter', aria: 'Enter', kind: 'key', data: '\r' },
  { id: 'pipe', label: '|', name: '세로 막대 |', aria: '세로 막대', kind: 'key', data: '|' },
  { id: 'tilde', label: '~', name: '물결 ~', aria: '물결', kind: 'key', data: '~' },
  { id: 'slash', label: '/', name: '슬래시 /', aria: '슬래시', kind: 'key', data: '/' },
  { id: 'backslash', label: '\\', name: '역슬래시 \\', aria: '역슬래시', kind: 'key', data: '\\' },
  { id: 'dash', label: '-', name: '빼기 -', aria: '빼기', kind: 'key', data: '-' },
];

/** The bar before anyone edits it: the keys it always had, in the same order. */
export const DEFAULT_KEY_BAR: readonly string[] = ['esc', 'tab', 'ctrl', 'alt', 'ctrl-c', 'left', 'down', 'up', 'right'];
export const KEY_BAR_MAX = 16;
const byId = new Map(KEY_BAR_KEYS.map(key => [key.id, key]));

export function keyBarKey(id: string): KeyBarKey | undefined { return byId.get(id); }

/** Known keys only, each once, at most KEY_BAR_MAX. Anything that is not a list is the default bar. */
export function sanitizeKeyBar(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_KEY_BAR];
  const ids: string[] = [];
  for (const item of value) if (typeof item === 'string' && byId.has(item) && !ids.includes(item) && ids.length < KEY_BAR_MAX) ids.push(item);
  return ids;
}

/** Moves one key earlier (-1) or later (+1); the bar is unchanged at either end. */
export function moveKeyBarItem(ids: readonly string[], id: string, offset: -1 | 1): string[] {
  const from = ids.indexOf(id), to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export function addKeyBarItem(ids: readonly string[], id: string): string[] { return sanitizeKeyBar([...ids, id]); }
export function removeKeyBarItem(ids: readonly string[], id: string): string[] { return ids.filter(item => item !== id); }
export function isDefaultKeyBar(ids: readonly string[]): boolean { return ids.length === DEFAULT_KEY_BAR.length && ids.every((id, index) => id === DEFAULT_KEY_BAR[index]); }

