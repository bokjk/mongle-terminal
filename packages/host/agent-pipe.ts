import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { SESSION_UUID, validCwd, type AgentSessionIdentity } from '../terminal/agent-status.js';

export interface AgentPipeTarget {
  /** HostCore.reportAgentSession with a non-null identity. */
  start(token: string, session: AgentSessionIdentity): boolean;
  /** Clears only when the stored record is exactly this identity. Never a generic clear. */
  end(token: string, session: AgentSessionIdentity): boolean;
}

const MAX_MESSAGE = 4096, MAX_TRACKED = 256;

/**
 * Host-local named pipe for the managed Codex hook: one JSON line per
 * connection, capped in size and time. A start counts only when HostCore
 * accepts its per-shell token. SessionEnd is forwarded only when it names the
 * same wrapped run and conversation this pipe last accepted for that shell, so
 * a late end of an older run cannot erase a newer record.
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
    } else if (value.event === 'SessionEnd') {
      const last = current.get(value.token);
      if (!last || last.run !== value.run || last.sessionId !== sessionId) return;
      current.delete(value.token);
      target.end(value.token, {provider:'codex', sessionId});
    }
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
      if (end < 0 && data.length <= MAX_MESSAGE) return;
      done = true;
      if (end >= 0 && end <= MAX_MESSAGE) handle(data.slice(0, end));
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
