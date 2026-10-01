import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, FileText, Folder, GitBranch, Link, RefreshCw, X } from 'lucide-react';
import type { Transport, TerminalInfo, DirectoryListing, FileEntry, FilePreview, GitChange } from '../../../packages/protocol/index';
import { GitChanges, GitMarker, gitKind, gitLabel, useGitListing } from './GitChanges';

type Reference = { id: string; hostId: string; bootId: string; generation: string; root: string };
type Props = { client: Transport; hostId: string; bootId: string; terminal?: TerminalInfo; supported: boolean; gitSupported: boolean; connected: boolean; onClose(): void; onError(message: string): void };
const message = (error: unknown) => error instanceof Error ? error.message : '파일을 불러오지 못했습니다.';

// Expanded folders, polling and previews share the host's two-read budget.
function explorerClient(client: Transport): Transport {
  let active = 0;
  const waiting: Array<() => void> = [];
  const pump = () => { while (active < 2 && waiting.length) { active++; waiting.shift()!(); } };
  return {
    request: <T,>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {
      waiting.push(() => { void client.request<T>(method, params).then(resolve, reject).finally(() => { active--; pump(); }); }); pump();
    }),
    subscribe: listener => client.subscribe(listener), close: () => client.close(),
  };
}

export function FileExplorer(props: Props) {
  const { terminal } = props;
  const client = useMemo(() => explorerClient(props.client), [props.client]);
  const [view, setView] = useState<'files' | 'git'>(() => { try { return localStorage.getItem('mongle.files.view') === 'git' ? 'git' : 'files'; } catch { return 'files'; } });
  useEffect(() => { try { localStorage.setItem('mongle.files.view', view); } catch {} }, [view]);
  const root = terminal?.currentCwd || terminal?.cwd || '';
  const reference = useMemo(() => terminal ? { id: terminal.id, hostId: props.hostId, bootId: props.bootId, generation: terminal.generation, root } : undefined, [terminal?.id, terminal?.generation, props.hostId, props.bootId, root]);
  const [width, setWidth] = useState(() => {
    try { const value = Number(localStorage.getItem('mongle.files.width')); return Number.isFinite(value) && value >= 220 ? Math.min(560, value) : 320; } catch { return 320; }
  });
  useEffect(() => { try { localStorage.setItem('mongle.files.width', String(width)); } catch {} }, [width]);
  return <aside className="file-explorer" aria-label="파일 탐색기" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }} style={{ '--file-width': `${width}px` } as React.CSSProperties}>
    <div className="file-resizer" role="separator" aria-label="파일 탐색기 너비" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={560} aria-valuenow={width} tabIndex={0}
      onDoubleClick={() => setWidth(320)} onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setWidth(Math.max(220, Math.min(560, event.currentTarget.parentElement!.getBoundingClientRect().right - event.clientX))); }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) { event.preventDefault(); setWidth(value => event.key === 'Home' ? 320 : Math.max(220, Math.min(560, value + (event.key === 'ArrowLeft' ? 20 : -20)))); } }}/>
    {(!props.connected || !terminal || !props.supported) && <ExplorerHeading view="files" gitSupported={false} count={0} onView={setView} onClose={props.onClose}/>}
    {!props.connected ? <p className="file-message">컴퓨터에 다시 연결하면 파일을 볼 수 있습니다.</p> : !terminal ? <p className="file-message">파일을 볼 터미널을 선택하세요.</p> : !props.supported ? <p className="file-message">이 컴퓨터의 몽글터미널을 업데이트하면 파일을 볼 수 있습니다.</p> :
      <ExplorerContent key={`${props.hostId}:${props.bootId}:${terminal.id}:${terminal.generation}:${root}`} client={client} reference={reference!} title={terminal.title} reported={Boolean(terminal.currentCwd)} gitSupported={props.gitSupported} view={props.gitSupported ? view : 'files'} onView={setView} onClose={props.onClose} onError={props.onError}/>}
  </aside>;
}

