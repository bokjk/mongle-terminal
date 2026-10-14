import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookmarkPlus, Bot, Crown, GitFork, Lock, MessagesSquare, Send, Users, X } from 'lucide-react';
import type { HostState, Team, TeamMessage, TerminalInfo } from '../../../packages/protocol/index';
import { AGENT_MESSAGE_LIMIT } from './AgentMessage';
import { aggregateTerminalStatus, terminalStatus, terminalStatusDescription, TerminalStatusBadge, type TerminalNotices } from './TerminalStatus';
import { canCancelTeamMessage, memberTerminal, modelLabel, ROLE_DEFAULTS, teamFlow, teamMessageStatus, teamSendBlocker } from './team-model';

type Request = <T = unknown>(method: string, params?: unknown) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 완료하지 못했습니다.';
const time = (at: number) => new Date(at).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit'});

/**
 * The small labels a member's pane header carries: lead, the role when the name does not already say it,
 * model and the read-only switch (an icon, so narrow panes keep the name readable).
 */
export function TeamMemberBadge({team, memberId}: {team: Team; memberId: string}) {
  const index = team.members.findIndex(item => item.id === memberId), member = team.members[index];
  if (!member) return null;
  const role = ROLE_DEFAULTS[member.role].label;
  return <span className="team-member-badge">
    {index === 0 && <span className="team-chip lead"><Crown size={11} aria-hidden="true"/>팀장</span>}
    {index !== 0 && member.role !== 'custom' && !role.startsWith(member.name) && <span className="team-chip">{role}</span>}
    <span className="team-chip model" title={modelLabel(member)}>{modelLabel(member)}</span>
    {member.readOnly && <span className="team-chip icon" role="img" aria-label="읽기 전용" title="읽기 전용: 파일을 고치지 못하게 실행했습니다"><Lock size={11} aria-hidden="true"/></span>}
  </span>;
}
/** What was typed in each team's message box, kept while the user looks elsewhere in this window. */
const drafts = new Map<string, string>();

/**
 * The team screen: the lead's terminal large on the left, the other members stacked on the right, the team
 * conversation under them and one line of team information at the bottom.
 */
export function TeamWorkspace({state, team, maximized, renderPane, request, onSelect, onError, onSaveTemplate, onRemove}: {
  state: HostState; team: Team; maximized?: string;
  renderPane(id: string): ReactNode; request: Request; onSelect(id: string): void; onError(message: string): void;
  onSaveTemplate(): void; onRemove(): void;
}) {
  const [lead, ...others] = team.members;
  const pane = (member: Team['members'][number], className: string) => {
    const terminal = memberTerminal(state, member);
    if (terminal) return <div key={member.id} className={className}>{renderPane(terminal.id)}</div>;
    return <div key={member.id} className={className}><section className="pane team-member-missing" aria-label={member.name + ' 패널'}>
      <header className="pane-header"><Bot size={14}/><span className="pane-title">{member.name}</span></header>
      <p className="hint">{member.error || '이 구성원의 터미널이 닫혔습니다.'}</p>
    </section></div>;
  };
  const focused = maximized && team.members.find(member => member.terminalId === maximized);
  return <div className="team-workspace">
    <div className={'team-panes' + (focused ? ' single' : '') + (others.length ? '' : ' solo')}>
      {focused ? pane(focused, 'team-pane-slot team-lead-slot') : <>
        {pane(lead, 'team-pane-slot team-lead-slot')}
        {others.length > 0 && <div className="team-others">{others.map(member => pane(member, 'team-pane-slot'))}</div>}
      </>}
    </div>
    <TeamChat state={state} team={team} request={request} onSelect={onSelect} onError={onError}/>
    <TeamBar team={team} state={state} onSaveTemplate={onSaveTemplate} onRemove={onRemove}/>
  </div>;
}

