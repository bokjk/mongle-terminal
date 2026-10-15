import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HostState, Team, TeamMessage, TeamScopeFolder, TerminalInfo } from '../../packages/protocol/index.js';
import { BUILT_IN_TEMPLATES, ROLE_DEFAULTS } from '../../packages/host/teams.js';
import { addMember, addScopeFolder, branchMoves, canCancelTeamMessage, draftsFrom, makeLead, modelSuggestions, moveTeamRow, removeMember, renameMember, scopeDraft, scopeProblems, specsFrom, TEAM_LEAD_DEFAULT, teamFlow, teamLayout, teamMessageStatus, teamOfTerminal, teamSendBlocker, toggleScopeFolder, withRole } from '../../apps/web/src/team-model.js';
import { TeamScopePicker } from '../../apps/web/src/TeamScope.js';
import { TeamModelPicker } from '../../apps/web/src/TeamModelPicker.js';
import { TeamBar, TeamChat, TeamSidebarList, TeamWorkspace } from '../../apps/web/src/TeamWorkspace.js';

const terminal = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, groupId: 'g', title: id, profileId: 'pwsh', cwd: 'C:/w', generation: '1', status: 'running', cols: 80, rows: 24, ...extra });
const spec = BUILT_IN_TEMPLATES[0].members;
const team: Team = { id: 'team', name: '로그인 개선', groupId: 'g', cwd: 'C:/w', createdAt: 1, members: spec.map((member, index) => ({ ...member, id: 'm' + index, terminalId: 't' + index })) };
const state = (terminals: TerminalInfo[], extra: Partial<HostState> = {}) => ({ hostId: 'h', bootId: 'b', capabilities: ['agent.messages', 'agent.teams'], groups: [{ id: 'g', name: 'my-app', cwd: 'C:/w', profileId: 'pwsh', revision: 1, layout: null }], terminals, teams: [team], ...extra }) as unknown as HostState;
const request = async () => undefined as never;

test('editing members keeps report targets and role defaults consistent', () => {
  let drafts = draftsFrom(spec);
  assert.deepEqual(specsFrom(drafts).map(member => member.name), ['설계', '개발', '검토']);
  drafts = renameMember(drafts, 2, '리뷰');
  assert.equal(specsFrom(drafts)[1].reportTo, '리뷰', 'whoever reported to the old name follows the rename');
  // The user's case: a lead renamed, another member briefly given the same name, then renamed back.
  let clash = renameMember(draftsFrom(spec), 0, '설계장');
  clash = renameMember(clash, 1, '설계장');
  clash = renameMember(clash, 1, '개발');
  assert.deepEqual(specsFrom(clash).map(member => [member.name, member.reportTo]), [['설계장', 'user'], ['개발', '검토'], ['검토', '설계장']], 'a brief duplicate never moves a report to another member');
  const reviewer = withRole(drafts[1], 'reviewer');
  assert.equal(reviewer.instructions, ROLE_DEFAULTS.reviewer.instructions);
  assert.equal(reviewer.readOnly, true, 'the role brings its read-only default');
  const rewritten = withRole({ ...drafts[1], instructions: '직접 쓴 지시문' }, 'tester');
  assert.equal(rewritten.instructions, '직접 쓴 지시문', 'rewritten instructions are kept');
  const removed = removeMember(drafts, 2);
  assert.deepEqual(specsFrom(removed).map(member => [member.name, member.reportTo]), [['설계', 'user'], ['개발', '설계']], 'reports to a removed member go to the lead');
  const promoted = makeLead(drafts, 2);
  assert.equal(promoted[0].name, '리뷰');
  let grown = drafts;
  for (let i = 0; i < 6; i++) grown = addMember(grown);
  assert.equal(grown.length, 6, 'a team has at most six members');
  assert.equal(new Set(grown.map(member => member.name)).size, 6, 'added members get distinct names');
  assert.deepEqual(teamFlow(spec), [{ from: '설계', to: '나' }, { from: '개발', to: '검토' }, { from: '검토', to: '설계' }]);
  assert.deepEqual(modelSuggestions('claude', BUILT_IN_TEMPLATES).slice(0, 3), ['opus', 'sonnet', 'haiku']);
  assert.ok(modelSuggestions('codex', BUILT_IN_TEMPLATES).includes('gpt-6-astra'));
  assert.ok(!modelSuggestions('codex', BUILT_IN_TEMPLATES).includes('opus'));
});

