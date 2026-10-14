import { randomUUID } from 'node:crypto';
import type { AgentHoldReason, AgentInboxSummary, AgentStatus } from '../protocol/index.js';

/** Longest message accepted. Longer material belongs in a file the agent can read. */
export const AGENT_MESSAGE_MAX_CHARS = 4000;
/** Messages waiting per terminal. */
export const AGENT_INBOX_MAX = 10;
const PREVIEW_CHARS = 120;
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';

export interface AgentInboxTiming {
  /** Someone who typed in the terminal within this window may still be typing. */
  typingQuietMs: number;
  /** A CLI that just reported its start may not have drawn its input box yet. */
  startSettleMs: number;
  /** The paste and its Enter are separate writes, so the CLI takes the text before the submit. */
  submitDelayMs: number;
  /** After a delivery, the next message waits for the agent's turn to start, at most this long. */
  deliveryAckMs: number;
}
export const AGENT_INBOX_TIMING: AgentInboxTiming = { typingQuietMs: 3000, startSettleMs: 1500, submitDelayMs: 150, deliveryAckMs: 20000 };

/**
 * Only printable text, line breaks and tabs remain: a message can never carry a key, an escape
 * sequence or the end of the bracketed paste it travels in. Line breaks become CR, as a pasted
 * line break; inside the paste it is text, not a submit.
 */
export function cleanAgentMessage(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, '').trim().replace(/\n/g, '\r');
}

const WIN32_KEY = /\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_/y;
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/y;
/**
 * Whether typed text may still sit in the CLI's input box. Only that fact is kept, never the text.
 * Enter outside a bracketed paste submits it; other keys, including deleting, leave the answer unknown,
 * so it stays true until the next Enter.
 */
export class DraftTracker {
  draft = false;
  private paste = false;
  /** True when the input submitted something with Enter. */
  observe(data: string): boolean {
    let submitted = false;
    for (let index = 0; index < data.length;) {
      if (data.startsWith(PASTE_START, index)) { this.paste = true; this.draft = true; index += PASTE_START.length; continue; }
      if (data.startsWith(PASTE_END, index)) { this.paste = false; index += PASTE_END.length; continue; }
      if (data[index] === '\x1b') {
        WIN32_KEY.lastIndex = index;
        const key = WIN32_KEY.exec(data);
        if (key) {
          // win32-input-mode: Vk;Sc;Uc;Kd;Cs;Rc. Only key presses count.
          if (key[4] === '1') {
            if (Number(key[1]) === 13 && !this.paste) { this.draft = false; submitted = true; }
            else if (Number(key[3] || 0) >= 0x20) this.draft = true;
          }
          index = WIN32_KEY.lastIndex; continue;
        }
        ESCAPE.lastIndex = index;
        const escape = ESCAPE.exec(data);
        index = escape ? ESCAPE.lastIndex : index + 1;
        continue;
      }
      const code = data.charCodeAt(index);
      if (data[index] === '\r' && !this.paste) { this.draft = false; submitted = true; }
      else if (code >= 0x20 && code !== 0x7f) this.draft = true;
      index += 1;
    }
    return submitted;
  }
}

export interface InboxFacts {
  /** The terminal runs a shell this version can deliver to (PowerShell with the agent token). */
  supported: boolean;
  /** Hook-proven status of the agent; undefined before its first report. */
  status?: AgentStatus;
  dnd: boolean;
}
/** How a message left the inbox: sent with its Enter, cancelled, or not delivered (write failed, the agent or terminal ended first). */
export type AgentMessageOutcome = 'delivered' | 'cancelled' | 'failed';
export interface InboxIo {
  /** Writes to the terminal's PTY. False when it can no longer be written. */
  write(data: string): boolean;
  facts(): InboxFacts;
  /** The summary changed; the host broadcasts its state. */
  changed(): void;
  /** A message left the inbox for good; each id settles exactly once. */
  settled?(id: string, outcome: AgentMessageOutcome): void;
  now?(): number;
}
interface Pending { id: string; text: string; preview: string; createdAt: number; from: string; force: boolean }

/**
 * Messages for the agent in one terminal generation, delivered one at a time and only while nothing
 * else may be reading the input box: the agent has proven by its hook that it runs in this shell, it
 * is not working nor asking, nobody has typed recently or left a draft, and the user did not turn on
 * do-not-disturb. Anything unknown holds the message. A delivery is a bracketed paste of the text and
 * a separate Enter, exactly what a person pasting and submitting would send.
 */
export class AgentInbox {
  private pending: Pending[] = [];
  private draft = new DraftTracker();
  private lastInputAt = Number.NEGATIVE_INFINITY;
  /** When the agent proved that it runs in this shell; undefined while the shell itself has the prompt. */
  private activeSince: number | undefined;
  /** A person submitted something no hook has answered yet (e.g. a slash command that opened a picker). */
  private unconfirmedSubmit = false;
  private deliveringSince: number | undefined;
  /** The pasted message whose Enter has not been sent yet. */
  private submitting: string | undefined;
  private hold: AgentHoldReason | undefined;
  private delivered = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private submitTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(private readonly io: InboxIo, private readonly timing: AgentInboxTiming = AGENT_INBOX_TIMING) {}
  private now() { return this.io.now?.() ?? Date.now(); }

  get size() { return this.pending.length; }
  /** The agent's hook proved that it runs in this shell and the shell prompt has not returned since. */
  get agentRunning() { return this.activeSince !== undefined; }
  has(id: string) { return this.pending.some(message => message.id === id); }
  summary(): AgentInboxSummary | undefined {
    if (!this.pending.length && !this.delivered) return;
    return {
      messages: this.pending.map(({id, preview, createdAt, from, force}) => ({id, preview, createdAt, from, ...(force ? {force:true as const} : {})})),
      ...(this.hold && this.pending.length ? {hold:this.hold} : {}),
      delivered: this.delivered,
    };
  }