/** What was sent to whom and what became of it, and the box to send the next message (to the lead by default). */
export function TeamChat({state, team, request, onSelect, onError}: {state: HostState; team: Team; request: Request; onSelect(id: string): void; onError(message: string): void}) {
  const [to, setTo] = useState(team.members[0]?.id ?? '');
  const [text, setTextState] = useState(() => drafts.get(team.id) ?? '');
  const setText = (value: string) => { setTextState(value); if (value) drafts.set(team.id, value); else drafts.delete(team.id); };
  const [sending, setSending] = useState(false);
  const log = useRef<HTMLOListElement>(null);
  const messages = team.messages ?? [];
  useEffect(() => { if (!team.members.some(member => member.id === to)) setTo(team.members[0]?.id ?? ''); }, [team.id, team.members.map(member => member.id).join(',')]);
  useEffect(() => { const list = log.current; if (list) list.scrollTop = list.scrollHeight; }, [messages.length, team.id]);
  const receiver = team.members.find(member => member.id === to);
  const blocker = teamSendBlocker(state, team, to);
  const length = text.trim().length;
  async function send() {
    if (blocker || !length || length > AGENT_MESSAGE_LIMIT || sending) return;
    setSending(true);
    try { await request('teams.message', {hostId: state.hostId, bootId: state.bootId, teamId: team.id, to, text}); setText(''); }
    catch (error) { onError(message(error)); }
    finally { setSending(false); }
  }
  function cancel(item: TeamMessage) {
    const terminal = memberTerminal(state, team.members.find(member => member.id === item.to)!);
    if (!terminal) return;
    void request('agent.message.cancel', {id: terminal.id, hostId: state.hostId, bootId: state.bootId, generation: terminal.generation, messageId: item.id}).catch(error => onError(message(error)));
  }
  const nameOf = (id: string) => id === 'user' ? '나' : team.members.find(member => member.id === id)?.name ?? '나간 구성원';
  return <section className="team-chat" aria-label="팀 대화">
    <header className="team-chat-header"><MessagesSquare size={14} aria-hidden="true"/><strong>팀 대화</strong><span className="hint">보낸 메시지와 전달 상태</span></header>
    <ol className="team-chat-log" ref={log} aria-live="polite">
      {!messages.length && <li className="team-chat-empty hint">아직 보낸 메시지가 없습니다. 팀장에게 할 일을 알려 주세요. 구성원에게 직접 보낼 수도 있습니다.</li>}
      {messages.map(item => {
        const member = team.members.find(candidate => candidate.id === item.to);
        const terminal = member ? memberTerminal(state, member) : undefined;
        return <li key={item.id} className={'team-message ' + item.status}>
          <button type="button" className="team-message-route" title={nameOf(item.to) + ' 터미널 보기'} disabled={!terminal} onClick={() => terminal && onSelect(terminal.id)}>{nameOf(item.from)} → {nameOf(item.to)}</button>
          <span className="team-message-text" title={item.preview}>{item.preview}</span>
          <span className={'team-message-status ' + item.status}>{teamMessageStatus(item, terminal)}</span>
          {canCancelTeamMessage(item, terminal) && <button type="button" className="icon-button" aria-label={'보류된 메시지 취소: ' + item.preview} title="보류된 메시지 취소" onClick={() => cancel(item)}><X size={13}/></button>}
          <time dateTime={new Date(item.createdAt).toISOString()}>{time(item.createdAt)}</time>
        </li>;
      })}
    </ol>
    <form className="team-chat-form" onSubmit={event => { event.preventDefault(); void send(); }}>
      <select className="select" aria-label="받는 사람" value={to} onChange={event => setTo(event.target.value)}>
        {team.members.map((member, index) => <option key={member.id} value={member.id}>{member.name}{index === 0 ? ' (팀장)' : ''}</option>)}
      </select>
      <textarea className="textarea team-chat-input" rows={1} aria-label={(receiver?.name ?? '구성원') + '에게 보낼 메시지'} placeholder={(receiver?.name ?? '구성원') + '에게 보낼 말 · Enter 보내기, Shift+Enter 줄바꿈'} value={text} maxLength={AGENT_MESSAGE_LIMIT * 2}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
      <button className="button primary" disabled={Boolean(blocker) || !length || length > AGENT_MESSAGE_LIMIT || sending}><Send size={14} aria-hidden="true"/>{sending ? '보내는 중…' : '보내기'}</button>
    </form>
    {blocker && <p className="hint team-chat-blocker" role="status">{blocker}</p>}
    {!blocker && length > AGENT_MESSAGE_LIMIT && <p className="hint team-warning" role="status">메시지는 {AGENT_MESSAGE_LIMIT.toLocaleString('ko-KR')}자까지 보낼 수 있습니다.</p>}
  </section>;
}

