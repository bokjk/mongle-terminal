import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILT_IN_TEMPLATES, ROLE_DEFAULTS, rolePromptFile, teamLaunchCommand, teamMemberFlags, teamMessageText, teamProblems, teamRelayConfig, teamRolePrompt, withoutTeamHeader } from '../../packages/host/teams.js';
import { claudeModels, codexModels } from '../../packages/host/team-environment.js';
import { TeamStore } from '../../packages/host/team-store.js';
import type { TeamMemberSpec } from '../../packages/protocol/index.js';

const spec = (extra: Partial<TeamMemberSpec> = {}): TeamMemberSpec => ({ name: '검토', role: 'reviewer', provider: 'codex', model: 'gpt-6-astra', reportTo: 'user', instructions: ROLE_DEFAULTS.reviewer.instructions, folder: 'worktree', readOnly: true, ...extra });

test('built-in templates are valid teams whose first member leads and whose reviewers are read-only', () => {
  assert.equal(BUILT_IN_TEMPLATES.length, 3);
  for (const template of BUILT_IN_TEMPLATES) {
    assert.deepEqual(teamProblems(template.name, template.members), [], template.name);
    for (const member of template.members) if (member.role === 'reviewer') assert.equal(member.readOnly, true);
  }
  assert.ok(BUILT_IN_TEMPLATES.every(template => template.members.every(member => member.folder === 'base')), 'everyone starts in the base folder; a worktree is opt-in');
});

test('a team as written is checked in the user\'s words', () => {
  const lead = spec({ name: '설계', role: 'lead', reportTo: 'user', readOnly: false });
  assert.deepEqual(teamProblems('팀', [lead, spec({ reportTo: '설계' })]), []);
  assert.ok(teamProblems('팀', [lead, spec({ name: '설계', reportTo: '설계' })]).some(p => p.includes('겹칩니다')));
  assert.ok(teamProblems('팀', [lead, spec({ reportTo: '없음' })]).some(p => p.includes('보고 대상')));
  assert.ok(teamProblems('팀', [spec({ name: '검토', reportTo: '검토' })]).some(p => p.includes('보고 대상')), 'nobody reports to themself');
  assert.ok(teamProblems('팀', [lead, spec({ model: "x'; rm" })]).some(p => p.includes('모델')));
  assert.ok(teamProblems('', [lead]).some(p => p.includes('팀 이름')));
  assert.ok(teamProblems('팀', Array.from({ length: 7 }, (_, i) => spec({ name: 'm' + i }))).some(p => p.includes('1~6명')));
});

test('the role prompt tells each member the roster, the lead, its report target and its own role', () => {
  const members = BUILT_IN_TEMPLATES[0].members;
  const prompt = teamRolePrompt({ name: '결제 정리' }, [...members.slice(0, 2), { ...members[2], extra: '결제 쪽 보안을 특히 꼼꼼히' }], 2);
  assert.match(prompt, /"결제 정리" 팀/);
  assert.match(prompt, /- 설계: 설계\(팀장\), 팀장, Claude Code opus\. 끝나면 사용자에게 보고/);
  assert.match(prompt, /당신: 검토\. 끝나면 설계에게 보고합니다/);
  assert.match(prompt, /읽기 전용으로 실행되었습니다/);
  assert.match(prompt, /코드를 직접 고치지 않습니다/);
  assert.match(prompt, /결제 쪽 보안을 특히 꼼꼼히/);
  assert.ok(prompt.endsWith('\n\n'), 'Codex places other developer text right after it');
  assert.equal(JSON.parse(rolePromptFile('codex', prompt)), prompt, 'Codex reads a TOML basic string');
  assert.equal(rolePromptFile('claude', prompt), prompt);
});

