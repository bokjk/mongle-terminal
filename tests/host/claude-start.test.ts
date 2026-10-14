import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import { startAgentPipe } from '../../packages/host/agent-pipe.js';
import { CLAUDE_HOOK_SOURCE } from '../../packages/host/claude-hook-source.js';
import type { ConnectionContext, PresentationSnapshot, ShellProfile, TerminalInfo } from '../../packages/protocol/index.js';

const START = '\x1b[200~', END = '\x1b[201~';

// Claude Code's fullscreen UI drops the terminal sequence of its SessionStart; the managed hook also
// reports the start through the host pipe. This runs the real hook script, pipe and host together.
test('a Claude start through the pipe makes the agent ready only while the shell has not shown its prompt since the last input', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-claude-start-'));
  const signal = path.join(dataDir, 'signal.json'), program = path.join(dataDir, 'fixture.cjs'), hook = path.join(dataDir, 'hook.cjs');
  await writeFile(signal, '{}');
  await writeFile(hook, CLAUDE_HOOK_SOURCE);
  // A stand-in shell: prints the authenticated shell prompt marker when the signal file changes.
  await writeFile(program, "const fs=require('node:fs');let last='';process.stdin.resume();process.stdout.write('FIXTURE_READY');setInterval(()=>{try{const s=fs.readFileSync(process.argv[2],'utf8');if(s===last)return;last=s;const v=JSON.parse(s);if(v.osc)process.stdout.write('\\x1b]777;'+v.osc.replace('TOKEN',process.env.MONGLE_AGENT_TOKEN)+'\\x07');}catch{}},20);");
  const core = new HostCore({ dataDir, claudeIntegration: { status: 'ready' } });
  let kind: ShellProfile['kind'] = 'powershell';
  const internal = core as any, original = internal.startTerminal.bind(core);
  internal.startTerminal = (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) =>
    original(info, { ...profile, kind }, { executable: process.execPath, args: [program, signal, '--'], cwd: launch.cwd }, history, command);
  const pipe = await startAgentPipe({ start: () => false, end: () => false, claudeStart: (token, session) => core.reportClaudeStart(token, session) });
  t.after(async () => {
    await pipe.close();
    await core.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await core.init();
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, () => {});
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const groupId = core.getState().groups[0].id, profileId = core.getState().profiles[0].id;
  const terminal: TerminalInfo = await request('terminals.create', { groupId, profileId, cwd: dataDir });
  const ref = { id: terminal.id, generation: terminal.generation, hostId: core.getState().hostId, bootId: core.getState().bootId };
  const info = () => core.getState().terminals.find(item => item.id === terminal.id)!;
  const runtime = internal.runtimes.get(terminal.id), token: string = runtime.agentToken;
  const writes: string[] = [];
  const write = runtime.pty.write.bind(runtime.pty);
  runtime.pty.write = (data: string) => { writes.push(data); return write(data); };
  const until = async (check: () => boolean, message: string, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  let nonce = 0;
  const osc = async (value: string) => { await writeFile(signal, JSON.stringify({ osc: value, nonce: ++nonce })); await new Promise(resolve => setTimeout(resolve, 120)); };
  const sessionId = randomUUID();
  // The managed hook as Claude Code runs it: SessionStart on stdin, the shell's token and pipe in its environment.
  const runHook = () => new Promise<{ out: string; code: number | null }>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_AGENT_TOKEN: token, MONGLE_AGENT_PIPE: pipe.name };
    const child = spawn(process.execPath, [hook], { env, windowsHide: true });
    let out = ''; child.stdout.on('data', value => out += value);
    child.on('error', reject); child.on('exit', code => resolve({ out, code }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup', cwd: dataDir }));
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));

  // The shell shows its prompt: a start that arrives now is late (Claude already ended) and is ignored.
  await osc('mongle-shell;TOKEN');
  await until(() => runtime.promptIdle === true, 'the shell prompt');
  assert.equal((await runHook()).code, 0);
  await settle();
  assert.equal(info().agentReady, undefined, 'a report after the prompt never makes the agent ready');

  // A person runs Claude; its hook reports the start only through the pipe (the fullscreen UI dropped the terminal one).
  const lease = await request('control.acquire', { ...ref, cols: 80, rows: 24 });
  await request('terminal.ack', { ...ref, seq: lease.frame.seq, epoch: lease.epoch });
  await request('terminal.input', { ...ref, epoch: lease.epoch, inputId: randomUUID(), clientInputSeq: 1, data: 'claude\r' });
  assert.equal(core.reportClaudeStart('0'.repeat(64), { provider: 'claude', sessionId }), false, 'another token');
  assert.equal(core.reportClaudeStart(token, { provider: 'codex', sessionId }), false, 'only Claude reports its start this way');
  const hooked = await runHook();
  assert.equal(hooked.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(hooked.out)), ['terminalSequence'], 'the terminal report is still written');
  await until(() => info().agentReady === true, 'ready from the pipe alone');
  assert.equal(info().agentProvider, 'claude');
  assert.equal(info().agentStatus, undefined, 'status still comes only from the terminal');
  assert.equal(internal.agentSessions.get(terminal.id)?.session.sessionId, sessionId, 'the conversation is recorded for resuming');
  await request('agent.message.send', { ...ref, text: 'from the team' });
  await until(() => writes.includes(START + 'from the team' + END), 'a message reaches Claude before its first request', 10000);

  // Back at the prompt: not ready, and a repeated late report changes nothing.
  await osc('mongle-shell;TOKEN');
  await until(() => info().agentReady === undefined, 'the prompt belongs to the shell again');
  await runHook(); await settle();
  assert.equal(info().agentReady, undefined);

  // Command Prompt has no prompt marker the host can trust, so its agents never become ready this way.
  kind = 'cmd';
  const plain: TerminalInfo = await request('terminals.create', { groupId, profileId, cwd: dataDir });
  assert.equal(core.reportClaudeStart(internal.runtimes.get(plain.id).agentToken, { provider: 'claude', sessionId }), false);
});