test('a team message says what became of it and what it waits for', () => {
  const message = (status: TeamMessage['status']): TeamMessage => ({ id: 'x', from: 'user', to: 'm0', preview: '시작해 주세요', createdAt: 1, status });
  const busy = terminal('t0', { agentReady: true, agentInbox: { messages: [{ id: 'x', preview: '…', createdAt: 1, from: 'pc' }], hold: 'busy', delivered: 0 } });
  assert.equal(teamMessageStatus(message('waiting'), busy), '지금 작업이 끝나면 전달');
  assert.equal(teamMessageStatus(message('waiting'), terminal('t0', { agentInbox: { messages: [{ id: 'y', preview: '', createdAt: 1, from: 'pc' }, { id: 'x', preview: '', createdAt: 1, from: 'pc' }], delivered: 0 } })), '앞 메시지 다음에 전달');
  assert.equal(teamMessageStatus(message('waiting'), terminal('t0')), '전달하는 중', 'pasted, Enter not sent yet');
  assert.equal(teamMessageStatus(message('delivered'), busy), '전달됨');
  assert.equal(teamMessageStatus(message('failed'), busy), '전달하지 못함');
  assert.equal(canCancelTeamMessage(message('waiting'), busy), true);
  assert.equal(canCancelTeamMessage(message('delivered'), busy), false);
  assert.equal(canCancelTeamMessage(message('waiting'), terminal('t0')), false, 'already left the inbox');
});

test('sending waits for a running, hook-proven agent and says why it cannot yet', () => {
  assert.match(teamSendBlocker(state([terminal('t0')]), team, 'm0')!, /설계의 Claude Code가 준비되기를 기다리는 중.*확인 질문/);
  assert.doesNotMatch(teamSendBlocker(state([terminal('t0')]), team, 'm0')!, /첫 요청|Codex/, 'Claude is ready at its start; no first request is needed');
  const codex = teamSendBlocker(state([terminal('t2')]), team, 'm2')!;
  assert.match(codex, /검토의 Codex가 준비되기를 기다리는 중.*Hooks need review/);
  assert.doesNotMatch(codex, /Claude/, 'no Claude-only advice for a Codex member');
  assert.equal(teamSendBlocker(state([terminal('t0', { agentReady: true })]), team, 'm0'), undefined);
  assert.match(teamSendBlocker(state([terminal('t0', { status: 'exited' })]), team, 'm0')!, /종료되었습니다/);
  assert.match(teamSendBlocker(state([]), team, 'm1')!, /개발의 터미널이 없습니다/);
  assert.equal(teamOfTerminal(state([]), 't2')?.id, 'team');
  assert.equal(teamOfTerminal(state([]), 'other'), undefined);
});

