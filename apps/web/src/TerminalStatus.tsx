import { createContext, useContext } from 'react';
import { CircleAlert, MessageCircleQuestion } from 'lucide-react';
import type { TerminalInfo } from '../../../packages/protocol/index';
import type { TerminalNotice } from './use-terminal-notifications';

export type TerminalStatusKind = 'working' | 'completed' | 'attention' | 'error' | 'notification';
/** terminals: how many show any state; unread: how many have unseen notifications, whatever their state. */
export type TerminalStatusCounts = { working: number; attention: number; error: number; unread: number; terminals: number };
export type TerminalStatusSummary = {
  kind: TerminalStatusKind;
  /** The shown alert (or, for several terminals, any alert) is not seen yet on this device. */
  unread: boolean;
  /** Several terminals: another unseen completion or notification sits behind a busier state. */
  alsoUnread?: boolean;
  /** Several terminals: how many show each state. */
  counts?: TerminalStatusCounts;
};
export type TerminalNotices = ReadonlyMap<string, TerminalNotice>;
export const NO_NOTICES: TerminalNotices = new Map();
/** True while disconnected: every status is the last one observed and must not look live. */
export const TerminalStatusStale = createContext(false);

/** Only hook-proven Claude states, otherwise an unseen CLI notification. */
export function terminalStatus(terminal: TerminalInfo | undefined, notice?: TerminalNotice): TerminalStatusSummary | undefined {
  const agent = terminal?.status === 'running' && terminal.agentProvider === 'claude' ? terminal.agentStatus : undefined;
  // A new turn takes precedence over an older unread notification; the dot keeps it discoverable without consuming it.
  if (agent === 'working') return {kind:'working', unread:false, alsoUnread:notice?.unread === true};
  if (agent === 'attention' || agent === 'error') return {kind:agent, unread:notice?.unread === true};
  // A completion is shown only while Claude's own alert is unseen; later plain notifications stay plain.
  if (agent === 'completed' && notice?.agentUnread) return {kind:'completed', unread:true};
  return notice?.unread ? {kind:'notification', unread:true} : undefined;
}

const rank: Record<TerminalStatusKind, number> = {error:5, attention:4, working:3, completed:2, notification:1};
/** The most urgent state wins, and any other unseen alert stays visible beside it. */
export function aggregateTerminalStatus(terminals: readonly TerminalInfo[], notices: TerminalNotices): TerminalStatusSummary | undefined {
  let top: TerminalStatusSummary | undefined, topUnread = false;
  const counts: TerminalStatusCounts = {working:0, attention:0, error:0, unread:0, terminals:0};
  for (const terminal of terminals) {
    const notice = notices.get(terminal.id), status = terminalStatus(terminal, notice);
    if (!status) continue;
    counts.terminals++;
    if (notice?.unread) counts.unread++;
    if (status.kind === 'working' || status.kind === 'attention' || status.kind === 'error') counts[status.kind]++;
    if (!top || rank[status.kind] > rank[top.kind]) { top = status; topUnread = notice?.unread === true; }
  }
  if (!top) return;
  const busy = top.kind === 'working' || top.kind === 'attention' || top.kind === 'error';
  // A request or error icon explains its own unseen alert; a dot keeps every other one visible beside it.
  const others = counts.unread - (topUnread && top.kind !== 'working' ? 1 : 0);
  return {kind:top.kind, unread:counts.unread > 0, alsoUnread:busy && others > 0, counts};
}

const labels = {working:'작업 중', completed:'응답 완료', attention:'확인 요청', error:'오류', notification:'알림'} as const;
export function terminalStatusDescription(status: TerminalStatusSummary | undefined): string | undefined {
  if (!status) return;
  const counts = status.counts;
  if (counts && counts.terminals > 1) {
    return [counts.error ? '오류 ' + counts.error + '개' : '', counts.attention ? '확인 요청 ' + counts.attention + '개' : '',
      counts.working ? '작업 중 ' + counts.working + '개' : '', counts.unread ? '미확인 ' + counts.unread + '개' : ''].filter(Boolean).join(' · ');
  }
  if (status.kind === 'notification') return '확인할 알림';
  if (status.kind === 'working') return labels.working + (status.alsoUnread ? ' · 미확인 알림' : '');
  return labels[status.kind] + (status.unread ? ' · 미확인' : '') + (status.alsoUnread ? ' · 미확인 알림' : '');
}

/** Distinct silhouettes: a turning arc, a request bubble, an alert circle, or one unread dot. */
function StatusIcon({kind}: {kind: TerminalStatusKind}) {
  if (kind === 'working') return <svg className="terminal-status-spinner" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <circle className="terminal-status-track" cx="8" cy="8" r="6"/>
    <path className="terminal-status-arc" d="M8 2a6 6 0 0 1 5.91 7.04"/>
  </svg>;
  if (kind === 'attention') return <MessageCircleQuestion size={13} aria-hidden="true"/>;
  if (kind === 'error') return <CircleAlert size={13} aria-hidden="true"/>;
  return <span className="terminal-status-dot"/>;
}

/** The containing row remains the click target. Shape and text carry the meaning; color only supplements it. */
export function TerminalStatusBadge({status, compact=false}: {status: TerminalStatusSummary | undefined; compact?: boolean}) {
  const stale = useContext(TerminalStatusStale);
  if (!status) return null;
  const description = terminalStatusDescription(status) + (stale ? ' · 연결이 끊겨 마지막으로 확인한 상태' : '');
  const explanation = status.kind === 'completed' ? ' · 응답이 끝났으며 작업 성공을 보장하지 않습니다.' : '';
  return <span className={'terminal-status terminal-status-' + status.kind + (compact ? ' terminal-status-compact' : '')} data-status={status.kind} data-unread={status.unread?'true':undefined} data-also-unread={status.alsoUnread?'true':undefined} data-stale={stale?'true':undefined} role="img" aria-label={description} title={description + explanation}>
    <span className="terminal-status-icon" aria-hidden="true"><StatusIcon kind={status.kind}/>{status.alsoUnread&&<span className="terminal-status-also"/>}</span>
    <span className="terminal-status-label" aria-hidden="true">{labels[status.kind]}</span>
  </span>;
}
