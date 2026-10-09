import { createHash } from 'node:crypto';
import type { AgentStatus } from '../protocol/index.js';

/** Exact, verified identity of the agent conversation running in this shell. Host-private. */
export type AgentProvider = 'claude' | 'codex';
export interface AgentSessionIdentity { provider: AgentProvider; sessionId: string; cwd?: string; }
export const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Accepts only an exact UUID, a known provider and an absolute Windows cwd. */
export function validAgentSession(value: unknown): AgentSessionIdentity | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if ((v.provider !== 'claude' && v.provider !== 'codex') || typeof v.sessionId !== 'string' || !SESSION_UUID.test(v.sessionId)) return;
  return {provider:v.provider, sessionId:v.sessionId.toLowerCase(), ...(validCwd(v.cwd) ? {cwd:v.cwd} : {})};
}
export interface AgentSessionCallbacks {
  /** null: the conversation ended or the shell prompt returned; drop any resume intent. */
  onSession?: (session: AgentSessionIdentity | null) => void;
  /** The shell printed its authenticated prompt marker. */
  onPrompt?: () => void;
}
const UUID = SESSION_UUID;
export function validCwd(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value) && /^(?:[a-z]:[\\/]|\\\\)/i.test(value);
}

const CANCEL_INPUT = new Set(['\x03', '\x1b', '\x1b[27u', '\x1b[99;5u']);
/** One delivered Ctrl+C or Esc, legacy or kitty encoded. Never retained. */
export function isCancelInput(data: string): boolean { return CANCEL_INPUT.has(data); }
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
/**
 * What a delivered key means to the observer, never its text: cancel keys as sent, Enter and paste
 * boundaries in place, anything else as 'x'. Escape sequences, mouse reports, control keys and digits can
 * move a dialog's selection, and so can letters: Claude binds J/K besides the arrows and Ctrl+N/P by
 * default, and bindings are configurable. Text therefore counts while a request is shown; otherwise
 * text alone is not observed and costs no queue fence.
 */
export function agentInputSignal(data: string, requestShown = false): string | undefined {
  if (isCancelInput(data)) return data;
  let signal = '', relevant = requestShown && data.length > 0;
  for (let index = 0; index < data.length;) {
    const marker = data.startsWith(PASTE_START, index) ? PASTE_START : data.startsWith(PASTE_END, index) ? PASTE_END : data[index] === '\r' ? '\r' : '';
    if (marker) { signal += marker; relevant = true; index += marker.length; continue; }
    const code = data.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (code >= 0x30 && code <= 0x39)) relevant = true;
    if (!signal.endsWith('x')) signal += 'x';
    index += 1;
  }
  return relevant ? signal : undefined;
}

export type AgentStatusUpdate = { status: AgentStatus; notify: boolean };
/** asked: a PermissionRequest already belongs to this call (an AskUserQuestion also gets one). */
type ToolRecord = { hash: string; state: 'running' | 'waiting' | 'answered'; asked: boolean; question: boolean };
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_TOOLS = 256;
/** idle_prompt reports about a minute at Claude's prompt; a hook within this window means it is stale. */
const IDLE_PROMPT_QUIET_MS = 30_000;

/**
 * State comes only from our per-shell authenticated Claude lifecycle hook, never titles/output
 * heuristics. Delivered keys are the only other evidence: Claude sends no hook after a user interrupt
 * or a rejected request, so a cancel key, or an answer whose selection was moved, ends the visible
 * work/request until a later hook from the same conversation proves that the turn goes on. Enter on
 * a permission dialog that no other key reached picks its preselected approval: the tool runs on.
 */
