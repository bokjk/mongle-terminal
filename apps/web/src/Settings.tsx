import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Download, HelpCircle, LoaderCircle, Monitor, Moon, Palette, RefreshCw, Shield, Sun, Trash2, Upload, X } from 'lucide-react';
import type { AppClient } from '../../../packages/client/index';
import type { HostState } from '../../../packages/protocol/index';
import { UpdateSettings } from './UpdateSettings';
import { RemoteAccessQr } from './RemoteAccessQr';
import { TOUCH_SCROLL_SPEEDS, touchScrollSpeed } from '../../../packages/terminal/touch-scrollback';

type Tab = 'appearance' | 'host' | 'remote' | 'updates' | 'help';
export type SettingsTab = Tab;
type RemoteStatus = { origin?: string | null; enabled: boolean; loopbackUrl?: string };
type Diagnosis = { installed: boolean; connected: boolean; dnsName?: string; origin?: string; serveEnabled?: boolean; message?: string };
type PairingRequest = { requestId: string; name: string; status: string; createdAt: string | number; expiresAt: string | number };
type Device = { deviceId: string; name: string; origin?: string; createdAt: string | number; expiresAt?: string | number; revoked: boolean; approvedBy?: string };
type PairingCode = { code: string; expiresAt: string | number; serverTime?: number };
type SettingsBackup = { version: 1; name: string; recordHistory: boolean; groups: { name: string; cwd: string; profileId: string }[] };
const SETTINGS_FILE_LIMIT = 96 * 1024;

function parseBackup(value: unknown): SettingsBackup {
  const object = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  const text = (item: unknown, max: number, required = false): item is string => typeof item === 'string' && item.length <= max && (!required || item.trim().length > 0);
  if (!object(value) || value.version !== 1 || !text(value.name, 100, true) || typeof value.recordHistory !== 'boolean' || !Array.isArray(value.groups) || value.groups.length > 100 || Object.keys(value).some(key => !['version', 'name', 'recordHistory', 'groups'].includes(key))) throw new Error('지원하는 몽글터미널 설정 파일(버전 1)을 선택해 주세요.');
  const groups = value.groups.map(group => {
    if (!object(group) || !text(group.name, 100, true) || !text(group.cwd, 4096) || !text(group.profileId, 300, true) || Object.keys(group).some(key => !['name', 'cwd', 'profileId'].includes(key))) throw new Error('설정 파일의 그룹 이름, 폴더 또는 셸 정보가 올바르지 않습니다.');
    return { name: group.name, cwd: group.cwd, profileId: group.profileId };
  });
  return { version: 1, name: value.name, recordHistory: value.recordHistory, groups };
}

