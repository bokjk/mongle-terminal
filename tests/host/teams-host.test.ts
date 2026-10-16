import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, PresentationSnapshot, ShellProfile, Team, TeamMemberSpec, TerminalInfo } from '../../packages/protocol/index.js';
import { BUILT_IN_TEMPLATES, ROLE_DEFAULTS } from '../../packages/host/teams.js';
import { groupRepositoryIds, leafIds } from '../../packages/protocol/index.js';

const modelCalls: string[] = [];
const environment = { executable: async (provider: string) => provider === 'claude' ? 'C:\\fake\\claude.exe' : 'C:\\fake\\codex.cmd', version: async () => '9.9.9', loggedIn: async () => true, gitChanges: async () => 2, models: async (provider: 'claude' | 'codex') => { modelCalls.push(provider); return provider === 'claude' ? [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }] : [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }]; } };
/** These tests check exact launch lines without the relay, even when run from a Mongle terminal that has a pipe. */
const withoutRelay = (t: { after(fn: () => void): void }) => {
  const pipe = process.env.MONGLE_AGENT_PIPE;
  delete process.env.MONGLE_AGENT_PIPE;
  t.after(() => { if (pipe !== undefined) process.env.MONGLE_AGENT_PIPE = pipe; });
};
const member = (extra: Partial<TeamMemberSpec>): TeamMemberSpec => ({ name: '설계', role: 'lead', provider: 'claude', model: 'opus', reportTo: 'user', instructions: ROLE_DEFAULTS.lead.instructions, folder: 'base', readOnly: false, ...extra });

