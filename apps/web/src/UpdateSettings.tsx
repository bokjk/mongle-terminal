import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UpdateState } from '../../../packages/client/index';

const labels: Record<UpdateState['status'], string> = {
  unsupported: '이 앱에서는 자동 업데이트를 사용할 수 없습니다.',
  idle: '업데이트 확인을 기다리고 있습니다.',
  checking: '새 버전을 확인하고 있습니다.',
  downloading: '업데이트를 다운로드하고 있습니다.',
  ready: '업데이트 설치를 준비했습니다.',
  installing: '터미널 구성을 보관하고 업데이트를 설치하고 있습니다.',
  error: '업데이트를 완료하지 못했습니다.',
};

export function UpdateSettings() {
  const bridge = window.mongle;
  const supported = !!(bridge?.getUpdateState && bridge.checkForUpdates && bridge.installUpdate && bridge.onUpdate);
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const operation = useRef(false);
  const eventVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (!supported) return () => { mounted.current = false; };
    // Subscribe first. A slower IPC response must not replace a newer event.
    const unsubscribe = bridge!.onUpdate!(value => {
      eventVersion.current += 1;
      if (active) { setState(value); setError(''); }
    });
    const version = eventVersion.current;
    void bridge!.getUpdateState!().then(value => {
      if (active && eventVersion.current === version) setState(value);
    }).catch(failure => {
      if (active && eventVersion.current === version) setError(failure instanceof Error ? failure.message : '업데이트 상태를 확인하지 못했습니다.');
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [bridge, supported]);

  async function run(install: boolean) {
    if (!supported || operation.current) return;
    operation.current = true;
    setBusy(true); setError('');
    const version = eventVersion.current;
    try {
      if (install) {
        await bridge!.installUpdate!();
        // A cancelled native confirmation leaves the downloaded update ready.
        const next = await bridge!.getUpdateState!();
        if (mounted.current && eventVersion.current === version) setState(next);
      } else {
        const next = await bridge!.checkForUpdates!();
        if (mounted.current && eventVersion.current === version) setState(next);
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '업데이트를 완료하지 못했습니다.');
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (!bridge) return <div className="settings-section"><h3 className="settings-title">앱 업데이트</h3><p className="settings-description">브라우저에서는 앱을 따로 설치하거나 업데이트하지 않습니다. 접속 대상 컴퓨터의 몽글터미널을 업데이트한 뒤 이 페이지를 새로고침하면 새 화면을 사용할 수 있습니다.</p><p className="hint">컴퓨터 앱의 업데이트는 해당 컴퓨터에서 진행합니다.</p></div>;
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
      {state?.status !== 'unsupported' && <p className="hint">새 버전은 자동으로 확인하고 다운로드합니다. 설치는 아래 버튼을 누른 뒤 확인 창에서 결정합니다.</p>}
      <div className="form-row">
        {state?.status === 'ready' ? <button type="button" className="button primary" disabled={pending} onClick={() => void run(true)}><Download size={16} />업데이트 설치 후 다시 시작</button> : <button type="button" className="button subtle" disabled={pending || state?.status === 'unsupported'} onClick={() => void run(false)}>{pending ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}업데이트 확인</button>}
      </div>
      <p className="hint">설치하면 이 기기에서 실행 중인 모든 터미널 작업과 이 기기로의 원격 연결이 종료됩니다. 저장된 그룹·분할과 보관된 출력은 다시 열 수 있지만, 셸은 새로 시작되며 실행 중인 프로그램과 저장하지 않은 작업은 복원되지 않습니다.</p>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