test('launch and resume arguments carry the model, the prompt file and the CLI\'s own read-only switch', () => {
  const file = 'C:\\Users\\o\'neil\\agent-teams\\t\\m.toml';
  assert.equal(teamMemberFlags(spec(), file), "-m 'gpt-6-astra' -c ('developer_instructions=' + [IO.File]::ReadAllText('C:\\Users\\o''neil\\agent-teams\\t\\m.toml')) -s read-only -a never");
  assert.equal(teamLaunchCommand(spec({ model: '', readOnly: false }), file), "codex -c ('developer_instructions=' + [IO.File]::ReadAllText('C:\\Users\\o''neil\\agent-teams\\t\\m.toml'))\r");
  const claude = teamLaunchCommand(spec({ provider: 'claude', model: 'sonnet' }), 'C:\\d\\m.md', 'C:\\Users\\u\\.local\\bin\\claude.exe');
  assert.equal(claude, "& \"C:\\Users\\u\\.local\\bin\\claude.exe\" --model 'sonnet' --append-system-prompt-file 'C:\\d\\m.md' --tools 'Read,Grep,Glob'\r");
  assert.equal(teamLaunchCommand(spec({ provider: 'claude' }), 'C:\\d\\m.md'), undefined, 'Claude needs a host-resolved executable');
  assert.equal(teamMemberFlags(spec(), 'relative\\m.toml'), undefined);
  assert.equal(teamMemberFlags(spec(), 'C:\\d\\$(evil).toml'), undefined);
  assert.equal(teamMemberFlags(spec({ model: 'a b' }), file), undefined);
});

test('a team across folders gives each CLI its other folders and names them and the branch in the role prompt', () => {
  const folders = ['C:\\work\\back', "C:\\work\\o'ai"];
  assert.equal(teamLaunchCommand(spec({ provider: 'claude', model: 'opus', readOnly: false }), 'C:\\d\\m.md', 'C:\\bin\\claude.exe', folders),
    "& \"C:\\bin\\claude.exe\" --model 'opus' --add-dir 'C:\\work\\back' 'C:\\work\\o''ai' --append-system-prompt-file 'C:\\d\\m.md'\r");
  assert.equal(teamMemberFlags(spec({ model: '', readOnly: false }), 'C:\\d\\m.toml', folders), "--add-dir 'C:\\work\\back' --add-dir 'C:\\work\\o''ai' -c ('developer_instructions=' + [IO.File]::ReadAllText('C:\\d\\m.toml'))");
  assert.equal(teamMemberFlags(spec(), 'C:\\d\\m.toml', folders), "-m 'gpt-6-astra' -c ('developer_instructions=' + [IO.File]::ReadAllText('C:\\d\\m.toml')) -s read-only -a never", 'a read-only Codex reads everywhere and gets no writable folder');
  assert.equal(teamMemberFlags(spec(), 'C:\\d\\m.toml', ['C:\\w\\$(evil)']), undefined);
  assert.equal(teamMemberFlags(spec(), 'C:\\d\\m.toml', ['relative']), undefined);
  const members = BUILT_IN_TEMPLATES[0].members;
  const prompt = teamRolePrompt({ name: '로그인', scope: { start: 'C:\\work\\front', folders: ['C:\\work\\front', 'C:\\work\\back'], branch: 'feature/login' } }, members, 1);
  assert.match(prompt, /작업 범위\(함께 보고 고칠 폴더\):\n- front: C:\\work\\front \(시작 폴더\)\n- back: C:\\work\\back\n브랜치: .*"feature\/login" 브랜치에서 일합니다/);
  const fromParent = teamRolePrompt({ name: '로그인', scope: { start: 'C:\\work', folders: ['C:\\work\\front', 'C:\\work\\back'] } }, members, 0);
  assert.match(fromParent, /시작 폴더: C:\\work\n/);
  assert.doesNotMatch(fromParent, /브랜치:/);
  assert.doesNotMatch(teamRolePrompt({ name: '혼자', scope: { start: 'C:\\w', folders: ['C:\\w'] } }, members, 0), /작업 범위/, 'one folder needs no scope section');
});

