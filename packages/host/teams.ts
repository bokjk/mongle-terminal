import type { AgentRole, Team, TeamMemberSpec, TeamTemplate } from '../protocol/index.js';

export const TEAM_MAX_MEMBERS = 6;
export const TEAM_INSTRUCTIONS_MAX = 4000;
export const TEAM_EXTRA_MAX = 2000;
/** Names show up in prompts and window titles, never in a command line. */
export const TEAM_NAME = /^[^\x00-\x1f\x7f]{1,30}$/;
/** A branch name a team may align: no whitespace, Git's forbidden characters, or a leading dash (it would read as an option). Git checks the rest. */
export const TEAM_BRANCH = /^(?!-)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/;
/** A model alias or id as the CLI accepts it; empty means the CLI's own default. */
export const TEAM_MODEL = /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,79})?$/;

export interface RoleDefault { label: string; instructions: string; readOnly: boolean }
/** What a role means when it is picked. Every text can be edited per member and per template. */
export const ROLE_DEFAULTS: Record<AgentRole, RoleDefault> = {
  lead: { label: '설계(팀장)', readOnly: false, instructions: [
    '당신은 이 팀의 팀장이며 설계를 맡습니다.',
    '- 사용자의 요청을 작은 작업으로 나누고, 각 작업을 알맞은 구성원에게 맡깁니다. 맡길 때는 목표, 범위, 끝났다고 판단할 기준을 적습니다.',
    '- 큰 코드 수정은 직접 하지 않습니다. 설계와 판단, 결과 확인에 집중합니다.',
    '- 구성원의 보고를 모아 사용자에게 무엇이 끝났고 무엇이 남았는지 알립니다.',
  ].join('\n') },
  developer: { label: '개발', readOnly: false, instructions: [
    '당신은 개발을 맡습니다.',
    '- 명시적으로 맡은 작업만 자기 작업 폴더에서 구현하고 테스트합니다.',
    '- 끝나면 커밋하고, 바꾼 내용과 실행한 테스트, 남은 문제를 보고합니다.',
  ].join('\n') },
  reviewer: { label: '검토', readOnly: true, instructions: [
    '당신은 검토를 맡습니다. 코드를 직접 고치지 않습니다.',
    '- 명시적으로 맡은 범위만 검토합니다.',
    '- 버그, 보안 문제, 빠진 테스트를 찾아 파일과 줄 위치를 붙여 보고합니다.',
    '- 문제가 없으면 억지로 찾지 말고 "통과"와 확인한 범위를 보고합니다.',
  ].join('\n') },
  tester: { label: '테스트', readOnly: false, instructions: [
    '당신은 테스트를 맡습니다.',
    '- 맡은 기능의 테스트를 작성하고 실행합니다.',
    '- 실패하면 재현 방법과 함께 보고합니다.',
  ].join('\n') },
  researcher: { label: '조사', readOnly: true, instructions: [
    '당신은 조사를 맡습니다. 파일을 고치지 않습니다.',
    '- 코드와 문서를 찾아 근거(파일 위치, 링크)와 함께 요약합니다.',
  ].join('\n') },
  custom: { label: '직접 만들기', readOnly: false, instructions: '' },
};

function member(name: string, role: AgentRole, provider: TeamMemberSpec['provider'], model: string, reportTo: string, folder: TeamMemberSpec['folder']): TeamMemberSpec {
  return { name, role, provider, model, reportTo, folder, readOnly: ROLE_DEFAULTS[role].readOnly, instructions: ROLE_DEFAULTS[role].instructions };
}
/** Offered as they are and never overwritten; an edited copy is saved as the user's own template. */
export const BUILT_IN_TEMPLATES: readonly TeamTemplate[] = [
  { id: 'builtin:design-dev-review', name: '설계·개발·검토 3명', builtIn: true, members: [
    member('설계', 'lead', 'claude', 'opus', 'user', 'base'),
    member('개발', 'developer', 'claude', 'sonnet', '검토', 'worktree'),
    member('검토', 'reviewer', 'codex', 'gpt-6-astra', '설계', 'worktree'),
  ] },
  { id: 'builtin:four-dev', name: '4명 개발팀', builtIn: true, members: [
    member('설계', 'lead', 'claude', 'opus', 'user', 'base'),
    member('프런트', 'developer', 'claude', 'sonnet', '검토', 'worktree'),
    member('백엔드', 'developer', 'codex', 'gpt-6.1-sol', '검토', 'worktree'),
    member('검토', 'reviewer', 'codex', 'gpt-6-astra', '설계', 'worktree'),
  ] },
  { id: 'builtin:build-review', name: '구현·검토 2명', builtIn: true, members: [
    member('구현', 'developer', 'codex', '', '검토', 'base'),
    member('검토', 'reviewer', 'claude', 'sonnet', '구현', 'worktree'),
  ] },
];

