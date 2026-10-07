import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UpdateState } from '../../../packages/client/index';
import { INSTALL_STEPS, useAppUpdate } from './update-store';

const labels: Record<UpdateState['status'], string> = {
  unsupported: '이 앱에서는 자동 업데이트를 사용할 수 없습니다.',
  idle: '업데이트 확인을 기다리고 있습니다.',
  checking: '새 버전을 확인하고 있습니다.',
  downloading: '업데이트를 다운로드하고 있습니다.',
  ready: '업데이트 설치를 준비했습니다.',
  installing: '업데이트 설치를 준비하고 있습니다.',
  error: '업데이트를 완료하지 못했습니다.',
};

export function UpdateSettings({ refreshBlocked = false }: { refreshBlocked?: boolean }) {
  const bridge = window.mongle;
  // One app-wide subscription shared with the sidebar notice keeps both views in step.
  const { supported, state, error, busy, store } = useAppUpdate();
  const run = (install: boolean) => install ? store.install() : store.check();

  if (!bridge) return <div className="settings-section">
    <h3 className="settings-title">화면 새로고침</h3>
    <p className="settings-description">접속한 컴퓨터의 몽글터미널을 업데이트한 뒤 새로고침하면 새 화면을 사용할 수 있습니다. 홈 화면에 설치한 앱도 다시 설치할 필요가 없습니다.</p>
    <button type="button" className="button subtle" disabled={refreshBlocked} onClick={() => { if (!refreshBlocked) window.location.reload(); }}><RefreshCw size={16} />화면 새로고침</button>
    {refreshBlocked && <p className="hint" role="status">저장하지 않았거나 저장 중인 파일이 있습니다. 설정을 닫고 파일을 저장하거나 변경을 취소한 뒤 다시 시도해 주세요.</p>}
    <p className="hint">화면을 다시 불러오고 연결합니다. 컴퓨터에서 실행 중인 터미널 작업은 계속되며, 열린 파일 탭은 닫힙니다.</p>
    <p className="hint">컴퓨터 앱의 업데이트는 해당 컴퓨터에서 진행합니다.</p>
  </div>;
  const pending = busy || (!state && !error) || !!(state && ['checking', 'downloading', 'installing'].includes(state.status));
  const progress = state?.progress !== undefined && Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : undefined;
  const message = state?.message || (state ? labels[state.status] : '업데이트 상태를 확인하고 있습니다.');
  return <div className="settings-section">
    <h3 className="settings-title">이 기기의 앱 업데이트</h3>
    <p className="settings-description">지금 사용 중인 기기에 설치된 몽글터미널 앱을 업데이트합니다. 접속한 원격 컴퓨터의 앱은 그 컴퓨터에서 업데이트합니다.</p>
    {!supported ? <p className="hint">이 버전에서는 앱 업데이트를 지원하지 않습니다. 새 설치 프로그램으로 업데이트해 주세요.</p> : <>
      {state && <div className="setting-row"><span>설치된 앱 버전</span><strong>{state.currentVersion}</strong></div>}
      {state?.availableVersion && <div className="setting-row"><span>새 버전</span><strong>{state.availableVersion}</strong></div>}
      <p className={state?.status === 'error' ? 'error-text' : 'hint'} role={state?.status === 'error' ? 'alert' : 'status'}>{message}</p>
      {state?.status === 'downloading' && <div className="form-row"><progress aria-label="업데이트 다운로드 진행률" max={100} value={progress} />{progress !== undefined && <span>{Math.round(progress)}%</span>}</div>}
      {state?.status === 'installing' && <ol className="update-steps" aria-label="업데이트 설치 단계">{INSTALL_STEPS.map((step, index) => {
        const current = INSTALL_STEPS.findIndex(item => item.phase === state.phase);
        const stepState = index < current ? 'done' : index === current ? 'current' : 'todo';
        return <li key={step.phase} className={stepState} aria-current={stepState === 'current' ? 'step' : undefined}>{stepState === 'current' ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <span className="update-step-dot" aria-hidden="true" />}{step.label}</li>;
      })}</ol>}
      {state?.status !== 'unsupported' && <p className="hint">새 버전은 자동으로 확인하고 다운로드합니다. 준비되면 사이드바 아래에 알림이 표시되며, 설치는 버튼을 누른 뒤 확인 창에서 결정합니다. 앱이 닫힌 뒤에는 설치 창에 진행 상황이 표시되고, 끝나면 앱이 다시 열립니다.</p>}
      <div className="form-row">
        {state?.status === 'ready' ? <button type="button" className="button primary" disabled={pending} onClick={() => void run(true)}><Download size={16} />업데이트 설치 후 다시 시작</button> : <button type="button" className="button subtle" disabled={pending || state?.status === 'unsupported'} onClick={() => void run(false)}>{pending ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}업데이트 확인</button>}
      </div>
      <p className="hint">설치하면 이 기기에서 실행 중인 모든 터미널 작업과 이 기기로의 원격 연결이 종료됩니다. 저장된 그룹·분할과 보관된 출력은 다시 열 수 있지만, 셸은 새로 시작됩니다. 연동으로 대화가 확인된 Claude·Codex는 같은 대화를 다시 열며, 진행 중 작업·미저장 내용은 복원하지 않고 이전 요청을 다시 보내지 않습니다.</p>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
