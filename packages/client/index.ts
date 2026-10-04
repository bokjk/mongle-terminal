import type { HostEvent, Transport } from '../protocol/index';
import type { UpdateState } from '../../apps/desktop/contracts';
export type { UpdateState } from '../../apps/desktop/contracts';

export type ConnectionInfo = { status: 'connecting' | 'connected' | 'pairing' | 'offline'; hostId?: string; connectionId?: string; owner: boolean; error?: string };
export type SavedHost = { id: string; name: string; url?: string; local: boolean; selected: boolean };
export interface DesktopBridge {
  titleBarOverlay?: boolean;
  setWindowTheme?(theme: 'dark' | 'light'): Promise<void>;
  request<T = any>(method: string, params?: unknown): Promise<T>;
  subscribe(listener: (event: HostEvent) => void): () => void;
  listHosts(): Promise<SavedHost[]>;
  addHost(host: {name: string; url: string}): Promise<SavedHost>;
  removeHost(id: string): Promise<void>;
  selectHost(id: string): Promise<ConnectionInfo>;
  selectDirectory?(currentPath?: string): Promise<string | null>;
  readClipboard?(): Promise<string>;
  writeClipboard?(text: string): Promise<void>;
  getUpdateState?(): Promise<UpdateState>;
  checkForUpdates?(): Promise<UpdateState>;
  installUpdate?(): Promise<void>;
  onUpdate?(listener: (state: UpdateState) => void): () => void;
  onConnection(listener: (info: ConnectionInfo) => void): () => void;
}
declare global { interface Window { mongle?: DesktopBridge } }
export class RpcError extends Error { constructor(message: string, public code = 'REQUEST_FAILED') { super(message); } }

export interface AppClient extends Transport {
  onConnection(listener: (info: ConnectionInfo) => void): () => void;
  reconnect(): void;
  pairingRequest(code: string, name: string): Promise<any>;
  pairingStatus(requestId: string, requesterSecret: string): Promise<any>;
  pairingClaim(requestId: string, requesterSecret: string): Promise<any>;
}

class DesktopClient implements AppClient {
  constructor(private bridge: DesktopBridge) {}
  request<T = any>(method: string, params?: unknown) { return this.bridge.request<T>(method, params); }
  subscribe(listener: (event: HostEvent) => void) { return this.bridge.subscribe(listener); }
  onConnection(listener: (info: ConnectionInfo) => void) { return this.bridge.onConnection(listener); }
  reconnect() { void this.bridge.listHosts().then(hosts => { const host = hosts.find(h => h.selected); if (host) return this.bridge.selectHost(host.id); }); }
  pairingRequest(code: string, name: string) { return this.request('pairing.request', {code, name}); }
  pairingStatus(requestId: string, requesterSecret: string) { return this.request('pairing.status', {requestId, requesterSecret}); }
  pairingClaim(requestId: string, requesterSecret: string) { return this.request('pairing.claim', {requestId, requesterSecret}); }
  close() {}
}