/** Problems with a team as written, in the user's words; empty when it can start. The first member leads. */
export function teamProblems(name: string, members: readonly TeamMemberSpec[]): string[] {
  const problems: string[] = [];
  if (!TEAM_NAME.test(name.trim())) problems.push('팀 이름은 1~30자로 써 주세요.');
  if (members.length < 1 || members.length > TEAM_MAX_MEMBERS) problems.push('구성원은 1~' + TEAM_MAX_MEMBERS + '명이어야 합니다.');
  const names = members.map(item => item.name.trim());
  members.forEach((item, index) => {
    const label = (index + 1) + '번 구성원';
    if (!TEAM_NAME.test(names[index]) || names[index] === 'user') problems.push(label + '의 이름을 1~30자로 써 주세요.');
    else if (names.indexOf(names[index]) !== index) problems.push('구성원 이름 "' + names[index] + '"이 겹칩니다.');
    if (!TEAM_MODEL.test(item.model)) problems.push(label + '의 모델 이름에 쓸 수 없는 글자가 있습니다.');
    if (item.reportTo !== 'user' && (!names.includes(item.reportTo) || item.reportTo === names[index])) problems.push(label + '의 보고 대상을 다른 구성원이나 "나"로 골라 주세요.');
    if (item.instructions.length > TEAM_INSTRUCTIONS_MAX) problems.push(label + '의 역할 지시문은 ' + TEAM_INSTRUCTIONS_MAX.toLocaleString('ko-KR') + '자까지입니다.');
    if ((item.extra ?? '').length > TEAM_EXTRA_MAX) problems.push(label + '의 덧붙일 말은 ' + TEAM_EXTRA_MAX.toLocaleString('ko-KR') + '자까지입니다.');
  });
  return problems;
}

const providerName = (provider: TeamMemberSpec['provider']) => provider === 'claude' ? 'Claude Code' : 'Codex';
const folderName = (folder: string) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;
const sameFolder = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const reportName = (target: string) => target === 'user' ? '사용자' : target;
/**
 * The role prompt a member's CLI starts with: who is on the team, who leads, whom to report to and how
 * teammates' messages arrive, then the role's own instructions and this team's extra note. It ends with
 * a blank line because Codex places other developer text right after it.
 */
export function teamRolePrompt(team: Pick<Team, 'name' | 'scope'>, members: readonly TeamMemberSpec[], index: number): string {
  const self = members[index], scope = team.scope;
  const roster = members.map((item, at) => '- ' + item.name + ': ' + ROLE_DEFAULTS[item.role].label + (at === 0 ? ', 팀장' : '') + ', ' + providerName(item.provider) + (item.model ? ' ' + item.model : '') + (item.readOnly ? ', 읽기 전용' : '') + '. 끝나면 ' + reportName(item.reportTo) + '에게 보고');
  const lines = [
    '[몽글 팀 안내]',
    '몽글터미널이 이 CLI를 "' + team.name + '" 팀의 구성원으로 실행했습니다.',
    '당신: ' + self.name + (index === 0 ? ' (팀장)' : '') + '. 끝나면 ' + reportName(self.reportTo) + '에게 보고합니다.',
    '구성원:',
    ...roster,
    ...(scope && (scope.folders.length > 1 || scope.branch) ? [
      '작업 범위(함께 보고 고칠 폴더):',
      ...scope.folders.map(folder => '- ' + folderName(folder) + ': ' + folder + (sameFolder(folder, scope.start) ? ' (시작 폴더)' : '')),
      ...(scope.folders.some(folder => sameFolder(folder, scope.start)) ? [] : ['시작 폴더: ' + scope.start]),
      ...(scope.branch ? ['브랜치: 작업 범위의 Git 저장소는 모두 "' + scope.branch + '" 브랜치에서 일합니다. 다른 브랜치로 바꾸지 마세요.'] : []),
    ] : []),
    '다른 구성원이나 사용자가 보낸 메시지는 "[몽글 팀 메시지]"로 시작하는 글로 이 입력창에 들어옵니다.',
    '아직 구성원에게 직접 보내는 도구는 없습니다. 맡은 일을 마치면 답변 첫 줄에 "보고 대상: ' + reportName(self.reportTo) + '"을 적고 결과를 정리하세요. 사용자가 몽글 화면에서 전달합니다.',
    ...(self.readOnly ? ['이 CLI는 파일을 고칠 수 없는 읽기 전용으로 실행되었습니다.'] : []),
    '',
    '[역할 지시문]',
    self.instructions.trim() || '(지시문 없음. 사용자가 맡기는 일을 처리합니다.)',
  ];
  if (self.extra?.trim()) lines.push('', '[이번 팀에서 덧붙일 말]', self.extra.trim());
  return lines.join('\n') + '\n\n';
}