export interface SettingsProps {
  client: AppClient;
  state: HostState;
  owner: boolean;
  theme: 'dark' | 'light';
  fontSize: number;
  scrollSpeed: number;
  onScrollSpeed: (value: number) => void;
  refreshBlocked?: boolean;
  /** Tab shown first, e.g. 'updates' when opened from the sidebar update notice. */
  initialTab?: Tab;
  onTheme: (value: 'dark' | 'light') => void;
  onFontSize: (value: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

const tabs = [
  { id: 'appearance' as const, label: '화면', Icon: Palette },
  { id: 'host' as const, label: '컴퓨터', Icon: Monitor },
  { id: 'remote' as const, label: '원격 연결', Icon: Shield },
  { id: 'updates' as const, label: '앱 업데이트', Icon: Download },
  { id: 'help' as const, label: '도움말', Icon: HelpCircle },
];
function dateLabel(value?: string | number) {
  if (value === undefined) return '기간 제한 없음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR');
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '요청을 완료하지 못했습니다.'; }
function hasExpired(value: string | number, now: number) { const end = new Date(value).getTime(); return !Number.isNaN(end) && end <= now; }
/** Pairing codes last minutes, so show the time left rather than a clock time. */
function remainingLabel(value: string | number, now: number) {
  const end = new Date(value).getTime();
  if (Number.isNaN(end)) return `만료 ${dateLabel(value)}`;
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 남음`;
}
/** Expiry times use the host clock. Keep the host-minus-device offset so a phone whose clock runs fast does not hide a valid code or request. */
function hostClockOffset(serverTime: unknown, sentAt: number, receivedAt: number, previous: number) {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return previous;
  const offset = serverTime - (sentAt + receivedAt) / 2;
  // Ignore network jitter so the countdown does not skip seconds.
  return Math.abs(offset - previous) > 1000 ? offset : previous;
}

export function Settings({ client, state, owner, theme, fontSize, scrollSpeed, onScrollSpeed, refreshBlocked = false, initialTab = 'appearance', onTheme, onFontSize, onClose, onError }: SettingsProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [name, setName] = useState(state.settings.name);
  const [recordHistory, setRecordHistory] = useState(state.settings.recordHistory);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [origin, setOrigin] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const [devices, setDevices] = useState<Device[]>([]);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [shutdownConfirm, setShutdownConfirm] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [importPreview, setImportPreview] = useState<SettingsBackup | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onClose, onError });
  const mounted = useRef(true);
  callbacks.current = { onClose, onError };
  const id = useId();
  // Older hosts reject remote approval, so a paired device shows the controls only when the host advertises them.
  const remoteApproval = owner || state.capabilities?.includes('pairing.remote-approve') === true;
  const hostNow = now + clockOffset;
  const pending = requests.filter(request => request.status === 'pending' && !hasExpired(request.expiresAt, hostNow));
  const codeLive = pairing !== null && !hasExpired(pairing.expiresAt, hostNow);
  const ticking = tab === 'remote' && (codeLive || pending.length > 0);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); return; }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || []).filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { mounted.current = false; document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (tab !== 'remote' || !remoteApproval) return;
    let active = true;
    let polling = false;
    let failing = false;
    const report = (failure: unknown) => { if (active) { const message = errorMessage(failure); setError(message); callbacks.current.onError(message); } };
    if (owner) void Promise.all([
      client.request<RemoteStatus>('remote.status').then(value => { if (active) { setRemote(value); setOrigin(value.origin || ''); } }).catch(report),
      client.request<{ devices: Device[] }>('devices.list').then(value => { if (active) setDevices(value.devices); }).catch(report),
    ]);
    const poll = async () => {
      if (polling || !active) return;
      polling = true;
      try {
        const sentAt = Date.now();
        const result = await client.request<{ requests: PairingRequest[]; serverTime?: number }>('pairing.list');
        const receivedAt = Date.now();
        if (active) { setRequests(result.requests); setClockOffset(previous => hostClockOffset(result.serverTime, sentAt, receivedAt, previous)); }
        failing = false;
      }
      // A phone on a weak connection would otherwise report the same failure every three seconds.
      catch (failure) { if (!failing) report(failure); failing = true; }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [tab, owner, remoteApproval, client]);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  async function run(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key); setError(''); setNotice('');
    try { await action(); }
    catch (failure) { const message = errorMessage(failure); if (mounted.current) setError(message); callbacks.current.onError(message); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function refreshRemote() {
    const value = await client.request<RemoteStatus>('remote.status');
    if (mounted.current) { setRemote(value); setOrigin(value.origin || ''); }
  }
  async function refreshDevices() {
    const value = await client.request<{ devices: Device[] }>('devices.list');
    if (mounted.current) setDevices(value.devices);
  }
  async function copy(value: string) {
    if (!window.mongle?.writeClipboard && !navigator.clipboard) throw new Error('이 환경에서는 복사를 지원하지 않습니다. 주소나 코드를 직접 선택해 복사해 주세요.');
    try {
      if (window.mongle?.writeClipboard) await window.mongle.writeClipboard(value);
      else await navigator.clipboard.writeText(value);
    } catch { throw new Error('복사하지 못했습니다. 주소나 코드를 직접 선택해 복사해 주세요.'); }
    if (mounted.current) setNotice('복사했습니다.');
  }
  async function exportSettings() {
    const config = await client.request<SettingsBackup>('settings.export', {});
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `mongle-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (mounted.current) setNotice('설정 파일 다운로드를 시작했습니다.');
  }
  async function previewSettings(file: File) {
    setImportPreview(null); setImportWarnings([]);
    if (file.size > SETTINGS_FILE_LIMIT) throw new Error('설정 파일은 96KiB 이하여야 합니다.');
    const data = await file.text();
    if (new TextEncoder().encode(data).byteLength > SETTINGS_FILE_LIMIT) throw new Error('설정 파일은 96KiB 이하여야 합니다.');
    let parsed: unknown;
    try { parsed = JSON.parse(data.replace(/^\uFEFF/, '')); }
    catch { throw new Error('올바른 JSON 설정 파일을 선택해 주세요.'); }
    const config = parseBackup(parsed);
    if (config.groups.length + state.groups.length > 100) throw new Error('가져올 그룹과 기존 그룹의 합계는 100개 이하여야 합니다.');
    if (mounted.current) setImportPreview(config);
  }
  const activeDevices = devices.filter(device => !device.revoked);
  // Shared by the PC and by paired devices. Like an app's connection request screen, it names the requester and states what approval grants.
  const pairingSection = <div className="settings-section"><h3 className="settings-title">새 기기 연결</h3>
    <p className="settings-description">{owner ? '코드는 접속할 기기에만 알려 주세요. 코드를 입력한 기기는 이 화면이나 이미 연결된 기기에서 승인해야 연결됩니다.' : `이 기기에서 ${state.name}의 연결 코드를 만들고, 코드를 입력한 기기를 승인할 수 있습니다. 코드는 접속할 기기에만 알려 주세요.`}</p>
    <button type="button" className="button subtle" disabled={!!busy || (owner && !remote?.enabled)} onClick={() => void run('pair', async () => { const sentAt = Date.now(); const value = await client.request<PairingCode>('pairing.create', {}); const receivedAt = Date.now(); if (mounted.current) { setPairing(value); setClockOffset(previous => hostClockOffset(value.serverTime, sentAt, receivedAt, previous)); setNow(receivedAt); } })}>{pairing ? '새 코드 만들기' : '연결 코드 만들기'}</button>
    {pairing && (codeLive ? <><div className="form-row"><code className="code-box" style={{ fontSize: 24, letterSpacing: '0.18em' }}>{pairing.code}</code><button type="button" className="icon-button" aria-label="연결 코드 복사" disabled={!!busy} onClick={() => void run('copy-code', () => copy(pairing.code))}><Copy size={16} /></button></div><p className="hint">{remainingLabel(pairing.expiresAt, hostNow)} · 한 번만 쓸 수 있습니다.</p></> : <p className="hint">코드가 만료되었습니다. 새 코드를 만들어 주세요.</p>)}
    <div className="pairing-requests"><p className="hint">승인한 기기는 {state.name}의 터미널에서 명령을 실행할 수 있습니다. 직접 요청한 기기인지 이름을 확인한 뒤 승인하세요.</p>
    {pending.length === 0 ? <p className="hint">승인 대기 중인 기기가 없습니다.</p> : pending.map(request => <div className="device-row" key={request.requestId}><div className="device-info"><strong>{request.name}</strong><p className="hint">연결 요청 · {remainingLabel(request.expiresAt, hostNow)}</p></div><div className="form-row pairing-actions"><button type="button" className="button primary" aria-label={`${request.name} 연결 승인`} disabled={!!busy} onClick={() => void run(`approve-${request.requestId}`, async () => { await client.request('pairing.approve', { requestId: request.requestId }); if (mounted.current) { setRequests(items => items.filter(item => item.requestId !== request.requestId)); setNotice(`${request.name}의 연결을 승인했습니다.`); } if (owner) await refreshDevices(); })}>승인</button><button type="button" className="button subtle" aria-label={`${request.name} 연결 거절`} disabled={!!busy} onClick={() => void run(`reject-${request.requestId}`, async () => { await client.request('pairing.reject', { requestId: request.requestId }); if (mounted.current) { setRequests(items => items.filter(item => item.requestId !== request.requestId)); setNotice(`${request.name}의 연결 요청을 거절했습니다.`); } })}>거절</button></div></div>)}</div>
  </div>;

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal wide" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <header className="modal-header"><h2 id={`${id}-title`}>설정</h2><button ref={closeRef} type="button" className="icon-button" aria-label="설정 닫기" onClick={onClose}><X size={18} /></button></header>
      <div className="modal-body settings-layout">
        <nav className="settings-tabs" role="tablist" aria-label="설정 분류" aria-orientation="vertical">
          {tabs.map(({ id: tabId, label, Icon }, index) => <button key={tabId} type="button" id={`${id}-tab-${tabId}`} role="tab" aria-selected={tab === tabId} aria-controls={`${id}-panel-${tabId}`} tabIndex={tab === tabId ? 0 : -1} className={`settings-tab ${tab === tabId ? 'active' : ''}`} onClick={() => { setTab(tabId); setError(''); setNotice(''); }} onKeyDown={event => {
            let next: number | undefined;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = tabs.length - 1;
            if (next !== undefined) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus(); }
          }}><Icon size={17} />{label}</button>)}
        </nav>
        <section className="settings-content" role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
          {tab === 'appearance' && <>
            <div className="settings-section"><h3 className="settings-title">편안한 작업 화면</h3><p className="settings-description">이 기기에서 사용할 테마와 터미널 글자 크기를 정합니다. 변경하면 바로 적용됩니다.</p>
              <div className="setting-row"><div className="setting-label">테마</div><div className="form-row" role="group" aria-label="화면 테마"><button type="button" className={`button ${theme === 'dark' ? 'primary' : 'subtle'}`} aria-pressed={theme === 'dark'} onClick={() => onTheme('dark')}><Moon size={16} />어둡게</button><button type="button" className={`button ${theme === 'light' ? 'primary' : 'subtle'}`} aria-pressed={theme === 'light'} onClick={() => onTheme('light')}><Sun size={16} />밝게</button></div></div>
              <div className="setting-row"><label className="setting-label" htmlFor={`${id}-font`}>터미널 글자 크기</label><select id={`${id}-font`} className="input" value={fontSize} onChange={event => onFontSize(Number(event.target.value))}>{Array.from({length:15},(_,index)=>index+10).map(value => <option value={value} key={value}>{value}px</option>)}</select></div>
              <div className="code-box" style={{ fontSize }} aria-label="터미널 글꼴 미리 보기">PS C:\Projects\mongle&gt; 안녕하세요, 몽글터미널</div>
            </div>
            <div className="settings-section">
              <h3 className="settings-title">모바일 스크롤</h3>
              <p className="settings-description" id={`${id}-scroll-help`}>한 번에 너무 많이 이동하면 속도를 낮춰 주세요. 이 기기에 저장되며 다음 스와이프부터 적용됩니다. 마우스 휠 속도는 바뀌지 않습니다.</p>
              <div className="setting-row"><label className="setting-label" htmlFor={`${id}-scroll`}>모바일 스크롤 속도</label><select id={`${id}-scroll`} className="input" aria-describedby={`${id}-scroll-help`} value={scrollSpeed} onChange={event => onScrollSpeed(touchScrollSpeed(Number(event.target.value)))}>{TOUCH_SCROLL_SPEEDS.map(value => <option key={value} value={value}>{value}배{value === 0.5 ? ' (기본)' : ''}</option>)}</select></div>
              <p className="hint">천천히 밀면 손가락을 따라가고, 빠르게 넘기면 짧게 감속합니다. 다시 터치하면 멈춥니다. Claude·Codex에서는 프로그램에 따라 이동하는 줄 수가 다를 수 있습니다.</p>
            </div>
          </>}
          {tab === 'host' && <div className="settings-section"><h3 className="settings-title">{state.name}</h3><p className="settings-description">이 컴퓨터의 이름과 기록 보관 방식을 설정합니다.</p>
            {!owner && <p className="hint">컴퓨터 설정은 해당 컴퓨터의 몽글터미널 앱에서 변경할 수 있습니다.</p>}
            <form onSubmit={event => { event.preventDefault(); void run('host', async () => { await client.request('settings.update', { name: name.trim(), recordHistory }); if (mounted.current) setNotice('컴퓨터 설정을 저장했습니다.'); }); }}>
              <label className="field" htmlFor={`${id}-name`}><span className="field-label">컴퓨터 이름</span><input className="input" id={`${id}-name`} value={name} maxLength={80} required disabled={!owner || !!busy} onChange={event => setName(event.target.value)} /></label>
              <div className="setting-row"><label className="setting-label" htmlFor={`${id}-history`}>터미널 기록 보관<p className="hint">재시작 후 이전 출력을 볼 수 있도록 이 컴퓨터에 기록합니다. 출력에 포함된 비밀번호나 토큰도 남을 수 있습니다.</p></label><input id={`${id}-history`} type="checkbox" checked={recordHistory} disabled={!owner || !!busy} onChange={event => setRecordHistory(event.target.checked)} /></div>
              <p className="hint">기록 보관을 끄고 저장하면 기존에 보관한 터미널 출력도 삭제합니다. 실행 중인 터미널 작업은 계속됩니다.</p>
              <button type="submit" className="button primary" disabled={!owner || !!busy || !name.trim()}>{busy === 'host' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}변경 저장</button>
            </form>
            {owner && <div className="settings-section"><h3 className="settings-title">설정 내보내기와 가져오기</h3><p className="settings-description">컴퓨터 이름·기록 설정과 그룹의 이름·폴더·셸 정보를 JSON 파일로 보관합니다. 터미널 출력, 실행 중인 작업, 기기 인증 정보는 포함하지 않습니다.</p>
              <div className="form-row"><button type="button" className="button subtle" disabled={!!busy} onClick={() => void run('export', exportSettings)}><Download size={16} />설정 내보내기</button><button type="button" className="button subtle" disabled={!!busy} onClick={() => importRef.current?.click()}><Upload size={16} />설정 가져오기</button><input type="file" ref={importRef} accept=".json,application/json" hidden aria-label="가져올 설정 파일" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run('preview-import', () => previewSettings(file)); }} /></div>
              {importPreview && <div className="code-box"><p><strong>{importPreview.name}</strong>에서 내보낸 그룹 {importPreview.groups.length}개</p><p className="hint">현재 컴퓨터 이름, 기록 정책과 기존 그룹을 유지하고 빈 그룹만 추가합니다. 셸이나 명령을 실행하지 않습니다. 없는 셸이나 폴더는 이 컴퓨터의 기본값으로 바뀝니다.</p><div className="form-row"><button type="button" className="button primary" disabled={!!busy || importPreview.groups.length === 0} onClick={() => void run('import', async () => { const result = await client.request<{ importedGroups: number; warnings: string[] }>('settings.import', { config: importPreview, confirmed: true }); if (mounted.current) { setImportPreview(null); setImportWarnings(result.warnings); setNotice(`빈 그룹 ${result.importedGroups}개를 추가했습니다.`); } })}>빈 그룹 {importPreview.groups.length}개 추가</button><button type="button" className="button subtle" disabled={!!busy} onClick={() => setImportPreview(null)}>취소</button></div></div>}
              {importWarnings.length > 0 && <details className="hint"><summary>가져오면서 변경된 항목 {importWarnings.length}개</summary><ul>{importWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            </div>}
            {owner && <div className="settings-section"><h3 className="settings-title">백그라운드 실행 종료</h3><p className="settings-description">앱 창만 닫으면 터미널 작업은 계속됩니다. 아래에서 실행부를 종료하면 이 컴퓨터의 모든 터미널 작업이 중단되고 원격 연결도 끊어집니다.</p><p className="hint">현재 실행 중인 터미널: {state.terminals.filter(terminal => terminal.status === 'running').length}개</p>{shutdownConfirm ? <div><p className="error-text" role="alert">실행 중인 모든 작업을 중단할까요? 프로세스와 저장하지 않은 작업은 복원할 수 없습니다.</p><div className="form-row"><button type="button" className="button danger" disabled={!!busy} onClick={() => void run('shutdown', async () => { await client.request('host.shutdown', {}); if (mounted.current) onClose(); })}>{busy === 'shutdown' && <LoaderCircle size={16} className="spin" />}모든 작업 중단 후 종료</button><button type="button" className="button subtle" disabled={!!busy} onClick={() => setShutdownConfirm(false)}>취소</button></div></div> : <button type="button" className="button danger" disabled={!!busy} onClick={() => setShutdownConfirm(true)}>백그라운드 실행 종료…</button>}</div>}
          </div>}
          {tab === 'remote' && (!owner ? <>{remoteApproval && pairingSection}<div className="settings-section"><h3 className="settings-title">{remoteApproval ? '이 기기의 연결' : '원격 연결 관리'}</h3><p className="settings-description">{remoteApproval ? '원격 접속 켜기·끄기와 연결한 기기 해제는 접속 대상 컴퓨터의 몽글터미널 앱에서 합니다.' : '원격 연결 설정과 기기 승인은 접속 대상 컴퓨터의 몽글터미널 앱에서 관리합니다.'}</p><p className="hint">현재 이 컴퓨터의 터미널에 원격으로 접속해 있습니다.</p>{logoutConfirm ? <div><p className="hint">이 기기의 접속 권한을 해제할까요? 다시 접속하려면 {remoteApproval ? '대상 컴퓨터나 연결된 다른 기기' : '대상 컴퓨터'}에서 승인이 필요합니다. 터미널 작업은 계속됩니다.</p><div className="form-row"><button type="button" className="button danger" disabled={!!busy} onClick={() => void run('logout', async () => { await client.request('auth.logout', {}); if (mounted.current) onClose(); })}>접속 권한 해제</button><button type="button" className="button subtle" disabled={!!busy} onClick={() => setLogoutConfirm(false)}>취소</button></div></div> : <button type="button" className="button subtle" disabled={!!busy} onClick={() => setLogoutConfirm(true)}>이 기기 연결 해제</button>}</div></> : <>
            <div className="settings-section"><h3 className="settings-title">다른 기기에서 이어 하기</h3><p className="settings-description">이 컴퓨터와 접속할 기기에 Tailscale을 설치하고 같은 네트워크에 연결해 주세요. 모바일에서는 Tailscale 앱과 웹 브라우저를 사용합니다.</p>
              <ol className="hint"><li>두 기기에 Tailscale을 설치하고 같은 계정으로 로그인합니다.</li><li>아래에서 연결을 확인하고 원격 접속을 켭니다.</li><li>휴대폰으로 QR 코드를 스캔하거나 접속 주소를 열고 연결 코드를 입력합니다.</li><li>이 화면이나 이미 연결된 기기의 설정에서 기기 이름을 확인한 뒤 승인합니다.</li></ol>
              <div className="form-row"><button type="button" className="button subtle" disabled={!!busy} onClick={() => void run('diagnose', async () => { const value = await client.request<Diagnosis>('remote.diagnose'); if (mounted.current) setDiagnosis(value); await refreshRemote(); })}><RefreshCw size={16} className={busy === 'diagnose' ? 'spin' : ''} />연결 확인</button><button type="button" className="button primary" disabled={!!busy || !!remote?.enabled} onClick={() => void run('enable', async () => { const value = await client.request<{ origin: string }>('remote.enable'); if (mounted.current) { setOrigin(value.origin); setNotice('원격 접속을 켰습니다. 다른 기기에서 아래 주소를 열어 주세요.'); } await refreshRemote(); })}>{busy === 'enable' && <LoaderCircle size={16} className="spin" />}원격 접속 켜기</button>{remote?.enabled && <button type="button" className="button subtle" disabled={!!busy} onClick={() => void run('disable', async () => { await client.request('remote.disable'); await refreshRemote(); if (mounted.current) setNotice('원격 접속을 껐습니다.'); })}>원격 접속 끄기</button>}</div>
              {diagnosis && <p className="hint" role="status">{diagnosis.message || (!diagnosis.installed ? 'Tailscale을 설치한 뒤 다시 확인해 주세요.' : !diagnosis.connected ? 'Tailscale에 로그인하고 연결해 주세요.' : `Tailscale 연결됨${diagnosis.dnsName ? ` · ${diagnosis.dnsName}` : ''}`)}</p>}
              <p className="hint">상태: {remote ? remote.enabled ? '원격 접속 켜짐' : '원격 접속 꺼짐' : '확인 중'}</p>
              {remote?.enabled && remote.origin && <RemoteAccessQr origin={remote.origin} />}
              {remote?.origin && <div className="form-row"><code className="code-box" style={{ overflowWrap: 'anywhere', flex: 1 }}>{remote.origin}</code><button type="button" className="icon-button" aria-label="접속 주소 복사" disabled={!!busy} onClick={() => void run('copy-origin', () => copy(remote.origin!))}><Copy size={16} /></button></div>}
              <button type="button" className="button subtle" aria-expanded={manualOpen} onClick={() => setManualOpen(value => !value)}>접속 주소 직접 설정</button>
              {manualOpen && <form onSubmit={event => { event.preventDefault(); void run('configure', async () => {
                let value: string | null = null;
                if (origin.trim()) { const url = new URL(origin.trim()); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('경로나 로그인 정보가 없는 HTTPS 주소를 입력해 주세요.'); value = url.origin; }
                await client.request('remote.configure', { origin: value }); await refreshRemote(); if (mounted.current) setNotice('접속 주소를 저장했습니다.');
              }); }}><label className="field" htmlFor={`${id}-origin`}><span className="field-label">HTTPS 접속 주소</span><input id={`${id}-origin`} type="url" className="input" placeholder="https://my-computer.example.ts.net" value={origin} disabled={!!busy} onChange={event => setOrigin(event.target.value)} /></label><p className="hint">이미 구성한 HTTPS 연결의 주소를 등록합니다. 주소를 저장하는 것만으로 네트워크 연결이 만들어지지는 않습니다. 비워 저장하면 등록된 주소를 해제합니다.</p><button type="submit" className="button subtle" disabled={!!busy}>주소 저장</button></form>}
            </div>
            {pairingSection}
            <div className="settings-section"><div className="form-row"><h3 className="settings-title">연결한 기기</h3><button type="button" className="icon-button" aria-label="연결한 기기 새로 고침" disabled={!!busy} onClick={() => void run('devices', refreshDevices)}><RefreshCw size={16} /></button></div>{activeDevices.length === 0 ? <p className="hint">아직 연결한 기기가 없습니다.</p> : activeDevices.map(device => <div className="device-row" key={device.deviceId}><div className="device-info"><strong>{device.name}</strong><p className="hint">연결: {dateLabel(device.createdAt)}{device.approvedBy && ` · ${device.approvedBy}에서 승인`}</p>{device.origin && <p className="hint" style={{ overflowWrap: 'anywhere' }}>{device.origin}</p>}{revokeId === device.deviceId && <p className="hint">이 기기의 접속 권한을 해제합니다. 다시 접속하려면 승인이 필요합니다.</p>}</div>{revokeId === device.deviceId ? <div className="form-row"><button type="button" className="button danger" disabled={!!busy} onClick={() => void run(`revoke-${device.deviceId}`, async () => { await client.request('devices.revoke', { deviceId: device.deviceId }); if (mounted.current) { setRevokeId(null); setNotice('기기의 접속 권한을 해제했습니다.'); } await refreshDevices(); })}>연결 해제</button><button type="button" className="button subtle" disabled={!!busy} onClick={() => setRevokeId(null)}>취소</button></div> : <button type="button" className="icon-button" disabled={!!busy} aria-label={`${device.name} 접속 권한 해제`} onClick={() => setRevokeId(device.deviceId)}><Trash2 size={16} /></button>}</div>)}</div>
          </>)}
          {tab === 'updates' && <UpdateSettings refreshBlocked={refreshBlocked} />}
          {tab === 'help' && <>
            <div className="settings-section"><h3 className="settings-title">Claude 작업 상태와 알림</h3><p className="settings-description">작업 중에는 표시가 천천히 맥동하고, 응답이 끝나면 종이 나타납니다. 해당 터미널의 최신 화면을 확인하면 종이 사라집니다. 확인 요청·오류는 별도로 표시하고 읽음 상태는 이 기기에 저장됩니다.</p>
              <p className={state.claudeIntegration?.status==='ready'?'hint':'hint warning'}>{state.claudeIntegration?.status==='ready'?'Claude 자동 연동 준비됨':state.claudeIntegration?.status==='unavailable'?'Claude 자동 연동 사용 불가':'Claude 자동 연동 상태를 확인할 수 없습니다.'}</p>
              {state.claudeIntegration?.message&&<p className="hint">{state.claudeIntegration.message}</p>}
              {state.codexIntegration&&<>
                <p className={state.codexIntegration.status==='installed'?'hint':'hint warning'}>{state.codexIntegration.status==='installed'?'Codex 대화 재개 연동 등록됨':'Codex 대화 재개 연동 사용 불가'}</p>
                <p className="hint">{state.codexIntegration.message}</p>
                <p className="hint">PowerShell에서 codex로 시작한 대화에 적용됩니다. 최초 연동은 Codex의 /hooks에서 검토·신뢰한 뒤 Codex를 다시 시작하세요. 기존 요청을 다시 보내지는 않습니다.</p>
              </>}
              <p className="hint">Windows용 Claude Code 2.1.292 이상에서 공식 훅으로 연결합니다. 기존 설정을 보존하며 terminal_bell을 따로 설정할 필요가 없습니다. 실행부가 연동을 준비한 뒤 새 터미널에서 Claude를 시작해 주세요. 이미 실행 중인 Claude와 셸에는 적용되지 않습니다.</p>
              <p className="hint">WSL·SSH 내부의 Claude 자동 설정은 지원하지 않습니다. 응답 완료는 작업의 성공을 보장하지 않습니다. Codex 등 다른 CLI는 프로그램이 보낸 알림만 벨로 표시하며, 알림 기능이 꺼져 있으면 표시되지 않습니다.</p>
            </div>
            <div className="settings-section"><h3 className="settings-title">작업은 이 컴퓨터에서 계속됩니다</h3><p className="settings-description">앱 창을 닫아도 몽글터미널의 백그라운드 실행부가 유지되는 동안 터미널 작업이 계속됩니다. 다시 열거나 다른 기기에서 접속하면 실행 중인 세션에 이어서 연결합니다.</p><p className="hint">컴퓨터 종료·재부팅·로그아웃 또는 백그라운드 실행부 종료 시 실행 중인 프로세스는 유지되지 않습니다. 다시 열면 저장된 구성과 보관된 출력, 연동으로 확인한 Claude·Codex 대화를 다시 엽니다. 이전 요청이나 명령을 자동으로 다시 보내지는 않습니다.</p></div>
            <div className="settings-section"><h3 className="settings-title">원격에서 사용하기</h3><p className="settings-description">대상 컴퓨터가 켜져 있고 Tailscale에 연결되어 있어야 합니다. 모바일 브라우저에서 접속 주소를 열고 홈 화면에 추가하면 앱처럼 사용할 수 있습니다.</p><p className="hint">한 터미널에는 한 기기만 입력할 수 있습니다. 다른 기기에서 제어권을 가져오면 기존 기기는 화면을 보는 상태로 바뀝니다.</p>{remoteApproval && <p className="hint">새 기기는 대상 컴퓨터나 이미 연결된 기기의 설정 → 원격 연결에서 승인할 수 있습니다.</p>}</div>
            <div className="settings-section"><h3 className="settings-title">터미널 단축키</h3><div className="setting-row"><span>선택한 내용 복사</span><kbd>Ctrl + Shift + C</kbd></div><div className="setting-row"><span>붙여넣기</span><kbd>Ctrl + Shift + V</kbd></div><div className="setting-row"><span>출력 검색</span><kbd>Ctrl + Shift + F</kbd></div><p className="hint">분할과 화면 확대는 각 터미널 제목줄에서 사용할 수 있습니다. Ctrl + C는 실행 중인 명령에 중단 신호를 보냅니다.</p></div>
            <p className="hint">몽글터미널 {state.version}</p>
          </>}
        </section>
      </div>
      <footer className="modal-footer"><div style={{ flex: 1 }}>{error && <p className="error-text" role="alert">{error}</p>}{notice && <p className="hint" role="status">{notice}</p>}</div><button type="button" className="button subtle" onClick={onClose}>닫기</button></footer>
    </div>
  </div>;
}
