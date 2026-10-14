import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, PresentationSnapshot, ShellProfile, Team, TeamMemberSpec, TerminalInfo } from '../../packages/protocol/index.js';
import { BUILT_IN_TEMPLATES, ROLE_DEFAULTS } from '../../packages/host/teams.js';
import { leafIds } from '../../packages/protocol/index.js';

const environment = { executable: async (provider: string) => provider === 'claude' ? 'C:\\fake\\claude.exe' : 'C:\\fake\\codex.cmd', version: async () => '9.9.9', loggedIn: async () => true, gitChanges: async () => 2 };
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
  await request('teams.templates.save', { id: mine.id, name: '내 팀 2', members: mine.members });
  assert.equal((await request('teams.templates')).at(-1).name, '내 팀 2');

  // The pre-start check speaks for each part; worktrees need a project in the group.
  const blocked = await request('teams.check', { ...host, groupId, name: '팀', cwd: dataDir, members: BUILT_IN_TEMPLATES[0].members });
  assert.equal(blocked.ready, false);
  assert.match(blocked.checks.find((item: any) => item.id === 'git').message, /프로젝트\(Git 저장소\) 하나를 먼저/);
  const ready = await request('teams.check', { ...host, groupId, name: '팀', cwd: dataDir, members: mine.members });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.checks.map((item: any) => [item.id, item.status]), [['shell', 'ok'], ['claude', 'ok'], ['codex', 'ok'], ['folder', 'ok'], ['permissions', 'ok']]);
  await rejects('teams.start', { ...host, groupId, name: '팀', cwd: dataDir, members: BUILT_IN_TEMPLATES[0].members }, 'TEAM_NOT_READY');

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
  assert.deepEqual(typed(lead.terminalId), ["& \"C:\\fake\\claude.exe\" --model 'opus' --append-system-prompt-file '" + leadFile + "'\r"]);
  assert.deepEqual(typed(reviewer.terminalId), ["codex -m 'gpt-6-astra' -c ('developer_instructions=' + [IO.File]::ReadAllText('" + reviewerFile + "')) -s read-only -a never\r"]);

  // The reviewer's Codex reports its conversation; after a host restart it reopens with its role and read-only switch.
  const token = (core as any).runtimes.get(reviewer.terminalId).agentToken;
  const sessionId = randomUUID();
  assert.equal(core.reportAgentSession(token, { provider: 'codex', sessionId, cwd: dataDir }), true);
  await core.close();
  core = create(); await core.init();
  assert.deepEqual(core.getState().teams?.map(item => item.name), ['결제 정리'], 'teams survive a restart');
  await until(() => typed(reviewer.terminalId).length > 0, 'the resumed reviewer is typed');
  assert.deepEqual(typed(reviewer.terminalId), ['__MongleCodex resume ' + sessionId + " -m 'gpt-6-astra' -c ('developer_instructions=' + [IO.File]::ReadAllText('" + reviewerFile + "')) -s read-only -a never\r"]);

  // Removing the team keeps the terminals and drops the record and prompt files.
  core.connect(ctx, () => {});
  await request('teams.remove', { teamId: team.id });
  assert.equal(core.getState().teams?.length, 0);
  assert.ok(core.getState().terminals.some(item => item.id === lead.terminalId));
  await assert.rejects(readFile(leadFile, 'utf8'));
});

test('worktree members get their own worktree and branch through the normal worktree job', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-team-worktree-'));
  // The project must live outside the app data folder, which the host never opens as a project.
  const dataDir = path.join(root, 'data'), repo = path.join(root, 'repo');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, windowsHide: true });
  await mkdir(repo); git('init', '-q', '-b', 'main'); await writeFile(path.join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'init');
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
  const attached = await request('projects.attach', { ...host, path: repo });
  const members = [member({}), member({ name: '개발', role: 'developer', model: 'sonnet', reportTo: '설계', folder: 'worktree', instructions: ROLE_DEFAULTS.developer.instructions })];
  const check = await request('teams.check', { ...host, groupId: attached.groupId, name: '팀', cwd: repo, members });
  assert.equal(check.ready, true, JSON.stringify(check.checks));
  assert.match(check.checks.find((item: any) => item.id === 'git').message, /새 워크트리 1개/);
  const team: Team = await request('teams.start', { ...host, groupId: attached.groupId, name: '팀', cwd: repo, members });
  const developer = team.members[1];
  assert.equal(developer.error, undefined);
  const worktree = core.getState().worktrees?.find(item => item.id === developer.worktreeId);
  assert.ok(worktree && worktree.path !== repo, 'the developer works in a new worktree');
  const terminal = core.getState().terminals.find(item => item.id === developer.terminalId)!;
  assert.equal(terminal.worktreeId, worktree!.id);
  assert.equal(terminal.title, '개발');
  assert.match(execFileSync('git', ['branch', '--list', 'worktree/*'], { cwd: repo, encoding: 'utf8' }), /worktree\//);
});
