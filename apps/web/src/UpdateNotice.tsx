import { AlertCircle, Download, LoaderCircle } from 'lucide-react';
import type { UpdateState } from '../../../packages/client/index';
import { INSTALL_STEPS, useAppUpdate } from './update-store';

/** Statuses that deserve a persistent notice without opening settings. */
function visible(state: UpdateState | null): state is UpdateState {
  return !!state && (state.status === 'downloading' || state.status === 'ready' || state.status === 'installing' || (state.status === 'error' && !!state.availableVersion));
}
function percent(state: UpdateState) {
  return state.progress !== undefined && Number.isFinite(state.progress) ? Math.max(0, Math.min(100, Math.round(state.progress))) : undefined;
}
function summary(state: UpdateState) {
  const version = state.availableVersion ? ` ${state.availableVersion}` : '';
  if (state.status === 'downloading') { const value = percent(state); return `새 버전${version} 다운로드 중${value !== undefined ? ` ${value}%` : ''}`; }
  if (state.status === 'ready') return `새 버전${version} 설치 준비 완료`;
  if (state.status === 'installing') return `업데이트 진행 중 · ${INSTALL_STEPS.find(step => step.phase === state.phase)?.label || '준비'}`;
  return '업데이트를 완료하지 못했습니다';
}

/**
 * Persistent update notice for the sidebar footer. Rendered as a card when the
 * sidebar is expanded and as an icon badge in the collapsed rail.
 */
export function UpdateNotice({ compact = false, onExpand, onOpenSettings }: { compact?: boolean; onExpand?: () => void; onOpenSettings?: () => void }) {
  const { supported, state, busy, error, store } = useAppUpdate();
  if (!supported || !visible(state)) return null;
  const status = state.status;
  const pending = busy || status === 'installing';
  const label = summary(state);
  const install = () => { if (!pending) void store.install(); };
  const Icon = status === 'error' ? AlertCircle : (status === 'installing' || status === 'downloading') ? LoaderCircle : Download;
  const spinning = status === 'installing' || status === 'downloading' || busy;

  if (compact) {
    // The badge only reveals the full card, so progress, errors and the install button stay visible.
    return <button type="button" className={`icon-button update-rail-badge ${status}`} aria-label={`${label} · 사이드바를 펼쳐 자세히 보기`} title={`${label} · 눌러서 자세히 보기`} disabled={!onExpand} onClick={onExpand}>
      <Icon size={18} className={spinning ? 'spin' : undefined}/>
      <span className="update-rail-dot" aria-hidden="true"/>
    </button>;
  }

  const value = percent(state);
  return <section className={`update-notice ${status}`} aria-label="앱 업데이트" aria-live="polite">
    <div className="update-notice-head">
      <Icon size={15} className={spinning ? 'spin' : undefined} aria-hidden="true"/>
      <strong>{label}</strong>
    </div>
    {status === 'downloading' && <progress aria-label="업데이트 다운로드 진행률" max={100} value={value}/>}
    {status === 'installing' && <ol className="update-steps" aria-label="업데이트 설치 단계">
      {INSTALL_STEPS.map((step, index) => {
        const current = INSTALL_STEPS.findIndex(item => item.phase === state.phase);
        const stepState = index < current ? 'done' : index === current ? 'current' : 'todo';
        return <li key={step.phase} className={stepState} aria-current={stepState === 'current' ? 'step' : undefined}>{stepState === 'current' ? <LoaderCircle size={11} className="spin" aria-hidden="true"/> : <span className="update-step-dot" aria-hidden="true"/>}{step.label}</li>;
      })}
    </ol>}
    {(status === 'installing' || status === 'error') && state.message && <p className={status === 'error' ? 'update-notice-text error-text' : 'update-notice-text'} role={status === 'error' ? 'alert' : 'status'}>{state.message}</p>}
    {status === 'ready' && <p className="update-notice-text">작업을 저장한 뒤 설치하세요. 이 컴퓨터의 터미널이 다시 시작됩니다.</p>}
    {status === 'ready' && <button type="button" className="button primary update-notice-action" disabled={pending} onClick={install}>{busy ? <LoaderCircle size={14} className="spin"/> : <Download size={14}/>}설치 후 다시 시작</button>}
    {status === 'error' && <button type="button" className="button subtle update-notice-action" disabled={busy} onClick={() => void store.check()}>{busy ? <LoaderCircle size={14} className="spin"/> : null}다시 확인</button>}
    {(status === 'error' || status === 'downloading') && onOpenSettings && <button type="button" className="button subtle update-notice-action" onClick={onOpenSettings}>업데이트 설정</button>}
    {error && <p className="update-notice-text error-text" role="alert">{error}</p>}
  </section>;
}
