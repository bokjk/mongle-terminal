import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import { HostStore } from '../../packages/storage/index.js';
import type { ConnectionContext, ServerMessage, ShellProfile, TerminalInfo, PresentationSnapshot } from '../../packages/protocol/index.js';
import type { AgentSessionIdentity } from '../../packages/terminal/agent-status.js';

// Real HostCore/SQLite/VT lifecycle; only the child executable and its input are
// test doubles. Never start Claude/Codex, read transcripts, or submit model work.
async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-agent-private-'));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const originalPath = process.env[pathKey];
  // Inert resolver fixtures; writes are intercepted and these are never executed.
  await writeFile(path.join(dataDir, 'claude.exe'), 'not executable: agent resume test fixture');
  await writeFile(path.join(dataDir, 'codex.exe'), 'not executable: agent resume test fixture');
  process.env[pathKey] = `${dataDir};${originalPath || ''}`;
  let core: HostCore;
  const writes = new Map<string, string[]>();
  const events: ServerMessage[] = [];
  let ctx: ConnectionContext;
  const boot = async () => {
    core = new HostCore({ dataDir });
    const internal = core as any;
    const original = internal.startTerminal.bind(core);
    internal.startTerminal = async (info: TerminalInfo, profile: ShellProfile, launch: { executable: string; args: string[]; cwd: string }, history?: PresentationSnapshot, command?: string) => {
      await original(info, { ...profile, kind: 'cmd' }, {
        executable: process.execPath,
        args: ['-e', "process.stdin.resume();setInterval(()=>{},1000)"],
        cwd: launch.cwd,
      }, history, command);
      const runtime = internal.runtimes.get(info.id);
      const recorded: string[] = []; writes.set(info.id, recorded);
      t.mock.method(runtime.pty, 'write', (value: string) => {
        // xterm device-attributes reply is protocol traffic, not replayed input.
        if (value !== '\x1b[?1;2c') recorded.push(value);
      });
    };
    await core.init();
    ctx = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Agent private fixture', owner: true };
    core.connect(ctx, event => events.push(event));
  };
  t.after(async () => {
    await core?.close();
    if (originalPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = originalPath;
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('mongle-agent-private-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  await boot();
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const ref = (info: TerminalInfo) => ({ id: info.id, generation: info.generation, hostId: core.getState().hostId, bootId: core.getState().bootId });
  const create = (): Promise<TerminalInfo> => request('terminals.create', { groupId: core.getState().groups[0].id, profileId: 'cmd', cwd: dataDir });
  // Use the host's token-authenticated report boundary; never inject the map.
  // Provider hook discovery is independent of host persistence/privacy.
  const remember = (info: TerminalInfo, session: AgentSessionIdentity) => {
    const token = (core as any).runtimes.get(info.id).agentToken;
    assert.equal(core.reportAgentSession(token, session), true);
  };
  const saved = () => ((core as any).store as HostStore).load()!;
  const prompt = async (id: string) => {
    const runtime = (core as any).runtimes.get(id);
    await runtime.engine.write(`\x1b]777;mongle-shell;${runtime.agentToken}\x07`);
  };
  return { get core() { return core; }, dataDir, request, ref, create, remember, saved, prompt, writes, events,
    reboot: async () => { await core.close(); await boot(); } };
}

function noIdentity(value: unknown, sessions: AgentSessionIdentity[]) {
  const serialized = JSON.stringify(value);
  for (const session of sessions) assert.ok(!serialized.includes(session.sessionId), 'exact session UUID leaked to public response');
  assert.ok(!serialized.includes('agentSessions'), 'private resume map leaked');
}

test('agent resume identities stay private in state, remote events, individual RPC and owner settings export', { timeout: 30000 }, async t => {
  const h = await fixture(t);
  const terminal = await h.create();
  const session: AgentSessionIdentity = { provider: 'claude', sessionId: randomUUID(), cwd: h.dataDir };
  h.remember(terminal, session);
  const remote: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Paired observer', owner: false };
  const remoteEvents: ServerMessage[] = [];
  h.core.connect(remote, event => remoteEvents.push(event));
  const renamed = await h.request('terminals.rename', { id: terminal.id, title: 'Public terminal title' });
  assert.equal(h.saved().agentSessions?.[terminal.id]?.session.sessionId, session.sessionId, 'positive control: exact identity must actually be persisted');
  noIdentity([h.core.getState(), await h.request('state.get'), await h.core.handle('state.get', {}, remote), renamed, h.events, remoteEvents, await h.request('settings.export')], [session]);
  await assert.rejects(h.core.handle('settings.export', {}, remote), { code: 'OWNER_REQUIRED' });
  await h.request('host.shutdown');
  await h.reboot();
  noIdentity([h.core.getState(), await h.request('state.get'), await h.request('settings.export'), h.events], [session]);
});

test('two terminals in the same cwd restore their own exact agent session once without latest-session fallback', { timeout: 30000 }, async t => {
  const h = await fixture(t);
  const first = await h.create(), second = await h.create();
  const a: AgentSessionIdentity = { provider: 'claude', sessionId: randomUUID(), cwd: h.dataDir };
  const b: AgentSessionIdentity = { provider: 'claude', sessionId: randomUUID(), cwd: h.dataDir };
  h.remember(first, a); h.remember(second, b);
  await h.request('host.shutdown');
  assert.equal(h.saved().agentSessions?.[first.id]?.session.sessionId, a.sessionId);
  assert.equal(h.saved().agentSessions?.[second.id]?.session.sessionId, b.sessionId);
  await h.reboot();
  assert.notEqual(h.core.getState().terminals.find(info => info.id === first.id)!.generation, first.generation);
  await h.prompt(first.id); await h.prompt(second.id);
  await h.prompt(first.id); await h.prompt(second.id);
  assert.deepEqual(h.writes.get(first.id), [`"${path.join(h.dataDir, 'claude.exe')}" --resume ${a.sessionId}\r`]);
  assert.deepEqual(h.writes.get(second.id), [`"${path.join(h.dataDir, 'claude.exe')}" --resume ${b.sessionId}\r`]);
  noIdentity(await h.request('settings.export'), [a, b]);
});

test('Codex resumes only through the PowerShell lifecycle wrapper; elsewhere a plain shell is restored', { timeout: 30000 }, async t => {
  const h = await fixture(t);
  const terminal = await h.create();
  h.remember(terminal, { provider: 'codex', sessionId: randomUUID(), cwd: h.dataDir });
  await h.request('host.shutdown');
  await h.reboot(); await h.prompt(terminal.id);
  assert.deepEqual(h.writes.get(terminal.id), [], 'cmd shell without the Codex wrapper types nothing');
  assert.equal(h.saved().agentSessions?.[terminal.id], undefined, 'no resume line means no saved intent');
});

test('explicit restart removes the old agent identity before the next host boot', { timeout: 30000 }, async t => {
  const h = await fixture(t);
  const terminal = await h.create();
  const session: AgentSessionIdentity = { provider: 'claude', sessionId: randomUUID(), cwd: h.dataDir };
  h.remember(terminal, session);
  const oldToken = (h.core as any).runtimes.get(terminal.id).agentToken;
  await h.request('terminals.rename', { id: terminal.id, title: 'Before restart' });
  assert.equal(h.saved().agentSessions?.[terminal.id]?.session.sessionId, session.sessionId);
  const restarted: TerminalInfo = await h.request('terminals.restart', { ...h.ref(terminal), confirmed: true });
  assert.notEqual(restarted.generation, terminal.generation);
  assert.equal(h.core.reportAgentSession(oldToken, session), false, 'old generation token must not repopulate the new shell');
  assert.equal((h.core as any).agentSessions.has(terminal.id), false);
  assert.equal(h.saved().agentSessions?.[terminal.id], undefined);
  await h.prompt(terminal.id);
  assert.deepEqual(h.writes.get(terminal.id), []);
  await h.request('host.shutdown'); await h.reboot(); await h.prompt(terminal.id);
  assert.deepEqual(h.writes.get(terminal.id), [], 'explicit new shell must not resurrect its previous agent');
});

for (const failure of ['metadata', 'snapshot'] as const) {
  test(`agent resume ${failure} save failure leaves live identity and shell usable and permits safe shutdown retry`, { timeout: 30000 }, async t => {
    const h = await fixture(t);
    const terminal = await h.create();
    const session: AgentSessionIdentity = { provider: 'claude', sessionId: randomUUID(), cwd: h.dataDir };
    h.remember(terminal, session);
    await h.request('terminals.rename', { id: terminal.id, title: 'Before failed checkpoint' });
    const before = h.saved();
    const db = (h.core as any).store.db;
    db.exec(failure === 'metadata'
      ? "CREATE TRIGGER reject_agent_checkpoint BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;"
      : "CREATE TRIGGER reject_agent_checkpoint BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;");
    try {
      await assert.rejects(h.request('host.shutdown'), { code: 'STORAGE_ERROR' });
      assert.deepEqual(h.saved(), before, 'private session and public metadata must roll back together');
      assert.equal((h.core as any).agentSessions.get(terminal.id).session.sessionId, session.sessionId);
      const current = (await h.request('state.get')).terminals.find((info: TerminalInfo) => info.id === terminal.id);
      assert.equal(current.status, 'running'); assert.equal(current.pid, terminal.pid);
      assert.doesNotThrow(() => process.kill(terminal.pid!, 0));
      const control = await h.request('control.acquire', { ...h.ref(terminal), cols: 80, rows: 24 });
      assert.ok(control.epoch > 0, 'failed shutdown must leave lease acquisition available');
      noIdentity([h.core.getState(), await h.request('settings.export')], [session]);
    } finally { db.exec('DROP TRIGGER reject_agent_checkpoint'); }
    await h.request('host.shutdown');
    assert.equal(h.core.reportAgentSession((h.core as any).runtimes.get(terminal.id).agentToken, null), false, 'late lifecycle clear must not erase committed resume intent');
    assert.equal(h.saved().agentSessions?.[terminal.id]?.session.sessionId, session.sessionId);
    await h.reboot(); await h.prompt(terminal.id);
    assert.deepEqual(h.writes.get(terminal.id), [`"${path.join(h.dataDir, 'claude.exe')}" --resume ${session.sessionId}\r`]);
  });
}
