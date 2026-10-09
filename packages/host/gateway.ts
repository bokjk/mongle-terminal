import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { AuthStore, secret, safeEqual, type AuthSession } from '../auth/store.ts';
import { AppError, errorResult, requestSchema, PROTOCOL_VERSION, type ConnectionContext, type Send, type HostEvent } from '../protocol/index.ts';

interface GatewayCore {
  getState(): { hostId: string; [key: string]: any };
  connect(ctx: ConnectionContext, send: Send): void;
  disconnect(id: string): void;
  handle(method: string, params: unknown, ctx: ConnectionContext): Promise<any>;
}
interface GatewayOptions { core: GatewayCore; dataDir: string; webRoot: string; port?: number; allowedOrigin?: string; }
type Ticket = { deviceId: string; origin: string; expiresAt: number };
type Peer = { ws: WebSocket; ctx: ConnectionContext; session: AuthSession; connected: boolean; expireTimer?: NodeJS.Timeout; };
const ownerMethods = new Set(['pairing.create', 'pairing.status', 'pairing.list', 'pairing.approve', 'pairing.reject', 'devices.list', 'devices.revoke', 'remote.configure', 'remote.status']);
// A paired device can already run shell commands, so it may also let another device in through
// its own address. Remote access settings and device revocation stay on the PC.
const deviceApprovalMethods = new Set(['pairing.create', 'pairing.list', 'pairing.approve', 'pairing.reject']);
const requestIdSchema = z.object({requestId: z.string().uuid()}).strict();
const pairSecretSchema = requestIdSchema.extend({requesterSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
const deviceSchema = z.object({deviceId: z.string().uuid()}).strict();
const emptySchema = z.object({}).strict();

export function normalizeRemoteOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('INVALID_ORIGIN', 'Tailscale HTTPS 주소를 입력해 주세요.'); }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new AppError('INVALID_ORIGIN', 'https://컴퓨터.테일넷.ts.net 형식의 주소만 사용할 수 있습니다.');
  return url.origin;
}
class RateLimiter {
  private buckets = new Map<string, {count: number; reset: number}>();
  allow(key: string, limit: number, windowMs = 60_000) {
    const now = Date.now();
    if (this.buckets.size > 2048) for (const [id, bucket] of this.buckets) if (bucket.reset <= now) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) { bucket = {count: 0, reset: now + windowMs}; this.buckets.set(key, bucket); }
    return ++bucket.count <= limit;
  }
}
function cookieToken(req: IncomingMessage, origin: string): string | undefined {
  const name = origin.startsWith('https:') ? '__Host-mongle' : 'mongle_loopback';
  const values = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  // Reject duplicate session cookies rather than trusting ambiguous parser ordering.
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}
function cookie(origin: string, token: string, maxAge = 30 * 24 * 60 * 60) {
  return `${origin.startsWith('https:') ? '__Host-mongle' : 'mongle_loopback'}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
function json(res: ServerResponse, status: number, data: unknown) {
  if (res.writableEnded) return;
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}
function errorStatus(code: string) {
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'UNAUTHENTICATED') return 401;
  if (['FORBIDDEN', 'INVALID_HOST', 'INVALID_ORIGIN', 'CSRF_FAILED'].includes(code)) return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}
function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || ''))
    return Promise.reject(new AppError('INVALID_REQUEST', 'JSON 요청만 허용됩니다.'));
  if (Number(req.headers['content-length']) > 16_384) { req.resume(); return Promise.reject(new AppError('PAYLOAD_TOO_LARGE', '요청이 너무 큽니다.')); }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > 16_384) { chunks.length = 0; fail(new AppError('PAYLOAD_TOO_LARGE', '요청이 너무 큽니다.')); return; }
      chunks.push(chunk);
    });
    req.once('end', () => {
      if (settled) return;
      settled = true;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AppError('INVALID_REQUEST', '올바른 JSON 요청이 아닙니다.')); }
    });
    req.once('error', fail);
    req.once('aborted', () => fail(new AppError('INVALID_REQUEST', '요청이 중단되었습니다.')));
  });
}

export async function startGateway({core, dataDir, webRoot, port = 0, allowedOrigin}: GatewayOptions) {
  await mkdir(dataDir, {recursive: true});
  const store = new AuthStore(resolve(dataDir, 'auth.sqlite'));
  try { if (allowedOrigin) store.setOrigin(normalizeRemoteOrigin(allowedOrigin)); }
  catch (error) { store.close(); throw error; }
  let remoteOrigin = store.getOrigin();
  let loopbackOrigin = '', closed = false;
  const limiter = new RateLimiter(), tickets = new Map<string, Ticket>();
  const blockedDevices = new Set<string>();
  const peers = new Set<Peer>();
  const ownerListeners = new Set<(event: HostEvent) => void>();
  const wss = new WebSocketServer({noServer: true, maxPayload: 131_072, perMessageDeflate: false, clientTracking: true});
  const emitPairings = () => {
    const event: HostEvent = {type: 'pairings', requests: store.listPairings()};
    for (const listener of ownerListeners) { try { listener(event); } catch { /* subscriber failure cannot roll back auth */ } }
  };
  const drop = (peer: Peer, code = 4001, reason = 'Authentication required') => {
    if (peer.connected) { peer.connected = false; core.disconnect(peer.ctx.id); }
    clearTimeout(peer.expireTimer);
    peers.delete(peer);
    if (peer.ws.readyState === WebSocket.OPEN || peer.ws.readyState === WebSocket.CONNECTING) peer.ws.close(code, reason);
  };
  const dropDevice = (deviceId: string) => {
    // Fail closed for the remainder of this host run even if the durable revoke write fails.
    blockedDevices.add(deviceId);
    for (const [key, ticket] of tickets) if (ticket.deviceId === deviceId) tickets.delete(key);
    for (const peer of peers) if (peer.session.deviceId === deviceId) drop(peer);
  };
  const requestOrigin = (req: IncomingMessage, requireOrigin = false) => {
    const host = req.headers.host;
    const candidates = [loopbackOrigin, remoteOrigin].filter((origin): origin is string => !!origin);
    const origin = candidates.find(candidate => host === new URL(candidate).host);
    if (!origin) throw new AppError('INVALID_HOST', '허용되지 않은 호스트입니다.');
    if (req.headers.origin !== undefined && req.headers.origin !== origin || requireOrigin && req.headers.origin !== origin)
      throw new AppError('INVALID_ORIGIN', '허용되지 않은 접속 주소입니다.');
    return origin;
  };
  const sessionFor = (req: IncomingMessage, origin: string) => {
    const token = cookieToken(req, origin);
    const session = token && store.authenticate(token, origin);
    if (!session || blockedDevices.has(session.deviceId)) throw new AppError('UNAUTHENTICATED', '이 기기를 PC에서 연결 승인해 주세요.');
    return session;
  };
  const isActive = (session: AuthSession) => {
    try { return !blockedDevices.has(session.deviceId) && store.isActive(session.deviceId, session.origin); }
    catch { return false; }
  };
  const csrfFor = (req: IncomingMessage, session: AuthSession) => {
    const csrf = req.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrf)) throw new AppError('CSRF_FAILED', '요청을 확인할 수 없습니다. 새로 연결해 주세요.');
  };
  const sessionResult = (session: AuthSession) => ({authenticated: true, csrf: session.csrf, deviceName: session.name, hostId: core.getState().hostId});
  const approveFromDevice = (method: string, params: unknown, session: AuthSession) => {
    if (!limiter.allow(`approval:${session.deviceId}`, 60)) throw new AppError('RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    if (method === 'pairing.create') {
      emptySchema.parse(params);
      if (!limiter.allow(`approval-code:${session.deviceId}`, 10)) throw new AppError('RATE_LIMITED', '연결 코드를 너무 자주 만들었습니다. 잠시 후 다시 시도해 주세요.');
      return store.createCode();
    }
    if (method === 'pairing.list') { emptySchema.parse(params); return {requests: store.listPairings(session.origin)}; }
    const {requestId} = requestIdSchema.parse(params);
    store.decidePairing(requestId, method === 'pairing.approve', {name: session.name, origin: session.origin});
    emitPairings();
    return {ok: true};
  };
  const api = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = requestOrigin(req, req.method !== 'GET' && req.method !== 'HEAD');
    const wsOrigin = origin.replace(/^http/, 'ws');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${wsOrigin}; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url || '/', origin);
    if (url.pathname.startsWith('/v1/') && url.search) throw new AppError('INVALID_REQUEST', 'API 요청에 쿼리 문자열을 사용할 수 없습니다.');
    const ip = req.socket.remoteAddress || 'unknown';
    if (!limiter.allow(`http:${ip}`, 600)) throw new AppError('RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    if (req.method === 'GET' && url.pathname === '/health') {
      const state = core.getState();
      return json(res, 200, {ok: true, hostId: state.hostId, bootId: state.bootId, protocolVersion: PROTOCOL_VERSION});
    }
    if (req.method === 'GET' && url.pathname === '/v1/session') {
      const token = cookieToken(req, origin), session = token && store.authenticate(token, origin);
      return json(res, 200, session && !blockedDevices.has(session.deviceId) ? sessionResult(session) : {authenticated: false});
    }
    if (req.method === 'GET' && url.pathname === '/v1/state') {
      sessionFor(req, origin);
      return json(res, 200, core.getState());
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/pairings/')) {
      if (!limiter.allow(`pairing:${ip}`, 120)) throw new AppError('RATE_LIMITED', '연결 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      const body = await readJson(req);
      if (url.pathname === '/v1/pairings/request') {
        if (!limiter.allow(`pairing-create:${ip}`, 10)) throw new AppError('RATE_LIMITED', '연결 요청이 너무 많습니다.');
        const {code, name} = z.object({code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/), name: z.string().trim().min(1).max(80).refine(value => !/[\x00-\x1f\x7f]/.test(value))}).strict().parse(body);
        const result = store.requestPairing(code, name, origin);
        emitPairings();
        return json(res, 200, result);
      }
      if (url.pathname === '/v1/pairings/status') {
        const {requestId, requesterSecret} = pairSecretSchema.parse(body);
        return json(res, 200, store.pairingStatus(requestId, requesterSecret, origin));
      }
      if (url.pathname === '/v1/pairings/claim') {
        const {requestId, requesterSecret} = pairSecretSchema.parse(body);
        const result = store.claimPairing(requestId, requesterSecret, origin);
        res.setHeader('Set-Cookie', cookie(origin, result.token));
        emitPairings();
        return json(res, 200, sessionResult(result.session));
      }
    }
    if (req.method === 'POST' && (url.pathname === '/v1/ws-ticket' || url.pathname === '/v1/logout')) {
      const session = sessionFor(req, origin);
      csrfFor(req, session);
      emptySchema.parse(await readJson(req));
      if (url.pathname === '/v1/logout') {
        try { store.revoke(session.deviceId); } finally { dropDevice(session.deviceId); }
        res.setHeader('Set-Cookie', cookie(origin, '', 0));
        return json(res, 200, {ok: true});
      }
      if (!limiter.allow(`ticket:${session.deviceId}`, 30)) throw new AppError('RATE_LIMITED', '연결 요청이 너무 많습니다.');
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(key);
      if (tickets.size >= 256) throw new AppError('RATE_LIMITED', '연결 요청이 너무 많습니다.');
      const ticket = secret(), expiresAt = Date.now() + 30_000;
      tickets.set(ticket, {deviceId: session.deviceId, origin, expiresAt});
      return json(res, 200, {ticket, expiresAt});
    }
    if (url.pathname.startsWith('/v1/') || req.method !== 'GET' && req.method !== 'HEAD') throw new AppError('NOT_FOUND', '요청한 항목을 찾을 수 없습니다.');
    // Do not allow encoded traversal, Windows alternate streams, backslashes, or symlinks outside webRoot.
    let pathname: string;
    try { pathname = decodeURIComponent((req.url || '/').split('?')[0]); } catch { throw new AppError('NOT_FOUND', '페이지를 찾을 수 없습니다.'); }
    if (pathname.split('/').includes('..') || /[\\:\x00]/.test(pathname)) throw new AppError('NOT_FOUND', '페이지를 찾을 수 없습니다.');
    const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.bcmap':'application/octet-stream','.pfb':'application/octet-stream','.ttf':'font/ttf','.woff2':'font/woff2','.woff':'font/woff'};
    let filePath = resolve(webRoot, pathname.replace(/^\/+/, '') || 'index.html');
    try { if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html'); }
    catch { if (!extname(pathname)) filePath = resolve(webRoot, 'index.html'); }
    const extension = extname(filePath).toLowerCase();
    if (!mime[extension]) throw new AppError('NOT_FOUND', '페이지를 찾을 수 없습니다.');
    try {
      const [rootPath, actualPath] = await Promise.all([realpath(webRoot), realpath(filePath)]);
      const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
      if (!normalize(actualPath).startsWith(normalize(rootPath + sep))) throw new AppError('NOT_FOUND', '페이지를 찾을 수 없습니다.');
      const info = await stat(actualPath);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new AppError('NOT_FOUND', '페이지를 찾을 수 없습니다.');
      res.writeHead(200, {'Content-Type': mime[extension], 'Content-Length': info.size});
      res.end(req.method === 'HEAD' ? undefined : await readFile(actualPath));
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError('NOT_FOUND', '웹 화면 파일을 찾을 수 없습니다.'); }
  };
  const server = http.createServer((req, res) => {
    void api(req, res).catch(error => { const result = errorResult(error); json(res, errorStatus(result.code), {error: result}); });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.on('upgrade', (req, socket, head) => {
    try {
      const origin = requestOrigin(req, true);
      if (req.url !== '/v1/ws') throw new AppError('NOT_FOUND', '잘못된 연결 주소입니다.');
      const session = sessionFor(req, origin);
      if (wss.clients.size >= 64 || !limiter.allow(`upgrade:${session.deviceId}`, 30)) throw new AppError('RATE_LIMITED', '연결 수가 너무 많습니다.');
      wss.handleUpgrade(req, socket, head, ws => attachSocket(ws, session));
    } catch (error) {
      const result = errorResult(error);
      socket.end(`HTTP/1.1 ${errorStatus(result.code)} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  function attachSocket(ws: WebSocket, session: AuthSession) {
    const ctx: ConnectionContext = {id: randomUUID(), deviceId: session.deviceId, deviceName: session.name, owner: false};
    const peer: Peer = {ws, ctx, session, connected: false};
    peers.add(peer);
    const authenticationTimeout = setTimeout(() => drop(peer, 4001, 'Ticket timeout'), 3_000);
    authenticationTimeout.unref();
    let processing = Promise.resolve(), pending = 0;
    const send: Send = message => {
      if (!peer.connected || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() >= session.expiresAt || !isActive(session)) { drop(peer); return; }
      if (ws.bufferedAmount > 2 * 1024 * 1024) { drop(peer, 4008, 'Client too slow; reconnect'); return; }
      ws.send(JSON.stringify(message));
    };
    ws.on('error', () => drop(peer));
    ws.on('close', () => { clearTimeout(authenticationTimeout); drop(peer); });
    ws.on('message', (buffer, binary) => {
      if (binary || ++pending > 64 || !limiter.allow(`rpc:${ctx.id}`, 300, 1000)) { drop(peer, 4008, 'Request limit'); return; }
      processing = processing.then(async () => {
        try {
          if (ws.readyState !== WebSocket.OPEN) return;
          let body: unknown;
          try { body = JSON.parse(buffer.toString()); } catch { drop(peer, 4002, 'Invalid JSON'); return; }
          if (!peer.connected) {
            const auth = z.object({type: z.literal('authenticate'), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().safeParse(body);
            const ticket = auth.success ? tickets.get(auth.data.ticket) : undefined;
            if (auth.success) tickets.delete(auth.data.ticket);
            if (!ticket || ticket.expiresAt <= Date.now() || ticket.deviceId !== session.deviceId || ticket.origin !== session.origin || !isActive(session)) {
              drop(peer, 4001, 'Invalid ticket'); return;
            }
            clearTimeout(authenticationTimeout);
            peer.connected = true;
            // Node timers cannot exceed 2^31-1 milliseconds. Re-arm long session expiry safely.
            const scheduleExpiry = () => {
              const remaining = session.expiresAt - Date.now();
              if (remaining <= 0) { drop(peer); return; }
              peer.expireTimer = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_483_647));
              peer.expireTimer.unref();
            };
            scheduleExpiry();
            ws.send(JSON.stringify({type: 'authenticated'}));
            core.connect(ctx, send);
            return;
          }
          if (!isActive(session)) { drop(peer); return; }
          const parsed = requestSchema.safeParse(body);
          if (!parsed.success) { drop(peer, 4002, 'Invalid request'); return; }
          const {id, method, params} = parsed.data;
          try {
            let result: unknown;
            if (deviceApprovalMethods.has(method)) result = approveFromDevice(method, params, session);
            else {
              if (ownerMethods.has(method) || /^(pairing|pairings|devices|remote|owner|host)\./.test(method)) throw new AppError('FORBIDDEN', '이 작업은 실행 PC에서만 할 수 있습니다.');
              result = await core.handle(method, params, ctx);
            }
            send({type:'response', id, ok:true, result});
          } catch (error) { send({type:'response', id, ok:false, error:errorResult(error)}); }
        } catch { drop(peer, 1011, 'Request failed'); }
        finally { pending--; }
      });
    });
  }
  try {
    await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
  } catch (error) { store.close(); wss.close(); throw error; }
  const actualPort = (server.address() as import('node:net').AddressInfo).port;
  loopbackOrigin = `http://127.0.0.1:${actualPort}`;
  const remoteStatus = () => ({origin: remoteOrigin, enabled: !!remoteOrigin, loopbackUrl: loopbackOrigin});
  return {
    port: actualPort,
    onOwnerEvents(listener: (event: HostEvent) => void) { ownerListeners.add(listener); return () => { ownerListeners.delete(listener); }; },
    async ownerRequest(method: string, params: unknown = {}): Promise<any> {
      if (closed) throw new AppError('HOST_STOPPED', '호스트가 종료되었습니다.');
      if (!ownerMethods.has(method)) throw new AppError('NOT_FOUND', '지원하지 않는 관리 요청입니다.');
      switch (method) {
        case 'pairing.create': emptySchema.parse(params); return store.createCode();
        case 'pairing.status': case 'pairing.list': emptySchema.parse(params); return {requests: store.listPairings()};
        case 'pairing.approve': case 'pairing.reject': {
          const {requestId} = requestIdSchema.parse(params); store.decidePairing(requestId, method === 'pairing.approve'); emitPairings(); return {ok: true};
        }
        case 'devices.list': emptySchema.parse(params); return {devices: store.listDevices()};
        case 'devices.revoke': {
          const {deviceId} = deviceSchema.parse(params);
          try { store.revoke(deviceId); } finally { dropDevice(deviceId); }
          return {ok: true};
        }
        case 'remote.configure': {
          const {origin} = z.object({origin: z.string().max(256).nullable()}).strict().parse(params);
          const next = origin ? normalizeRemoteOrigin(origin) : undefined;
          const previous = remoteOrigin;
          try { store.setOrigin(next); remoteOrigin = next; }
          catch (error) { remoteOrigin = undefined; throw error; }
          finally { if (next !== previous) for (const peer of peers) if (peer.session.origin === previous) drop(peer); }
          for (const [key, ticket] of tickets) if (ticket.origin !== loopbackOrigin && ticket.origin !== next) tickets.delete(key);
          return remoteStatus();
        }
        case 'remote.status': emptySchema.parse(params); return remoteStatus();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const peer of peers) { drop(peer, 1001, 'Host closing'); peer.ws.terminate(); }
      tickets.clear(); ownerListeners.clear();
      await new Promise<void>(resolveClose => wss.close(() => resolveClose()));
      await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); });
      store.close();
    },
  };
}
