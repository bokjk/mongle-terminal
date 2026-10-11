import { useEffect, useRef, useState } from 'react';
import { BellRing, LoaderCircle } from 'lucide-react';
import type { AppClient } from '../../../packages/client/index';
import type { HostState } from '../../../packages/protocol/index';
import { disablePush, enablePush, pushAvailability, pushOn, readPushView } from './push';

type Status = 'loading' | 'off' | 'on' | 'blocked';
const STATUS_TEXT: Record<Status, string> = {
  loading: '알림 상태를 확인하고 있습니다.',
  off: '꺼져 있습니다. 켜면 브라우저가 알림을 허용할지 묻습니다.',
  on: '켜져 있습니다. 이 기기로 알림을 받습니다.',
  blocked: '브라우저에서 이 주소의 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 알림을 허용한 뒤 다시 확인해 주세요.',
};
const failure = (error: unknown) => error instanceof Error ? error.message : '알림 설정을 바꾸지 못했습니다.';

/** Phone notifications for this PC (packages/host/push-notifier.ts), shown in browsers connected to it. */
export function PushSettings({ client, state }: { client: AppClient; state: HostState }) {
  const availability = pushAvailability();
  const supported = state.capabilities?.includes('notifications.push') === true;
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState<'' | 'enable' | 'disable' | 'test' | 'check'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = async () => {
    const view = await readPushView(client);
    if (mounted.current) setStatus(view.permission === 'denied' ? 'blocked' : pushOn(view) ? 'on' : 'off');
  };
  useEffect(() => {
    if (availability !== 'ready' || !supported) return;
    void refresh().catch(reason => { if (mounted.current) { setStatus('off'); setError(failure(reason)); } });
  }, [availability, supported, state.hostId]);
  if (availability === 'desktop' || !supported) return null;
  const run = async (kind: Exclude<typeof busy, ''>, task: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(kind); setError(''); setNotice('');
    try { const done = await task(); if (mounted.current && done) setNotice(done); }
    catch (reason) { if (mounted.current) setError(failure(reason)); }
    finally { if (mounted.current) setBusy(''); await refresh().catch(() => {}); }
  };
  const spinner = (kind: typeof busy) => busy === kind ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : null;
  return <div className="settings-section push-settings">
    <h3 className="settings-title">이 기기로 알림 받기</h3>
    <p className="settings-description">PC 앞에 없을 때 이 기기로 알려 드립니다.</p>
    <ul className="push-reasons">
      <li>Claude·Codex가 확인이나 답을 기다릴 때</li>
      <li>새 기기가 이 PC에 연결을 요청할 때</li>
    </ul>
    <div className="push-preview" aria-hidden="true">
      <img src="/icon-192.png" alt="" />
      <div><strong>{state.name}</strong><span>작업 · PowerShell: Claude가 확인을 기다리고 있습니다.</span></div>
    </div>
    <p className="hint">PC가 잠겨 있거나 5분 넘게 키보드·마우스 입력이 없을 때만 보냅니다. 어느 기기에서든 이 PC의 몽글터미널 화면을 보고 있거나 본 지 5분이 지나지 않았으면 보내지 않습니다. 알림에는 컴퓨터·그룹·터미널 이름만 나오고 출력 내용과 연결 코드는 담지 않습니다. 응답 완료는 알리지 않습니다.</p>
    {availability === 'insecure' && <p className="hint" role="status">보안 연결(HTTPS) 주소로 접속했을 때 켤 수 있습니다.</p>}
    {availability === 'unsupported' && <p className="hint" role="status">이 브라우저는 웹 알림을 지원하지 않습니다. 휴대폰의 Chrome이나 삼성 인터넷에서 열어 주세요.</p>}
    {availability === 'install-first' && <p className="hint" role="status">iPhone·iPad에서는 Safari의 공유 → 홈 화면에 추가로 설치한 앱에서 열어야 알림을 켤 수 있습니다.</p>}
    {availability === 'ready' && <>
      <p className={status === 'blocked' ? 'error-text push-status' : 'hint push-status'} role="status">{STATUS_TEXT[status]}</p>
      <div className="form-row">
        {status === 'on' ? <>
          <button type="button" className="button subtle" disabled={!!busy} onClick={() => void run('test', async () => { await client.request('push.test', {}); return '시험 알림을 보냈습니다. 몇 초 안에 이 기기에 나타납니다.'; })}>{spinner('test') || <BellRing size={16} aria-hidden="true" />}시험 알림 보내기</button>
          <button type="button" className="button subtle" disabled={!!busy} onClick={() => void run('disable', async () => { await disablePush(client); return '알림을 껐습니다.'; })}>{spinner('disable')}알림 끄기</button>
        </> : status === 'blocked'
          ? <button type="button" className="button subtle" disabled={!!busy} onClick={() => void run('check', async () => {})}>{spinner('check')}다시 확인</button>
          : <button type="button" className="button primary" disabled={!!busy || status === 'loading'} onClick={() => void run('enable', async () => { await enablePush(client); return '알림을 켰습니다. 시험 알림으로 확인해 보세요.'; })}>{spinner('enable') || <BellRing size={16} aria-hidden="true" />}알림 켜기</button>}
      </div>
    </>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