test('a team starts its members as PowerShell tabs, types each CLI with its role once the shell is ready, and resumes with the role', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-team-host-'));
  const program = path.join(dataDir, 'shell.cjs');
  // A stand-in PowerShell: prints the authenticated prompt marker shortly after it starts.
  await writeFile(program, "process.stdin.resume();setTimeout(()=>process.stdout.write('\\x1b]777;mongle-shell;'+process.env.MONGLE_AGENT_TOKEN+'\\x07'),400);setInterval(()=>{},1000);");
  const pipe = process.env.MONGLE_AGENT_PIPE;
  process.env.MONGLE_AGENT_PIPE = '\\\\.\\pipe\\mongle-agent-' + 'a'.repeat(32);
  const writes = new Map<string, string[]>();
  const create = () => {
    const host = new HostCore({ dataDir, claudeIntegration: { status: 'ready' }, codexIntegration: { status: 'installed', message: '' }, teamEnvironment: environment });
    const internal = host as any, original = internal.startTerminal.bind(host);
    internal.startTerminal = async (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) => {
      await original(info, { ...profile, kind: 'powershell' }, { executable: process.execPath, args: [program, '--'], cwd: launch.cwd }, history, command);
      const runtime = internal.runtimes.get(info.id), write = runtime.pty.write.bind(runtime.pty);
      writes.set(info.id, []);
      runtime.pty.write = (data: string) => { writes.get(info.id)!.push(data); return write(data); };
    };
    return host;
  };
  let core = create();
  t.after(async () => {
    await core.close();
    if (pipe === undefined) delete process.env.MONGLE_AGENT_PIPE; else process.env.MONGLE_AGENT_PIPE = pipe;
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await core.init();
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, () => {});
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const rejects = async (method: string, params: unknown, code: string) => { await assert.rejects(request(method, params), (error: any) => error.code === code, code); };
  const until = async (check: () => boolean, message: string, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  // Terminal replies (device attributes) also reach the PTY; only typed lines matter here.
  const typed = (id: string | undefined) => (writes.get(id!) ?? []).filter(data => !data.startsWith('\x1b'));
  const host = { hostId: core.getState().hostId, bootId: core.getState().bootId };
  const groupId = core.getState().groups[0].id;

  // Templates: built-ins are offered and protected; the user's own are saved, updated and deleted.
  const templates = await request('teams.templates');
  assert.deepEqual(templates.map((item: any) => item.id), BUILT_IN_TEMPLATES.map(item => item.id));
  await rejects('teams.templates.save', { id: BUILT_IN_TEMPLATES[0].id, name: '바꾼 기본', members: BUILT_IN_TEMPLATES[0].members }, 'TEMPLATE_READ_ONLY');
  await rejects('teams.templates.delete', { id: BUILT_IN_TEMPLATES[0].id }, 'TEMPLATE_READ_ONLY');
  await rejects('teams.templates.save', { name: '겹침', members: [member({}), member({ reportTo: '설계' })] }, 'TEAM_INVALID');
  const mine = await request('teams.templates.save', { name: ' 내 팀 ', members: [member({}), member({ name: '검토', role: 'reviewer', provider: 'codex', model: 'gpt-6-astra', reportTo: '설계', readOnly: true })] });
  assert.equal(mine.name, '내 팀');
  // Model lists: each CLI is asked once and the answer is kept for a while.
  const models = await request('teams.models', host);
  assert.deepEqual([models.claude.map((item: any) => item.id), models.codex.map((item: any) => item.id)], [['opus', 'sonnet'], ['gpt-6-astra']]);
  await request('teams.models', host);
  assert.deepEqual(modelCalls, ['claude', 'codex'], 'cached');
  await request('teams.templates.save', { id: mine.id, name: '내 팀 2', members: mine.members });
  assert.equal((await request('teams.templates')).at(-1).name, '내 팀 2');

  // The pre-start check speaks for each part. A folder that cannot hold worktrees does not block the team.
  assert.ok(BUILT_IN_TEMPLATES.every(template => template.members.every(item => item.folder === 'base')), 'built-in teams start in the base folder');
  const withWorktrees = BUILT_IN_TEMPLATES[0].members.map(item => item.role === 'lead' ? item : { ...item, folder: 'worktree' as const });
  const shared = await request('teams.check', { ...host, groupId, name: '팀', cwd: dataDir, members: withWorktrees });
  assert.equal(shared.ready, true, JSON.stringify(shared.checks));
  assert.equal(shared.source, undefined, 'only the result reaches the view');
  const sharedGit = shared.checks.find((item: any) => item.id === 'git');
  assert.equal(sharedGit.status, 'warning');
  assert.match(sharedGit.message, /개발, 검토도 기본 폴더에서 일합니다/);
  const ready = await request('teams.check', { ...host, groupId, name: '팀', cwd: dataDir, members: mine.members });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.checks.map((item: any) => [item.id, item.status]), [['shell', 'ok'], ['claude', 'ok'], ['codex', 'ok'], ['folder', 'ok'], ['permissions', 'ok']]);
  await rejects('teams.start', { ...host, groupId, name: '팀', cwd: dataDir, members: [member({}), member({ reportTo: '설계' })] }, 'TEAM_NOT_READY');

  const team: Team = await request('teams.start', { ...host, groupId, name: '결제 정리', cwd: dataDir, members: mine.members });
  assert.deepEqual(team.members.map(item => [item.name, Boolean(item.terminalId), item.error]), [['설계', true, undefined], ['검토', true, undefined]]);
  const [lead, reviewer] = team.members;
  const state = core.getState();
  assert.deepEqual(state.teams?.map(item => item.id), [team.id]);
  assert.deepEqual([lead, reviewer].map(item => state.terminals.find(terminal => terminal.id === item.terminalId)?.title), ['설계', '검토']);
  const layout = state.groups.find(item => item.id === groupId)!.layout!;
  assert.equal(layout.type, 'leaf', 'members open as tabs in the lead\'s pane');
  assert.deepEqual(leafIds(layout), [lead.terminalId, reviewer.terminalId]);
  const leadFile = path.join(dataDir, 'agent-teams', team.id, lead.id + '.md'), reviewerFile = path.join(dataDir, 'agent-teams', team.id, reviewer.id + '.toml');
  assert.match(await readFile(leadFile, 'utf8'), /당신: 설계 \(팀장\)/);
  assert.match(JSON.parse(await readFile(reviewerFile, 'utf8')), /당신: 검토\. 끝나면 설계에게 보고합니다/);
  await until(() => typed(lead.terminalId).length > 0 && typed(reviewer.terminalId).length > 0, 'each CLI line is typed after the first prompt');
  // Each CLI gets the team relay as an MCP server through its own options; the user's CLI settings stay as they are.
  const relayFolder = path.join(dataDir, 'agent-teams', team.id);
  const leadRelay = path.join(relayFolder, lead.id + '.mcp.json'), reviewerRelay = path.join(relayFolder, reviewer.id + '.mcp.toml');
  assert.deepEqual(typed(lead.terminalId), ["& \"C:\\fake\\claude.exe\" --model 'opus' --mcp-config '" + leadRelay + "' --allowedTools 'mcp__mongle_team' --append-system-prompt-file '" + leadFile + "'\r"]);
  assert.deepEqual(typed(reviewer.terminalId), ["codex -m 'gpt-6-astra' -c ('mcp_servers.mongle_team=' + [IO.File]::ReadAllText('" + reviewerRelay + "')) -c ('developer_instructions=' + [IO.File]::ReadAllText('" + reviewerFile + "')) -s read-only -a never\r"]);
  const script = path.join(dataDir, 'agent-teams', 'mongle-team-relay.cjs');
  assert.deepEqual(JSON.parse(await readFile(leadRelay, 'utf8')).mcpServers.mongle_team, { type: 'stdio', command: process.execPath, args: [script, path.join(relayFolder, lead.id + '.relay.json')] });
  assert.equal(await readFile(reviewerRelay, 'utf8'), "{ command = '" + process.execPath + "', args = ['" + script + "', '" + path.join(relayFolder, reviewer.id + '.relay.json') + "'], startup_timeout_sec = 10, tool_timeout_sec = 30, default_tools_approval_mode = 'approve' }");
  assert.match(await readFile(script, 'utf8'), /^\/\/ Mongle Terminal team relay v1/);
  assert.match(await readFile(leadFile, 'utf8'), /send_message로 구성원에게 맡깁니다/, 'the role prompt names the relay');

  // The team conversation: a message reaches the member's running agent with the team header, and its fate is recorded.
  await rejects('teams.message', { ...host, teamId: team.id, to: lead.id, text: '시작해 주세요' }, 'AGENT_NOT_RUNNING');
  await rejects('teams.message', { ...host, teamId: team.id, to: randomUUID(), text: '누구?' }, 'TEAM_MEMBER_NOT_FOUND');
  const leadToken = (core as any).runtimes.get(lead.terminalId).agentToken;
  assert.equal(core.reportAgentSession(leadToken, { provider: 'claude', sessionId: randomUUID(), cwd: dataDir }), true);
  const sent = await request('teams.message', { ...host, teamId: team.id, to: lead.id, text: ' 로그인 화면을\r\n고쳐 주세요 ' });
  assert.deepEqual([sent.from, sent.to, sent.preview, sent.status, sent.device], ['user', lead.id, '로그인 화면을\n고쳐 주세요', 'waiting', 'Desktop view']);
  const log = () => core.getState().teams![0].messages ?? [];
  await until(() => log()[0]?.status === 'delivered', 'delivered once the agent settles, then recorded');
  assert.ok(writes.get(lead.terminalId!)!.includes('\x1b[200~[몽글 팀 메시지] 사용자 → 설계\r로그인 화면을\r고쳐 주세요\x1b[201~'), 'the header the role prompt announces comes first');
  const cancelled = await request('teams.message', { ...host, teamId: team.id, to: lead.id, text: '취소할 메시지' });
  await request('agent.message.cancel', { id: lead.terminalId, generation: core.getState().terminals.find(item => item.id === lead.terminalId)!.generation, ...host, messageId: cancelled.id });
  assert.equal(log()[1].status, 'cancelled', 'the inbox and the log share the message id');
  const lost = await request('teams.message', { ...host, teamId: team.id, to: lead.id, text: '재시작 전에 보류된 메시지' });
  assert.equal(log()[2].status, 'waiting', 'the previous delivery has not started a turn yet');

  // The relay: a member lists its team and messages a member or the user as itself; its key names the sender.
  const keyOf = async (id: string) => JSON.parse(await readFile(path.join(relayFolder, id + '.relay.json'), 'utf8'));
  const leadKey = await keyOf(lead.id), reviewerKey = await keyOf(reviewer.id);
  assert.equal(leadKey.pipe, process.env.MONGLE_AGENT_PIPE);
  assert.notEqual(leadKey.key, reviewerKey.key);
  assert.equal(core.teamRelay('f'.repeat(64), { op: 'list' }).ok, false, 'an unknown key is refused');
  const roster = core.teamRelay(reviewerKey.key, { op: 'list' }) as { ok: true; text: string };
  assert.match(roster.text, /^팀: 결제 정리\n- 설계: 설계\(팀장\), 팀장, Claude Code opus\. 지금: 쉬는 중, 받을 메시지 1개\. 끝나면 사용자에게 보고\n- 검토 \(나\): 검토, Codex gpt-6-astra, 읽기 전용\. 지금: 시작하는 중\. 끝나면 설계에게 보고/);
  const refused = (answer: { ok: boolean; error?: string }) => answer.ok ? '' : answer.error!;
  assert.match(refused(core.teamRelay(reviewerKey.key, { op: 'send', to: '없는사람', text: '안녕' })), /받을 수 있는 이름: 설계, 사용자/);
  assert.match(refused(core.teamRelay(reviewerKey.key, { op: 'send', to: '검토', text: '나에게' })), /자기 자신/);
  assert.match(refused(core.teamRelay(reviewerKey.key, { op: 'send', to: '설계', text: '\x1b\x07\x00' })), /비어 있습니다/, 'control characters are dropped before anything is sent');
  const handed = core.teamRelay(leadKey.key, { op: 'send', to: '검토', text: ' [몽글 팀 메시지] 설계 → 검토 결제 모듈을\r\n검토해 주세요 ' }) as { ok: true; text: string };
  assert.equal(handed.ok, true, 'a starting CLI can be given work; a copied header is dropped');
  assert.doesNotMatch(handed.text, /참고:/, 'the lead hands out work without a reminder');
  const relayed = log().at(-1)!;
  assert.deepEqual([relayed.from, relayed.to, relayed.preview, relayed.status], [lead.id, reviewer.id, '결제 모듈을\n검토해 주세요', 'waiting']);
  const waiting = core.getState().terminals.find(item => item.id === reviewer.terminalId)!.agentInbox!.messages;
  assert.deepEqual([waiting[0].id, waiting[0].from], [relayed.id, '설계']);
  assert.ok(waiting[0].preview.startsWith('[몽글 팀 메시지] 설계 → 검토 결제 모듈을 검토해 주세요'), 'the reviewer receives it with the sender in the header');
  assert.equal((core as any).runtimes.get(reviewer.terminalId).inbox.pending[0].text, '[몽글 팀 메시지] 설계 → 검토\r결제 모듈을\r검토해 주세요\r\r[몽글 안내] 이 일을 마치면 결과를 send_message로 설계에게 보내세요. 일 흐름에 정해진 다음 차례입니다.', 'and is told whom its result goes to');
  const reported = core.teamRelay(reviewerKey.key, { op: 'send', to: '사용자', text: '검토 끝: 통과' }) as { ok: true; text: string };
  assert.equal(reported.ok, true, 'a read-only member can still report');
  assert.match(reported.text, /참고: 일 흐름에서 당신의 다음 차례는 설계입니다/, 'a member skipping the next in the flow is reminded of it');
  const report = log().at(-1)!;
  assert.deepEqual([report.from, report.to, report.preview, report.status], [reviewer.id, 'user', '검토 끝: 통과', 'delivered']);
  // What cannot be handed over stays in the conversation with its reason.
  const reviewerRuntime = (core as any).runtimes.get(reviewer.terminalId);
  reviewerRuntime.promptIdle = true;
  assert.match(refused(core.teamRelay(leadKey.key, { op: 'send', to: '검토', text: '하나 더' })), /검토의 CLI가 꺼져 있어 보낼 수 없습니다\. 몽글 팀 대화에 "전달하지 못함"으로 남았습니다/);
  reviewerRuntime.promptIdle = false;
  const undelivered = log().at(-1)!;
  assert.deepEqual([undelivered.from, undelivered.to, undelivered.preview, undelivered.status, undelivered.reason], [lead.id, reviewer.id, '하나 더', 'failed', 'CLI 꺼짐']);

  // The reviewer's Codex reports its conversation; after a host restart it reopens with its role and read-only switch.
  const token = (core as any).runtimes.get(reviewer.terminalId).agentToken;
  const sessionId = randomUUID();
  assert.equal(core.reportAgentSession(token, { provider: 'codex', sessionId, cwd: dataDir }), true);
  await core.close();
  core = create(); await core.init();
  assert.deepEqual(core.getState().teams?.map(item => item.name), ['결제 정리'], 'teams survive a restart');
  assert.deepEqual(core.getState().teams![0].messages?.map(item => [item.id, item.status]), [[sent.id, 'delivered'], [cancelled.id, 'cancelled'], [lost.id, 'failed'], [relayed.id, 'failed'], [report.id, 'delivered'], [undelivered.id, 'failed']], 'the log survives; a message the stopped host held was not delivered');
  await until(() => typed(reviewer.terminalId).length > 0, 'the resumed reviewer is typed');
  assert.deepEqual(typed(reviewer.terminalId), ['__MongleCodex resume ' + sessionId + " -m 'gpt-6-astra' -c ('mcp_servers.mongle_team=' + [IO.File]::ReadAllText('" + reviewerRelay + "')) -c ('developer_instructions=' + [IO.File]::ReadAllText('" + reviewerFile + "')) -s read-only -a never\r"]);
  const resumedKey = await keyOf(reviewer.id);
  assert.notEqual(resumedKey.key, reviewerKey.key, 'a restarted host names the member with a new key');
  assert.equal(core.teamRelay(reviewerKey.key, { op: 'list' }).ok, false, 'the previous boot\'s key is refused');
  assert.equal(core.teamRelay(resumedKey.key, { op: 'list' }).ok, true);

  // Removing the team keeps the terminals and drops the record and prompt files, and the team messages still waiting.
  core.connect(ctx, () => {});
  assert.equal(core.teamRelay(resumedKey.key, { op: 'send', to: '설계', text: '해제 전에 보낸 보고' }).ok, true);
  const leadInbox = (core as any).runtimes.get(lead.terminalId).inbox;
  assert.equal(leadInbox.size, 1, 'waits until the lead\'s CLI runs');
  await request('teams.remove', { teamId: team.id });
  assert.equal(leadInbox.size, 0, 'a team message is not delivered once its team is gone');
  assert.equal(core.getState().teams?.length, 0);
  assert.equal(core.teamRelay(resumedKey.key, { op: 'list' }).ok, false, 'a removed team takes its relay keys with it');
  assert.ok(core.getState().terminals.some(item => item.id === lead.terminalId));
  await assert.rejects(readFile(leadFile, 'utf8'));
});

