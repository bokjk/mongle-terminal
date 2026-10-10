import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Globe2, LoaderCircle, Monitor, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { addSavedComputer, computerOrigin, computerRows, defaultComputerName, loadSavedComputers, storeSavedComputers, type SavedComputer } from './computer-list';

type Requester = { request<T = any>(method: string, params?: unknown): Promise<T> };
type Scan = { status: 'idle' | 'loading' | 'done' | 'error'; computers: SavedComputer[]; available: boolean; message?: string; error?: string };

/** The host lists other PCs. Keep only Mongle's https *.ts.net origins even if a reply is malformed. */
function discovered(value: unknown): Pick<Scan, 'computers' | 'available' | 'message'> {
  const reply = value as { computers?: unknown; available?: unknown; message?: unknown } | null;
  const computers = (Array.isArray(reply?.computers) ? reply.computers : []).flatMap(item => {
    try {
      const origin = computerOrigin(String((item as SavedComputer).origin));
      return [{name: String((item as SavedComputer).name ?? '').trim().slice(0, 63) || defaultComputerName(origin), origin}];
    } catch { return []; }
  });
  return {computers, available: reply?.available !== false, message: typeof reply?.message === 'string' ? reply.message : undefined};
}

/**
 * Browser counterpart of the desktop HostPicker. A browser can only use the PC whose address it opened,
 * so choosing another PC opens that PC's own address, where that PC checks this device's approval.
 */
