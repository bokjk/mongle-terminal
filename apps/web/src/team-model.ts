// What the AI team screens decide, kept apart from React so it stays easy to test.
import { ROLE_DEFAULTS, TEAM_MAX_MEMBERS, teamProblems } from '../../../packages/host/teams';
import type { AgentRole, HostState, Team, TeamMemberSpec, TeamMessage, TeamTemplate, TerminalInfo } from '../../../packages/protocol/index';
import { agentHoldDescription } from './AgentMessage';

export { ROLE_DEFAULTS, TEAM_MAX_MEMBERS, teamProblems };
export const ROLES: AgentRole[] = ['lead', 'developer', 'reviewer', 'tester', 'researcher', 'custom'];
/** The Claude Code aliases that always mean the latest model of each family. */
export const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'];
export const DEFAULT_TEMPLATE_KEY = 'mongle.team.defaultTemplate';

export const providerLabel = (provider: TeamMemberSpec['provider']) => provider === 'claude' ? 'Claude Code' : 'Codex';
/** "Claude · opus", or the CLI's own default when no model is set. */
export const modelLabel = (member: Pick<TeamMemberSpec, 'provider' | 'model'>) => (member.provider === 'claude' ? 'Claude' : 'Codex') + ' · ' + (member.model || '기본 모델');
export const reportLabel = (target: string) => target === 'user' ? '나' : target;

/** Suggestions for the model box: the provider's aliases and every model already written for it. */
export function modelSuggestions(provider: TeamMemberSpec['provider'], templates: readonly TeamTemplate[]): string[] {
  const used = templates.flatMap(template => template.members).filter(member => member.provider === provider && member.model).map(member => member.model);
  return [...new Set([...(provider === 'claude' ? CLAUDE_MODEL_ALIASES : []), ...used])];
}

/**
 * A member row being edited. key keeps React rows stable, and reportKey points at the row (or 'user') this
 * member reports to, so renaming or briefly duplicating a name never moves a report to another member.
 * reportTo keeps the written name only for a target that is not in the team.
 */
export type MemberDraft = TeamMemberSpec & { key: string; reportKey: string };
let nextKey = 0;
const key = () => 'member-' + (++nextKey);
export function draftsFrom(members: readonly TeamMemberSpec[]): MemberDraft[] {
  const keyed = members.map(member => ({ ...member, key: key() }));
  return keyed.map(member => ({ ...member, reportKey: member.reportTo === 'user' ? 'user' : keyed.find(other => other !== member && other.name === member.reportTo)?.key ?? '' }));
}
/** The report target's current name; a target missing from the team keeps its written name. */
export function reportName(drafts: readonly MemberDraft[], member: MemberDraft): string {
  return member.reportKey === 'user' ? 'user' : drafts.find(other => other.key === member.reportKey)?.name ?? member.reportTo;
}
export const specsFrom = (drafts: readonly MemberDraft[]): TeamMemberSpec[] => drafts.map(member => {
  const { key: _key, reportKey: _reportKey, ...spec } = member;
  return { ...spec, reportTo: reportName(drafts, member), ...(spec.extra?.trim() ? { extra: spec.extra } : { extra: undefined }) };
});

