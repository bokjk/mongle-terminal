import { stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { ShellProfile } from '../protocol/index.js';
import { validAgentSession, type AgentSessionIdentity } from '../terminal/agent-status.js';

/** Absolute executable used to reopen a conversation. Resolved by the host, never by the shell. */
export interface AgentExecutable { path: string; kind: 'exe' | 'cmd'; }

// Characters that would need quoting rules beyond a plain double-quoted path in
// PowerShell, cmd or Bash. Such install locations are reported as unsupported.
const UNSAFE_PATH = /["%!^&|<>`$'\x00-\x1f\x7f]/;
/** Host-local Codex lifecycle pipe name, as passed to PowerShell by the shell integration. */
export const AGENT_PIPE_NAME = /^\\\\\.\\pipe\\mongle-agent-[a-f0-9]{32}$/;

/**
 * Finds the installed CLI only in absolute local PATH directories (plus the
 * native Claude installer folder). Relative PATH entries, UNC shares and the
 * shell's working directory are never searched, so a file planted in a project
 * folder cannot run instead of the real CLI. Native .exe wins over an npm .cmd shim.
 */
export async function resolveAgentExecutable(provider: AgentSessionIdentity['provider'], env: NodeJS.ProcessEnv = process.env): Promise<AgentExecutable | undefined> {
  const name = provider === 'claude' ? 'claude' : 'codex';
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const roots = pathValue.split(';').map(item => item.trim().replace(/^"(.*)"$/, '$1'))
    .filter(item => item && /^[a-z]:[\\/]/i.test(item));
  if (provider === 'claude') roots.push(path.win32.join(homedir(), '.local', 'bin'));
  for (const kind of ['exe', 'cmd'] as const) {
    for (const root of [...new Set(roots.map(item => path.win32.resolve(item)))]) {
      const file = path.win32.join(root, `${name}.${kind}`);
      if (UNSAFE_PATH.test(file)) continue;
      if (await stat(file).then(info => info.isFile(), () => false)) return {path:file, kind};
    }
  }
  return undefined;
}

/**
 * Builds the single line typed into a freshly started shell to reopen one exact
 * conversation: an absolute, host-resolved executable plus the validated UUID.
 * Nothing from the old shell (commands, prompts, tool input) is replayed.
 * Unsupported shells or unsafe executables return undefined.
 */
export function agentResumeCommand(profile: Pick<ShellProfile, 'kind'>, session: AgentSessionIdentity, executable: AgentExecutable | undefined, options: { codexWrapper?: boolean } = {}): string | undefined {
  const valid = validAgentSession(session);
  if (!valid) return;
  if (valid.provider === 'codex') {
    // Codex is resumed only through the session-local PowerShell wrapper, which adds
    // --no-daemon and a fresh run nonce so the resumed run is captured again.
    // Without that wrapper (other shells, no lifecycle pipe) only a plain shell is restored.
    return profile.kind === 'powershell' && options.codexWrapper ? `__MongleCodex resume ${valid.sessionId}\r` : undefined;
  }
  if (!executable || !/^[a-z]:\\/i.test(executable.path) || UNSAFE_PATH.test(executable.path)) return;
  const args = valid.provider === 'claude' ? `--resume ${valid.sessionId}` : `resume ${valid.sessionId}`;
  let line: string;
  if (profile.kind === 'powershell') line = `& "${executable.path}" ${args}`;
  // cmd runs a quoted absolute path (including npm .cmd shims) directly.
  else if (profile.kind === 'cmd') line = `"${executable.path}" ${args}`;
  // Git Bash accepts Windows paths with forward slashes; .cmd shims need cmd.
  else if (profile.kind === 'bash') {
    if (executable.kind !== 'exe') return;
    line = `"${executable.path.replaceAll('\\', '/')}" ${args}`;
  } else return;
  // A carriage return submits the line in PowerShell, cmd and Bash under ConPTY.
  return line + '\r';
}

/**
 * True when client input carries only terminal protocol traffic: focus in/out,
 * mouse reports, device status/attribute replies, or win32-input-mode key-up and
 * lone modifier events. Attaching a desktop view sends these before the user
 * types anything, so they must not cancel a pending resume line.
 */
export function isTerminalReportOnly(data: string): boolean {
  if (!data) return true;
  const token = /\x1b\[(?:[IO]|<\d+;\d+;\d+[Mm]|\?[\d;]*c|\d+;\d+R|\?[\d;]*\$y|(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_)/y;
  let index = 0;
  while (index < data.length) {
    token.lastIndex = index;
    const match = token.exec(data);
    if (!match) return false;
    if (match[0].endsWith('_')) {
      // win32-input-mode: Vk;Sc;Uc;Kd;Cs;Rc. Key-up (Kd=0) or Shift/Ctrl/Alt/Win alone is not typing.
      const virtualKey = Number(match[1] || 0), keyDown = match[4] === '1';
      if (keyDown && ![16, 17, 18, 91, 92].includes(virtualKey)) return false;
    }
    index = token.lastIndex;
  }
  return true;
}
