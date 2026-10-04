import { useEffect, useRef, useState } from 'react';
import { FILE_EDIT_BYTES, type FileDocument, type HostState, type Transport } from '../../../packages/protocol';
import type { EditorSession } from './CodeEditor';

export type FileReference = { id: string; hostId: string; bootId: string; generation: string; root: string };
export type OpenDocument = {
  key: string; name: string; reference: FileReference; path: string; file?: FileDocument;
  text: string; baseline: string; busy: boolean; saving: boolean; error?: string; changedOnDisk?: boolean;
  mode: 'edit' | 'preview' | 'split'; loadId: number; connectionId?: string;
  editorSession: EditorSession;
};
const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
export const isMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '파일 작업을 완료하지 못했습니다.';
export const dirtyDocument = (doc: OpenDocument) => doc.text !== doc.baseline;
function encodeText(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > FILE_EDIT_BYTES) throw new Error('저장할 내용은 UTF-8 기준 64 KiB 이하여야 합니다.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function useFileDocuments(client: Transport, state: HostState | undefined, connected: boolean, connectionId: string | undefined) {
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const current = useRef(documents);
  const [activeKey, setActiveKey] = useState('');
  const [visible, setVisible] = useState(false);
  const context = useRef({ state, connected, connectionId }); context.current = { state, connected, connectionId };
  const sequence = useRef(0);
  function update(transform: (docs: OpenDocument[]) => OpenDocument[]) { current.current = transform(current.current); setDocuments(current.current); }
  function patch(key: string, changes: Partial<OpenDocument>) { update(docs => docs.map(doc => doc.key === key ? { ...doc, ...changes } : doc)); }
  const active = documents.find(doc => doc.key === activeKey);
  const unsaved = documents.filter(dirtyDocument).length;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (current.current.some(doc => dirtyDocument(doc) || doc.saving)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const savingCount = documents.filter(doc => doc.saving).length;
  useEffect(() => { void window.mongle?.setUnsavedFiles?.(unsaved + savingCount).catch(() => {}); }, [unsaved, savingCount]);

  function available(doc: OpenDocument) { const ctx = context.current; return ctx.connected && ctx.state?.hostId === doc.reference.hostId; }
  async function load(key: string, replace = true) {
    const doc = current.current.find(item => item.key === key); if (!doc || doc.busy || doc.saving || !available(doc)) return;
    const loadId = ++sequence.current, startConnection = context.current.connectionId;
    let reference = { ...doc.reference, bootId: context.current.state!.bootId };
    if (replace) patch(key, { busy: true, error: undefined, loadId });
    try {
      let result: FileDocument;
      if (doc.file?.documentId && doc.connectionId === startConnection && doc.reference.bootId === reference.bootId) {
        result = await client.request<FileDocument>('files.reload', { hostId: doc.reference.hostId, bootId: doc.reference.bootId, documentId: doc.file.documentId });
      } else {
        const terminal = context.current.state?.terminals.find(info => normalize(info.currentCwd || info.cwd) === normalize(doc.reference.root));
        if (!terminal) throw new Error('처음 파일을 연 폴더의 터미널로 이동한 뒤 다시 열어 주세요. 편집한 내용은 유지됩니다.');
        reference = { ...reference, id: terminal.id, generation: terminal.generation };
        const editable = context.current.state?.capabilities?.includes('files.edit');
        result = await client.request<FileDocument>(editable ? 'files.open' : 'files.preview', { ...reference, path: doc.path });
        if (!editable) result.readOnlyReason = '이 컴퓨터를 업데이트하면 파일을 편집할 수 있습니다.';
      }
      const latest = current.current.find(item => item.key === key);
      if (!latest || !available(latest) || context.current.connectionId !== startConnection || (replace && latest.loadId !== loadId)) return;
      if (!replace && (latest.saving || latest.busy || latest.file?.version !== doc.file?.version)) return;
      if (replace || !dirtyDocument(latest)) patch(key, { file: result, reference, text: result.text, baseline: result.text, busy: false, error: undefined, changedOnDisk: false, connectionId: startConnection });
      else patch(key, { changedOnDisk: result.version !== latest.file?.version });
    } catch (error) {
      const latest = current.current.find(item => item.key === key);
      if (latest && (replace ? latest.loadId === loadId : !latest.busy && !latest.saving)) patch(key, { busy: false, error: errorMessage(error) });
    } finally {
      const latest = current.current.find(item => item.key === key);
      if (replace && latest?.loadId === loadId) patch(key, { busy: false });
    }
  }
  async function open(reference: FileReference, path: string) {
    const key = `${reference.hostId}:${normalize(reference.root + '/' + path)}`;
    setActiveKey(key); setVisible(true);
    if (current.current.some(doc => doc.key === key)) return;
    if (current.current.length >= 24) { const last = current.current.at(-1)!; setActiveKey(last.key); patch(last.key, { error: '파일은 최대 24개까지 열 수 있습니다. 사용하지 않는 파일 탭을 닫아 주세요.' }); return; }
    update(docs => [...docs, { key, name: path.split(/[\\/]/).at(-1) || path, path, reference, text: '', baseline: '', busy: false, saving: false, mode: isMarkdown(path) ? 'preview' : 'edit', loadId: 0, editorSession: {} }]);
    await load(key);
  }
  async function save(key: string) {
    const doc = current.current.find(item => item.key === key);
    if (!doc || !doc.file?.documentId || !doc.file.version || !available(doc) || doc.busy || doc.saving || !dirtyDocument(doc)) return;
    if (doc.connectionId !== context.current.connectionId || doc.reference.bootId !== context.current.state?.bootId) {
      patch(key, { error: '컴퓨터에 다시 연결했습니다. 내 수정 내용을 복사한 뒤 디스크 파일을 다시 열어 비교해 주세요.' }); return;
    }
    const text = doc.text;
    patch(key, { saving: true, error: undefined });
    try {
      const file = await client.request<FileDocument>('files.save', { hostId: doc.reference.hostId, bootId: doc.reference.bootId, documentId: doc.file.documentId, version: doc.file.version, contentBase64: encodeText(text) });
      // Edits typed while a save is pending remain dirty against the saved snapshot.
      patch(key, { file, baseline: text, saving: false, changedOnDisk: false });
    } catch (error) { patch(key, { saving: false, error: errorMessage(error) }); }
  }
  function close(key: string) {
    const doc = current.current.find(item => item.key === key); if (!doc || doc.saving) return;
    if (doc.file?.documentId && available(doc)) void client.request('files.close', { hostId: doc.reference.hostId, bootId: doc.reference.bootId, documentId: doc.file.documentId }).catch(() => {});
    update(docs => docs.filter(item => item.key !== key));
    if (activeKey === key) setActiveKey(current.current.at(-1)?.key || '');
    if (!current.current.length) setVisible(false);
  }
  useEffect(() => {
    if (!visible || !active?.file?.documentId || !connected) return;
    let checking = false;
    const refresh = async () => {
      const doc = current.current.find(item => item.key === activeKey);
      if (checking || document.visibilityState === 'hidden' || !doc || doc.busy || doc.saving || !available(doc) || doc.connectionId !== context.current.connectionId) return;
      checking = true; try { await load(activeKey, false); } finally { checking = false; }
    };
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [visible, activeKey, active?.file?.documentId, connected, connectionId]);
  return { documents, active, activeKey, visible, unsaved, open, load, save, close, patch, setVisible, setActiveKey, available };
}
export type FileDocuments = ReturnType<typeof useFileDocuments>;