/** Picking a role brings its instructions and read-only default, unless the user already rewrote the instructions. */
export function withRole(member: MemberDraft, role: AgentRole): MemberDraft {
  const before = ROLE_DEFAULTS[member.role], after = ROLE_DEFAULTS[role];
  const untouched = !member.instructions.trim() || member.instructions === before.instructions;
  return { ...member, role, readOnly: after.readOnly, instructions: untouched ? after.instructions : member.instructions };
}
/** Reports follow the row, so everyone who reported to this member still does under the new name. */
export function renameMember(drafts: readonly MemberDraft[], index: number, name: string): MemberDraft[] {
  return drafts.map((member, at) => at === index ? { ...member, name } : member);
}
/** Removing a member sends whoever reported to it to the lead (or to the user when the lead reported to it). */
export function removeMember(drafts: readonly MemberDraft[], index: number): MemberDraft[] {
  const removed = drafts[index].key, rest = drafts.filter((_, at) => at !== index);
  const lead = rest[0]?.key;
  return rest.map((member, at) => member.reportKey !== removed ? member : { ...member, reportKey: at === 0 || !lead ? 'user' : lead });
}
/** A new developer that reports to the lead, named so it does not clash. */
export function addMember(drafts: readonly MemberDraft[]): MemberDraft[] {
  if (drafts.length >= TEAM_MAX_MEMBERS) return [...drafts];
  const names = new Set(drafts.map(member => member.name));
  let name = '개발', n = 2;
  while (names.has(name)) name = '개발 ' + n++;
  const role: AgentRole = drafts.length ? 'developer' : 'lead';
  return [...drafts, { key: key(), name: drafts.length ? name : '설계', role, provider: 'claude', model: drafts.length ? 'sonnet' : 'opus', reportTo: drafts[0]?.name ?? 'user', reportKey: drafts[0]?.key ?? 'user', instructions: ROLE_DEFAULTS[role].instructions, folder: drafts.length ? 'worktree' : 'base', readOnly: ROLE_DEFAULTS[role].readOnly }];
}
/** Moves a member to the top, which makes it the lead. */
export function makeLead(drafts: readonly MemberDraft[], index: number): MemberDraft[] {
  if (index <= 0) return [...drafts];
  return [drafts[index], ...drafts.filter((_, at) => at !== index)];
}

/** "설계 → 나", "개발 → 검토": who reports to whom, in member order. */
export function teamFlow(members: readonly Pick<TeamMemberSpec, 'name' | 'reportTo'>[]): { from: string; to: string }[] {
  return members.map(member => ({ from: member.name, to: reportLabel(member.reportTo) }));
}

export function memberTerminal(state: HostState, member: Team['members'][number]): TerminalInfo | undefined {
  return member.terminalId ? state.terminals.find(terminal => terminal.id === member.terminalId) : undefined;
}
export function teamOfTerminal(state: HostState | undefined, terminalId: string): Team | undefined {
  return state?.teams?.find(team => team.members.some(member => member.terminalId === terminalId));
}

/** What happened to a message, in the user's words. A waiting one says what it waits for. */
export function teamMessageStatus(message: TeamMessage, receiver: TerminalInfo | undefined): string {
  if (message.status === 'delivered') return '전달됨';
  if (message.status === 'cancelled') return '취소됨';
  if (message.status === 'failed') return '전달하지 못함';
  const waiting = receiver?.agentInbox?.messages ?? [];
  const at = waiting.findIndex(item => item.id === message.id);
  if (at === 0) return agentHoldDescription(receiver?.agentInbox?.hold);
  if (at > 0) return '앞 메시지 다음에 전달';
  return '전달하는 중';
}
/** Only a message still in the receiver's inbox can be cancelled. */
export function canCancelTeamMessage(message: TeamMessage, receiver: TerminalInfo | undefined): boolean {
  return message.status === 'waiting' && receiver?.status === 'running' && (receiver.agentInbox?.messages ?? []).some(item => item.id === message.id);
}

/** Why the chosen member cannot take a message now, or undefined when it can. */
export function teamSendBlocker(state: HostState, team: Team, memberId: string): string | undefined {
  const member = team.members.find(item => item.id === memberId);
  if (!member) return '받을 구성원을 골라 주세요.';
  const terminal = memberTerminal(state, member);
  if (!terminal) return member.name + '의 터미널이 없습니다.' + (member.error ? ' ' + member.error : '');
  if (terminal.status !== 'running') return member.name + '의 터미널이 종료되었습니다. 터미널을 다시 열고 CLI를 실행해 주세요.';
  if (!terminal.agentReady) return member.name + '의 ' + providerLabel(member.provider) + '가 준비되기를 기다리는 중입니다. 터미널에 폴더 신뢰 같은 확인 질문이 떠 있으면 먼저 답해 주세요.' + (member.provider === 'claude' ? ' Claude Code는 첫 요청을 보낸 뒤 준비될 수 있습니다.' : ' Codex는 훅 신뢰 확인(Hooks need review)을 마쳐야 준비됩니다.');
  if ((terminal.agentInbox?.messages.length ?? 0) >= 10) return member.name + '에게 보류 중인 메시지가 10개입니다. 전달되거나 취소된 뒤 보내 주세요.';
}
