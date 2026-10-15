import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { SESSION_UUID, validCodexEvent, validCwd, type AgentSessionIdentity, type CodexAgentEvent } from '../terminal/agent-status.js';

export interface AgentPipeTarget {
  /** HostCore.reportAgentSession with a non-null identity. */
  start(token: string, session: AgentSessionIdentity): boolean;
  /** Clears only when the stored record is exactly this identity. Never a generic clear. */
  end(token: string, session: AgentSessionIdentity): boolean;
  /** HostCore.reportAgentStatus: an event of the shell's live Codex conversation. */
  status?(token: string, event: CodexAgentEvent): boolean;
  /** HostCore.reportClaudeStart: the managed Claude hook's SessionStart. */
  claudeStart?(token: string, session: AgentSessionIdentity): boolean;
  /** HostCore.teamRelay: a team member's relay asks something and waits for the one-line answer. */
  team?(key: string, request: TeamRelayRequest): TeamRelayAnswer | Promise<TeamRelayAnswer>;
}

export type TeamRelayRequest = {op: 'list'} | {op: 'send'; to: string; text: string};
export type TeamRelayAnswer = {ok: true; text: string} | {ok: false; error: string};

/** Hook events stay small; a relay message carries up to a team message's text. */
const MAX_MESSAGE = 4096, MAX_RELAY = 24 * 1024, MAX_TRACKED = 256;

/** A relay request as the team relay script sends it, or undefined. */
export function teamRelayRequest(value: any): {key: string; request: TeamRelayRequest} | undefined {
  if (!value || value.v !== 3 || typeof value.key !== 'string' || !/^[a-f0-9]{64}$/.test(value.key)) return;
  if (value.op === 'list') return {key: value.key, request: {op: 'list'}};
  if (value.op === 'send' && typeof value.to === 'string' && typeof value.text === 'string' && value.to.length <= 200 && value.text.length <= 8000) return {key: value.key, request: {op: 'send', to: value.to, text: value.text}};
}

/**
 * Host-local named pipe for the managed Codex hook: one JSON line per
 * connection, capped in size and time. A start counts only when HostCore
 * accepts its per-shell token. SessionEnd and the events of a turn are
 * forwarded only when they name the same wrapped run and conversation this pipe
 * last accepted for that shell, so a late end or report of an older run cannot
 * erase a newer record or change its status.
 *
 * The managed Claude hook sends only its SessionStart here, as message version 2 (so hosts that know only
 * version 1 never take it for a Codex start). Claude's other events arrive in order through the terminal.
 *
 * A team member's relay (message version 3) is the only sender that gets an answer: one JSON line back on
 * the same connection. Its key, not a shell token, names the member; the host checks it.
 */
export async function startAgentPipe(target: AgentPipeTarget, options: {name?: string} = {}) {
  const name = options.name ?? `\\\\.\\pipe\\mongle-agent-${randomBytes(16).toString('hex')}`;
  // token -> last accepted {run, sessionId}; insertion order doubles as age for the cap.
  const current = new Map<string, {run: string; sessionId: string}>();
  const sockets = new Set<net.Socket>();
  let closed = false;
  const handle = (line: string) => {
    if (closed) return;
    let value: any;
    try { value = JSON.parse(line); } catch { return; }
    if (value && value.v === 2 && value.provider === 'claude') {
      if (value.event !== 'SessionStart' || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) return;
      if (typeof value.sessionId !== 'string' || !SESSION_UUID.test(value.sessionId)) return;
      target.claudeStart?.(value.token, {provider:'claude', sessionId:value.sessionId, ...(validCwd(value.cwd) ? {cwd:value.cwd} : {})});
      return;
    }
    if (!value || value.v !== 1 || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) return;
    if (typeof value.run !== 'string' || !/^[a-f0-9]{32}$/.test(value.run)) return;
    if (typeof value.sessionId !== 'string' || !SESSION_UUID.test(value.sessionId)) return;
    const sessionId = value.sessionId.toLowerCase();
    if (value.event === 'SessionStart') {
      const session: AgentSessionIdentity = {provider:'codex', sessionId, ...(validCwd(value.cwd) ? {cwd:value.cwd} : {})};
      if (!target.start(value.token, session)) return;
      current.delete(value.token);
      current.set(value.token, {run:value.run, sessionId});
      while (current.size > MAX_TRACKED) current.delete(current.keys().next().value!);
      target.status?.(value.token, validCodexEvent({event:'SessionStart', source:value.source})!);
      return;
    }
    const last = current.get(value.token);
    if (!last || last.run !== value.run || last.sessionId !== sessionId) return;
    if (value.event === 'SessionEnd') {
      current.delete(value.token);
      target.end(value.token, {provider:'codex', sessionId});
      target.status?.(value.token, {event:'SessionEnd'});
      return;
    }
    const event = validCodexEvent(value);
    if (event && event.event !== 'SessionStart' && event.event !== 'SessionEnd') target.status?.(value.token, event);
  };
  const server = net.createServer(socket => {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    let data = '', done = false;
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', chunk => {
      if (done) return;
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0 && data.length <= MAX_RELAY) return;
      done = true;
      const line = end >= 0 ? data.slice(0, end) : '';
      let value: any;
      if (line.startsWith('{"v":3,')) try { value = JSON.parse(line); } catch { /* not a relay request */ }
      const relay = teamRelayRequest(value);
      if (relay && target.team && !closed) {
        const answer = (reply: TeamRelayAnswer) => { if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n'); };
        Promise.resolve().then(() => target.team!(relay.key, relay.request)).then(answer, () => answer({ok: false, error: '몽글터미널이 요청을 처리하지 못했습니다.'}));
        return;
      }
      if (end >= 0 && end <= MAX_MESSAGE) handle(line);
      socket.end();
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(name, () => { server.off('error', reject); resolve(); }); });
  server.on('error', () => {});
  return {
    name,
    /** The shell's terminal ended or returned to its prompt; drop this pipe's record of it. */
    forget(token: string) { current.delete(token); },
    get tracked() { return current.size; },
    close: () => new Promise<void>(resolve => {
      closed = true; current.clear();
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
