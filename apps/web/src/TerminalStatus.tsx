import { Bell, Circle, CircleAlert, MessageCircleQuestion } from 'lucide-react';
import type { TerminalInfo } from '../../../packages/protocol/index';

export type TerminalStatusSummary = { kind: 'working' | 'completed' | 'attention' | 'error' | 'notification'; unread: boolean };

/** A new turn takes visual precedence over an older unread notification, without consuming its receipt. */
export function terminalStatus(terminal: TerminalInfo | undefined, unread: boolean): TerminalStatusSummary | undefined {
  const kind = terminal?.status === 'running' && terminal.agentProvider === 'claude' ? terminal.agentStatus : undefined;
  if (kind === 'completed' && !unread) return;
  if (kind && kind !== 'idle') return {kind, unread: kind === 'working' ? false : unread};
  return unread ? {kind:'notification', unread:true} : undefined;
}

const priority = (status: TerminalStatusSummary) => status.kind === 'error' ? 6 : status.kind === 'attention' ? 5 : status.kind === 'working' ? 4 : status.unread ? 3 : 2;
export function aggregateTerminalStatus(terminals: readonly TerminalInfo[], unread: ReadonlySet<string>): TerminalStatusSummary | undefined {
  let result: TerminalStatusSummary | undefined;
  for (const terminal of terminals) {
    const status = terminalStatus(terminal, unread.has(terminal.id));
    if (status && (!result || priority(status) > priority(result) || (priority(status) === priority(result) && status.unread && !result.unread))) result = status;
  }
  return result;
}

const labels = {working:'작업 중', completed:'응답 완료', attention:'확인 요청', error:'오류', notification:'알림'} as const;
const icons = {working:Circle, completed:Bell, attention:MessageCircleQuestion, error:CircleAlert, notification:Bell};
export function terminalStatusDescription(status: TerminalStatusSummary | undefined): string | undefined {
  if (!status) return;
  return status.kind === 'notification' ? '확인할 알림' : `${labels[status.kind]}${status.unread ? ' · 미확인' : ''}`;
}

/** The containing row remains the click target. Color supplements an icon and a readable label. */
export function TerminalStatusBadge({status, compact=false}: {status: TerminalStatusSummary | undefined; compact?: boolean}) {
  if (!status) return null;
  const Icon = icons[status.kind], description = terminalStatusDescription(status);
  const explanation = status.kind === 'completed' ? ' · 응답이 끝났으며 작업 성공을 보장하지 않습니다.' : '';
  return <span className={`terminal-status terminal-status-${status.kind}${compact?' terminal-status-compact':''}`} data-status={status.kind} data-unread={status.unread?'true':undefined} role="img" aria-label={description} title={`${description}${explanation}`}>
    <Icon size={14} className={status.kind==='working'?'terminal-working-pulse':undefined} aria-hidden="true"/>
    <span className="terminal-status-label" aria-hidden="true">{labels[status.kind]}</span>
  </span>;
}
