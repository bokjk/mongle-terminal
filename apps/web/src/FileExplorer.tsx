import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, FileText, Folder, Link, RefreshCw, X } from 'lucide-react';
import type { Transport, TerminalInfo, DirectoryListing, FileEntry, FilePreview } from '../../../packages/protocol/index';

type Reference = { id: string; hostId: string; bootId: string; generation: string; root: string };
type Props = { client: Transport; hostId: string; bootId: string; terminal?: TerminalInfo; supported: boolean; connected: boolean; onClose(): void; onError(message: string): void };
const message = (error: unknown) => error instanceof Error ? error.message : '파일을 불러오지 못했습니다.';

export function FileExplorer(props: Props) {
  const { terminal } = props;
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
    <header className="file-explorer-heading"><Folder size={16}/><strong>파일</strong><button className="icon-button" aria-label="파일 탐색기 닫기" onClick={props.onClose}><X size={16}/></button></header>
    {!props.connected ? <p className="file-message">컴퓨터에 다시 연결하면 파일을 볼 수 있습니다.</p> : !terminal ? <p className="file-message">파일을 볼 터미널을 선택하세요.</p> : !props.supported ? <p className="file-message">이 컴퓨터의 몽글터미널을 업데이트하면 파일을 볼 수 있습니다.</p> :
      <ExplorerContent key={`${props.hostId}:${props.bootId}:${terminal.id}:${terminal.generation}:${root}`} client={props.client} reference={reference!} title={terminal.title} reported={Boolean(terminal.currentCwd)} onError={props.onError}/>}
  </aside>;
}

function ExplorerContent({ client, reference, title, reported, onError }: { client: Transport; reference: Reference; title: string; reported: boolean; onError(message: string): void }) {
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<FilePreview>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  async function openFile(entry: FileEntry) {
    const current = ++sequence.current;
    setSelected(entry.path); setPreview(undefined); setError(''); setBusy(true);
    try { const result = await client.request<FilePreview>('files.preview', { ...reference, path: entry.path }); if (sequence.current === current) setPreview(result); }
    catch (error) { if (sequence.current === current) setError(message(error)); }
    finally { if (sequence.current === current) setBusy(false); }
  }
  function refresh() { sequence.current++; setPreview(undefined); setSelected(''); setError(''); setBusy(false); setRevision(value => value + 1); }
  async function copy(value: string) {
    try { if (window.mongle?.writeClipboard) await window.mongle.writeClipboard(value); else await navigator.clipboard.writeText(value); }
    catch { onError('경로를 복사하지 못했습니다. 클립보드 권한을 확인해 주세요.'); }
  }
  return <>
    <div className="file-context"><span className="file-terminal-name" title={title}>{title}</span><span className="file-root" title={reference.root}>{reference.root}</span><span className="hint">{reported ? '선택한 터미널의 현재 폴더' : '셸 경로 보고 없음 · 시작 폴더'}</span></div>
    <div className="file-actions"><button className="button subtle" onClick={refresh}><RefreshCw size={14}/>새로고침</button><button className="icon-button" aria-label="현재 폴더 경로 복사" title="현재 폴더 경로 복사" onClick={() => void copy(reference.root)}><Copy size={14}/></button></div>
    <div className="file-tree" aria-label="폴더 트리"><FolderContents key={revision} client={client} reference={reference} directory="" selected={selected} onFile={entry => void openFile(entry)}/></div>
    {selected && <section className="file-preview" aria-label="파일 미리보기"><header><span title={selected}>{selected}</span>{preview && <button className="icon-button" aria-label="파일 경로 복사" onClick={() => void copy(preview.absolutePath)}><Copy size={14}/></button>}<button className="icon-button" aria-label="미리보기 닫기" onClick={() => { sequence.current++; setSelected(''); setPreview(undefined); setBusy(false); setError(''); }}><X size={14}/></button></header>
      {busy ? <p className="file-message" role="status">파일을 읽는 중…</p> : error ? <p className="file-message error-text" role="alert">{error}</p> : preview && <><div className="file-preview-meta">읽기 전용 · {preview.encoding}{preview.truncated && ' · 처음 64 KiB만 표시'}</div><pre tabIndex={0}>{preview.text || '(빈 파일)'}</pre></>}
    </section>}
  </>;
}

function FolderContents({ client, reference, directory, selected, onFile }: { client: Transport; reference: Reference; directory: string; selected: string; onFile(entry: FileEntry): void }) {
  const [listing, setListing] = useState<DirectoryListing>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true; setListing(undefined); setError('');
    void client.request<DirectoryListing>('files.list', { ...reference, path: directory }).then(result => { if (active) setListing(result); }, error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [client, reference, directory, attempt]);
  if (error) return <div className="file-message" role="alert">{error}<button className="button subtle" onClick={() => setAttempt(value => value + 1)}>다시 시도</button></div>;
  if (!listing) return <p className="file-message" role="status">폴더를 읽는 중…</p>;
  return <><ul className="file-entries">{listing.entries.map(entry => <FileRow key={entry.path} entry={entry} client={client} reference={reference} selected={selected} onFile={onFile}/>)}</ul>{listing.entries.length === 0 && <p className="file-message">빈 폴더입니다.</p>}{listing.truncated && <p className="file-message">항목이 많아 최대 500개만 표시합니다.</p>}</>;
}

function FileRow({ entry, client, reference, selected, onFile }: { entry: FileEntry; client: Transport; reference: Reference; selected: string; onFile(entry: FileEntry): void }) {
  const [expanded, setExpanded] = useState(false);
  const folder = entry.kind === 'directory';
  const disabled = entry.kind === 'link' || entry.kind === 'other';
  return <li><button className={`file-entry ${selected === entry.path ? 'selected' : ''}`} title={disabled ? `${entry.name} · 링크 또는 특수 파일은 열 수 없습니다` : entry.name} disabled={disabled} aria-expanded={folder ? expanded : undefined} onClick={() => folder ? setExpanded(value => !value) : onFile(entry)}>
    {folder ? expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/> : <span className="file-indent"/>}{folder ? <Folder size={15}/> : disabled ? <Link size={15}/> : <FileText size={15}/>}<span>{entry.name}</span>
  </button>{folder && expanded && <div className="file-children"><FolderContents client={client} reference={reference} directory={entry.path} selected={selected} onFile={onFile}/></div>}</li>;
}