export class BrowserClient implements AppClient {
  private socket?: WebSocket;
  private listeners = new Set<(event: HostEvent) => void>();
  private connectionListeners = new Set<(info: ConnectionInfo) => void>();
  private pending = new Map<string, {resolve: (v:any)=>void; reject:(e:Error)=>void; timer:ReturnType<typeof setTimeout>}>();
  private info: ConnectionInfo = { status: 'connecting', owner: false };
  private closed = false;
  private connecting = false;
  private generation = 0;
  private connectAbort?: AbortController;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private csrf = '';
  constructor() { void this.connect(); }
  private announce(info: ConnectionInfo) { this.info = info; this.connectionListeners.forEach(fn => fn(info)); }
  private async json(path: string, data?: unknown, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(path, {method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal:signal ? AbortSignal.any([signal, timeout]) : timeout, headers: data === undefined ? {} : {'Content-Type':'application/json', ...(this.csrf ? {'X-CSRF-Token':this.csrf} : {})}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new RpcError(body.error?.message || body.message || '요청을 완료하지 못했습니다.', body.error?.code || `${response.status}`);
    return body;
  }
  private async connect() {
    if (this.closed || this.connecting || this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = true;
    const generation = ++this.generation;
    const controller = this.connectAbort = new AbortController();
    const current = () => !this.closed && this.generation === generation;
    this.announce({status:'connecting',owner:false});
    try {
      const session = await this.json('/v1/session', undefined, controller.signal);
      if (!current()) return;
      if (!session.authenticated) { this.announce({status:'pairing', owner:false}); return; }
      this.csrf = session.csrfToken || session.csrf || '';
      const ticket = await this.json('/v1/ws-ticket', {}, controller.signal);
      if (!current()) return;
      const url = new URL('/v1/ws', location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = this.socket = new WebSocket(url);
      const active = () => current() && this.socket === socket;
      const handshakeTimer=this.handshakeTimer=setTimeout(()=>{if(active()&&this.info.status!=='connected')socket.close();},10000);
      socket.onopen = () => { if (active()) socket.send(JSON.stringify({type:'authenticate',ticket:ticket.ticket})); };
      socket.onmessage = event => {
        if (!active()) return;
        let message: any; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'authenticated') { clearTimeout(handshakeTimer);this.attempt = 0; this.announce({status:'connected',owner:false,connectionId:message.connectionId,hostId:message.hostId}); return; }
        if (message.type === 'response') {
          const pending = this.pending.get(message.id); if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result); else pending.reject(new RpcError(message.error?.message || '요청 실패', message.error?.code));
        } else this.listeners.forEach(fn => fn(message));
      };
      socket.onerror = () => { if (active()) socket.close(); };
      socket.onclose = () => {
        clearTimeout(handshakeTimer);
        if (!active()) return;
        this.socket = undefined;
        this.rejectPending('연결이 끊겼습니다. 마지막 입력의 전달 여부를 확인해 주세요.');
        if (!this.closed) { this.announce({status:'offline',owner:false,error:'컴퓨터와 연결이 끊겼습니다. 다시 연결하고 있습니다.'}); this.schedule(); }
      };
    } catch (error) {
      if (!current()) return;
      if (error instanceof RpcError && ['401','UNAUTHENTICATED','AUTH_REQUIRED'].includes(error.code)) this.announce({status:'pairing',owner:false});
      else { this.announce({status:'offline',owner:false,error:error instanceof Error ? error.message : '연결할 수 없습니다.'}); this.schedule(); }
    } finally { if (current()) { this.connecting = false; this.connectAbort = undefined; } }
  }
  private schedule() { clearTimeout(this.retry); if (!this.closed) this.retry = setTimeout(() => void this.connect(), Math.min(15000, 1000 * 2 ** Math.min(this.attempt++, 4))); }
  private rejectPending(message: string) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new RpcError(message, 'CONNECTION_LOST')); }
    this.pending.clear();
  }
  private disconnect(message: string) {
    ++this.generation;
    this.connectAbort?.abort();
    this.connectAbort = undefined;
    this.connecting = false;
    clearTimeout(this.retry);
    clearTimeout(this.handshakeTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.rejectPending(message);
    socket?.close();
  }
  reconnect() {
    if (this.closed) return;
    this.attempt = 0;
    this.disconnect('연결을 다시 열었습니다. 이전 입력을 자동으로 다시 보내지 않습니다.');
    void this.connect();
  }
  request<T = any>(method: string, params: unknown = {}): Promise<T> {
    if(method==='auth.logout')return this.json('/v1/logout',{}).then(result=>{this.csrf='';this.reconnect();return result as T;});
    if (this.closed || this.info.status !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError('컴퓨터에 연결한 뒤 다시 시도해 주세요.', 'OFFLINE'));
    const id = crypto.randomUUID();
    return new Promise((resolve,reject) => {
      const frame = JSON.stringify({type:'request',id,method,params});
      const timer = setTimeout(() => {this.pending.delete(id); reject(new RpcError('응답을 기다리는 시간이 초과되었습니다. 입력은 자동으로 다시 보내지 않습니다.', 'TIMEOUT'));}, 15000);
      this.pending.set(id,{resolve,reject,timer});
      try { this.socket!.send(frame); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  subscribe(listener: (event: HostEvent) => void) { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; }
  onConnection(listener: (info: ConnectionInfo) => void) { this.connectionListeners.add(listener); listener(this.info); return () => {this.connectionListeners.delete(listener);}; }
  pairingRequest(code: string, name: string) { return this.json('/v1/pairings/request',{code,name}); }
  pairingStatus(requestId: string, requesterSecret: string) { return this.json('/v1/pairings/status',{requestId,requesterSecret}); }
  async pairingClaim(requestId: string, requesterSecret: string) { const result = await this.json('/v1/pairings/claim',{requestId,requesterSecret}); this.reconnect(); return result; }
  close() {
    this.closed = true;
    this.disconnect('연결을 닫았습니다. 마지막 입력의 전달 여부를 확인해 주세요.');
    this.listeners.clear();
    this.connectionListeners.clear();
  }
}
export function createClient(): AppClient { return window.mongle ? new DesktopClient(window.mongle) : new BrowserClient(); }

