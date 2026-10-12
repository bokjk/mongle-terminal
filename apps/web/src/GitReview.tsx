import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, drawSelection, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { EditorState, Text } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { Chunk, getChunks, unifiedMergeView } from '@codemirror/merge';
import { ChevronDown, ChevronRight, ChevronUp, FileText, GitCompareArrows, FoldVertical, ListTree, UnfoldVertical } from 'lucide-react';
import type { GitDiff, GitReview as Review, GitReviewFile, GitReviewMode } from '../../../packages/protocol/index';
import { editorThemeSpec, highlighting, language } from './CodeEditor';
import { GitMarker, type GitKind } from './GitChanges';
import { countLines, lineEndingsOnly, preferredCollapse, rememberCollapse } from './diff-layout';

type Request = <T>(method: string, params: unknown, signal?: AbortSignal) => Promise<T>;
type Reference = { id: string; hostId: string; bootId: string; generation: string; root: string };
type Content = { diff?: GitDiff; error?: string; added: number; removed: number; chunks: number };
const kinds: Record<GitReviewFile['status'], GitKind> = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', conflicted: 'conflicted' };
const statusNames: Record<GitReviewFile['status'], string> = { added: '추가됨', modified: '수정됨', deleted: '삭제됨', renamed: '이름 변경', conflicted: '충돌' };
const contentKey = (base: string, file: GitReviewFile) => base + '\0' + (file.originalPath || '') + '\0' + file.path;
const phrases = EditorState.phrases.of({ '$ unchanged lines': '바뀌지 않은 줄 $개' });
const PRELOAD = 150;

function count(diff: GitDiff): Content {
  if (diff.unavailable) return { diff, added: 0, removed: 0, chunks: 0 };
  if (diff.original === null || diff.modified === null) { const added = countLines(diff.modified), removed = countLines(diff.original); return { diff, added, removed, chunks: added || removed ? 1 : 0 }; }
  const a = Text.of((diff.original ?? '').split(/\r\n?|\n/)), b = Text.of((diff.modified ?? '').split(/\r\n?|\n/));
  let added = 0, removed = 0;
  const chunks = diff.original === null ? (diff.modified ? [new Chunk([], 0, 0, 0, b.length)] : []) : diff.modified === null ? (diff.original ? [new Chunk([], 0, a.length, 0, 0)] : []) : Chunk.build(a, b);
  for (const chunk of chunks) {
    if (chunk.toA > chunk.fromA) removed += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1;
    if (chunk.toB > chunk.fromB) added += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1;
  }
  return { diff, added, removed, chunks: chunks.length };
}

