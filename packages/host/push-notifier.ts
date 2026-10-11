import { AppError, type HostState } from '../protocol/index.ts';
import { AWAY_IDLE_MS, type PcPresence } from './presence.ts';
import type { PushMessage, PushResult, PushSubscriptionRecord } from './web-push.ts';

export interface PushTarget { deviceId: string; subscription: PushSubscriptionRecord }
/** What the service worker shows (apps/web/public/sw.js). Names only: never terminal output or pairing codes. */
export interface PushPayload { v: 1; kind: 'attention' | 'pairing' | 'test'; title: string; body: string; tag: string; url: string; ts: number }
export interface PushNotifierOptions {
  /** Subscribed devices that may still connect; for a pairing request only those paired through its address. */
  targets(origin?: string): PushTarget[];
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
  /** The browser dropped this subscription (404/410). */
  forget(deviceId: string): void;
  presence(): Promise<PcPresence>;
  /** Until when someone counts as looking at this PC's Mongle on a device (Infinity while a view is open). */
  viewingUntil(): number;
  hostName(): string;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}
interface Alert { key: string; payload: PushPayload; origin?: string; ttl: number; expiresAt: number; done: Set<string>; failures: Map<string, { count: number; at: number }> }

const ATTENTION_TTL_SECONDS = 15 * 60;
const RETRY_MS = 30_000;
const MAX_FAILURES = 3;
const PRESENCE_CACHE_MS = 10_000;
const shorten = (value: string, length: number) => value.length > length ? value.slice(0, length - 1) + '…' : value;

/**
 * Phone notifications for Claude·Codex requests and new device requests. Each waiting request goes
 * to each subscribed device at most once, and only while nobody is at this PC (locked, another
 * session, or no input for five minutes) and nobody looked at this PC's Mongle on a device within
 * the last five minutes. A request still waiting when that becomes true is sent then; an answered
 * one is dropped. Completions are not sent.
 */