export function ComputerSwitcher({client, name, connected, navigate = url => window.location.assign(url)}: {client: Requester; name: string; connected: boolean; navigate?: (url: string) => void}) {
  const [open, setOpen] = useState(false);
  const [scan, setScan] = useState<Scan>({status: 'idle', computers: [], available: true});
  const [saved, setSaved] = useState(() => loadSavedComputers());
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [formError, setFormError] = useState('');
  const [leaving, setLeaving] = useState('');
  const sequence = useRef(0);
  const current = window.location.origin;
  const load = useCallback(async (refresh: boolean) => {
    const id = ++sequence.current;
    setScan(previous => ({...previous, status: 'loading', error: undefined}));
    try {
      const result = discovered(await client.request('computers.list', refresh ? {refresh: true} : {}));
      if (id === sequence.current) setScan({status: 'done', ...result});
    } catch (error) {
      if (id === sequence.current) setScan(previous => ({...previous, status: 'error', error: error instanceof Error ? error.message : '다른 컴퓨터를 찾지 못했습니다.'}));
    }
  }, [client]);
  useEffect(() => { if (open && connected) void load(false); }, [open, connected, load]);
  function close() { sequence.current++; setOpen(false); setAdding(false); setFormError(''); setLeaving(''); }
  function save(next: SavedComputer[]) { setSaved(next); storeSavedComputers(next); }
  function go(origin: string) { if (leaving) return; setLeaving(origin); navigate(`${origin}/`); }
  const rows = computerRows(scan.computers, saved, current);
  const found = scan.computers.filter(item => item.origin !== current).length;
  const leavingRow = rows.find(row => row.origin === leaving);
  const searching = connected && (scan.status === 'idle' || scan.status === 'loading');
  const status = leavingRow ? `${leavingRow.name} 여는 중…`
    : !connected ? '이 컴퓨터에 연결되면 같은 Tailscale의 다른 몽글 PC를 찾습니다. 직접 추가한 주소는 지금도 열 수 있습니다.'
    : searching ? '같은 Tailscale에서 다른 몽글 PC를 찾는 중…'
    : scan.status === 'error' ? scan.error || '다른 컴퓨터를 찾지 못했습니다.'
    : !scan.available ? `다른 PC를 찾지 못했습니다. ${scan.message ?? ''}`.trim()
    : found ? `다른 몽글 PC ${found}대를 찾았습니다.`
    : '다른 몽글 PC를 찾지 못했습니다. 그 PC와 몽글터미널이 켜져 있고 원격 접속이 켜져 있는지 확인하거나, 주소로 추가해 주세요.';
  return <div className="host-picker">
    <button type="button" className="host-select" aria-label="컴퓨터 전환" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span className="host-device-icon"><Monitor size={18}/></span><span className="host-label"><strong title={name}>{name}</strong><small>접속 중인 컴퓨터</small></span><ChevronDown className="host-chevron" size={15}/>
    </button>
    {open && createPortal(<Modal title="컴퓨터 전환" onClose={close}><div className="modal-body panel-list computer-switcher">
      <div className="device-row computer-current" aria-current="true"><Monitor size={20}/><span className="device-info"><strong>{name}</strong><small>지금 보는 컴퓨터 · {window.location.host}</small></span><Check size={17} aria-hidden="true"/></div>
      {rows.map(row => <div key={row.origin} className="computer-row">
        {/* aria-disabled keeps focus inside the dialog while the next page loads, so Escape still closes it. */}
        <button type="button" className="device-row" aria-label={`${row.name} 열기`} aria-disabled={Boolean(leaving)} onClick={() => go(row.origin)}>
          <Globe2 size={20}/><span className="device-info"><strong>{row.name}</strong><small>{row.saved ? '직접 추가 · ' : ''}{new URL(row.origin).host}</small></span>
          {leaving === row.origin ? <LoaderCircle size={17} className="spin" aria-hidden="true"/> : <ChevronRight size={17} aria-hidden="true"/>}
        </button>
        {row.saved && <button type="button" className="icon-button" aria-label={`${row.name} 주소 삭제`} title="주소 삭제" disabled={Boolean(leaving)} onClick={() => save(saved.filter(item => item.origin !== row.origin))}><Trash2 size={16}/></button>}
      </div>)}
      <p className="hint computer-status" role="status">{(searching || leavingRow) && <LoaderCircle size={13} className="spin" aria-hidden="true"/>}<span>{status}</span></p>
      <div className="computer-actions">
        <button type="button" className="button subtle" disabled={!connected || searching || Boolean(leaving)} onClick={() => void load(true)}><RefreshCw size={15}/>다시 찾기</button>
        {!adding && <button type="button" className="button subtle" disabled={Boolean(leaving)} onClick={() => { setAdding(true); setFormError(''); }}><Plus size={15}/>주소로 추가</button>}
      </div>
      {adding && <form className="computer-add" noValidate onSubmit={event => {
        event.preventDefault();
        try { save(addSavedComputer(saved, label, address, current)); setAdding(false); setLabel(''); setAddress(''); setFormError(''); }
        catch (error) { setFormError(error instanceof Error ? error.message : '주소를 추가하지 못했습니다.'); }
      }}>
        <label className="field"><span className="field-label">이름(선택)</span><input className="input" autoFocus maxLength={40} placeholder="회사 PC" value={label} onChange={event => setLabel(event.target.value)}/></label>
        <label className="field"><span className="field-label">몽글 접속 주소</span><input className="input" required inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://my-pc.tailnet.ts.net" value={address} onChange={event => setAddress(event.target.value)}/></label>
        <p className="hint">그 PC의 설정 → 원격 연결에 표시된 주소입니다. 추가한 주소는 이 브라우저에서 지금 컴퓨터의 화면을 열 때만 보입니다.</p>
        {formError && <p className="error-text" role="alert">{formError}</p>}
        <div className="computer-add-actions"><button type="button" className="button" onClick={() => { setAdding(false); setFormError(''); }}>취소</button><button type="submit" className="button primary">추가</button></div>
      </form>}
      <p className="hint computer-note">같은 Tailscale 계정에 연결되어 있고 몽글터미널 원격 접속이 켜진 Windows PC를 찾습니다. 처음 여는 PC에서는 그 PC의 연결 승인이 필요합니다.</p>
    </div></Modal>, document.body)}
  </div>;
}
