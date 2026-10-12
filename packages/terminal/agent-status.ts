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

/** True when Enter is typed outside a bracketed paste. Paste state survives chunk boundaries. */
function submitsOutsidePaste(data: string, paste: {active: boolean}): boolean {
  let submitted = false, index = 0;
  while (index < data.length) {
    if (paste.active) {
      const end = data.indexOf(PASTE_END, index);
      if (end < 0) return submitted;
      paste.active = false; index = end + PASTE_END.length;
    } else {
      const start = data.indexOf(PASTE_START, index);
      if ((start < 0 ? data.slice(index) : data.slice(index, start)).includes('\r')) submitted = true;
      if (start < 0) return submitted;
      paste.active = true; index = start + PASTE_START.length;
    }
  }
  return submitted;
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
  private paste = {active:false};
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
  private submits(data: string): boolean { return submitsOutsidePaste(data, this.paste); }
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

type CodexSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
export type CodexTurnEvent = 'UserPromptSubmit' | 'PermissionRequest' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Interrupt';
/**
 * A managed Codex hook event as the host accepts it: digests and flags only, never prompts or tool data.
 * turn: digest of Codex's turn id. agent: digest of the subagent that reported it, if one did.
 * tool: digest of the tool name and its command (or input) that a request or a finished tool is about.
 */
export type CodexAgentEvent =
  | { event: 'SessionStart'; source?: CodexSource }
  | { event: 'SessionEnd' }
  | { event: CodexTurnEvent; turn: string; agent?: string; tool?: string; question?: true };
const CODEX_SOURCES: ReadonlySet<string> = new Set<CodexSource>(['startup', 'resume', 'clear', 'compact', 'fork']);
const CODEX_TURN_EVENTS: ReadonlySet<string> = new Set<CodexTurnEvent>(['UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt']);
/** Keeps exactly the fields the managed hook sends, in their exact shapes. */
export function validCodexEvent(value: unknown): CodexAgentEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.event === 'SessionStart') return typeof v.source === 'string' && CODEX_SOURCES.has(v.source) ? {event:'SessionStart', source:v.source as CodexSource} : {event:'SessionStart'};
  if (v.event === 'SessionEnd') return {event:'SessionEnd'};
  if (typeof v.event !== 'string' || !CODEX_TURN_EVENTS.has(v.event) || typeof v.turn !== 'string' || !DIGEST.test(v.turn)) return;
  for (const digest of [v.agent, v.tool]) if (digest !== undefined && (typeof digest !== 'string' || !DIGEST.test(digest))) return;
  return {event:v.event as CodexTurnEvent, turn:v.turn, ...(typeof v.agent === 'string' ? {agent:v.agent} : {}),
    ...(typeof v.tool === 'string' ? {tool:v.tool} : {}), ...(v.question === true ? {question:true as const} : {})};
}

/** How long a permission request waits for Codex's prompt or its automatic review before it is shown anyway. */
export const CODEX_PROMPT_WAIT_MS = 2500;
/** What Codex draws on the visible screen: its approval prompt, or its automatic approval review at work. */
export interface CodexScreen { prompt: boolean; review: boolean }
interface CodexRequest {
  /** The thread that asked: '' is the main thread, otherwise the subagent's digest. */
  thread: string;
  /** Digest of the tool the request is about, when the hook sent one. */
  tool?: string;
  kind: 'permission' | 'question';
  /** Shown to the user. A permission request is not until Codex shows its prompt (or the wait ends). */
  shown: boolean;
  since: number;
}

/**
 * Codex states come only from the managed Codex hook through the host pipe, never titles or output.
 * Codex names every turn and reports an interrupt itself, so an event of another or a finished turn
 * changes nothing, and a tool report that arrives late cannot revive a turn.
 * Codex runs PermissionRequest hooks before it decides who answers: its automatic approval review may
 * approve or deny without asking anyone. A permission request is therefore shown only once the screen
 * shows Codex's approval prompt, dropped when the screen shows the automatic review instead, and shown
 * anyway when neither appears in time. The screen never creates a request or a status by itself.
 * A finished tool answers only its own request, so a tool that ran alongside a waiting one cannot hide
 * it. A permission request names no tool id: requests and reports match by the digest of the tool name
 * and its command (or input).
 * Delivered keys count only as Codex shows them: a cancel key interrupts the turn or declines the shown
 * request, and Enter that no other key preceded picks Codex's preselected "Yes, proceed", so the approved
 * tool runs on. Any other answer may be a rejection, which Codex does not report; an approval then proves
 * itself when its tool finishes.
 */
