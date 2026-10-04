import { net, session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { AppError, PROTOCOL_VERSION, type HostEvent, type Transport, type ServerMessage } from '../../packages/protocol/index';
import type { SavedHost } from './contracts';

export class RemoteTransport implements Transport {
  private ses: Session;
  private ws?: Electron.WebSocket;
  private csrf = '';
  private listeners = new Set<(event: HostEvent) => void>();
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private lifetime = new AbortController();
  private origin: string;
  constructor(private host: SavedHost, private bindIdentity: (id: string) => Promise<void>, private onLost: () => void) {
    this.origin = host.url!;
    this.ses = session.fromPartition('persist:mongle-host-' + host.id, { cache: false });
    this.ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    this.ses.setPermissionCheckHandler(() => false);
  }
  private ensureOpen() {
    if (this.closed) throw new AppError('OFFLINE', '연결을 닫았습니다. 이전 입력을 자동으로 다시 보내지 않습니다.');
  }
  private async json(route: string, body?: unknown, credentials: 'include' | 'omit' = 'include') {
    this.ensureOpen();
    const response = await this.ses.fetch(this.origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      credentials, redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Origin: this.origin, ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]),
    });
    this.ensureOpen();
    const text = await response.text();
    this.ensureOpen();
    if (text.length > 2 * 1024 * 1024) throw new Error('서버 응답이 너무 큽니다.');
    let data: any; try { data = JSON.parse(text); } catch { throw new Error('몽글터미널 서버 응답을 확인하지 못했습니다.'); }
    if (!response.ok) throw new AppError(data.error?.code || data.code || 'REMOTE_ERROR', data.error?.message || data.message || '원격 요청을 완료하지 못했습니다.');
    return data;
  }
  async connect(): Promise<{ paired: boolean; hostId: string; connectionId?: string }> {
    const health = await this.json('/health', undefined, 'omit');
    this.ensureOpen();
    if (typeof health.hostId !== 'string') throw new Error('서버 설치 정보를 확인하지 못했습니다.');
    if (health.protocolVersion !== PROTOCOL_VERSION) throw new AppError('VERSION_MISMATCH', '원격 컴퓨터의 몽글터미널 버전이 호환되지 않습니다. 해당 컴퓨터의 앱 버전을 확인하세요.');
    await this.bindIdentity(health.hostId);
    const info = await this.json('/v1/session');
    this.ensureOpen();
    if (!info.authenticated) return { paired: false, hostId: health.hostId };
    if (info.hostId !== health.hostId) throw new Error('연결 중 서버 설치 정보가 바뀌었습니다.');
    this.csrf = info.csrf;
    const issued = await this.json('/v1/ws-ticket', {});
    this.ensureOpen();
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws = new net.WebSocket(this.origin.replace(/^https:/, 'wss:') + '/v1/ws', { session: this.ses, useSessionCookies: true, origin: this.origin });
      let authenticated = false;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new AppError('OFFLINE', '원격 연결을 닫았습니다.'));
      const timer = setTimeout(() => { finish(new Error('원격 연결 시간이 초과되었습니다.')); ws.close(); }, 10_000);
      this.lifetime.signal.addEventListener('abort', cancel, { once: true });
      ws.onopen = () => { if (!this.closed) ws.send(JSON.stringify({ type: 'authenticate', ticket: issued.ticket })); };
      ws.onmessage = (event: { data: string | Buffer }) => {
        if (this.closed) return;
        const text = event.data.toString(); if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) { ws.close(1009); return; }
        let value: any; try { value = JSON.parse(text); } catch { ws.close(1002); return; }
        if (!authenticated) {
          if (value.type !== 'authenticated') { finish(new Error('원격 인증 응답을 확인하지 못했습니다.')); ws.close(1008); return; }
          authenticated = true; finish(); return;
        }
        this.receive(value);
      };
      ws.onerror = () => { finish(new Error('원격 연결에 실패했습니다. Tailscale 연결을 확인하세요.')); };
      ws.onclose = () => { finish(new Error('원격 연결이 종료되었습니다.')); this.rejectPending(); if (!this.closed) this.onLost(); };
    });
    const context = await this.request<{ id: string }>('connection.info');
    return { paired: true, hostId: health.hostId, connectionId: context.id };
  }
  private receive(message: ServerMessage) {
    if (message.type === 'response') {
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result); else request.reject(new AppError(message.error.code, message.error.message));
    } else for (const listener of this.listeners) listener(message);
  }
  async pairing(method: string, params: unknown) {
    const routes: Record<string, string> = { 'pairing.request': '/v1/pairings/request', 'pairing.status': '/v1/pairings/status', 'pairing.claim': '/v1/pairings/claim', 'auth.logout': '/v1/logout' };
    const route = routes[method]; if (!route) throw new Error('지원하지 않는 인증 요청입니다.');
    return this.json(route, params ?? {});
  }
  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== 1 || this.closed) return Promise.reject(new AppError('OFFLINE', '연결이 끊어졌습니다. 입력은 다시 보내지 않았습니다.'));
    if (this.ws.bufferedAmount > 1024 * 1024 || this.pending.size >= 128) return Promise.reject(new AppError('BACKPRESSURE', '연결이 느립니다. 잠시 후 다시 시도하세요.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError('REQUEST_TIMEOUT', '요청 결과를 확인하지 못했습니다. 입력은 자동으로 다시 보내지 않습니다.')); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: 'request', id, method, params }));
    });
  }
  subscribe(listener: (event: HostEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private rejectPending() { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new AppError('OFFLINE', '연결이 끊어졌습니다.')); } this.pending.clear(); }
  close() { this.closed = true; this.lifetime.abort(); this.ws?.close(); this.rejectPending(); this.listeners.clear(); }
  async forget() { this.close(); await this.ses.clearStorageData(); await this.ses.closeAllConnections(); }
}