test('the team screen shows the conversation, the work flow and the member list', () => {
  const messages: TeamMessage[] = [
    { id: 'a', from: 'user', device: 'pc', to: 'm0', preview: '로그인 화면에 Google 버튼 추가', createdAt: Date.UTC(2026, 9, 15, 1, 3), status: 'delivered' },
    { id: 'b', from: 'user', device: 'pc', to: 'm2', preview: '끝나면 함께 봐줘', createdAt: Date.UTC(2026, 9, 15, 1, 13), status: 'waiting' },
  ];
  const withLog = { ...team, messages };
  const terminals = [terminal('t0', { agentReady: true }), terminal('t1'), terminal('t2', { agentReady: true, agentStatus: 'attention', agentInbox: { messages: [{ id: 'b', preview: '', createdAt: 1, from: 'pc' }], hold: 'attention', delivered: 0 } })];
  const chat = renderToStaticMarkup(createElement(TeamChat, { state: state(terminals, { teams: [withLog] }), team: withLog, request, onSelect: () => {}, onError: () => {} }));
  assert.match(chat, /나 → 설계/);
  assert.match(chat, /전달됨/);
  assert.match(chat, /나 → 검토/);
  assert.match(chat, /확인 요청에 답한 뒤 전달/);
  assert.match(chat, /보류된 메시지 취소: 끝나면 함께 봐줘/);
  assert.match(chat, /<option value="m0" selected="">설계 \(팀장\)<\/option>/, 'the lead receives by default');
  const empty = renderToStaticMarkup(createElement(TeamChat, { state: state([terminal('t0')]), team, request, onSelect: () => {}, onError: () => {} }));
  assert.match(empty, /아직 메시지가 없습니다/);
  // Members' own messages and their reports to the user share the conversation.
  const relayed: TeamMessage[] = [
    { id: 'c', from: 'm0', to: 'm1', preview: '로그인 API를 만들어 주세요', createdAt: Date.UTC(2026, 9, 15, 1, 20), status: 'delivered' },
    { id: 'd', from: 'm2', to: 'user', preview: '검토 끝: 통과', createdAt: Date.UTC(2026, 9, 15, 1, 40), status: 'delivered' },
  ];
  const conversation = renderToStaticMarkup(createElement(TeamChat, { state: state(terminals), team: { ...team, messages: relayed }, request, onSelect: () => {}, onError: () => {} }));
  assert.match(conversation, /설계 → 개발<\/button><span class="team-message-text" title="로그인 API를 만들어 주세요">/);
  assert.match(conversation, /disabled="">검토 → 나<\/button>.*<span class="team-message-status delivered">보고<\/span>/, 'a report to the user has no terminal to open');
  assert.match(empty, /준비되기를 기다리는 중/);
  const bar = renderToStaticMarkup(createElement(TeamBar, { team, state: state([]), onSaveTemplate: () => {}, onRemove: () => {} }));
  assert.match(bar, /구성원 3명 · my-app/);
  const withWorktree = { ...team, members: team.members.map((member, index) => index ? { ...member, folder: 'worktree' as const } : member) };
  assert.match(renderToStaticMarkup(createElement(TeamBar, { team: withWorktree, state: state([]), onSaveTemplate: () => {}, onRemove: () => {} })), /구성원 3명 · 워크트리 2개 · my-app/);
  assert.match(bar, /설계 → 나/);
  assert.match(bar, /개발 → 검토/);
  assert.match(bar, /템플릿으로 저장/);
  const list = renderToStaticMarkup(createElement(TeamSidebarList, { state: state(terminals), activeTeamId: 'team', activeId: 't0', notices: new Map(), onOpen: () => {}, onSelectMember: () => {} }));
  assert.match(list, /로그인 개선/);
  assert.match(list, /aria-label="팀장"/);
  assert.match(list, /Claude · opus/);
  assert.match(list, /Codex · gpt-6-astra/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(TeamSidebarList, { state: state(terminals), activeTeamId: '', activeId: '', notices: new Map(), onOpen: () => {}, onSelectMember: () => {} })), /Claude · opus/, 'members show only for the open team');
});
test('a team scope starts in the group folder, takes one working tree per repository and shows the branch it aligns', () => {
  const folders: TeamScopeFolder[] = [
    { path: 'D:\\work', name: 'work', git: false },
    { path: 'D:\\work\\front', name: 'front', git: true, branch: 'main', changes: 2, repository: 'D:\\work\\front\\.git' },
    { path: 'D:\\work\\front.worktrees\\login', name: 'login', git: true, branch: 'login', changes: 0, repository: 'D:\\work\\front\\.git' },
    { path: 'D:\\work\\back', name: 'back', git: true, branch: 'feature/login', changes: 0, repository: 'D:\\work\\back\\.git' },
    { path: 'C:\\Users\\me', name: 'me', git: false },
  ];
  let scope = scopeDraft(folders);
  assert.deepEqual([scope.start, scope.checked], ['D:\\work', ['D:\\work', 'D:\\work\\front', 'D:\\work\\back']], 'one working tree per repository; other plain folders wait to be checked');
  scope = toggleScopeFolder(scope, 'D:\\work');
  assert.equal(scope.start, 'D:\\work\\front', 'unchecking the start moves it to the first checked folder');
  scope = { ...scope, align: true, branch: 'feature/login' };
  assert.deepEqual(branchMoves(scope), [{ name: 'front', from: 'main', to: 'feature/login', same: false }, { name: 'back', from: 'feature/login', to: 'feature/login', same: true }]);
  assert.deepEqual(scopeProblems(scope), []);
  assert.match(scopeProblems({ ...scope, branch: ' ' })[0], /브랜치 이름을 써/);
  assert.match(scopeProblems({ ...scope, branch: 'bad name' })[0], /공백/);
  assert.match(scopeProblems(toggleScopeFolder(scope, 'D:\\work\\front.worktrees\\login')).join(), /front, login: 같은 저장소/);
  assert.deepEqual(scopeProblems({ ...scope, align: false, branch: '' }), [], 'keeping each branch needs no name');
  assert.match(scopeProblems({ ...scope, checked: [] })[0], /하나 이상/);
  const added = addScopeFolder(scope, { path: 'D:\\work\\ai', name: 'ai', git: true, branch: 'main', changes: 0, repository: 'D:\\work\\ai\\.git' });
  assert.ok(added.checked.includes('D:\\work\\ai'));
  assert.equal(addScopeFolder(added, added.folders[5]).folders.length, 6, 'a folder is shown once');

  const markup = renderToStaticMarkup(createElement(TeamScopePicker, { scope, loading: false, error: '', onChange: () => {}, onToggle: () => {}, onAdd: async () => {} }));
  assert.match(markup, /폴더 2개 · front에서 시작/);
  assert.match(markup, /변경 2/);
  assert.match(markup, /Git 아님/);
  assert.match(markup, /aria-checked="true"[^>]*>모두 같은 브랜치로 맞추기/);
  assert.match(markup, /체크한 Git 저장소 2곳을 이 브랜치로 맞춥니다/);
  assert.match(markup, /이미 feature\/login/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(TeamScopePicker, { scope: { ...scope, checked: ['D:\\work'], start: 'D:\\work' }, loading: false, error: '', onChange: () => {}, onToggle: () => {}, onAdd: async () => {} })), /맞추기/, 'no branch choice without a checked repository');
});
test('the team screen splits by the sizes the user dragged, kept per team and team size', () => {
  assert.deepEqual(teamLayout(undefined, 2), { lead: TEAM_LEAD_DEFAULT, rows: [1, 1] });
  assert.deepEqual(teamLayout({ lead: 0.95, rows: [2, 1] }, 2), { lead: 0.8, rows: [2, 1] }, 'the lead keeps room for the others');
  assert.deepEqual(teamLayout({ lead: 0.5, rows: [2, 1] }, 3), { lead: 0.5, rows: [1, 1, 1] }, 'a split saved for another team size starts equal');
  assert.deepEqual(teamLayout({ lead: 'wide', rows: [0, 1] }, 2), { lead: TEAM_LEAD_DEFAULT, rows: [1, 1] });
  assert.deepEqual(moveTeamRow([1, 1, 1], 0, 0.75), [1.5, 0.5, 1]);
  assert.deepEqual(moveTeamRow([1, 1, 1], 1, 0.05).map(value => Math.round(value * 100) / 100), [1, 0.3, 1.7], 'each keeps 15% of the two');
  assert.deepEqual(moveTeamRow([1, 1], 1, 0.5), [1, 1], 'there is no divider after the last member');
  const screen = renderToStaticMarkup(createElement(TeamWorkspace, { state: state([terminal('t0'), terminal('t1'), terminal('t2')]), team, renderPane: (id: string) => createElement('i', null, id), request, onSelect: () => {}, onError: () => {}, onSaveTemplate: () => {}, onRemove: () => {} }));
  assert.match(screen, /style="--team-lead:0\.63fr;--team-rest:0\.37fr"/);
  assert.match(screen, /role="separator"[^>]*aria-label="팀장 칸 너비"[^>]*aria-valuenow="63"/);
  assert.match(screen, /role="separator"[^>]*aria-label="개발와 검토 칸 높이"[^>]*aria-valuenow="50"/);
  assert.equal(screen.match(/role="separator"/g)?.length, 2, 'one handle beside the lead and one between the two others');
});

test('a model is picked from the CLI list, with the CLI default first and any other name typed', () => {
  const models = [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Our most capable model.' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }];
  const picker = renderToStaticMarkup(createElement(TeamModelPicker, { name: '검토', model: 'gpt-6-astra', models, suggestions: [], onChange: () => {} }));
  assert.match(picker, /<select[^>]*aria-label="검토 모델"/);
  assert.match(picker, /<option value="">도구 기본값<\/option><option value="gpt-6-astra" title="Our most capable model." selected="">GPT-6-Astra<\/option><option value="gpt-6.1-sol">GPT-6.1-Sol<\/option><option value="__custom__">직접 입력…<\/option>/);
  assert.match(renderToStaticMarkup(createElement(TeamModelPicker, { name: '검토', model: 'gpt-7-preview', models, suggestions: [], onChange: () => {} })), /<option value="gpt-7-preview" selected="">gpt-7-preview<\/option><option value="__custom__">/, 'a typed model not in the list stays chosen');
  assert.match(renderToStaticMarkup(createElement(TeamModelPicker, { name: '검토', model: 'opus', suggestions: ['opus'], onChange: () => {} })), /<input[^>]*list=/, 'without a list it stays a box with suggestions');
});
