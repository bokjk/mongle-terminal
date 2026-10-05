import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, Copy, Eye, FileText, Folder, Maximize2, Minimize2, Pencil, RefreshCw, Save, X } from 'lucide-react';
import type { FileDocuments } from './use-file-documents';
import { dirtyDocument, isMarkdown } from './use-file-documents';
import { CodeEditor } from './CodeEditor';
import { MarkdownPreview } from './MarkdownPreview';

type Props = { files: FileDocuments; treeOpen: boolean; onToggleTree(): void; maximized: boolean; onMaximize(): void; onError(message: string): void };
export function FileEditorPanel({ files, treeOpen, onToggleTree, maximized, onMaximize, onError }: Props) {
  const [confirm, setConfirm] = useState<{ key: string; action: 'close' | 'reload' }>();
  const copy = useCallback(async (text: string, description: string) => {
    try { if (window.mongle?.writeClipboard) await window.mongle.writeClipboard(text); else await navigator.clipboard.writeText(text); onError(`${description} 복사했습니다.`); }
    catch { onError('클립보드에 복사하지 못했습니다. 내용을 선택해 복사해 주세요.'); }
  }, [onError]);
  const copyLink = useCallback((url: string) => { void copy(url, '링크 주소를'); }, [copy]);
  const doc = files.active;
  if (!files.visible || !doc) return null;
  const dirty = dirtyDocument(doc), connected = files.available(doc), editable = Boolean(doc.file?.documentId && !doc.file.readOnlyReason);
  const markdown = isMarkdown(doc.path);
  function reload() { if (dirty) setConfirm({ key: doc!.key, action: 'reload' }); else void files.load(doc!.key); }
  return <section className="file-editor-panel" aria-label="파일 편집기" onKeyDown={event => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void files.save(doc.key); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Tab') { event.preventDefault(); const index = files.documents.indexOf(doc); files.setActiveKey(files.documents[(index + (event.shiftKey ? -1 : 1) + files.documents.length) % files.documents.length].key); }
  }}>
    <header className="file-editor-tabs">
      <button className="icon-button" title={treeOpen ? '파일 목록 접기' : '파일 목록 펼치기'} aria-label={treeOpen ? '파일 목록 접기' : '파일 목록 펼치기'} aria-expanded={treeOpen} onClick={onToggleTree}><Folder size={16}/></button>
      <div className="document-tabs" role="tablist" aria-label="열린 파일" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = files.documents.indexOf(doc);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.documents.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + files.documents.length) % files.documents.length;
        files.setActiveKey(files.documents[next].key); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
      }}>{files.documents.map(item => <div className={`document-tab ${item.key === doc.key ? 'active' : ''}`} key={item.key}>
        <button role="tab" aria-label={`${item.name}${dirtyDocument(item) ? ' · 수정 중' : ''}`} aria-selected={item.key === doc.key} tabIndex={item.key === doc.key ? 0 : -1} title={item.file?.absolutePath || item.path} onClick={() => files.setActiveKey(item.key)}><FileText size={13}/><span>{item.name}</span>{dirtyDocument(item) && <span className="file-dirty" aria-hidden="true">●</span>}</button>
        <button className="document-tab-close" aria-label={`${item.name} 닫기`} disabled={item.saving || item.busy} onClick={() => dirtyDocument(item) ? setConfirm({ key: item.key, action: 'close' }) : files.close(item.key)}><X size={12}/></button>
      </div>)}</div>
      <button className="icon-button" aria-label={maximized ? '편집기 원래 크기' : '편집기 최대화'} onClick={onMaximize}>{maximized ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>
      <button className="icon-button" aria-label="편집기 숨기기" title="편집기 숨기기 · 열린 파일 유지" onClick={() => files.setVisible(false)}><X size={16}/></button>
    </header>
    <div className="file-editor-toolbar">
      <span className="editor-breadcrumb" title={doc.file?.absolutePath || doc.path}>{doc.path}</span>
      <button className="icon-button" aria-label="파일 경로 복사" disabled={!doc.file} onClick={() => void copy(doc.file!.absolutePath, '파일 경로를')}><Copy size={14}/></button>
      <button className="icon-button" aria-label="디스크 파일 다시 열기" title="디스크 파일 다시 열기" disabled={doc.busy || doc.saving || !connected} onClick={reload}><RefreshCw size={14}/></button>
      <button className="button editor-save" aria-label={doc.saving ? '저장 중' : '파일 저장'} disabled={!dirty || !editable || !connected || doc.busy || doc.saving} onClick={() => void files.save(doc.key)}><Save size={14}/>{doc.saving ? '저장 중…' : '저장'}<kbd aria-hidden="true">Ctrl S</kbd></button>
    </div>
    {markdown && <div className="markdown-modes" role="group" aria-label="마크다운 보기 방식">{([
      ['edit', '편집', Pencil], ['preview', '미리보기', Eye], ['split', '나란히 보기', Columns2],
    ] as const).map(([mode, label, Icon]) => <button key={mode} aria-pressed={doc.mode === mode} onClick={() => files.patch(doc.key, { mode })}><Icon size={13}/>{label}</button>)}</div>}
    {!connected && <div className="editor-notice">이 파일을 연 컴퓨터에 다시 연결하면 저장할 수 있습니다. 수정 내용은 유지됩니다.</div>}
    {doc.file?.readOnlyReason && <div className="editor-notice">{doc.file.readOnlyReason}</div>}
    {doc.file?.truncated && <div className="editor-notice">처음 64 KiB만 표시합니다. 전체 파일을 편집하려면 외부 편집기를 사용해 주세요.</div>}
    {(doc.error || doc.changedOnDisk) && <div className="editor-notice warning" role="alert"><span>{doc.error || '디스크의 파일이 변경되었습니다. 내 수정 내용은 유지됩니다.'}</span><button className="button subtle" onClick={() => void copy(doc.text, '내 수정 내용을')}>내 내용 복사</button><button className="button subtle" disabled={!connected || doc.busy || doc.saving} onClick={reload}>디스크 파일 다시 열기</button></div>}
    {doc.busy && <p className="file-message" role="status">파일을 읽는 중…</p>}
    <div className="document-bodies">{files.documents.map(item => <div key={item.key} role="tabpanel" aria-label={item.name} hidden={item.key !== doc.key || !item.file} className={`document-body mode-${isMarkdown(item.path) ? item.mode : 'edit'}`}>
      <div className="source-pane" hidden={isMarkdown(item.path) && item.mode === 'preview'}>
        {item.file && <CodeEditor path={item.path} value={item.text} session={item.editorSession} active={item.key === doc.key && item.mode !== 'preview'} readOnly={!item.file.documentId || Boolean(item.file.readOnlyReason) || item.busy} onChange={text => files.patch(item.key, { text })} onSave={() => void files.save(item.key)}/>}
      </div>
      {item.key === doc.key && isMarkdown(item.path) && item.mode !== 'edit' && <MarkdownPreview text={item.text} onCopyLink={copyLink}/>}
    </div>)}</div>
    <footer className="editor-status"><span>{doc.file?.encoding || '텍스트'}{doc.file?.text.includes('\r\n') ? ' · CRLF' : ' · LF'}</span><span role="status">{doc.saving ? '저장 중…' : dirty ? '저장하지 않은 변경' : doc.file ? '수정 없음' : '파일 열기'}</span><span>{doc.text.split(/\r\n|\r|\n/).length}줄</span></footer>
    {confirm && <DiscardFileDialog name={files.documents.find(item => item.key === confirm.key)?.name || '파일'} onCancel={() => setConfirm(undefined)} onDiscard={() => { if (confirm.action === 'close') files.close(confirm.key); else void files.load(confirm.key); setConfirm(undefined); }}/>}
  </section>;
}

function DiscardFileDialog({ name, onCancel, onDiscard }: { name: string; onCancel(): void; onDiscard(): void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="editor-confirm-backdrop"><div ref={panel} className="editor-confirm" role="alertdialog" aria-modal="true" aria-labelledby="file-confirm-title" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    if (event.key === 'Tab') { event.preventDefault(); const buttons = panel.current!.querySelectorAll('button'); (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus(); }
  }}>
    <h3 id="file-confirm-title">저장하지 않은 변경이 있습니다</h3><p>{name}의 수정 내용을 버릴까요?</p>
    <div><button className="button" onClick={onCancel}>계속 편집</button><button className="button danger" onClick={onDiscard}>변경 버리기</button></div>
  </div></div>, document.body);
}
