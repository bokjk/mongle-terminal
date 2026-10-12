import type { GitDiff, GitDiffBase, GitDiffTarget } from '../../../packages/protocol/index';

/** Kept free of editor imports: the document hook loads with the app shell, the diff view lazily. */
export type DiffLayout = 'split' | 'unified';
export function preferredLayout(): DiffLayout {
  try { const saved = localStorage.getItem('mongle.diff.layout'); if (saved === 'split' || saved === 'unified') return saved; } catch {}
  return 'unified';
}
export function rememberLayout(layout: DiffLayout) { try { localStorage.setItem('mongle.diff.layout', layout); } catch {} }
/** One-file diff tabs show the whole file like Orca; the many-file review folds unchanged runs by default. */
export function preferredCollapse(scope: 'diff' | 'review') { try { const saved = localStorage.getItem('mongle.' + scope + '.collapse'); if (saved) return saved === 'on'; } catch {} return scope === 'review'; }
export function rememberCollapse(scope: 'diff' | 'review', collapse: boolean) { try { localStorage.setItem('mongle.' + scope + '.collapse', collapse ? 'on' : 'off'); } catch {} }
/** Short tab suffix that tells staged and unstaged comparisons of the same file apart. */
export function diffLabel(base: GitDiffBase, target: GitDiffTarget) {
  return base === 'HEAD' && target === 'INDEX' ? '스테이징' : base === 'HEAD' ? 'HEAD 비교' : base === 'INDEX' ? '작업 중' : '기준';
}
/** Pane title for one side of a comparison. */
export function sideName(side: GitDiffBase | GitDiffTarget) {
  return side === 'HEAD' ? 'HEAD · 마지막 커밋' : side === 'INDEX' ? '스테이징' : side === 'WORKTREE' ? '작업 폴더 · 현재 파일' : '기준 커밋 · ' + side.slice(0, 7);
}
/** Line endings are normalized by the editor, so a CRLF-only change would otherwise look empty. */
export function lineEndingsOnly(diff: GitDiff) {
  return diff.original !== null && diff.modified !== null && diff.original !== diff.modified && diff.original.replace(/\r\n?/g, '\n') === diff.modified.replace(/\r\n?/g, '\n');
}

