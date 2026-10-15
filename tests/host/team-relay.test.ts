import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgentPipe, type TeamRelayRequest } from '../../packages/host/agent-pipe.js';
import { TEAM_RELAY_SOURCE } from '../../packages/host/team-relay-source.js';

test('a member CLI speaks MCP to the team relay, which asks the host over the pipe with the member key', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mongle-team-relay-'));
  const key = randomBytes(32).toString('hex'), asked: [string, TeamRelayRequest][] = [];
  const pipe = await startAgentPipe({ start: () => false, end: () => false, team: async (from, request) => {
    asked.push([from, request]);
    if (request.op === 'list') return { ok: true, text: '팀: 시험' };
    return request.to === '검토' ? { ok: true, text: '검토에게 보냈습니다.' } : { ok: false, error: '"누구"라는 구성원이 없습니다.' };
  } });
  const script = path.join(dir, 'relay.cjs'), keyFile = path.join(dir, 'member.relay.json');
  await writeFile(script, TEAM_RELAY_SOURCE);
  await writeFile(keyFile, JSON.stringify({ pipe: pipe.name, key }));
  const child = spawn(process.execPath, [script, keyFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => { child.kill(); await pipe.close(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir())); await rm(dir, { recursive: true, force: true }); });
  const replies = new Map<number, any>();
  let out = '', next = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    out += chunk;
    for (let end = out.indexOf('\n'); end >= 0; end = out.indexOf('\n')) { const message = JSON.parse(out.slice(0, end)); out = out.slice(end + 1); replies.set(message.id, message); }
  });
  const call = async (method: string, params?: unknown) => {
    const id = ++next;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    const deadline = Date.now() + 8000;
    while (!replies.has(id)) { assert.ok(Date.now() < deadline, method + ' is answered'); await new Promise(resolve => setTimeout(resolve, 10)); }
    return replies.get(id);
  };
  const tool = (name: string, args: unknown) => call('tools/call', { name, arguments: args }).then(reply => reply.result);

  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.deepEqual([init.result.protocolVersion, init.result.capabilities, init.result.serverInfo.name], ['2025-06-18', { tools: { listChanged: false } }, 'mongle-team']);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = (await call('tools/list')).result.tools;
  assert.deepEqual(listed.map((item: any) => [item.name, item.annotations.readOnlyHint, item.inputSchema.required ?? []]), [['list_agents', true, []], ['send_message', false, ['to', 'text']]]);
  assert.deepEqual(await tool('list_agents', {}), { content: [{ type: 'text', text: '팀: 시험' }] });
  assert.deepEqual(await tool('send_message', { to: '검토', text: '결제 모듈을 봐 주세요' }), { content: [{ type: 'text', text: '검토에게 보냈습니다.' }] });
  assert.deepEqual(await tool('send_message', { to: '누구', text: '안녕' }), { content: [{ type: 'text', text: '"누구"라는 구성원이 없습니다.' }], isError: true });
  assert.equal((await tool('send_message', { to: '검토' })).isError, true, 'a missing text stops before the host');
  assert.equal((await call('resources/list')).error.code, -32601);
  assert.deepEqual((await call('ping')).result, {});
  assert.deepEqual(asked, [[key, { op: 'list' }], [key, { op: 'send', to: '검토', text: '결제 모듈을 봐 주세요' }], [key, { op: 'send', to: '누구', text: '안녕' }]], 'only the member key and the call reach the host');

  // A broken key file or a host that does not take the request ends the call with a reason for the CLI.
  await writeFile(keyFile, JSON.stringify({ pipe: pipe.name, key: 'nope' }));
  assert.match((await tool('list_agents', {})).content[0].text, /연결 정보를 읽지 못했습니다/);
  const old = await startAgentPipe({ start: () => false, end: () => false });
  t.after(() => old.close());
  await writeFile(keyFile, JSON.stringify({ pipe: old.name, key }));
  const unanswered = await tool('list_agents', {});
  assert.equal(unanswered.isError, true);
  assert.match(unanswered.content[0].text, /이 요청을 받지 않았습니다/);
});

test('the pipe answers only well-formed relay requests and keeps the size limit of hook events', { timeout: 15000 }, async t => {
  const starts: string[] = [];
  const pipe = await startAgentPipe({ start: (_token, session) => { starts.push(session.cwd ?? ''); return true; }, end: () => false, team: () => ({ ok: true, text: 'ok' }) });
  t.after(() => pipe.close());
  const send = (line: string) => new Promise<string>((resolve, reject) => {
    let data = '';
    const socket = net.connect(pipe.name, () => socket.write(line + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', chunk => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
  const key = randomBytes(32).toString('hex');
  assert.equal(await send(JSON.stringify({ v: 3, key, op: 'list' })), '{"ok":true,"text":"ok"}\n');
  assert.equal(await send(JSON.stringify({ v: 3, key: 'short', op: 'list' })), '', 'a malformed key gets no answer');
  assert.equal(await send(JSON.stringify({ v: 3, key, op: 'delete' })), '', 'an unknown request gets no answer');
  assert.equal(await send(JSON.stringify({ v: 3, key, op: 'send', to: '검토', text: 'x'.repeat(8001) })), '', 'an oversized message gets no answer');
  const token = randomBytes(32).toString('hex'), run = randomBytes(16).toString('hex');
  const start = (cwd: string) => JSON.stringify({ v: 1, token, run, sessionId: '0f5c2d4e-8b1a-4c3d-9e7f-1a2b3c4d5e6f', event: 'SessionStart', cwd });
  await send(start('C:\\' + 'a'.repeat(5000)));
  await send(start('C:\\work'));
  assert.deepEqual(starts, ['C:\\work'], 'a hook event over 4096 characters is still ignored');
});