export class ClaudeTaskState {
  private session = '';
  private status: AgentStatus = 'idle';
  /** sha256 of the conversation whose exact UUID was reported; independent of status resets. */
  private resumeHash = '';
  private resumeCwd: string | undefined;
  /** Tool calls of the current turn, oldest first: call-id digests, or input digests from older hooks. */
  private tools = new Map<string, ToolRecord>();
  private sequence = 0;
  /** A delivered cancel/answer key lowered the status; only forward progress may raise it again. */
  private provisional = false;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  /** Bracketed paste spans input chunks; Enter inside it is text, not an answer. */
  private pasting = false;
  /** No key reached the shown permission dialog since it appeared, so its preselected approval holds. */
  private untouched = false;
  /** The last visible request was answered here; a reminder for it is not a new request. */
  private settled = false;
  constructor(private token: string, private callbacks: AgentSessionCallbacks = {}, private clock: () => number = Date.now) {}
  private dropResume() { if (!this.resumeHash) return; this.resumeHash = ''; this.resumeCwd = undefined; this.callbacks.onSession?.(null); }
  private reset() { this.tools.clear(); this.provisional = false; this.untouched = false; this.settled = false; }
  private waiting() { for (const record of this.tools.values()) if (record.state === 'waiting') return true; return false; }
  /** Oldest matching record; loose matching never takes a call that has its own id. */
  private find(hash: string, state: ToolRecord['state'], loose = false) {
    for (const [key, record] of this.tools) if (record.hash === hash && record.state === state && (!loose || !key.startsWith('c:'))) return key;
  }
  /** True when Enter is typed outside a bracketed paste. Paste state survives chunk boundaries. */
  private submits(data: string): boolean {
    let submitted = false, index = 0;
    while (index < data.length) {
      if (this.pasting) {
        const end = data.indexOf(PASTE_END, index);
        if (end < 0) return submitted;
        this.pasting = false; index = end + PASTE_END.length;
      } else {
        const start = data.indexOf(PASTE_START, index);
        if ((start < 0 ? data.slice(index) : data.slice(index, start)).includes('\r')) submitted = true;
        if (start < 0) return submitted;
        this.pasting = true; index = start + PASTE_START.length;
      }
    }
    return submitted;
  }
  private track(key: string, record: ToolRecord) {
    this.tools.set(key, record);
    if (this.tools.size > MAX_TOOLS) this.tools.delete(this.tools.keys().next().value!);
  }
  /** Completion and failure notify on every finished turn; attention only when it begins. */
  private move(next: AgentStatus, finishedTurn = false): AgentStatusUpdate | undefined {
    const changed = next !== this.status;
    this.status = next;
    if (!changed && !finishedTurn) return;
    return {status:next, notify:finishedTurn || next === 'attention'};
  }

  /** A delivered key is evidence about this shell's CLI, never a completion. */
  observeInput(data: string): AgentStatusUpdate | undefined {
    const submitted = this.submits(data);
    if (this.status !== 'working' && this.status !== 'attention') return;
    if (isCancelInput(data)) {
      // An interrupt sends no hook. If the key only closed a menu, Claude's next hook restores the status.
      this.tools.clear(); this.provisional = true; this.untouched = false;
      return this.move('idle');
    }
    if (this.status !== 'attention') return;
    // Arrows, digits, mouse or control keys may move the selection away from the preselected option.
    if (!submitted) { this.untouched = false; return; }
    // Enter answers the oldest visible request (also batched after arrow keys).
    const preselected = this.untouched && data === '\r';
    // Whether a request still waiting is shown next, and with which selection, is unknown.
    this.untouched = false;
    let answered: ToolRecord | undefined;
    for (const record of this.tools.values()) if (record.state === 'waiting') { record.state = 'answered'; answered = record; break; }
    if (this.waiting()) return;
    this.settled = true;
    // Claude 2.1.294 preselects "1. Yes" in a permission dialog, so the approved tool runs on with no hook
    // until it ends. Any other answer may be a rejection, which sends no hook at all; an approval then
    // proves itself when the tool ends. Questions may span several screens and stay provisional.
    this.provisional = !(preselected && answered?.asked && !answered.question);
    return this.move(this.provisional ? 'idle' : 'working');
  }

