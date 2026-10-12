import { useEffect, useRef, useState } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { getChunks, goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView, type Chunk } from '@codemirror/merge';
import { ChevronDown, ChevronUp, Columns2, FoldVertical, Rows2 } from 'lucide-react';
import type { GitDiff } from '../../../packages/protocol/index';
import { editorThemeSpec, highlighting, language } from './CodeEditor';
import { lineEndingsOnly, rememberLayout, sideName, type DiffLayout } from './diff-layout';

const lineEnding = (text: string | null) => !text ? '' : text.includes('\r\n') ? 'CRLF' : 'LF';
const phrases = EditorState.phrases.of({ '$ unchanged lines': '바뀌지 않은 줄 $개' });
type Mark = { top: number; height: number; kind: 'added' | 'removed' | 'modified'; index: number };

function summarize(chunks: readonly Chunk[], a: EditorState['doc'], b: EditorState['doc']) {
  let added = 0, removed = 0;
  for (const chunk of chunks) {
    if (chunk.toA > chunk.fromA) removed += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1;
    if (chunk.toB > chunk.fromB) added += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1;
  }
  return { added, removed };
}

type Props = { path: string; diff: GitDiff; layout: DiffLayout; collapse: boolean; active: boolean; onLayout(layout: DiffLayout): void; onCollapse(collapse: boolean): void };
export function GitDiffView({ path, diff, layout, collapse, active, onLayout, onCollapse }: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const navigation = useRef<EditorView>(undefined);
  const [position, setPosition] = useState({ current: 0, total: 0, added: 0, removed: 0 });
  // Overview strip beside the scrollbar: where each change sits in the whole file.
  const [marks, setMarks] = useState<Mark[]>([]);
  const original = diff.original ?? '', modified = diff.modified ?? '';
  function locate(view: EditorView) {
    const chunks = getChunks(view.state)?.chunks || [], head = view.state.selection.main.head;
    const index = chunks.findIndex(chunk => head >= chunk.fromB && head <= Math.max(chunk.fromB, chunk.endB));
    setPosition(value => ({ ...value, current: index + 1, total: chunks.length }));
  }
  function measure() {
    const view = navigation.current; if (!view) return;
    const chunks = getChunks(view.state)?.chunks || [], total = Math.max(1, view.contentHeight);
    setMarks(chunks.map((chunk, index) => {
      const top = view.lineBlockAt(chunk.fromB).top, bottom = chunk.toB > chunk.fromB ? view.lineBlockAt(Math.min(chunk.endB, view.state.doc.length)).bottom : top + view.defaultLineHeight;
      return { top: top / total, height: Math.max(bottom - top, view.defaultLineHeight) / total, kind: chunk.fromA === chunk.toA ? 'added' : chunk.fromB === chunk.toB ? 'removed' : 'modified', index };
    }));
  }
  function go(index: number) {
    const view = navigation.current, chunk = view && getChunks(view.state)?.chunks[index]; if (!view || !chunk) return;
    view.dispatch({ selection: { anchor: chunk.fromB }, effects: EditorView.scrollIntoView(chunk.fromB, { y: 'center' }) });
    view.focus(); locate(view);
  }
  function move(direction: 1 | -1) {
    const view = navigation.current; if (!view) return;
    const chunks = getChunks(view.state)?.chunks || [];
    if (!chunks.length) return;
    if (!(direction > 0 ? goToNextChunk : goToPreviousChunk)(view)) view.dispatch({ selection: { anchor: chunks[0].fromB }, effects: EditorView.scrollIntoView(chunks[0].fromB, { y: 'center' }) });
    view.focus(); locate(view);
  }
  useEffect(() => {
    const host = parent.current!;
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const keys = keymap.of([{ key: 'F7', run: () => { move(1); return true; } }, { key: 'Shift-F7', run: () => { move(-1); return true; } }]);
    const base = (label: string, wrap: boolean): Extension[] => [
      basicSetup, language(path), syntaxHighlighting(highlighting), keys, EditorState.readOnly.of(true), phrases,
      ...(wrap ? [EditorView.lineWrapping] : []),
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-readonly': 'true', spellcheck: 'false' }),
      EditorView.theme({ '&': { backgroundColor: 'var(--terminal)', color: 'var(--text)', ...(wrap ? { height: '100%' } : {}) }, ...editorThemeSpec }),
      EditorView.updateListener.of(update => { if (update.view !== navigation.current) return; if (update.selectionSet) locate(update.view); if (update.geometryChanged || update.docChanged) schedule(); }),
    ];
    const folding = collapse ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {};
    const originalLabel = sideName(diff.base) + (diff.originalPath ? ' · ' + diff.originalPath : '');
    let destroy: () => void, a: EditorState['doc'], b: EditorState['doc'], chunks: readonly Chunk[];
    if (layout === 'split') {
      const merge = new MergeView({ parent: host, a: { doc: original, extensions: base('이전 내용: ' + originalLabel, false) }, b: { doc: modified, extensions: base('새 내용: ' + sideName(diff.target), false) }, highlightChanges: true, gutter: true, ...folding });
      navigation.current = merge.b; a = merge.a.state.doc; b = merge.b.state.doc; chunks = merge.chunks;
      destroy = () => merge.destroy();
    } else {
      // Inline like VS Code/Orca: +/− beside the line number instead of a separate change bar.
      const view = new EditorView({ parent: host, state: EditorState.create({ doc: modified, extensions: [...base('변경 내용: ' + path, true), unifiedMergeView({ original, mergeControls: false, gutter: false, highlightChanges: true, syntaxHighlightDeletions: true, ...folding })] }) });
      navigation.current = view; b = view.state.doc; a = EditorState.create({ doc: original }).doc; chunks = getChunks(view.state)?.chunks || [];
      destroy = () => view.destroy();
    }
    const first = chunks[0], view = navigation.current;
    setPosition({ current: first ? 1 : 0, total: chunks.length, ...summarize(chunks, a, b) });
    if (first) view.dispatch({ selection: { anchor: first.fromB }, effects: EditorView.scrollIntoView(first.fromB, { y: 'center' }) });
    schedule();
    return () => { cancelAnimationFrame(frame); navigation.current = undefined; destroy(); };
  }, [path, original, modified, diff.base, diff.target, diff.originalPath, layout, collapse]);
  useEffect(() => { if (active) navigation.current?.requestMeasure(); }, [active]);
  const missing = (text: string | null) => text === null ? ' · 파일 없음' : '';
  return <div className={'diff-view layout-' + layout}>
    <div className="diff-toolbar" role="toolbar" aria-label="변경 비교 도구">
      <div className="diff-layouts" role="group" aria-label="비교 방식">
        <button aria-pressed={layout === 'unified'} onClick={() => { onLayout('unified'); rememberLayout('unified'); }}><Rows2 size={13}/>한 화면</button>
        <button aria-pressed={layout === 'split'} onClick={() => { onLayout('split'); rememberLayout('split'); }}><Columns2 size={13}/>나란히</button>
      </div>
      <button className="diff-toggle" aria-pressed={collapse} title="바뀌지 않은 줄을 접어 변경 부분만 보기" onClick={() => onCollapse(!collapse)}><FoldVertical size={13}/>변경 부분만</button>
      <span className="diff-stats" aria-label={'추가 ' + position.added + '줄, 삭제 ' + position.removed + '줄'}><span className="diff-added">+{position.added}</span><span className="diff-removed">−{position.removed}</span></span>
      <span className="diff-nav">
        <span className="diff-position" role="status">{position.total ? position.current ? position.current + ' / ' + position.total : position.total + '곳 변경' : '내용 차이 없음'}</span>
        <button className="icon-button" aria-label="이전 변경" title="이전 변경 (Shift+F7)" disabled={!position.total} onClick={() => move(-1)}><ChevronUp size={15}/></button>
        <button className="icon-button" aria-label="다음 변경" title="다음 변경 (F7)" disabled={!position.total} onClick={() => move(1)}><ChevronDown size={15}/></button>
      </span>
    </div>
    {layout === 'split' && <div className="diff-sides" aria-hidden="true"><span title={originalLabelFor(diff)}>{originalLabelFor(diff)}{missing(diff.original)}{lineEndingsOnly(diff) && ' · ' + lineEnding(diff.original)}</span><span>{sideName(diff.target)}{missing(diff.modified)}{lineEndingsOnly(diff) && ' · ' + lineEnding(diff.modified)}</span></div>}
    <div className="diff-main">
      <div className="diff-body" ref={parent}/>
      <div className="diff-overview" aria-label="변경 위치">{marks.map(mark => <button key={mark.index} className={'diff-overview-mark ' + mark.kind} style={{ top: mark.top * 100 + '%', height: 'max(3px, ' + mark.height * 100 + '%)' }} aria-label={(mark.index + 1) + '번째 변경으로 이동'} title={(mark.index + 1) + '번째 변경'} onClick={() => go(mark.index)}/>)}</div>
    </div>
  </div>;
}
function originalLabelFor(diff: GitDiff) { return sideName(diff.base) + (diff.originalPath ? ' · ' + diff.originalPath : ''); }

