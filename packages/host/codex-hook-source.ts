/**
 * Managed Codex lifecycle hook. Codex feeds one JSON object on stdin; plain
 * stdout would become model context, so this script never writes to stdout or
 * stderr. It forwards only the exact session UUID (and cwd on start) to the
 * Mongle host over a local named pipe, authenticated with the per-shell token.
 * No network, transcript reads, commands from hook input, or model calls.
 */
export const CODEX_HOOK_SOURCE = String.raw`// Mongle Terminal managed Codex hook v1
'use strict';
const token = process.env.MONGLE_AGENT_TOKEN, pipe = process.env.MONGLE_AGENT_PIPE, run = process.env.MONGLE_CODEX_RUN;
// MONGLE_CODEX_RUN is set only by the session-local PowerShell wrapper for one
// --no-daemon Codex process. A shared daemon or an unwrapped launch lacks it.
if (!/^[a-f0-9]{64}$/.test(token || '') || !/^[a-f0-9]{32}$/.test(run || '') || !/^\\\\\.\\pipe\\mongle-agent-[a-f0-9]{32}$/.test(pipe || '')) process.exit(0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let input = '', bytes = 0;
const timer = setTimeout(() => process.exit(0), 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 65536) process.exit(0); input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let message;
  try {
    const data = JSON.parse(input);
    const event = data && data.hook_event_name;
    if ((event !== 'SessionStart' && event !== 'SessionEnd') || typeof data.session_id !== 'string' || !UUID.test(data.session_id)) process.exit(0);
    // Subagent lifecycle events carry the parent's session_id but their own cwd; never record them.
    if (data.agent_id !== undefined || data.agent_type !== undefined || data.subagent_id !== undefined) process.exit(0);
    message = {v:1, token, run, event, sessionId:data.session_id.toLowerCase()};
    if (event === 'SessionStart' && typeof data.cwd === 'string' && data.cwd.length <= 1024) message.cwd = data.cwd;
  } catch { process.exit(0); }
  const socket = require('node:net').connect(pipe);
  socket.on('error', () => process.exit(0));
  socket.on('close', () => { clearTimeout(timer); process.exit(0); });
  socket.end(JSON.stringify(message) + '\n');
});
`;

export const CODEX_HOOK_EVENTS = ['SessionStart', 'SessionEnd'] as const;