  accept(data: string): AgentStatusUpdate | undefined {
    if (!this.token) return;
    if (data === 'mongle-shell;' + this.token) {
      this.session = '';
      this.reset();
      // Back at the shell prompt: the CLI is no longer the active program.
      this.dropResume();
      this.callbacks.onPrompt?.();
      return this.move('idle');
    }
    const prefix = 'mongle-agent;' + this.token + ';';
    if (!data.startsWith(prefix) || data.length > 4096) return;
    let value: any;
    try { value = JSON.parse(Buffer.from(data.slice(prefix.length), 'base64').toString('utf8')); } catch { return; }
    if (!value || typeof value !== 'object' || !DIGEST.test(value.session)) return;
    const event = value.event;
    if ((event === 'SessionStart' || event === 'UserPromptSubmit') && typeof value.id === 'string' && UUID.test(value.id)
      && createHash('sha256').update(value.id).digest('hex') === value.session) {
      const cwd = validCwd(value.cwd) ? value.cwd : undefined;
      // A moved project (same conversation, new cwd) must update the saved folder.
      if (this.resumeHash !== value.session || this.resumeCwd !== cwd) {
        this.resumeHash = value.session; this.resumeCwd = cwd;
        this.callbacks.onSession?.({provider:'claude', sessionId:value.id, ...(cwd ? {cwd} : {})});
      }
    }
    if (event === 'SessionEnd' && value.session === this.resumeHash) this.dropResume();
    // Compaction continues the same conversation and turn; it is not a new start.
    if (event === 'SessionStart' && value.source === 'compact' && value.session === this.session) return;
    if (event === 'SessionStart' || event === 'UserPromptSubmit') { this.session = value.session; this.reset(); }
    if (!this.session || value.session !== this.session) return;
    const idlePrompt = event === 'Notification' && value.notification === 'idle_prompt';
    const quietFor = this.clock() - this.lastEventAt;
    if (!idlePrompt) this.lastEventAt = this.clock();
    const tool = typeof value.tool === 'string' && DIGEST.test(value.tool) ? value.tool : '';
    const call = typeof value.call === 'string' && DIGEST.test(value.call) ? value.call : '';
    switch (event) {
      case 'SessionStart': return this.move('idle');
      case 'UserPromptSubmit': return this.move('working');
      case 'PreToolUse': {
        const question = value.question === true;
        if (call || tool) this.track(call ? 'c:' + call : 'h:' + tool + ':' + (++this.sequence), {hash:tool, state:question ? 'waiting' : 'running', asked:false, question});
        this.provisional = false; this.settled = false;
        return this.move(question || this.waiting() ? 'attention' : 'working');
      }
      case 'PermissionRequest': {
        // Shown at once only when no other request waits; then its preselection holds until a key reaches it.
        if (!this.waiting()) this.untouched = true;
        // The request carries no call id: it belongs to the oldest call with the same input that has none yet.
        if (tool) {
          let record: ToolRecord | undefined;
          for (const item of this.tools.values()) if (item.hash === tool && !item.asked && item.state !== 'answered') { record = item; break; }
          if (record) { record.asked = true; record.state = 'waiting'; }
          else this.track('p:' + tool + ':' + (++this.sequence), {hash:tool, state:'waiting', asked:true, question:false});
        }
        this.provisional = false; this.settled = false;
        return this.move('attention');
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (event === 'PostToolUseFailure' && value.interrupted === true) { this.reset(); return this.move('idle'); }
        // Answers may rewrite a call's input, so the id decides. Older hooks finish an unrequested identical run first.
        let key = call && this.tools.has('c:' + call) ? 'c:' + call : undefined;
        if (!key && tool) key = this.find(tool, 'running', true) ?? this.find(tool, 'answered', true) ?? this.find(tool, 'waiting', true);
        const record = key ? this.tools.get(key) : undefined;
        if (key) this.tools.delete(key);
        // After a delivered cancel/answer, a tool that merely finished does not prove the turn goes on.
        if (this.provisional && record?.state !== 'waiting' && record?.state !== 'answered') return;
        this.provisional = false;
        return this.move(this.waiting() ? 'attention' : 'working');
      }
      case 'Notification':
        if (idlePrompt) {
          // A reminder from before the latest hook (e.g. racing a new prompt) says nothing about this turn.
          if (quietFor < IDLE_PROMPT_QUIET_MS) return;
          // Claude has waited at its own prompt for about a minute: nothing is running or waiting.
          if (this.status === 'working') { this.reset(); return this.move('completed', true); }
          if (this.status === 'attention') { this.reset(); return this.move('idle'); }
          return;
        }
        if (value.notification !== 'permission_prompt' && value.notification !== 'elicitation_dialog') return;
        // A late reminder for a request already answered or cancelled here is not a new request. An MCP
        // elicitation may still follow an approved tool.
        if (this.provisional || (this.settled && value.notification === 'permission_prompt')) return;
        return this.move('attention');
      case 'Stop':
        this.reset();
        return value.interrupted === true ? this.move('idle') : this.move('completed', true);
      case 'StopFailure': this.reset(); return this.move('error', true);
      case 'SessionEnd': this.reset(); this.session = ''; return this.move('idle');
      default: return;
    }
  }
}
