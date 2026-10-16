import { useState } from 'react';
import { BellOff, Send, X } from 'lucide-react';
import type { AgentHoldReason, AppClientRequest, HostState, TerminalInfo } from './agent-message-types';
import { Modal } from './Modal';

/** Same limit as the host (packages/host/agent-inbox.ts). */
export const AGENT_MESSAGE_LIMIT = 4000;

const holdText: Record<AgentHoldReason, string> = {
  'no-agent': '에이전트가 준비되기를 기다리는 중',
  starting: '에이전트가 준비되기를 기다리는 중',
  busy: '지금 작업이 끝나면 전달',
  attention: '확인 요청에 답한 뒤 전달',
  unconfirmed: '방금 보낸 입력의 처리를 기다리는 중',
  typing: '입력을 멈추면 전달',
  dnd: '방해 금지가 꺼지면 전달',
  delivering: '앞 메시지의 처리를 기다리는 중',
};
/** What the waiting message is waiting for, in the user's words. */
export function agentHoldDescription(reason: AgentHoldReason | undefined): string {
  return reason ? holdText[reason] : '곧 전달';
}

export function agentName(info: TerminalInfo): string {
  return info.agentProvider === 'codex' ? 'Codex' : info.agentProvider === 'claude' ? 'Claude Code' : '에이전트';
}

/** Sending is possible only when the host supports it and a hook proved the agent runs in this terminal. */
export function canMessageAgent(state: HostState, info: TerminalInfo): boolean {
  return state.capabilities?.includes('agent.messages') === true && info.status === 'running' && info.agentReady === true;
}

type Ref = { id: string; hostId: string; bootId: string; generation: string };
export function AgentMessageDialog({state, info, request, onClose, onError}: {state: HostState; info: TerminalInfo; request: AppClientRequest; onClose(): void; onError(message: string): void}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref: Ref = {id: info.id, hostId: state.hostId, bootId: state.bootId, generation: info.generation};
  const name = agentName(info);
  const ready = canMessageAgent(state, info);
  const length = text.trim().length;
  async function send() {
    if (!ready || !length || length > AGENT_MESSAGE_LIMIT || sending) return;
    setSending(true);
    try { await request('agent.message.send', {...ref, text}); setText(''); onClose(); }
    catch (error) { onError(error instanceof Error ? error.message : '메시지를 보내지 못했습니다.'); }
    finally { setSending(false); }
  }
  return <Modal title={name + '에게 메시지'} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <div className="modal-body agent-message-body">
        <p className="hint">{info.title}에서 실행 중인 {name}의 입력창에 이 글을 붙여 넣고 보냅니다. 작업 중이거나 확인을 기다리는 중이면, 그리고 이 터미널에 누군가 입력하고 있으면 끝날 때까지 기다렸다가 보냅니다.</p>
        {info.agentDnd && <p className="agent-message-dnd" role="status"><BellOff size={14} aria-hidden="true"/>방해 금지가 켜져 있습니다. 끌 때까지 전달하지 않습니다.</p>}
        <textarea className="textarea agent-message-text" autoFocus aria-label="보낼 메시지" placeholder="예: 로그인 화면 검토를 시작해 주세요." value={text} maxLength={AGENT_MESSAGE_LIMIT * 2}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }}/>
        <p className={'hint agent-message-count' + (length > AGENT_MESSAGE_LIMIT ? ' over' : '')}>{length.toLocaleString('ko-KR')} / {AGENT_MESSAGE_LIMIT.toLocaleString('ko-KR')}자 · Ctrl+Enter로 보내기</p>
        {!ready && <p className="hint agent-message-warning" role="status">이 터미널에서 실행 중인 {name}를 확인하지 못했습니다. 에이전트를 실행한 뒤 다시 열어 주세요.</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="button" onClick={onClose}>취소</button>
        <button className="button primary" disabled={!ready || !length || length > AGENT_MESSAGE_LIMIT || sending}><Send size={14} aria-hidden="true"/>{sending ? '보내는 중…' : '보내기'}</button>
      </div>
    </form>
  </Modal>;
}

/** Waiting messages under the terminal: what each waits for, and how to cancel or send it now. */
export function AgentInboxBanner({state, info, request, onError}: {state: HostState; info: TerminalInfo; request: AppClientRequest; onError(message: string): void}) {
  const messages = info.agentInbox?.messages ?? [];
  if (info.status !== 'running' || !messages.length) return null;
  const ref: Ref = {id: info.id, hostId: state.hostId, bootId: state.bootId, generation: info.generation};
  const hold = info.agentInbox?.hold;
  const act = (method: 'agent.message.cancel' | 'agent.message.force', messageId: string) =>
    void request(method, {...ref, messageId}).catch(error => onError(error instanceof Error ? error.message : '요청을 완료하지 못했습니다.'));
  const first = messages[0];
  return <div className="connection-banner agent-inbox-banner" role="status" aria-label={agentName(info) + '에게 보낼 메시지 ' + messages.length + '개'}>
    <span className="agent-inbox-summary"><Send size={13} aria-hidden="true"/><strong>보낼 메시지 {messages.length}개</strong><span className="agent-inbox-hold">{agentHoldDescription(hold)}</span><span className="agent-inbox-preview" title={first.preview}>“{first.preview}”</span></span>
    <span className="agent-inbox-actions">
      {(hold === 'typing' || hold === 'unconfirmed') && !first.force && <button type="button" className="button subtle" title="기다리지 않고 보냅니다. 입력창에 쓰던 글이나 열린 메뉴가 있으면 함께 처리될 수 있습니다. 작업 중이거나 확인 요청 중이면 여전히 기다립니다." onClick={() => act('agent.message.force', first.id)}>지금 보내기</button>}
      <button type="button" className="icon-button" aria-label={'맨 앞 메시지 취소: ' + first.preview} title="맨 앞 메시지 취소" onClick={() => act('agent.message.cancel', first.id)}><X size={14}/></button>
    </span>
  </div>;
}