/** One line at the bottom: the team, its size, who reports to whom, and saving it as a template. */
export function TeamBar({team, state, onSaveTemplate, onRemove}: {team: Team; state: HostState; onSaveTemplate(): void; onRemove(): void}) {
  const worktrees = team.members.filter(member => member.folder === 'worktree').length;
  const group = state.groups.find(item => item.id === team.groupId);
  return <footer className="team-bar">
    <span className="team-bar-name"><Users size={14} aria-hidden="true"/><strong>{team.name}</strong><span className="hint">구성원 {team.members.length}명{worktrees ? ' · 워크트리 ' + worktrees + '개' : ''}{group ? ' · ' + group.name : ''}</span></span>
    <span className="team-flow" aria-label="일 흐름" title={'일 흐름: ' + teamFlow(team.members).map(item => item.from + ' → ' + item.to).join(', ')}><GitFork size={13} aria-hidden="true"/>{teamFlow(team.members).map(item => <span key={item.from} className="team-chip">{item.from} → {item.to}</span>)}</span>
    <button type="button" className="button subtle" onClick={onSaveTemplate}><BookmarkPlus size={14}/>템플릿으로 저장</button>
    <details className="command-menu"><summary className="icon-button" aria-label={team.name + ' 팀 메뉴'}>···</summary><div>
      <button type="button" className="menu-item danger" onClick={onRemove}>팀 해제…</button>
    </div></details>
  </footer>;
}

/** The AI team list in the sidebar; the open team also lists its members. */
export function TeamSidebarList({state, activeTeamId, activeId, notices, onOpen, onSelectMember}: {state: HostState; activeTeamId: string; activeId: string; notices: TerminalNotices; onOpen(team: Team): void; onSelectMember(team: Team, terminalId: string): void}) {
  const teams = state.teams ?? [];
  return <nav className="team-list" aria-label="AI 팀">
    {teams.map(team => {
      const terminals = team.members.map(member => memberTerminal(state, member)).filter((item): item is TerminalInfo => Boolean(item));
      const status = aggregateTerminalStatus(terminals, notices), active = team.id === activeTeamId;
      return <div key={team.id} className="project-group">
        <div className={'group-row' + (active ? ' active' : '')}>
          <button className="group-main" aria-current={active ? 'page' : undefined} aria-description={terminalStatusDescription(status)} onClick={() => onOpen(team)}><Users size={16}/><span className="group-name">{team.name}<span className="group-meta">구성원 {team.members.length}명</span></span><TerminalStatusBadge status={status}/></button>
        </div>
        {active && <div className="worktree-list" aria-label={team.name + ' 구성원'}>
          {team.members.map((member, index) => {
            const terminal = memberTerminal(state, member), selected = terminal?.id === activeId;
            return <div key={member.id} className={'worktree-row' + (selected ? ' selected' : '')}>
              <button className="worktree-main" disabled={!terminal} aria-current={selected ? 'true' : undefined} aria-description={terminalStatusDescription(terminalStatus(terminal, terminal ? notices.get(terminal.id) : undefined))} title={member.error || modelLabel(member)} onClick={() => terminal && onSelectMember(team, terminal.id)}>
                <span className="worktree-symbol">{index === 0 ? <Crown size={14} aria-label="팀장"/> : <Bot size={15}/>}</span>
                <span className="worktree-details"><strong>{member.name}</strong><span className="worktree-meta"><small>{member.error ? '시작하지 못함' : !terminal ? '터미널 닫힘' : modelLabel(member)}</small></span></span>
                <TerminalStatusBadge status={terminalStatus(terminal, terminal ? notices.get(terminal.id) : undefined)}/>
              </button>
            </div>;
          })}
        </div>}
      </div>;
    })}
    {!teams.length && <p className="hint sidebar-empty">팀으로 시작한 작업이<br/>여기에 모입니다.</p>}
  </nav>;
}