test('the team relay reaches each CLI through its own options, and the role prompt says how to hand out work and report', () => {
  const json = 'C:\\data\\agent-teams\\t\\m.mcp.json', toml = 'C:\\data\\agent-teams\\t\\m.mcp.toml';
  assert.equal(teamMemberFlags({ provider: 'claude', model: 'opus', readOnly: true }, 'C:\\p.md', [], json), "--model 'opus' --mcp-config '" + json + "' --allowedTools 'mcp__mongle_team' --append-system-prompt-file 'C:\\p.md' --tools 'Read,Grep,Glob'");
  assert.equal(teamMemberFlags({ provider: 'codex', model: '', readOnly: true }, 'C:\\p.toml', [], toml), "-c ('mcp_servers.mongle_team=' + [IO.File]::ReadAllText('" + toml + "')) -c ('developer_instructions=' + [IO.File]::ReadAllText('C:\\p.toml')) -s read-only -a never");
  assert.doesNotMatch(teamMemberFlags({ provider: 'claude', model: '', readOnly: false }, 'C:\\p.md', [], 'C:\\a"b.json')!, /mcp-config/, 'an unsafe relay path is left out');
  const node = 'C:\\Program Files\\Mongle\\runtime\\node.exe';
  assert.deepEqual(JSON.parse(teamRelayConfig('claude', node, 'C:\\d\\relay.cjs', 'C:\\d\\k.json')!), { mcpServers: { mongle_team: { type: 'stdio', command: node, args: ['C:\\d\\relay.cjs', 'C:\\d\\k.json'] } } });
  assert.equal(teamRelayConfig('codex', node, 'C:\\d\\relay.cjs', 'C:\\d\\k.json'), "{ command = 'C:\\Program Files\\Mongle\\runtime\\node.exe', args = ['C:\\d\\relay.cjs', 'C:\\d\\k.json'], startup_timeout_sec = 10, tool_timeout_sec = 30, default_tools_approval_mode = 'approve' }");
  assert.equal(teamRelayConfig('codex', "C:\\Users\\o'neil\\node.exe", 'C:\\d\\relay.cjs', 'C:\\d\\k.json'), undefined, 'a quote would end a TOML literal string');
  assert.equal(teamRelayConfig('claude', 'node', 'C:\\d\\relay.cjs', 'C:\\d\\k.json'), undefined, 'only absolute paths');
  const members = BUILT_IN_TEMPLATES[0].members;
  const lead = teamRolePrompt({ name: '팀' }, members, 0, { relay: true }), developer = teamRolePrompt({ name: '팀' }, members, 1, { relay: true });
  assert.match(lead, /send_message로 구성원에게 맡깁니다/);
  assert.match(lead, /send_message로 사용자에게 결과를 보고하세요/);
  assert.doesNotMatch(lead, /아직 구성원에게 직접 보내는 도구는 없습니다/);
  assert.doesNotMatch(developer, /팀장은 사용자가 맡긴 일을/, 'only the lead hands out work');
  assert.match(developer, new RegExp('send_message로 ' + members[1].reportTo + '에게 결과를 보고하세요'));
  // Seen on a user's PC: the lead said "report back to me" and the developer skipped the reviewer.
  assert.match(lead, /결과를 누구에게 보내라고는 적지 마세요/, 'the lead leaves the next step to the work flow');
  assert.match(lead, /다음 차례를 건너뛰고 당신에게 결과를 보냈다면 그 결과를 일 흐름의 다음 구성원에게 넘기세요/);
  assert.match(developer, new RegExp('자기에게 보고하라고 해도 결과는 일 흐름대로 ' + members[1].reportTo + '에게 보냅니다'));
  assert.doesNotMatch(lead, /자기에게 보고하라고 해도/);
  assert.match(teamRolePrompt({ name: '팀' }, members, 0), /아직 구성원에게 직접 보내는 도구는 없습니다/, 'without the relay the user forwards');
  assert.match(lead, /머리글은 몽글이 붙이니 쓰지 마세요/);
});

test('a header a member copied into its message is dropped, so the receiver sees Mongle\'s header once', () => {
  const names = ['설계', '개발', '검토'];
  // As seen in the real app: haiku members started their text with the header of the message they had received.
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 설계 → 개발 작업: 파일 개수를 세어 주세요', names), '작업: 파일 개수를 세어 주세요');
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 개발 → 검토\r파일 4개입니다.', names), '파일 4개입니다.');
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 설계 → 사용자 결과: 통과', names), '결과: 통과');
  assert.equal(withoutTeamHeader(' [몽글 팀 메시지] 설계 → 개발\r[몽글 팀 메시지] 설계 → 개발\r두 번', names), '두 번');
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 내용만 있음', names), '내용만 있음', 'a label without a route loses only the label');
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 설계 → 나중에 볼 것', names), '설계 → 나중에 볼 것', 'a word that only starts with a name stays');
  assert.equal(withoutTeamHeader('결과는 [몽글 팀 메시지] 형식으로 옵니다', names), '결과는 [몽글 팀 메시지] 형식으로 옵니다', 'only the start of the text');
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 설계 → 개발', names), '');
});

