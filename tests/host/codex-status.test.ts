import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, PresentationSnapshot, ShellProfile, TerminalInfo } from '../../packages/protocol/index.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('a Codex hook event changes only its own running terminal and reaches connected views', { timeout: 40000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-codex-status-'));
  const core = new HostCore({ dataDir });
  const internal = core as any, original = internal.startTerminal.bind(core);
  internal.startTerminal = (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) =>
    // '--' hands the appended PowerShell integration arguments to the script instead of Node's option parser.
    original(info, { ...profile, kind: 'powershell' }, { executable: process.execPath, args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)', '--'], cwd: launch.cwd }, history, command);
  t.after(async () => {
    await core.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await core.init();
  const sent: string[] = [];
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, message => { sent.push(JSON.stringify(message)); });
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const groupId = core.getState().groups[0].id, profileId = core.getState().profiles[0].id;
  const codex: TerminalInfo = await request('terminals.create', { groupId, profileId, cwd: dataDir });
  const other: TerminalInfo = await request('terminals.create', { groupId, profileId, cwd: dataDir });
  const token: string = internal.runtimes.get(codex.id).agentToken;
  const info = (id: string) => core.getState().terminals.find(item => item.id === id)!;
  const until = async (check: () => boolean, message: string) => {
    for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), message);
  };
  const turn = digest('turn-1');
  assert.equal(core.reportAgentStatus('f'.repeat(64), { event: 'UserPromptSubmit', turn }), false, 'unknown shell token');
  assert.equal(core.reportAgentStatus(token, { event: 'UserPromptSubmit', turn: 'turn-1' }), false, 'a raw turn id is not accepted');
  const before = sent.length;
  assert.equal(core.reportAgentStatus(token, { event: 'UserPromptSubmit', turn }), true);
  await until(() => info(codex.id).agentStatus === 'working', 'Codex is shown working');
  assert.equal(info(codex.id).agentProvider, 'codex');
  assert.equal(info(other.id).agentStatus, undefined, 'another terminal is untouched');
  await until(() => sent.slice(before).some(message => message.includes('"agentProvider":"codex"')), 'connected views receive the status');
  assert.equal(core.reportAgentStatus(token, { event: 'Stop', turn }), true);
  await until(() => info(codex.id).agentStatus === 'completed', 'the turn ended');
  assert.equal(info(codex.id).notificationCount, 1);
  assert.equal(info(codex.id).agentNotificationCount, 1, 'the completion is the agent alert');
  assert.equal(info(codex.id).status, 'running', 'the fixture shell stayed up for the whole check');
});