function ExplorerHeading({ view, gitSupported, count, onView, onClose }: { view: 'files' | 'git'; gitSupported: boolean; count: number; onView(value: 'files' | 'git'): void; onClose(): void }) {
  return <header className="file-explorer-heading"><div className="file-view-tabs" role="tablist" aria-label="탐색기 보기" onKeyDown={event => {
    if (gitSupported && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'files' : event.key === 'End' ? 'git' : view === 'files' ? 'git' : 'files'; onView(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus(); }
  }}><button role="tab" data-view="files" aria-selected={view === 'files'} tabIndex={view === 'files' ? 0 : -1} onClick={() => onView('files')}><Folder size={15}/>파일</button>{gitSupported && <button role="tab" data-view="git" aria-selected={view === 'git'} tabIndex={view === 'git' ? 0 : -1} onClick={() => onView('git')}><GitBranch size={15}/>Git{count > 0 && <span className="git-count" aria-label={`변경 파일 ${count}개`}>{count}</span>}</button>}</div><button className="icon-button" aria-label="파일 탐색기 닫기" onClick={onClose}><X size={16}/></button></header>;
}

function ExplorerContent({ client, reference, title, reported, gitSupported, view, onView, onClose, onError }: { client: Transport; reference: Reference; title: string; reported: boolean; gitSupported: boolean; view: 'files' | 'git'; onView(value: 'files' | 'git'): void; onClose(): void; onError(message: string): void }) {
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<FilePreview>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const git = useGitListing(client, reference, gitSupported, revision);
  const changes = git.listing?.state === 'repository' ? git.listing.changes : [];
  const decorations = useMemo(() => new Map(changes.map(change => [change.path.toLowerCase(), change])), [git.listing]);
  const folderRevision = `${revision}:${JSON.stringify(changes)}`;
  useEffect(() => () => { sequence.current++; }, []);
  async function openFile(entry: FileEntry) {
    const current = ++sequence.current;
    setSelected(entry.path); setPreview(undefined); setError(''); setBusy(true);
    try { const result = await client.request<FilePreview>('files.preview', { ...reference, path: entry.path }); if (sequence.current === current) setPreview(result); }
    catch (error) { if (sequence.current === current) setError(message(error)); }
    finally { if (sequence.current === current) setBusy(false); }
  }
  function refresh() { sequence.current++; setPreview(undefined); setSelected(''); setError(''); setBusy(false); setRevision(value => value + 1); }
  function openChange(change: GitChange) {
    if (!change.untracked && (change.worktree === 'D' || change.index === 'D')) { sequence.current++; setSelected(change.path); setPreview(undefined); setBusy(false); setError('삭제된 파일입니다. 작업 폴더에 미리 볼 내용이 없습니다.'); return; }
    void openFile({ name: change.path.split('/').pop()!, path: change.path, kind: 'file' });
  }
  async function copy(value: string) {
    try { if (window.mongle?.writeClipboard) await window.mongle.writeClipboard(value); else await navigator.clipboard.writeText(value); }
    catch { onError('경로를 복사하지 못했습니다. 클립보드 권한을 확인해 주세요.'); }
  }
  return <>
    <ExplorerHeading view={view} gitSupported={gitSupported} count={changes.length} onView={onView} onClose={onClose}/>
    <div className="file-context"><span className="file-terminal-name" title={title}>{title}</span><span className="file-root" title={reference.root}>{reference.root}</span><span className="hint">{reported ? '선택한 터미널의 현재 폴더' : '셸 경로 보고 없음 · 시작 폴더'}</span></div>
    <div className="file-actions"><button className="button subtle" aria-busy={git.busy} onClick={refresh}><RefreshCw size={14}/>새로고침</button><button className="icon-button" aria-label="현재 폴더 경로 복사" title="현재 폴더 경로 복사" onClick={() => void copy(reference.root)}><Copy size={14}/></button></div>
    <div className="file-tree" role="tabpanel" aria-label={view === 'files' ? '폴더 트리' : 'Git 변경 파일'}>
      <div hidden={view !== 'files'}><FolderContents client={client} reference={reference} directory="" revision={folderRevision} decorations={decorations} selected={selected} onFile={entry => void openFile(entry)}/></div>
      {view === 'git' && <GitChanges listing={git.listing} error={git.error} selected={selected} onFile={openChange} onRetry={refresh}/>}
      {view === 'files' && git.error && <p className="file-message">Git 상태 표시를 갱신하지 못했습니다. 새로고침해 주세요.</p>}
    </div>
    {selected && <section className="file-preview" aria-label="파일 미리보기"><header><span title={selected}>{selected}</span>{preview && <button className="icon-button" aria-label="파일 경로 복사" onClick={() => void copy(preview.absolutePath)}><Copy size={14}/></button>}<button className="icon-button" aria-label="미리보기 닫기" onClick={() => { sequence.current++; setSelected(''); setPreview(undefined); setBusy(false); setError(''); }}><X size={14}/></button></header>
      {busy ? <p className="file-message" role="status">파일을 읽는 중…</p> : error ? <p className="file-message error-text" role="alert">{error}</p> : preview && <><div className="file-preview-meta">현재 파일 · 읽기 전용 · {preview.encoding}{preview.truncated && ' · 처음 64 KiB만 표시'}</div><pre tabIndex={0}>{preview.text || '(빈 파일)'}</pre></>}
    </section>}
  </>;
}

type TreeProps = { client: Transport; reference: Reference; revision: string; decorations: Map<string, GitChange>; selected: string; onFile(entry: FileEntry): void };
function FolderContents({ client, reference, directory, revision, decorations, selected, onFile }: TreeProps & { directory: string }) {
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setError('');
    void client.request<DirectoryListing>('files.list', { ...reference, path: directory }).then(result => { if (active) setListing(result); }, error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [client, reference, directory, attempt, revision]);
  if (error) return <div className="file-message" role="alert">{error}<button className="button subtle" onClick={() => setAttempt(value => value + 1)}>다시 시도</button></div>;
  if (!listing) return <p className="file-message" role="status">폴더를 읽는 중…</p>;
  return <><ul className="file-entries">{listing.entries.map(entry => <FileRow key={entry.path} entry={entry} client={client} reference={reference} revision={revision} decorations={decorations} selected={selected} onFile={onFile}/>)}</ul>{listing.entries.length === 0 && <p className="file-message">빈 폴더입니다.</p>}{listing.truncated && <p className="file-message">항목이 많아 최대 500개만 표시합니다.</p>}</>;
}

function FileRow({ entry, client, reference, revision, decorations, selected, onFile }: TreeProps & { entry: FileEntry }) {
  const [expanded, setExpanded] = useState(false);
  const folder = entry.kind === 'directory';
  const disabled = entry.kind === 'link' || entry.kind === 'other';
  const normalized = entry.path.replace(/\\/g, '/').toLowerCase(), change = decorations.get(normalized), kind = change && gitKind(change);
  const containsChanges = folder && [...decorations.keys()].some(value => value.startsWith(normalized + '/'));
  const status = kind ? gitLabel(kind) : containsChanges ? '변경된 파일 포함' : '';
  const descriptionId = useId();
  return <li><button className={`file-entry ${kind ? `has-git-change git-status-${kind}` : ''} ${selected.replace(/\\/g, '/') === entry.path.replace(/\\/g, '/') ? 'selected' : ''}`} aria-label={entry.name} aria-describedby={status ? descriptionId : undefined} title={disabled ? `${entry.name} · 링크 또는 특수 파일은 열 수 없습니다` : `${entry.name}${status ? ` · ${status}` : ''}`} disabled={disabled} aria-expanded={folder ? expanded : undefined} onClick={() => folder ? setExpanded(value => !value) : onFile(entry)}>
    {folder ? expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span className="file-indent"/>}{folder ? <Folder size={15}/> : disabled ? <Link size={15}/> : <FileText size={15}/>}<span className="file-entry-name">{entry.name}</span>{kind ? <GitMarker kind={kind}/> : containsChanges ? <span className="git-folder-dot" aria-hidden="true"/> : null}{status && <span id={descriptionId} className="sr-only">{status}</span>}
  </button>{folder && expanded && <div className="file-children"><FolderContents client={client} reference={reference} directory={entry.path} revision={revision} decorations={decorations} selected={selected} onFile={onFile}/></div>}</li>;
}