export class CodexTaskState {
  private status: AgentStatus = 'idle';
  /** Digest of the user's turn in progress; empty once it stopped or was interrupted. */
  private turn = '';
  /** Requests of the turn in progress, oldest first. */
  private requests: CodexRequest[] = [];
  /** No key reached the shown approval since it appeared, so its preselected answer holds. */
  private untouched = false;
  /** When the last shown request was answered: the next one gets the full wait from then. */
  private freedAt = 0;
  /** Codex's review status has stayed on screen since it answered a request; it answers one request each time it appears. */
  private reviewing = false;
  private paste = {active:false};
  constructor(private readonly now: () => number = Date.now) {}
  private move(next: AgentStatus, finishedTurn = false): AgentStatusUpdate | undefined {
    const changed = next !== this.status;
    this.status = next;
    if (!changed && !finishedTurn) return;
    return {status:next, notify:finishedTurn || next === 'attention'};
  }
  private clear() { this.requests = []; this.untouched = false; }
  private anyShown() { return this.requests.some(request => request.shown); }
  private show(request: CodexRequest): AgentStatusUpdate | undefined {
    // Its preselection holds until a key reaches it, when nothing else was shown before it.
    this.untouched = !this.anyShown() && request.kind === 'permission';
    request.shown = true;
    return this.move('attention');
  }
  /** A new conversation, its end, or the shell prompt: nothing of the last turn runs any more. */
  reset(): AgentStatusUpdate | undefined { this.turn = ''; this.clear(); return this.move('idle'); }
  /** A permission request waits for the screen to tell whether the user or Codex's review answers it. */
  get awaitingPrompt(): boolean { return this.requests.some(request => !request.shown); }
  private due(request: CodexRequest) { return Math.max(request.since, this.freedAt) + CODEX_PROMPT_WAIT_MS; }
  /** Milliseconds until the oldest unshown request is shown anyway, or undefined when none waits.
   * Codex shows one approval at a time, so nothing times out while another request is shown. */
  promptWait(): number | undefined {
    const waiting = this.requests.find(request => !request.shown);
    return waiting && !this.anyShown() ? Math.max(0, this.due(waiting) - this.now()) : undefined;
  }

  accept(event: CodexAgentEvent): AgentStatusUpdate | undefined {
    // Compaction continues the same conversation and turn; any other start is a new conversation.
    if (event.event === 'SessionStart') return event.source === 'compact' ? undefined : this.reset();
    if (event.event === 'SessionEnd') return this.reset();
    // A subagent's own prompt and end are not the user's turn.
    if (event.agent !== undefined && (event.event === 'UserPromptSubmit' || event.event === 'Stop' || event.event === 'Interrupt')) return;
    if (event.event === 'UserPromptSubmit') { this.turn = event.turn; this.clear(); return this.move('working'); }
    // Everything else belongs to the turn in progress; a subagent's events carry the subagent's own turn ids.
    if (!this.turn || (event.agent === undefined && event.turn !== this.turn)) return;
    const thread = event.agent ?? '', tool = event.tool;
    const request = {thread, ...(tool ? {tool} : {}), shown:false, since:this.now()};
    // Codex has not decided yet whether it asks the user or lets its automatic review answer.
    if (event.event === 'PermissionRequest') { this.requests.push({...request, kind:'permission'}); this.reviewing = false; return; }
    if (event.event === 'PreToolUse' && event.question) {
      const question: CodexRequest = {...request, kind:'question'};
      this.requests.push(question);
      return this.show(question);
    }
    switch (event.event) {
      case 'PostToolUse': {
        // Only the finished tool's own request is answered. A report without a digest (an older hook
        // script) answers the oldest request of its thread as before. The thread goes on, also after a
        // key here lowered the status.
        const index = this.requests.findIndex(waiting => waiting.thread === thread && (!tool || !waiting.tool || waiting.tool === tool));
        if (index >= 0 && this.requests.splice(index, 1)[0].shown) this.freedAt = this.now();
        if (this.anyShown()) return this.move('attention');
        this.untouched = false;
        return this.move('working');
      }
      case 'Stop': this.turn = ''; this.clear(); return this.move('completed', true);
      case 'Interrupt': this.turn = ''; this.clear(); return this.move('idle');
      default: return;
    }
  }

  /**
   * The visible screen while a permission request waits: Codex's approval prompt shows the oldest one;
   * its automatic review answers all of them without the user. An approval then runs the tool, and a
   * denial goes back to the model.
   */
  observeScreen(screen: CodexScreen): AgentStatusUpdate | undefined {
    if (!screen.review) this.reviewing = false;
    const waiting = this.requests.find(request => !request.shown);
    if (!waiting) return;
    // Codex shows one approval at a time: while one is shown, a prompt on screen is that one's.
    if (screen.prompt) return this.anyShown() ? undefined : this.show(waiting);
    // The review answers the oldest waiting request; a later one still gets its own prompt or review.
    if (screen.review && !this.reviewing) { this.reviewing = true; this.requests.splice(this.requests.indexOf(waiting), 1); }
    return;
  }

  /** Neither Codex's prompt nor its review was recognized in time: show the request as Codex asks. */
  showOverdue(): AgentStatusUpdate | undefined {
    const waiting = this.requests.find(request => !request.shown);
    if (!waiting || this.anyShown() || this.due(waiting) > this.now()) return;
    return this.show(waiting);
  }

  /** A delivered key is evidence about this shell's Codex, never a completion. */
  observeInput(data: string): AgentStatusUpdate | undefined {
    const submitted = submitsOutsidePaste(data, this.paste);
    if (this.status !== 'working' && this.status !== 'attention') return;
    if (isCancelInput(data)) {
      // Codex reports a real interrupt. If the key only closed a menu or declined a request,
      // the turn's next event restores the status.
      this.clear();
      return this.move('idle');
    }
    if (this.status !== 'attention') {
      // A prompt that was answered before its screen was recognized needs no showing any more.
      const index = submitted ? this.requests.findIndex(request => !request.shown) : -1;
      if (index >= 0) this.requests.splice(index, 1);
      return;
    }
    // Arrow keys, digits or letters may move the selection or answer through a shortcut.
    if (!submitted) { this.untouched = false; return; }
    const preselected = this.untouched && data === '\r';
    this.untouched = false;
    const index = this.requests.findIndex(request => request.shown);
    const answered = index >= 0 ? this.requests.splice(index, 1)[0] : undefined;
    if (answered) this.freedAt = this.now();
    // Another shown request comes next, with a selection nobody knows.
    if (this.anyShown()) return;
    return this.move(preselected && answered?.kind === 'permission' ? 'working' : 'idle');
  }
}
