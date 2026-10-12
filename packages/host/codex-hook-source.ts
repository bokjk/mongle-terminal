/**
 * Managed Codex hook. Codex feeds one JSON object on stdin; plain stdout would
 * become model context (and Stop and Interrupt reject plain text), so this
 * script never writes to stdout or stderr. Over a local named pipe,
 * authenticated with the per-shell token, it forwards the exact session UUID
 * (with cwd and source on start) and, for the events of a turn, only digests of
 * the turn and subagent ids, a digest of the tool name and command (or input)
 * that a request or tool report is about, and whether Codex asks a question.
 * Prompts, tool input and output, transcripts and models never leave it.
 * No network, transcript reads, commands from hook input, or model calls.
 */
export const CODEX_HOOK_SOURCE = String.raw`// Mongle Terminal managed Codex hook v1
'use strict';
const token = process.env.MONGLE_AGENT_TOKEN, pipe = process.env.MONGLE_AGENT_PIPE, run = process.env.MONGLE_CODEX_RUN;
// MONGLE_CODEX_RUN is set only by the session-local PowerShell wrapper for one
// --no-daemon Codex process. A shared daemon or an unwrapped launch lacks it.
const live = /^[a-f0-9]{64}$/.test(token || '') && /^[a-f0-9]{32}$/.test(run || '') && /^\\\\\.\\pipe\\mongle-agent-[a-f0-9]{32}$/.test(pipe || '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN = ['UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt'];
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
// Object keys sorted, so the same input always gives the same text.
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  : JSON.stringify(value === undefined ? null : value);
// Which tool a permission request or a tool report is about. A permission request names no tool id, and
// Codex adds a description to the command it asks about, so a command counts by itself.
const tool = data => {
  const input = data.tool_input, name = typeof data.tool_name === 'string' ? data.tool_name : '';
  return digest(input && typeof input === 'object' && typeof input.command === 'string' ? name + '\ncommand\n' + input.command : name + '\ninput\n' + canonical(input));
};
let input = '', bytes = 0;
const timer = setTimeout(() => process.exit(0), 1500);
process.stdin.setEncoding('utf8');
// Read all of the input even when nothing is sent, so Codex never writes into a closed pipe. PostToolUse
// carries the tool output; past the cap only this update is dropped, never the turn.
process.stdin.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (live && bytes <= 4194304) input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  if (!live || bytes > 4194304) process.exit(0);
  let message;
  try {
    const data = JSON.parse(input);
    const event = data && data.hook_event_name;
    if (typeof data.session_id !== 'string' || !UUID.test(data.session_id)) process.exit(0);
    const subagent = data.agent_id !== undefined || data.agent_type !== undefined || data.subagent_id !== undefined;
    message = {v:1, token, run, event, sessionId:data.session_id.toLowerCase()};
    if (event === 'SessionStart' || event === 'SessionEnd') {
      // Subagent lifecycle events carry the parent's session_id but their own cwd; never record them.
      if (subagent) process.exit(0);
      if (event === 'SessionStart' && typeof data.cwd === 'string' && data.cwd.length <= 1024) message.cwd = data.cwd;
      if (event === 'SessionStart' && ['startup', 'resume', 'clear', 'compact', 'fork'].includes(data.source)) message.source = data.source;
    } else if (TURN.includes(event) && id(data.turn_id)) {
      // A subagent's own prompt and end are not the user's turn; its requests and tools belong to it.
      if (subagent && (event === 'UserPromptSubmit' || event === 'Stop' || event === 'Interrupt')) process.exit(0);
      message.turn = digest(data.turn_id);
      if (subagent) message.agent = digest(id(data.agent_id) ? data.agent_id : id(data.agent_type) ? data.agent_type : 'subagent');
      if (event === 'PermissionRequest' || event === 'PreToolUse' || event === 'PostToolUse') message.tool = tool(data);
      if ((event === 'PreToolUse' || event === 'PostToolUse') && data.tool_name === 'request_user_input') message.question = true;
    } else process.exit(0);
  } catch { process.exit(0); }
  const socket = require('node:net').connect(pipe);
  socket.on('error', () => process.exit(0));
  socket.on('close', () => { clearTimeout(timer); process.exit(0); });
  socket.end(JSON.stringify(message) + '\n');
});
`;

export const CODEX_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt'] as const;
export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number];
/** status: an event of a turn (work, request and completion status), installed only for CLIs that know it. */
export interface CodexHookHandler { readonly status?: true; readonly matcher?: string }
/** How Codex runs each managed event. SessionStart and SessionEnd keep their first definition, and with it their Codex trust. */
export const CODEX_HOOK_HANDLERS: Readonly<Record<CodexHookEvent, CodexHookHandler>> = {
  SessionStart: {},
  SessionEnd: {},
  UserPromptSubmit: {status:true},
  PermissionRequest: {status:true},
  // Only Codex's question tool needs a report before it runs.
  PreToolUse: {status:true, matcher:'^request_user_input$'},
  // Synchronous like every other event: a background report of an earlier tool could arrive after a later
  // request and hide it. It runs alongside the other hooks of the same event.
  PostToolUse: {status:true},
  Stop: {status:true},
  Interrupt: {status:true},
};
