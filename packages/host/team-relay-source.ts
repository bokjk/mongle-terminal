/**
 * The team relay a member's CLI starts as a stdio MCP server (Claude Code --mcp-config, Codex -c mcp_servers).
 * It offers list_agents and send_message and forwards each call, with this member's key from the file named
 * on its command line, to the host over the host-local pipe. It reads nothing else, writes only its MCP
 * replies and makes no network or model calls. The host decides who the sender is from the key.
 */
export const TEAM_RELAY_SOURCE = String.raw`// Mongle Terminal team relay v1
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const KEY_FILE = process.argv[2] || '';
const PIPE = /^\\\\\.\\pipe\\mongle-agent-[a-f0-9]{32}$/;
const TOOLS = [
  {
    name: 'list_agents',
    description: 'Lists the members of your Mongle team: name, role, lead, tool and model, whom each reports to, and whether each is working now. Use it to find whom to send work or a report to.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Mongle team members', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_message',
    description: 'Sends a message to another member of your Mongle team, or to the user. Mongle types it into that member\'s CLI once the member has finished what it is doing, so it may wait. Use it to hand out work (goal, scope, how to tell it is done) and to report your result to the member you report to. Write "사용자" as the receiver to report to the user. Replies arrive later as new messages that start with "[몽글 팀 메시지]".',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The receiving member\'s name exactly as list_agents shows it, or "사용자" for the user.' },
        text: { type: 'string', description: 'The message, up to 4000 characters. Put longer material in a file and name the file.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    annotations: { title: 'Message a Mongle team member', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

function credentials() {
  const value = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  if (!value || typeof value.pipe !== 'string' || !PIPE.test(value.pipe) || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) throw new Error('invalid');
  return value;
}

function ask(request) {
  return new Promise(resolve => {
    let found;
    try { found = credentials(); } catch { resolve({ ok: false, error: '몽글 팀 연결 정보를 읽지 못했습니다. 사용자에게 몽글터미널에서 이 구성원을 다시 시작해 달라고 알려 주세요.' }); return; }
    let data = '', done = false;
    const socket = net.connect(found.pipe);
    const finish = value => { if (done) return; done = true; socket.destroy(); resolve(value); };
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => finish({ ok: false, error: '몽글터미널이 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.' }));
    socket.on('connect', () => socket.write(JSON.stringify(Object.assign({ v: 3, key: found.key }, request)) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end >= 0) {
        let value;
        try { value = JSON.parse(data.slice(0, end)); } catch { value = undefined; }
        finish(value && typeof value.ok === 'boolean' ? value : { ok: false, error: '몽글터미널의 응답을 읽지 못했습니다.' });
      } else if (data.length > 65536) finish({ ok: false, error: '몽글터미널의 응답이 너무 깁니다.' });
    });
    socket.on('end', () => finish({ ok: false, error: '몽글터미널이 이 요청을 받지 않았습니다. 몽글터미널을 업데이트했는지 확인해 주세요.' }));
    socket.on('error', () => finish({ ok: false, error: '몽글터미널에 연결하지 못했습니다. 몽글터미널이 실행 중인지 사용자에게 확인해 주세요.' }));
  });
}

const result = answer => ({ content: [{ type: 'text', text: String(answer.ok ? answer.text : answer.error) }], ...(answer.ok ? {} : { isError: true }) });

async function call(name, args) {
  if (name === 'list_agents') return result(await ask({ op: 'list' }));
  if (name === 'send_message') {
    const to = args && typeof args.to === 'string' ? args.to : '', text = args && typeof args.text === 'string' ? args.text : '';
    if (!to.trim() || !text.trim()) return result({ ok: false, error: 'to와 text를 모두 넣어 주세요.' });
    return result(await ask({ op: 'send', to: to.slice(0, 200), text: text.slice(0, 8000) }));
  }
  return result({ ok: false, error: '알 수 없는 도구입니다.' });
}

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }

async function handle(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
  const request = message.id !== undefined && message.id !== null, id = message.id, params = message.params || {};
  if (!request) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mongle-team', version: '1.0.0' },
      instructions: 'Mongle Terminal team relay: list_agents shows your teammates; send_message hands work to them or reports back.',
    } });
  } else if (message.method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  else if (message.method === 'tools/call') send({ jsonrpc: '2.0', id, result: await call(params.name, params.arguments) });
  else send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    for (const item of Array.isArray(message) ? message : [message]) handle(item).catch(() => {});
  }
  if (buffer.length > 1024 * 1024) buffer = '';
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
`;