/** Messages kept per team and the part of each shown in the conversation. */
export const TEAM_MESSAGE_LOG = 100;
export const TEAM_MESSAGE_PREVIEW = 200;
/**
 * A team message as it reaches the receiver's input box: the header the role prompt announces, then the
 * text. The text is already cleaned (line breaks are CR inside the paste) and names hold no control characters.
 */
export function teamMessageText(from: string, to: string, text: string): string {
  return '[몽글 팀 메시지] ' + from + ' → ' + to + '\r' + text;
}

/** What the prompt file holds: plain text for Claude, a TOML basic string for Codex's -c value. */
export function rolePromptFile(provider: TeamMemberSpec['provider'], prompt: string): string {
  return provider === 'claude' ? prompt : JSON.stringify(prompt);
}

const UNSAFE_FILE = /[\x00-\x1f\x7f"\x60$]/;
/** A local absolute path that can be passed to a CLI as a PowerShell single-quoted literal. */
export function safeCliPath(value: string) { return /^[a-z]:\\/i.test(value) && !UNSAFE_FILE.test(value); }
/** A PowerShell single-quoted literal. */
function quoted(value: string) { return "'" + value.replaceAll("'", "''") + "'"; }
/**
 * The arguments that make a CLI this member: model, role prompt from its file and, for review or research,
 * the CLI's own read-only switch (Claude: only reading tools; Codex: read-only sandbox and no escalation, so
 * an automatic approval review cannot grant a write). The team's other folders are added to the CLI's working
 * directories (`--add-dir`); a read-only Codex already reads everywhere and gets no writable folder.
 * Also appended when the conversation is resumed.
 */
export function teamMemberFlags(spec: Pick<TeamMemberSpec, 'provider' | 'model' | 'readOnly'>, promptFile: string, folders: readonly string[] = []): string | undefined {
  if (!safeCliPath(promptFile) || !TEAM_MODEL.test(spec.model) || !folders.every(safeCliPath)) return;
  if (spec.provider === 'claude') return [spec.model ? '--model ' + quoted(spec.model) : '', folders.length ? '--add-dir ' + folders.map(quoted).join(' ') : '', '--append-system-prompt-file ' + quoted(promptFile), spec.readOnly ? '--tools ' + quoted('Read,Grep,Glob') : ''].filter(Boolean).join(' ');
  return [spec.model ? '-m ' + quoted(spec.model) : '', ...(spec.readOnly ? [] : folders.map(folder => '--add-dir ' + quoted(folder))), "-c ('developer_instructions=' + [IO.File]::ReadAllText(" + quoted(promptFile) + '))', spec.readOnly ? '-s read-only -a never' : ''].filter(Boolean).join(' ');
}

/**
 * The single line typed into a member's new PowerShell after its first prompt. Claude runs from the
 * host-resolved absolute path; Codex runs through the session's codex function so the managed wrapper
 * adds --no-daemon and reports the conversation to the host.
 */
export function teamLaunchCommand(spec: Pick<TeamMemberSpec, 'provider' | 'model' | 'readOnly'>, promptFile: string, claudePath?: string, folders: readonly string[] = []): string | undefined {
  const flags = teamMemberFlags(spec, promptFile, folders);
  if (!flags) return;
  if (spec.provider === 'codex') return 'codex ' + flags + '\r';
  if (!claudePath || !safeCliPath(claudePath)) return;
  return '& "' + claudePath + '" ' + flags + '\r';
}