export class PushNotifier {
  private readonly alerts = new Map<string, Alert>();
  private timer: unknown;
  private dueAt = Infinity;
  private running = false;
  private again = false;
  private closed = false;
  private cached?: { at: number; value: PcPresence };
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly options: PushNotifierOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return timer; });
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** Called with every state broadcast. A terminal entering 'attention' becomes a waiting request. */
  observeState(state: HostState): void {
    if (this.closed) return;
    const waiting = new Set<string>();
    const groups = new Map(state.groups.map(group => [group.id, group.name]));
    let added = false;
    for (const terminal of state.terminals) {
      if (terminal.status !== 'running' || terminal.agentStatus !== 'attention') continue;
      const key = `attention:${terminal.id}:${terminal.generation}`;
      waiting.add(key);
      if (this.alerts.has(key)) continue;
      const agent = terminal.agentProvider === 'codex' ? 'Codex' : 'Claude';
      const place = [groups.get(terminal.groupId), terminal.title].filter((value): value is string => !!value).map(value => shorten(value, 40)).join(' · ');
      this.alerts.set(key, this.alert(key, { kind: 'attention', title: shorten(state.name, 60), body: `${place}: ${agent}가 확인을 기다리고 있습니다.`, tag: `attention-${terminal.id}`, url: `/?terminal=${terminal.id}` }, ATTENTION_TTL_SECONDS, Infinity));
      added = true;
    }
    for (const key of [...this.alerts.keys()]) if (key.startsWith('attention:') && !waiting.has(key)) this.alerts.delete(key);
    if (added) this.schedule(0);
  }

  /** A device asked to connect through a remote address; devices paired through it can approve. */
  pairingRequested(request: { requestId: string; name: string; origin: string; expiresAt: number }): void {
    if (this.closed || request.expiresAt <= this.now()) return;
    const key = `pairing:${request.requestId}`;
    if (this.alerts.has(key)) return;
    this.alerts.set(key, this.alert(key, { kind: 'pairing', title: shorten(this.options.hostName(), 60), body: `새 기기 연결 요청: ${shorten(request.name, 60)}. 열어서 승인하거나 거절하세요.`, tag: `pairing-${request.requestId}`, url: '/?open=pairing' }, 0, request.expiresAt, request.origin));
    this.schedule(0);
  }

  /** Requests decided, claimed or expired need no notification any more. */
  pairingsPending(requestIds: Iterable<string>): void {
    const pending = new Set(requestIds);
    for (const key of [...this.alerts.keys()]) if (key.startsWith('pairing:') && !pending.has(key.slice('pairing:'.length))) this.alerts.delete(key);
  }

  /** A device opened or left a Mongle view of this PC. */
  presenceChanged(): void { this.schedule(0); }

  /** Sends right away, for the settings button: the user is looking at the phone and wants to see it work. */
  async sendTest(deviceId: string): Promise<{ ok: true }> {
    const target = this.options.targets().find(item => item.deviceId === deviceId);
    if (!target) throw new AppError('PUSH_NOT_SUBSCRIBED', '이 기기의 알림이 꺼져 있습니다. 먼저 알림을 켜 주세요.');
    const payload: PushPayload = { v: 1, kind: 'test', title: shorten(this.options.hostName(), 60), body: '알림이 켜졌습니다. PC 앞에 없을 때 확인 요청과 새 기기 연결 요청을 이렇게 알려 드립니다.', tag: 'test', url: '/', ts: this.now() };
    const result = await this.options.send(target, { ttl: 120, urgency: 'high', payload });
    if (result.status === 'gone') { this.options.forget(deviceId); throw new AppError('PUSH_EXPIRED', '브라우저의 알림 구독이 만료됐습니다. 알림을 다시 켜 주세요.'); }
    if (result.status === 'failed') throw new AppError('PUSH_FAILED', result.httpStatus ? `알림 서비스가 시험 알림을 받지 않았습니다(${result.httpStatus}). 잠시 후 다시 시도해 주세요.` : '알림 서비스에 연결하지 못했습니다. PC의 인터넷 연결을 확인해 주세요.');
    return { ok: true };
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.alerts.clear();
  }

  private alert(key: string, content: Omit<PushPayload, 'v' | 'ts'>, ttl: number, expiresAt: number, origin?: string): Alert {
    return { key, payload: { v: 1, ...content, ts: this.now() }, ttl, expiresAt, done: new Set(), failures: new Map(), ...(origin ? { origin } : {}) };
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    const wait = Math.max(0, delay), at = this.now() + wait;
    if (this.timer !== undefined) { if (this.dueAt <= at) return; this.clearTimer(this.timer); }
    this.dueAt = at;
    this.timer = this.setTimer(() => { this.timer = undefined; this.dueAt = Infinity; void this.run(); }, wait);
  }

  private async run(): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try { do { this.again = false; await this.pass(); } while (this.again && !this.closed); }
    catch { /* The next change or timer tries again. */ }
    finally { this.running = false; }
  }

  private async presence(): Promise<PcPresence> {
    if (this.cached && this.now() - this.cached.at < PRESENCE_CACHE_MS) return this.cached.value;
    const value = await this.options.presence().catch((): PcPresence => ({ away: true, reason: 'unknown' }));
    this.cached = { at: this.now(), value };
    return value;
  }

  private async pass(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    for (const [key, alert] of this.alerts) if (alert.expiresAt <= now) this.alerts.delete(key);
    let retryAt = Infinity;
    const due: Array<[Alert, PushTarget]> = [];
    for (const alert of this.alerts.values()) for (const target of this.options.targets(alert.origin)) {
      if (alert.done.has(target.deviceId)) continue;
      const failure = alert.failures.get(target.deviceId);
      if (failure && failure.count >= MAX_FAILURES) continue;
      if (failure && now - failure.at < RETRY_MS) { retryAt = Math.min(retryAt, failure.at + RETRY_MS); continue; }
      due.push([alert, target]);
    }
    if (!due.length) { if (retryAt < Infinity) this.schedule(retryAt - now); return; }
    // Someone looks at this PC's Mongle on a device: wait until that view has been closed long enough.
    const viewing = this.options.viewingUntil();
    if (viewing > now) { if (Number.isFinite(viewing)) this.schedule(viewing - now); return; }
    const presence = await this.presence();
    if (this.closed) return;
    // At the PC: look again when five minutes without input could have passed, and at least every minute for a lock.
    if (!presence.away) { this.schedule(Math.min(60_000, Math.max(15_000, AWAY_IDLE_MS - (presence.idleMs ?? 0)))); return; }
    let failed = false;
    await Promise.all(due.map(async ([alert, target]) => {
      if (this.alerts.get(alert.key) !== alert) return; // answered while checking
      const ttl = Number.isFinite(alert.expiresAt) ? Math.max(1, Math.floor((alert.expiresAt - this.now()) / 1000)) : alert.ttl;
      const result = await this.options.send(target, { ttl, urgency: 'high', payload: alert.payload }).catch((): PushResult => ({ status: 'failed' }));
      if (result.status === 'sent') alert.done.add(target.deviceId);
      else if (result.status === 'gone') { alert.done.add(target.deviceId); this.options.forget(target.deviceId); }
      else { const previous = alert.failures.get(target.deviceId); alert.failures.set(target.deviceId, { count: (previous?.count ?? 0) + 1, at: this.now() }); failed = true; }
    }));
    if (failed) this.schedule(RETRY_MS);
  }
}
