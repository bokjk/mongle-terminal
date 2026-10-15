import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, PresentationSnapshot, ShellProfile, TerminalInfo } from '../../packages/protocol/index.js';

const START = '\x1b[200~', END = '\x1b[201~';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('agent messages wait for a hook-proven idle agent and reach it as one paste and a separate Enter', { timeout: 60000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-agent-messages-'));
  const signal = path.join(dataDir, 'signal.json'), program = path.join(dataDir, 'fixture.cjs');
  await writeFile(signal, '{}');
  // A stand-in shell: prints Claude's hook OSC or the shell prompt marker when the signal file changes.
  await writeFile(program, "const fs=require('node:fs');let last='';process.stdin.resume();process.stdout.write('FIXTURE_READY');setInterval(()=>{try{const s=fs.readFileSync(process.argv[2],'utf8');if(s===last)return;last=s;const v=JSON.parse(s);if(v.osc)process.stdout.write('\\x1b]777;'+v.osc.replace('TOKEN',process.env.MONGLE_AGENT_TOKEN)+'\\x07');}catch{}},20);");
  let core = new HostCore({ dataDir });
  let kind: ShellProfile['kind'] = 'powershell';
  const patch = (host: HostCore) => {
    const internal = host as any, original = internal.startTerminal.bind(host);
    internal.startTerminal = (info: TerminalInfo, profile: ShellProfile, launch: { cwd: string }, history?: PresentationSnapshot, command?: string) =>
      original(info, { ...profile, kind }, { executable: process.execPath, args: [program, signal, '--'], cwd: launch.cwd }, history, command);
  };
  patch(core);
  t.after(async () => {
    await core.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    await rm(dataDir, { recursive: true, force: true });
  });
  await core.init();
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: 'Desktop view', owner: true };
  core.connect(ctx, () => {});
  const request = (method: string, params: unknown = {}) => core.handle(method, params, ctx);
  const rejects = async (method: string, params: unknown, code: string) => { await assert.rejects(request(method, params), (error: any) => error.code === code, code); };
  const groupId = core.getState().groups[0].id, profileId = core.getState().profiles[0].id;
  const terminal: TerminalInfo = await request('terminals.create', { groupId, profileId, cwd: dataDir });
  const ref = { id: terminal.id, generation: terminal.generation, hostId: core.getState().hostId, bootId: core.getState().bootId };
  const info = () => core.getState().terminals.find(item => item.id === terminal.id)!;
  const runtime = (core as any).runtimes.get(terminal.id);
  const writes: string[] = [];
  const write = runtime.pty.write.bind(runtime.pty);
  runtime.pty.write = (data: string) => { writes.push(data); return write(data); };
  const until = async (check: () => boolean, message: string, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  let nonce = 0;
  // The stand-in shell polls the file: give it time to print each signal before the next replaces it.
  const osc = async (value: string) => { await writeFile(signal, JSON.stringify({ osc: value, nonce: ++nonce })); await new Promise(resolve => setTimeout(resolve, 120)); };
  const sessionId = randomUUID(), session = digest(sessionId);
  const hook = (event: string, extra: Record<string, unknown> = {}) => osc('mongle-agent;TOKEN;' + Buffer.from(JSON.stringify({ event, session, ...extra })).toString('base64'));
  const pasted = (text: string) => writes.indexOf(START + text + END);

  await rejects('agent.message.send', { ...ref, text: 'too early' }, 'AGENT_NOT_RUNNING');
  await hook('SessionStart', { id: sessionId, cwd: dataDir });
  await until(() => (runtime.inbox as any).agentRunning, 'the hook proves Claude runs in this shell');
  await until(() => info().agentReady === true, 'views learn that messages can be sent');
  const first = await request('agent.message.send', { ...ref, text: '  hello\r\nworld\x1b[201~ ' });
  assert.equal(first.pending, true, 'a CLI that just started may not have drawn its input box');
  await until(() => pasted('hello\rworld[201~') >= 0, 'one bracketed paste with clean text');
  await until(() => writes[pasted('hello\rworld[201~') + 1] === '\r', 'Enter follows as its own write');
  assert.equal(info().agentInbox?.delivered, 1);

  await hook('UserPromptSubmit', { id: sessionId });
  await until(() => info().agentStatus === 'working', 'the delivery started a turn');
  await request('agent.message.send', { ...ref, text: 'second' });
  assert.equal(info().agentInbox?.hold, 'busy');
  assert.deepEqual(info().agentInbox?.messages.map(({ preview, from }) => ({ preview, from })), [{ preview: 'second', from: 'Desktop view' }]);
  assert.equal(pasted('second'), -1);
  await hook('Stop');
  await until(() => pasted('second') >= 0, 'delivered when the turn ended');

  await hook('UserPromptSubmit', { id: sessionId });
  await until(() => info().agentStatus === 'working', 'the second delivery started a turn');
  await hook('Stop');
  await until(() => info().agentStatus === 'completed', 'turn finished');
  assert.deepEqual(await request('agent.dnd', { ...ref, enabled: true }), { enabled: true });
  const quiet = await request('agent.message.send', { ...ref, text: 'quiet' });
  assert.equal(info().agentInbox?.hold, 'dnd');
  await request('agent.message.cancel', { ...ref, messageId: quiet.messageId });
  await rejects('agent.message.cancel', { ...ref, messageId: quiet.messageId }, 'AGENT_MESSAGE_GONE');
  await request('agent.dnd', { ...ref, enabled: false });
  assert.equal(info().agentDnd, undefined);

  // A person's draft holds the message; force sends it anyway once nothing else holds it.
  const lease = await request('control.acquire', { ...ref, cols: 80, rows: 24 });
  await request('terminal.ack', { ...ref, seq: lease.frame.seq, epoch: lease.epoch });
  await request('terminal.input', { ...ref, epoch: lease.epoch, inputId: randomUUID(), clientInputSeq: 1, data: '\x1b[I' });
  assert.equal(info().agentInbox?.hold, undefined, 'a focus report is not typing');
  await request('terminal.input', { ...ref, epoch: lease.epoch, inputId: randomUUID(), clientInputSeq: 2, data: 'half' });
  const typed = await request('agent.message.send', { ...ref, text: 'over a draft' });
  assert.equal(info().agentInbox?.hold, 'typing');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(pasted('over a draft'), -1);
  await request('agent.message.force', { ...ref, messageId: typed.messageId });
  await until(() => pasted('over a draft') >= 0, 'force skips only the typing hold');

  // Back at the shell prompt nothing is written, not even the Enter of a paste in flight.
  await hook('UserPromptSubmit', { id: sessionId });
  await until(() => info().agentStatus === 'working', 'working');
  await request('agent.message.send', { ...ref, text: 'never pasted' });
  await osc('mongle-shell;TOKEN');
  await until(() => info().agentInbox?.hold === 'no-agent', 'the prompt belongs to the shell again');
  assert.equal(info().agentReady, undefined);
  await rejects('agent.message.send', { ...ref, text: 'nobody' }, 'AGENT_NOT_RUNNING');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(pasted('never pasted'), -1);

  await request('agent.dnd', { ...ref, enabled: true });
  kind = 'cmd';
  const plain: TerminalInfo = await request('terminals.create', { groupId, profileId, cwd: dataDir });
  await rejects('agent.message.send', { id: plain.id, generation: plain.generation, hostId: ref.hostId, bootId: ref.bootId, text: 'cmd' }, 'AGENT_MESSAGE_UNSUPPORTED');
  assert.ok(core.getState().capabilities?.includes('agent.messages'));

  await core.close();
  core = new HostCore({ dataDir }); patch(core); await core.init();
  const saved = core.getState().terminals.find(item => item.id === terminal.id)!;
  assert.equal(saved.agentDnd, true, 'do-not-disturb is a terminal setting');
  assert.equal(saved.agentInbox, undefined, 'waiting messages live in host memory only');
  assert.equal(saved.agentReady, undefined);
});