test('deleting a group releases its teams, and a team left without its group can still be removed', { timeout: 30000 }, async t => {
  withoutRelay(t);
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-team-orphan-'));
  const create = () => new HostCore({ dataDir, claudeIntegration: { status: 'ready' }, teamEnvironment: environment });
  let core = create();
  t.after(async () => {
    await core.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await core.init();
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, () => {});
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const kept = await request('groups.create', { name: '남는 그룹', cwd: tmpdir() }), gone = await request('groups.create', { name: '지울 그룹', cwd: tmpdir() });
  // Team records as the host keeps them; whether their terminals run does not matter here.
  const internal = core as any;
  const team = (name: string, groupId: string): Team => ({ id: randomUUID(), name, groupId, cwd: tmpdir(), createdAt: 1, members: [{ ...member({}), id: randomUUID() }] });
  const doomed = team('지울 팀', gone.id), orphan = team('남은 팀', randomUUID()), other = team('다른 팀', kept.id);
  for (const item of [doomed, orphan, other]) { internal.teams.push(item); internal.teamStore.saveTeam(item); await mkdir(path.join(dataDir, 'agent-teams', item.id), { recursive: true }); }
  const group = core.getState().groups.find(item => item.id === gone.id)!;
  await request('groups.delete', { id: gone.id, revision: group.revision, terminate: true });
  assert.deepEqual(core.getState().teams?.map(item => item.name), ['남은 팀', '다른 팀'], 'the deleted group\'s team goes with it');
  assert.deepEqual((await readdir(path.join(dataDir, 'agent-teams'))).sort(), [orphan.id, other.id].sort(), 'with its prompt folder');
  // A team whose group was deleted by an earlier version is removed from its own menu.
  await request('teams.remove', { teamId: orphan.id });
  assert.deepEqual(core.getState().teams?.map(item => item.name), ['다른 팀']);
  await core.close();
  core = create(); await core.init();
  assert.deepEqual(core.getState().teams?.map(item => item.name), ['다른 팀'], 'both are gone after a restart');
});

test('worktree members branch from the team folder\'s repository, linking it to the group, and share a folder without one', { timeout: 120000 }, async t => {
  withoutRelay(t);
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-team-worktree-'));
  // The project must live outside the app data folder, which the host never opens as a project.
  const dataDir = path.join(root, 'data'), repo = path.join(root, 'repo'), plain = path.join(root, 'plain'), fresh = path.join(root, 'fresh');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, windowsHide: true });
  await mkdir(repo); git('init', '-q', '-b', 'main'); await writeFile(path.join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'init');
  await mkdir(plain); await mkdir(fresh); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh, windowsHide: true });
  const program = path.join(root, 'shell.cjs');
  await writeFile(program, "process.stdin.resume();setTimeout(()=>process.stdout.write('\\x1b]777;mongle-shell;'+process.env.MONGLE_AGENT_TOKEN+'\\x07'),300);setInterval(()=>{},1000);");
  const core = new HostCore({ dataDir, claudeIntegration: { status: 'ready' }, teamEnvironment: { ...environment, gitChanges: async () => 0 } });
  const internal = core as any, original = internal.startTerminal.bind(core);
  internal.startTerminal = (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) =>
    original(info, { ...profile, kind: 'powershell' }, { executable: process.execPath, args: [program, '--'], cwd: launch.cwd }, history, command);
  t.after(async () => { await core.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  await core.init();
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, () => {});
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const host = { hostId: core.getState().hostId, bootId: core.getState().bootId };
  // A group the project was never opened in, as when the user made the group or ran git init later.
  const groupId = core.getState().groups[0].id;
  const group = () => core.getState().groups.find(item => item.id === groupId)!;
  const gitRow = (check: any) => check.checks.find((item: any) => item.id === 'git');
  const members = [member({}), member({ name: '개발', role: 'developer', model: 'sonnet', reportTo: '설계', folder: 'worktree', instructions: ROLE_DEFAULTS.developer.instructions })];

  // A plain folder: the team still starts and the worktree member works in the team folder.
  const plainCheck = await request('teams.check', { ...host, groupId, name: '일반', cwd: plain, members });
  assert.equal(plainCheck.ready, true, JSON.stringify(plainCheck.checks));
  assert.deepEqual([gitRow(plainCheck).status, /Git 저장소가 아니라서.*개발도 기본 폴더에서 일합니다/.test(gitRow(plainCheck).message)], ['warning', true], gitRow(plainCheck).message);
  const plainTeam: Team = await request('teams.start', { ...host, groupId, name: '일반', cwd: plain, members });
  assert.deepEqual(plainTeam.members.map(item => [item.folder, item.worktreeId, item.error]), [['base', undefined, undefined], ['base', undefined, undefined]]);
  assert.equal(path.resolve(core.getState().terminals.find(item => item.id === plainTeam.members[1].terminalId)!.cwd), path.resolve(plain));
  assert.equal(groupRepositoryIds(group()).length, 0, 'a folder without a repository links nothing');

  // A new repository without a commit cannot give worktrees yet, and the check says so.
  const freshCheck = await request('teams.check', { ...host, groupId, name: '새 저장소', cwd: fresh, members });
  assert.equal(freshCheck.ready, true);
  assert.match(gitRow(freshCheck).message, /아직 커밋이 없어.*첫 커밋을 만들면/);

  // The repository holding the team folder is found although the group has no project; starting links it.
  const check = await request('teams.check', { ...host, groupId, name: '팀', cwd: repo, members });
  assert.equal(check.ready, true, JSON.stringify(check.checks));
  assert.equal(gitRow(check).status, 'ok');
  assert.match(gitRow(check).message, /새 워크트리 1개를 .*repo\.worktrees에 만듭니다\. 작업 폴더의 저장소\(repo\)를 이 그룹의 프로젝트로 연결합니다/);
  assert.equal(groupRepositoryIds(group()).length, 0, 'the check itself changes nothing');
  const team: Team = await request('teams.start', { ...host, groupId, name: '팀', cwd: repo, members });
  const developer = team.members[1];
  assert.equal(developer.error, undefined);
  const worktree = core.getState().worktrees?.find(item => item.id === developer.worktreeId);
  assert.ok(worktree && worktree.path !== repo, 'the developer works in a new worktree');
  assert.deepEqual(groupRepositoryIds(group()), [worktree!.repositoryId], 'the team folder\'s repository is now the group\'s project');
  assert.equal(team.repositoryId, worktree!.repositoryId);
  const terminal = core.getState().terminals.find(item => item.id === developer.terminalId)!;
  assert.equal(terminal.worktreeId, worktree!.id);
  assert.equal(terminal.title, '개발');
  assert.match(execFileSync('git', ['branch', '--list', 'worktree/*'], { cwd: repo, encoding: 'utf8' }), /worktree\//);

  // Next time the linked project is used directly.
  const again = await request('teams.check', { ...host, groupId, name: '팀 2', cwd: repo, members });
  assert.doesNotMatch(gitRow(again).message, /연결합니다/);
});