test('work one member hands another ends with whom the result goes to; a copied note is dropped', () => {
  assert.equal(teamMessageText('설계', '개발', '로그인 API를\r만들어 주세요', '검토'), '[몽글 팀 메시지] 설계 → 개발\r로그인 API를\r만들어 주세요\r\r[몽글 안내] 이 일을 마치면 결과를 send_message로 검토에게 보내세요. 일 흐름에 정해진 다음 차례입니다.');
  assert.match(teamMessageText('설계', '검토', '봐 주세요', 'user'), /send_message로 사용자에게 보내세요/);
  assert.equal(teamMessageText('사용자', '설계', '시작해 주세요'), '[몽글 팀 메시지] 사용자 → 설계\r시작해 주세요', 'no note without a next step');
  const names = ['설계', '개발', '검토'];
  assert.equal(withoutTeamHeader('[몽글 팀 메시지] 설계 → 개발\r끝났습니다.\r\r[몽글 안내] 이 일을 마치면 결과를 send_message로 검토에게 보내세요. 일 흐름에 정해진 다음 차례입니다.', names), '끝났습니다.');
  assert.equal(withoutTeamHeader('안내는 [몽글 안내] 줄로 옵니다', names), '안내는 [몽글 안내] 줄로 옵니다', 'only a note on its own line');
});

test('model lists come from each CLI: Codex catalog order without hidden models, Claude aliases from its help', () => {
  const catalog = JSON.stringify({ models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'hide', priority: 103 },
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model.', visibility: 'list', priority: 1 },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Our most capable model.', visibility: 'list', priority: 0, model_messages: { instructions_template: 'long' } },
    { slug: 'anthropic/claude-opus-5-5', display_name: 'anthropic/claude-opus-5-5', visibility: 'list', priority: 5 },
    { slug: 'bad name', display_name: 'Bad', visibility: 'list', priority: 2 },
  ] });
  assert.deepEqual(codexModels(catalog), [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Our most capable model.' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model.' },
    { id: 'anthropic/claude-opus-5-5', label: 'anthropic/claude-opus-5-5' },
  ]);
  assert.deepEqual(codexModels('{}'), []);
  const help = "  --fallback-model <model>              Enable automatic fallback\n  --model <model>                       Model for the current session. Provide\n                                        an alias for the latest model (e.g.\n                                        'fable', 'opus', or 'sonnet') or a\n                                        model's full name.\n  -n, --name <name>                     Set a display name";
  assert.deepEqual(claudeModels(help).map(model => model.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.match(claudeModels(help)[1].description!, /Opus 계열의 최신 모델/);
  assert.deepEqual(claudeModels('').map(model => model.id), ['opus', 'sonnet', 'haiku'], 'a help without examples still offers the families');
});

test('teams and user templates live in their own store and survive a reopen', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mongle-team-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new TeamStore(dir);
  store.saveTemplate({ id: 'user:1', name: '내 팀', members: [spec({ name: '설계', role: 'lead', readOnly: false })] });
  store.saveTeam({ id: 't1', name: '팀', groupId: 'g', cwd: 'C:\\w', createdAt: 1, members: [] });
  store.saveTeam({ id: 't1', name: '바뀐 팀', groupId: 'g', cwd: 'C:\\w', createdAt: 1, members: [] });
  store.close();
  store = new TeamStore(dir);
  assert.deepEqual(store.teams().map(team => team.name), ['바뀐 팀']);
  assert.deepEqual(store.templates().map(template => template.id), ['user:1']);
  store.deleteTeam('t1'); store.deleteTemplate('user:1');
  assert.deepEqual([store.teams().length, store.templates().length], [0, 0]);
  store.close();
});
