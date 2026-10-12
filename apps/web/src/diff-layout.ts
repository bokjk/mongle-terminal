import type { GitDiff, GitDiffBase, GitDiffTarget } from '../../../packages/protocol/index';

/** Kept free of editor imports: the document hook loads with the app shell, the diff view lazily. */
export type DiffLayout = 'split' | 'unified';
export function preferredLayout(): DiffLayout {
  try { const saved = localStorage.getItem('mongle.diff.layout'); if (saved === 'split' || saved === 'unified') return saved; } catch {}
  return window.innerWidth < 900 ? 'unified' : 'split';
}
export function rememberLayout(layout: DiffLayout) { try { localStorage.setItem('mongle.diff.layout', layout); } catch {} }
/** Short tab suffix that tells staged and unstaged comparisons of the same file apart. */
export function diffLabel(base: GitDiffBase, target: GitDiffTarget) {
  return base === 'HEAD' && target === 'INDEX' ? '스테이징' : base === 'HEAD' ? 'HEAD 비교' : '작업 중';
}
/** Line endings are normalized by the editor, so a CRLF-only change would otherwise look empty. */
export function lineEndingsOnly(diff: GitDiff) {
  return diff.original !== null && diff.modified !== null && diff.original !== diff.modified && diff.original.replace(/\r\n?/g, '\n') === diff.modified.replace(/\r\n?/g, '\n');
}

