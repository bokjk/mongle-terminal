import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import { isTerminalReportOnly } from '../../packages/shell-profiles/agent-resume.js';
import type { ConnectionContext, PresentationSnapshot, ShellProfile, TerminalInfo } from '../../packages/protocol/index.js';

// Native QA failure: the desktop view attached during boot and its focus report
// (ESC[I, sendFocusMode) reached terminal.input before PowerShell's first prompt,
// which cancelled the pending resume as if the user had typed.
test('terminal protocol reports are not typing; real keys are', () => {
  for (const report of ['\x1b[I', '\x1b[O', '\x1b[I\x1b[O', '\x1b[<0;10;5M\x1b[<0;10;5m', '\x1b[?1;2c', '\x1b[12;40R',
    '\x1b[16;42;0;1;16;1_', '\x1b[65;30;97;0;0;1_']) assert.equal(isTerminalReportOnly(report), true, JSON.stringify(report));
  for (const typed of ['a', 'ls\r', '\r', '\x03', '\x1b[A', '\x1b[65;30;97;1;0;1_', '\x1b[I' + 'x', '\x1b[13;28;13;1;0;1_'])
    assert.equal(isTerminalReportOnly(typed), false, JSON.stringify(typed));
  // A dialog's selection may follow the mouse; focus and device replies still are not user actions.
  assert.equal(isTerminalReportOnly('\x1b[<0;10;5M\x1b[<0;10;5m', false), false);
  for (const report of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[12;40R', '\x1b[65;30;97;0;0;1_']) assert.equal(isTerminalReportOnly(report, false), true, JSON.stringify(report));
});

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-agent-input-'));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const originalPath = process.env[pathKey];
  await writeFile(path.join(dataDir, 'claude.exe'), 'inert fixture; writes are intercepted and never executed');
  process.env[pathKey] = `${dataDir};${originalPath || ''}`;
  const writes = new Map<string, string[]>();
  let core!: HostCore;
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  const boot = async () => {
    core = new HostCore({ dataDir });
    const internal = core as any, original = internal.startTerminal.bind(core);
    internal.startTerminal = async (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) => {
      await original(info, { ...profile, kind: 'powershell' }, { executable: process.execPath, args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], cwd: launch.cwd }, history, command);
      const runtime = internal.runtimes.get(info.id), recorded: string[] = [];
      writes.set(info.id, recorded);
      t.mock.method(runtime.pty, 'write', (value: string | Buffer) => { const text = String(value); if (text !== '\x1b[?1;2c') recorded.push(text); });
    };
    await core.init();
    core.connect(ctx, () => {});
  };
  t.after(async () => {
    await core?.close();
    if (originalPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = originalPath;
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await boot();
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const terminal: TerminalInfo = await request('terminals.create', { groupId: core.getState().groups[0].id, profileId: core.getState().profiles[0].id, cwd: dataDir });
  const sessionId = randomUUID();
  assert.equal(core.reportAgentSession((core as any).runtimes.get(terminal.id).agentToken, { provider: 'claude', sessionId, cwd: dataDir }), true);
  await request('host.shutdown');
  await core.close(); await boot();
  const info = () => core.getState().terminals.find(item => item.id === terminal.id)!;
  const ref = () => ({ id: terminal.id, generation: info().generation, hostId: core.getState().hostId, bootId: core.getState().bootId });
  let seq = 0;
  // Same handshake as the desktop view: acquire control, then acknowledge the synced frame.
  const lease = async () => { const control = await request('control.acquire', { ...ref(), cols: 120, rows: 30 }); await request('terminal.ack', { ...ref(), seq: control.frame.seq, epoch: control.epoch }); return control.epoch as number; };
  const input = (epoch: number, data: string) => request('terminal.input', { ...ref(), epoch, inputId: randomUUID(), clientInputSeq: ++seq, data });
  const prompt = async () => { const runtime = (core as any).runtimes.get(terminal.id); await runtime.engine.write(`\x1b]777;mongle-shell;${runtime.agentToken}\x07`); };
  const typed = () => (writes.get(terminal.id) || []).filter(value => value.includes('--resume'));
  const savedSession = () => (core as any).store.load()?.agentSessions?.[terminal.id]?.session.sessionId as string | undefined;
  const shutdownAndReboot = async () => { writes.delete(terminal.id); await request('host.shutdown'); await core.close(); await boot(); };
  const token = () => (core as any).runtimes.get(terminal.id).agentToken as string;
  return { dataDir, sessionId, lease, input, prompt, typed, savedSession, shutdownAndReboot, token, core: () => core };
}

test('an attaching view’s focus and mouse reports before the first prompt keep the pending resume', { timeout: 30000 }, async t => {
  const h = await fixture(t);
  const epoch = await h.lease();
  await h.input(epoch, '\x1b[I');
  await h.input(epoch, '\x1b[<35;20;7M');
  await h.prompt();
  assert.deepEqual(h.typed(), [`& "${path.join(h.dataDir, 'claude.exe')}" --resume ${h.sessionId}\r`]);
  await h.prompt();
  assert.equal(h.typed().length, 1, 'typed exactly once');
});

test('real typing before the first prompt cancels the resume so the line is never mixed with user input', { timeout: 30000 }, async t => {
  const h = await fixture(t);
  const epoch = await h.lease();
  await h.input(epoch, '\x1b[I');
  await h.input(epoch, 'g');
  await h.prompt();
  assert.deepEqual(h.typed(), []);
});


test('a shutdown before the restored shell’s first prompt keeps the exact resume intent for the next boot', { timeout: 40000 }, async t => {
  const h = await fixture(t);
  assert.equal(h.savedSession(), h.sessionId, 'restore saves the intent under the new generation');
  await h.shutdownAndReboot();
  await h.prompt();
  assert.deepEqual(h.typed(), [`& "${path.join(h.dataDir, 'claude.exe')}" --resume ${h.sessionId}\r`], 'second boot still resumes the same conversation once');
  assert.equal(h.savedSession(), h.sessionId, 'typed line keeps the intent until the CLI reports itself or the shell prompt returns');
  await h.prompt();
  assert.equal(h.typed().length, 1, 'never typed twice');
  assert.equal(h.savedSession(), undefined, 'a later prompt means the resumed CLI is no longer running');
});

test('typing first discards the saved resume intent, so a later boot does not resurrect it', { timeout: 40000 }, async t => {
  const h = await fixture(t);
  const epoch = await h.lease();
  await h.input(epoch, 'g');
  assert.equal(h.savedSession(), undefined);
  await h.shutdownAndReboot(); await h.prompt();
  assert.deepEqual(h.typed(), []);
});

test('endAgentSession clears only the identical provider and UUID of the current shell', { timeout: 40000 }, async t => {
  const h = await fixture(t);
  const token = h.token();
  assert.equal(h.core().endAgentSession(token, { provider: 'claude', sessionId: randomUUID() }), false, 'another conversation');
  assert.equal(h.core().endAgentSession(token, { provider: 'codex', sessionId: h.sessionId }), false, 'same UUID, other provider');
  assert.equal(h.core().endAgentSession('f'.repeat(64), { provider: 'claude', sessionId: h.sessionId }), false, 'unknown shell token');
  assert.equal(h.savedSession(), h.sessionId);
  assert.equal(h.core().endAgentSession(token, { provider: 'claude', sessionId: h.sessionId.toUpperCase() }), true);
  assert.equal(h.savedSession(), undefined);
  assert.equal(h.core().endAgentSession(token, { provider: 'claude', sessionId: h.sessionId }), false, 'nothing left to clear');
});