test('a team across folders aligns one branch in every repository and gives each CLI the other folders', { timeout: 120000 }, async t => {
  withoutRelay(t);
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-team-scope-'));
  const dataDir = path.join(root, 'data'), front = path.join(root, 'front'), back = path.join(root, 'back'), notes = path.join(root, 'notes');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, windowsHide: true, encoding: 'utf8' });
  for (const [repo, file] of [[front, 'a.txt'], [back, 'b.txt']]) { await mkdir(repo); git(repo, 'init', '-q', '-b', 'main'); await writeFile(path.join(repo, file), 'one'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); }
  // The backend already has the branch, with b.txt changed on it.
  git(back, 'switch', '-q', '-c', 'feature/login'); await writeFile(path.join(back, 'b.txt'), 'two'); git(back, 'commit', '-qam', 'login'); git(back, 'switch', '-q', 'main');
  await mkdir(notes); await writeFile(path.join(front, 'draft.txt'), 'untracked');
  const program = path.join(root, 'shell.cjs');
  await writeFile(program, "process.stdin.resume();setTimeout(()=>process.stdout.write('\\x1b]777;mongle-shell;'+process.env.MONGLE_AGENT_TOKEN+'\\x07'),300);setInterval(()=>{},1000);");
  const writes = new Map<string, string[]>();
  const core = new HostCore({ dataDir, claudeIntegration: { status: 'ready' }, teamEnvironment: { ...environment, gitChanges: async () => 0 } });
  const internal = core as any, original = internal.startTerminal.bind(core);
  internal.startTerminal = async (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) => {
    await original(info, { ...profile, kind: 'powershell' }, { executable: process.execPath, args: [program, '--'], cwd: launch.cwd }, history, command);
    const runtime = internal.runtimes.get(info.id), write = runtime.pty.write.bind(runtime.pty);
    writes.set(info.id, []);
    runtime.pty.write = (data: string) => { writes.get(info.id)!.push(data); return write(data); };
  };
  t.after(async () => { await core.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  await core.init();
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, () => {});
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const host = { hostId: core.getState().hostId, bootId: core.getState().bootId };
  const groupId = core.getState().groups[0].id;
  const [realFront, realBack, realNotes] = await Promise.all([front, back, notes].map(folder => realpath(folder)));
  assert.ok(core.getState().capabilities?.includes('agent.teams.scope'));

  // Offered folders: the group's terminals lead to their repositories; added folders are reported as they are.
  const terminal = await request('terminals.create', { groupId, profileId: core.getState().profiles[0].id, cwd: path.join(back) });
  const offered = (await request('teams.scope', { ...host, groupId })).folders;
  assert.ok(offered.some((item: any) => item.path === realBack && item.git && item.branch === 'main'), JSON.stringify(offered));
  await request('terminals.close', { id: terminal.id, hostId: host.hostId, bootId: host.bootId, generation: terminal.generation }).catch(() => {});
  const added = (await request('teams.scope', { ...host, groupId, paths: [front, notes] })).folders;
  assert.deepEqual(added.map((item: any) => [item.path, item.name, item.git, item.branch, item.changes]), [[realFront, 'front', true, 'main', 1], [realNotes, 'notes', false, undefined, undefined]]);
  assert.ok(added[0].repository, 'working trees of one repository can be told apart');

  const members = [member({}), member({ name: '개발', role: 'developer', provider: 'codex', model: 'gpt-6.1-sol', reportTo: '설계', folder: 'worktree', instructions: ROLE_DEFAULTS.developer.instructions }), member({ name: '검토', role: 'reviewer', provider: 'codex', model: 'gpt-6-astra', reportTo: '설계', readOnly: true, instructions: ROLE_DEFAULTS.reviewer.instructions })];
  const scope = { start: front, folders: [front, back, notes], branch: 'feature/login' };
  const payload = (extra = {}) => ({ ...host, groupId, name: '로그인', cwd: front, members, scope: { ...scope, ...extra } });
  const row = (check: any, label: string) => check.checks.find((item: any) => item.label === label);

  // A local change that the branch also changes stops the check; Git would refuse to switch.
  await writeFile(path.join(back, 'b.txt'), 'local');
  const refused = await request('teams.check', payload());
  assert.equal(refused.ready, false);
  assert.match(row(refused, 'back').message, /main → feature\/login \(있는 브랜치로 바꿈\)\. 저장하지 않은 변경이 이 브랜치와 겹치는 파일 1개\(b\.txt\)/);
  assert.equal(row(refused, 'back').status, 'error');
  git(back, 'checkout', '--', 'b.txt');
  // A merge in progress also stops it.
  await writeFile(path.join(back, '.git', 'MERGE_HEAD'), git(back, 'rev-parse', 'HEAD'));
  assert.match(row(await request('teams.check', payload()), 'back').message, /병합이나 리베이스 같은 Git 작업이 진행 중/);
  await rm(path.join(back, '.git', 'MERGE_HEAD'));
  for (const bad of ['bad name', '-x', 'a..b']) {
    const invalid = await request('teams.check', payload({ branch: bad }));
    assert.equal(invalid.ready, false, bad);
    assert.equal(row(invalid, '브랜치').status, 'error', bad);
  }

  const check = await request('teams.check', payload());
  assert.equal(check.ready, true, JSON.stringify(check.checks));
  assert.deepEqual(['시작 폴더', 'front', 'back', 'notes', 'Git'].map(label => [label, row(check, label)?.status]), [['시작 폴더', 'ok'], ['front', 'warning'], ['back', 'ok'], ['notes', 'ok'], ['Git', 'warning']]);
  assert.match(row(check, 'front').message, /^main → feature\/login \(새로 만듦\) · 저장하지 않은 변경 1개도 함께 옮겨집니다\.$/);
  assert.match(row(check, 'notes').message, /Git 저장소가 아닌 폴더라 브랜치는 바꾸지 않습니다/);
  assert.match(row(check, 'Git').message, /여러 폴더를 함께 쓰는 팀에서는 아직 새 워크트리를 만들지 않습니다\. 새 워크트리로 고른 개발도 기본 폴더에서 일합니다/);
  assert.equal(git(front, 'branch', '--show-current').trim(), 'main', 'the check moves nothing');

  const team: Team = await request('teams.start', payload());
  assert.deepEqual(team.scope, { start: realFront, folders: [realFront, realBack, realNotes], branch: 'feature/login' });
  assert.deepEqual([front, back].map(repo => git(repo, 'branch', '--show-current').trim()), ['feature/login', 'feature/login']);
  assert.equal(await readFile(path.join(front, 'draft.txt'), 'utf8'), 'untracked', 'uncommitted work comes along');
  assert.deepEqual(team.members.map(item => [item.name, item.folder, item.worktreeId, item.error]), [['설계', 'base', undefined, undefined], ['개발', 'base', undefined, undefined], ['검토', 'base', undefined, undefined]]);
  const [lead, developer, reviewer] = team.members;
  const typed = (id: string | undefined) => (writes.get(id!) ?? []).filter(data => !data.startsWith('\x1b'));
  const deadline = Date.now() + 8000;
  while (team.members.some(item => typed(item.terminalId).length === 0)) { assert.ok(Date.now() < deadline, 'each CLI line is typed'); await new Promise(resolve => setTimeout(resolve, 20)); }
  const others = (folders: string[]) => folders.map(folder => "'" + folder + "'");
  assert.ok(typed(lead.terminalId)[0].includes("--add-dir " + others([realBack, realNotes]).join(' ') + ' --append-system-prompt-file'), typed(lead.terminalId)[0]);
  assert.ok(typed(developer.terminalId)[0].startsWith("codex -m 'gpt-6.1-sol' --add-dir " + others([realBack]) + ' --add-dir ' + others([realNotes]) + ' -c '), typed(developer.terminalId)[0]);
  assert.doesNotMatch(typed(reviewer.terminalId)[0], /--add-dir/, 'a read-only Codex gets no writable folder');
  const terminals = core.getState().terminals;
  assert.ok(team.members.every(item => path.resolve(terminals.find(terminal => terminal.id === item.terminalId)!.cwd) === path.resolve(front)), 'every member starts in the start folder');
  const prompt = await readFile(path.join(dataDir, 'agent-teams', team.id, lead.id + '.md'), 'utf8');
  assert.ok(prompt.includes('- back: ' + realBack) && prompt.includes('"feature/login" 브랜치에서 일합니다'), prompt);
});