  /** Returns the new message id. The text must be cleaned by cleanAgentMessage and not empty. */
  add(text: string, from: string, force = false, id: string = randomUUID()): string {
    const preview = text.replace(/\r/g, ' ').slice(0, PREVIEW_CHARS);
    this.pending.push({id, text, preview, createdAt:this.now(), from:from.slice(0, 100), force});
    this.pump();
    return id;
  }
  cancel(id: string): boolean {
    const index = this.pending.findIndex(message => message.id === id);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.settle(id, 'cancelled');
    this.pump();
    return true;
  }
  /** Sends the message even though someone may be typing; every other condition still applies. */
  force(id: string): boolean {
    const message = this.pending.find(item => item.id === id);
    if (!message) return false;
    message.force = true;
    this.pump();
    return true;
  }

  /** Keys a person sent to this terminal. Never retained. */
  observeInput(data: string) {
    this.lastInputAt = this.now();
    if (this.draft.observe(data) && this.activeSince !== undefined) this.unconfirmedSubmit = true;
    this.pump();
  }
  /** The agent's hook proved it runs in this shell. */
  agentStarted() {
    if (this.activeSince === undefined) { this.activeSince = this.now(); this.io.changed(); }
    this.pump();
  }
  /** The shell prompt returned or the agent reported its end: the input box is the shell's again. */
  agentStopped() {
    const was = this.activeSince !== undefined;
    this.activeSince = undefined;
    this.unconfirmedSubmit = false;
    this.endDelivery();
    if (was) this.io.changed();
    this.pump();
  }
  /** Any hook event of the agent: it answered whatever was submitted before. */
  agentReported() {
    this.unconfirmedSubmit = false;
    this.pump();
  }
  /** The agent's status changed: a started turn confirms the delivery. */
  statusChanged(status: AgentStatus | undefined) {
    if (this.deliveringSince !== undefined && (status === 'working' || status === 'attention')) this.endDelivery();
    this.pump();
  }

  /** Ends the wait for the agent's turn. A paste whose Enter was not sent yet is not delivered. */
  private endDelivery() {
    this.deliveringSince = undefined;
    if (this.submitTimer) { clearTimeout(this.submitTimer); this.settle(this.submitting, 'failed'); }
    this.submitTimer = undefined;
    this.submitting = undefined;
  }
  private settle(id: string | undefined, outcome: AgentMessageOutcome) { if (id) this.io.settled?.(id, outcome); }

  private reason(facts: InboxFacts, force: boolean, now: number): AgentHoldReason | undefined {
    // Without a running agent nothing can be delivered, whatever else holds the message.
    if (!facts.supported || this.activeSince === undefined) return 'no-agent';
    if (facts.dnd) return 'dnd';
    if (this.deliveringSince !== undefined) return 'delivering';
    if (facts.status === 'attention') return 'attention';
    if (facts.status === 'working') return 'busy';
    if (now - this.activeSince < this.timing.startSettleMs) return 'starting';
    if (this.unconfirmedSubmit && !force) return 'unconfirmed';
    if (!force && (this.draft.draft || now - this.lastInputAt < this.timing.typingQuietMs)) return 'typing';
  }
  /** When a timed hold ends by itself; event-driven holds wait for the event. */
  private retryIn(reason: AgentHoldReason, now: number): number | undefined {
    if (reason === 'starting') return this.activeSince! + this.timing.startSettleMs - now;
    if (reason === 'delivering') return this.deliveringSince! + this.timing.deliveryAckMs - now;
    if (reason === 'typing' && !this.draft.draft) return this.lastInputAt + this.timing.typingQuietMs - now;
  }

  pump() {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    // An unconfirmed delivery that the agent never answered stops blocking the next one.
    if (this.deliveringSince !== undefined && now - this.deliveringSince >= this.timing.deliveryAckMs) this.endDelivery();
    const next = this.pending[0];
    const hold = next ? this.reason(this.io.facts(), next.force, now) : undefined;
    const before = this.hold;
    this.hold = hold;
    if (next && hold) {
      const wait = this.retryIn(hold, now);
      if (wait !== undefined) { this.timer = setTimeout(() => this.pump(), Math.max(1, wait)); this.timer.unref?.(); }
    }
    if (next && !hold) { this.deliver(next, now); return; }
    if (before !== hold) this.io.changed();
  }

  private deliver(message: Pending, now: number) {
    this.pending.shift();
    this.deliveringSince = now;
    this.hold = 'delivering';
    if (!this.io.write(PASTE_START + message.text + PASTE_END)) { this.endDelivery(); this.settle(message.id, 'failed'); this.io.changed(); return; }
    this.submitting = message.id;
    this.submitTimer = setTimeout(() => {
      this.submitTimer = undefined;
      this.submitting = undefined;
      // The prompt is the shell's again: Enter would run the pasted text as a command.
      if (this.disposed || this.activeSince === undefined || !this.io.facts().supported) { this.endDelivery(); this.settle(message.id, 'failed'); this.pump(); return; }
      if (this.io.write('\r')) { this.delivered += 1; this.settle(message.id, 'delivered'); }
      else this.settle(message.id, 'failed');
      this.io.changed();
      this.pump();
    }, this.timing.submitDelayMs);
    this.submitTimer.unref?.();
    this.io.changed();
  }

  /** The terminal generation ended: whatever still waits is not delivered. */
  dispose() {
    const waiting = this.pending.map(message => message.id);
    this.disposed = true;
    this.pending = [];
    if (this.timer) clearTimeout(this.timer);
    this.endDelivery();
    for (const id of waiting) this.settle(id, 'failed');
  }
}