type Props = { review: Review; mode: GitReviewMode; reference: Reference; request: Request; active: boolean; focus?: { path: string; token: number }; onMode(mode: GitReviewMode): void; onSplit(file: GitReviewFile, base: string): void; onOpenFile(file: GitReviewFile): void };
export function GitReview({ review, mode, reference, request, active, focus, onMode, onSplit, onOpenFile }: Props) {
  const files = review.state === 'repository' ? review.files : [];
  const base = review.state === 'repository' ? review.base : '';
  const [contents, setContents] = useState(() => new Map<string, Content>());
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [folding, setFolding] = useState(() => preferredCollapse('review'));
  const [seen, setSeen] = useState(() => new Set<string>());
  const [listOpen, setListOpen] = useState(() => { try { return localStorage.getItem('mongle.review.list') !== 'closed'; } catch { return true; } });
  const [current, setCurrent] = useState({ path: '', chunk: -1 });
  // Narrow panels show the file list as an overlay that closes after picking a file.
  const [narrow, setNarrow] = useState(false), [overlay, setOverlay] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { const element = container.current; if (!element) return; const observer = new ResizeObserver(() => setNarrow(element.clientWidth < 640)); observer.observe(element); return () => observer.disconnect(); }, []);
  const showList = narrow ? overlay : listOpen;
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const views = useRef(new Map<string, EditorView>());
  const pending = useRef<{ path: string; chunk: number } | undefined>(undefined);
  const visible = useRef(new Set<string>());
  // Each queue owns an AbortController, so a closed tab or a new base cancels its reads.
  const queue = useRef<{ keys: string[]; running: boolean; generation: number; abort: AbortController }>({ keys: [], running: false, generation: 0, abort: new AbortController() });
  const live = useRef({ files, base, reference, request }); live.current = { files, base, reference, request };

  // A different base or folder invalidates every loaded comparison.
  const restart = () => { queue.current.abort.abort(); queue.current = { keys: [], running: false, generation: queue.current.generation + 1, abort: new AbortController() }; };
  useEffect(() => { restart(); setContents(new Map()); setSeen(new Set()); }, [base, reference.root, reference.hostId]);
  // Unmounting (closed tab, hidden editor) drops queued reads and cancels the waiting ones.
  useEffect(() => () => restart(), []);
  function want(keys: string[], front = false) {
    const q = queue.current;
    for (const key of keys) { const at = q.keys.indexOf(key); if (at >= 0) q.keys.splice(at, 1); if (front) q.keys.unshift(key); else q.keys.push(key); }
    void pump();
  }
  async function pump() {
    const q = queue.current; if (q.running) return;
    q.running = true;
    try {
      while (q.keys.length && queue.current === q) {
        const key = q.keys.shift()!, file = live.current.files.find(item => contentKey(live.current.base, item) === key);
        if (!file) continue;
        try {
          const diff = await live.current.request<GitDiff>('git.diff', { ...live.current.reference, path: file.path, ...(file.originalPath ? { originalPath: file.originalPath } : {}), base: live.current.base, target: 'WORKTREE' }, q.abort.signal);
          if (queue.current !== q) return;
          setContents(map => { const previous = map.get(key); if (previous?.diff && JSON.stringify(previous.diff) === JSON.stringify(diff)) return map; const next = new Map(map); next.set(key, count(diff)); return next; });
        } catch (error) {
          if (queue.current !== q) return;
          setContents(map => new Map(map).set(key, { error: error instanceof Error ? error.message : '변경 내용을 읽지 못했습니다.', added: 0, removed: 0, chunks: 0 }));
        }
      }
    } finally { q.running = false; }
  }
  // Visible files first, then a bounded background pass so the file list can show line counts.
  useEffect(() => { want(files.slice(0, PRELOAD).map(file => contentKey(base, file)).filter(key => !contents.has(key))); }, [files, base]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (!document.hidden) want(files.filter(file => visible.current.has(file.path)).map(file => contentKey(base, file)), true); }, 5000);
    return () => clearInterval(timer);
  }, [active, files, base]);
  useEffect(() => {
    const root = scroller.current; if (!root) return;
    const observer = new IntersectionObserver(entries => {
      const shown: string[] = [];
      for (const entry of entries) {
        const path = (entry.target as HTMLElement).dataset.path!;
        if (entry.isIntersecting) { visible.current.add(path); shown.push(path); } else visible.current.delete(path);
      }
      if (shown.length) {
        setSeen(value => shown.every(path => value.has(path)) ? value : new Set([...value, ...shown]));
        want(files.filter(file => shown.includes(file.path) && !contents.has(contentKey(base, file))).map(file => contentKey(base, file)), true);
      }
    }, { root, rootMargin: '600px 0px' });
    for (const element of sections.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [files, base, contents]);
  useEffect(() => {
    if (!focus) return;
    const element = sections.current.get(focus.path);
    if (element) { setCollapsed(value => { const next = new Set(value); next.delete(focus.path); return next; }); element.scrollIntoView({ block: 'start' }); setCurrent({ path: focus.path, chunk: -1 }); }
  }, [focus?.token, files]);

  const totals = useMemo(() => {
    let added = 0, removed = 0, chunks = 0, loaded = 0;
    for (const file of files) { const content = contents.get(contentKey(base, file)); if (content?.diff) { added += content.added; removed += content.removed; chunks += content.chunks; loaded++; } }
    return { added, removed, chunks, loaded };
  }, [files, base, contents]);
  const order = files.filter(file => (contents.get(contentKey(base, file))?.chunks || 0) > 0);
  const position = (() => {
    let index = 0;
    for (const file of order) { const chunks = contents.get(contentKey(base, file))!.chunks; if (file.path === current.path && current.chunk >= 0) return index + current.chunk + 1; index += chunks; }
    return 0;
  })();

  function topFile() {
    const root = scroller.current; if (!root) return -1;
    const top = root.getBoundingClientRect().top + 8;
    let index = 0;
    files.forEach((file, at) => { const element = sections.current.get(file.path); if (element && element.getBoundingClientRect().top <= top) index = at; });
    return index;
  }
  function jumpFile(direction: 1 | -1) {
    if (!files.length) return;
    const selected = files.findIndex(file => file.path === current.path), at = Math.max(0, Math.min(files.length - 1, (selected >= 0 ? selected : topFile()) + direction));
    const file = files[at]; sections.current.get(file.path)?.scrollIntoView({ block: 'start' }); setCurrent({ path: file.path, chunk: -1 });
  }
  function show(path: string, chunk: number) {
    setCollapsed(value => { if (!value.has(path)) return value; const next = new Set(value); next.delete(path); return next; });
    const view = views.current.get(path);
    if (!view) { pending.current = { path, chunk }; setSeen(value => new Set([...value, path])); sections.current.get(path)?.scrollIntoView({ block: 'start' }); setCurrent({ path, chunk }); return; }
    const chunks = getChunks(view.state)?.chunks || [], target = chunks[Math.max(0, Math.min(chunks.length - 1, chunk))];
    if (!target) return;
    view.dispatch({ selection: { anchor: Math.min(target.fromB, view.state.doc.length) }, effects: EditorView.scrollIntoView(Math.min(target.fromB, view.state.doc.length), { y: 'center' }) });
    setCurrent({ path, chunk: chunks.indexOf(target) });
  }
  function jumpChunk(direction: 1 | -1) {
    if (!order.length) return;
    let fileAt = order.findIndex(file => file.path === current.path), chunk = current.chunk;
    if (fileAt < 0) { const top = files[topFile()]?.path; fileAt = Math.max(0, order.findIndex(file => file.path === top)); chunk = direction > 0 ? -1 : 0; }
    const chunks = (at: number) => contents.get(contentKey(base, order[at]))!.chunks;
    chunk += direction;
    if (chunk >= chunks(fileAt)) { fileAt = (fileAt + 1) % order.length; chunk = 0; }
    if (chunk < 0) { fileAt = (fileAt - 1 + order.length) % order.length; chunk = chunks(fileAt) - 1; }
    show(order[fileAt].path, chunk);
  }
  function toggle(path: string) { setCollapsed(value => { const next = new Set(value); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  const allCollapsed = files.length > 0 && files.every(file => collapsed.has(file.path));

  if (review.state !== 'repository') return <div className="review-empty" ref={container}><strong>{review.message}</strong><p>{review.state === 'not-repository' ? 'Git으로 관리하는 프로젝트 폴더의 터미널에서 열어 주세요.' : '잠시 후 새로고침해 주세요.'}</p></div>;
  return <div className="git-review" ref={container} onKeyDown={event => {
    if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input, textarea, .cm-panels')) return;
    const action = ({ j: () => jumpFile(1), k: () => jumpFile(-1), n: () => jumpChunk(1), p: () => jumpChunk(-1) } as Record<string, () => void>)[event.key];
    if (action) { event.preventDefault(); action(); }
  }}>
    <div className="review-toolbar" role="toolbar" aria-label="변경 검토 도구">
      <button className="icon-button review-list-toggle" aria-label={showList ? '파일 목록 숨기기' : '파일 목록 보기'} aria-pressed={showList} title="파일 목록" onClick={() => { if (narrow) { setOverlay(!overlay); return; } setListOpen(!listOpen); try { localStorage.setItem('mongle.review.list', listOpen ? 'closed' : 'open'); } catch {} }}><ListTree size={15}/></button>
      <div className="diff-layouts" role="group" aria-label="비교 기준">
        <button aria-pressed={mode === 'branch'} title="이 브랜치가 기준 브랜치에서 갈라진 뒤 바뀐 전부(커밋한 것 포함)" onClick={() => onMode('branch')}>브랜치 전체</button>
        <button aria-pressed={mode === 'head'} title="마지막 커밋 이후 바뀐 것(스테이징 포함)" onClick={() => onMode('head')}>커밋 안 한 변경</button>
      </div>
      <button className="diff-toggle" aria-pressed={folding} title="바뀌지 않은 줄을 접어 변경 부분만 보기" onClick={() => { rememberCollapse('review', !folding); setFolding(!folding); }}><FoldVertical size={13}/>변경 부분만</button>
      <span className="review-base" title={review.base}>{review.mode === 'branch' ? review.baseLabel + ' 이후' : 'HEAD 이후'} · {review.base.slice(0, 7)}</span>
      <span className="review-summary">파일 {files.length}{review.truncated && '+'}개{totals.loaded > 0 && <> · <span className="diff-added">+{totals.added}</span> <span className="diff-removed">−{totals.removed}</span>{totals.loaded < files.length && <span className="review-partial" title="아직 읽지 않은 파일은 합계에 포함되지 않습니다"> (읽는 중)</span>}</>}</span>
      <span className="diff-nav">
        <span className="diff-position" role="status">{totals.chunks ? (position ? position + ' / ' + totals.chunks : '변경 ' + totals.chunks + '곳') : ''}</span>
        <button className="icon-button" aria-label="이전 변경" title="이전 변경 (p)" disabled={!order.length} onClick={() => jumpChunk(-1)}><ChevronUp size={15}/></button>
        <button className="icon-button" aria-label="다음 변경" title="다음 변경 (n)" disabled={!order.length} onClick={() => jumpChunk(1)}><ChevronDown size={15}/></button>
        <button className="icon-button" aria-label={allCollapsed ? '모든 파일 펼치기' : '모든 파일 접기'} title={allCollapsed ? '모든 파일 펼치기' : '모든 파일 접기'} disabled={!files.length} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map(file => file.path)))}>{allCollapsed ? <UnfoldVertical size={15}/> : <FoldVertical size={15}/>}</button>
      </span>
    </div>
    {review.notice && <div className="editor-notice">{review.notice}</div>}
    {review.truncated && <div className="editor-notice">변경이 많아 처음 1,000개 파일만 표시합니다. 더 작은 폴더에서 확인해 주세요.</div>}
    {!files.length ? <div className="review-empty"><strong>변경된 파일이 없습니다</strong><p>{review.mode === 'branch' ? review.baseLabel + '에서 갈라진 뒤 바뀐 내용이 없습니다.' : '마지막 커밋 이후 바뀐 내용이 없습니다.'}</p></div> :
    <div className={'review-layout' + (showList ? ' with-list' : '') + (narrow ? ' narrow' : '')}>
      {showList && <nav className="review-files" aria-label="변경 파일 목록">{files.map(file => {
        const content = contents.get(contentKey(base, file)), name = file.path.split('/').pop()!, directory = file.path.slice(0, -name.length).replace(/\/$/, '');
        return <button key={file.path} className={'review-file git-status-' + kinds[file.status] + (current.path === file.path ? ' current' : '')} title={(file.originalPath ? file.originalPath + ' → ' : '') + file.path + ' · ' + statusNames[file.status]} onClick={() => { setCollapsed(value => { const next = new Set(value); next.delete(file.path); return next; }); sections.current.get(file.path)?.scrollIntoView({ block: 'start' }); setCurrent({ path: file.path, chunk: -1 }); setOverlay(false); }}>
          <GitMarker kind={kinds[file.status]}/><span className="git-file-label"><span className="git-file-name">{name}</span>{directory && <span className="git-file-directory">{directory}</span>}</span>
          {content?.diff && !content.diff.unavailable && <span className="review-count"><span className="diff-added">+{content.added}</span> <span className="diff-removed">−{content.removed}</span></span>}
        </button>;
      })}</nav>}
      <div className="review-scroll" ref={scroller} tabIndex={-1} aria-label="모든 변경 내용">
        {files.map(file => {
          const content = contents.get(contentKey(base, file)), open = !collapsed.has(file.path);
          return <section key={file.path} className={'review-section' + (current.path === file.path ? ' current' : '')} data-path={file.path} aria-label={file.path + ' · ' + statusNames[file.status]} ref={element => { if (element) sections.current.set(file.path, element); else sections.current.delete(file.path); }}>
            <header className={'review-section-header git-status-' + kinds[file.status]}>
              <button className="review-toggle" aria-expanded={open} aria-label={(open ? '접기: ' : '펼치기: ') + file.path} onClick={() => toggle(file.path)}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
              <GitMarker kind={kinds[file.status]}/>
              <span className="review-path" title={file.path}>{file.originalPath ? <><span className="review-original">{file.originalPath}</span> → </> : null}{file.path}</span>
              {content?.diff && !content.diff.unavailable && <span className="review-count"><span className="diff-added">+{content.added}</span> <span className="diff-removed">−{content.removed}</span></span>}
              <button className="icon-button" aria-label={file.path + ' 비교 탭 열기'} title="이 파일만 비교" onClick={() => onSplit(file, base)}><GitCompareArrows size={14}/></button>
              {file.status !== 'deleted' && <button className="icon-button" aria-label={file.path + ' 파일 열기'} title="파일 열기" onClick={() => onOpenFile(file)}><FileText size={14}/></button>}
            </header>
            {open && (content?.error ? <p className="review-message" role="alert">{content.error}</p>
              : !content?.diff ? <p className="review-message review-placeholder">변경 내용을 읽는 중…</p>
              : content.diff.unavailable ? <p className="review-message">{content.diff.unavailable}</p>
              : lineEndingsOnly(content.diff) ? <p className="review-message">줄 끝 문자(CRLF/LF)만 바뀌었습니다.</p>
              : !content.chunks ? <p className="review-message">내용 차이가 없습니다.</p>
              : seen.has(file.path) ? <UnifiedDiff path={file.path} diff={content.diff} folding={folding} onView={view => {
                  if (view) { views.current.set(file.path, view); if (pending.current?.path === file.path) { const target = pending.current; pending.current = undefined; requestAnimationFrame(() => show(target.path, target.chunk)); } }
                  else views.current.delete(file.path);
                }} onSelect={chunk => setCurrent({ path: file.path, chunk })}/>
              : <p className="review-message review-placeholder" style={{ minHeight: Math.min(600, 22 * (content.added + content.removed + 7)) }}/>)}
          </section>;
        })}
      </div>
    </div>}
  </div>;
}

function UnifiedDiff({ path, diff, folding, onView, onSelect }: { path: string; diff: GitDiff; folding: boolean; onView(view: EditorView | undefined): void; onSelect(chunk: number): void }) {
  const parent = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onView, onSelect }); callbacks.current = { onView, onSelect };
  useEffect(() => {
    const view = new EditorView({ parent: parent.current!, state: EditorState.create({ doc: diff.modified ?? '', extensions: [
      lineNumbers(), highlightSpecialChars(), drawSelection(), EditorView.lineWrapping, language(path), syntaxHighlighting(highlighting), EditorState.readOnly.of(true), phrases,
      EditorView.contentAttributes.of({ 'aria-label': '변경 내용: ' + path, 'aria-readonly': 'true', spellcheck: 'false' }),
      EditorView.theme({ '&': { backgroundColor: 'var(--terminal)', color: 'var(--text)' }, ...editorThemeSpec, '.cm-content': { padding: '4px 0' } }),
      EditorView.updateListener.of(update => {
        if (!update.selectionSet || !update.view.hasFocus) return;
        const head = update.state.selection.main.head, chunks = getChunks(update.state)?.chunks || [];
        const index = chunks.findIndex(chunk => head >= chunk.fromB && head <= Math.max(chunk.fromB, chunk.endB));
        if (index >= 0) callbacks.current.onSelect(index);
      }),
      unifiedMergeView({ original: diff.original ?? '', mergeControls: false, gutter: false, highlightChanges: true, syntaxHighlightDeletions: true, ...(folding ? { collapseUnchanged: { margin: 3, minSize: 4 } } : {}) }),
    ] }) });
    callbacks.current.onView(view);
    return () => { callbacks.current.onView(undefined); view.destroy(); };
  }, [path, diff.original, diff.modified, folding]);
  return <div className="review-diff" ref={parent}/>;
}

