/** No network, transcript reads, model calls, or commands from hook input.
 * SessionStart/UserPromptSubmit also carry the exact session UUID and cwd so the
 * host can offer `claude --resume <UUID>` after an app update; nothing else is sent. */
export const CLAUDE_HOOK_SOURCE = String.raw`// Mongle Terminal managed Claude hook v1
'use strict';
const token = process.env.MONGLE_AGENT_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token || '')) process.exit(0);
const { createHash } = require('node:crypto');
let input = '', bytes = 0;
process.stdin.setEncoding('utf8');
const timer = setTimeout(() => process.exit(0), 1500);
process.stdin.on('data', chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 1024 * 1024) process.exit(0);
  input += chunk;
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    const data = JSON.parse(input);
    if (data.agent_id || typeof data.session_id !== 'string' || data.session_id.length > 200) return;
    const events = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','Notification','Stop','StopFailure','SessionEnd'];
    if (!events.includes(data.hook_event_name)) return;
    const event = {event:data.hook_event_name, session:createHash('sha256').update(data.session_id).digest('hex')};
    if ((data.hook_event_name === 'SessionStart' || data.hook_event_name === 'UserPromptSubmit') && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.session_id)) {
      event.id = data.session_id;
      if (typeof data.cwd === 'string' && data.cwd.length <= 1024) event.cwd = data.cwd;
    }
    if (typeof data.tool_name === 'string' && data.tool_input && typeof data.tool_input === 'object') {
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
      event.tool = createHash('sha256').update(JSON.stringify([data.tool_name,canonical(data.tool_input)])).digest('hex');
    }
    if (data.hook_event_name === 'Notification') {
      if (!['permission_prompt','idle_prompt','elicitation_dialog'].includes(data.notification_type)) return;
      event.notification = data.notification_type;
    }
    if (data.hook_event_name === 'PreToolUse' && data.tool_name === 'AskUserQuestion') event.question = true;
    if (data.is_interrupt === true) event.interrupted = true;
    const encoded = Buffer.from(JSON.stringify(event)).toString('base64');
    process.stdout.write(JSON.stringify({terminalSequence:'\x1b]777;mongle-agent;'+token+';'+encoded+'\x07'}));
  } catch { /* Observability must never block a Claude turn. */ }
});
`;

export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'] as const;
