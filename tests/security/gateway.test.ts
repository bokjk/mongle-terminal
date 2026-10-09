import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { startGateway } from '../../packages/host/gateway.ts';

type JsonResponse = { status: number; headers: Record<string, any>; body: any; text: string };
type Gateway = Awaited<ReturnType<typeof startGateway>>;

function mockCore() {
  const connections = new Map<string, any>();
  const disconnected: string[] = [];
  const calls: { method: string; params: unknown; context: any }[] = [];
  const state = {
    hostId: randomUUID(), bootId: randomUUID(), name: 'Security test host',
    version: '0.1.0', protocolVersion: 1, groups: [], terminals: [], profiles: [],
    settings: { name: 'Security test host', recordHistory: false, scrollback: 1000 },
  };
  return {
    connections, disconnected, calls,
    async init() {}, getState: () => state,
    connect(context: any, send: (event: any) => void) {
      connections.set(context.id, context);
      send({ type: 'state', state });
    },
    disconnect(id: string) { disconnected.push(id); connections.delete(id); },
    async handle(method: string, params: unknown, context: any) {
      calls.push({ method, params, context });
      return { method, owner: context.owner };
    },
    async close() {},
  };
}

class SocketProbe {
  readonly messages: any[] = [];
  readonly socket: WebSocket;
  private waiters: (() => void)[] = [];
  private ended = false;
  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('message', data => {
      try { this.messages.push(JSON.parse(data.toString())); }
      catch { this.messages.push({ malformed: data.toString() }); }
      this.notify();
    });
    this.socket.on('error', () => { this.ended = true; this.notify(); });
    this.socket.on('close', () => { this.ended = true; this.notify(); });
  }
  private notify() { for (const wake of this.waiters.splice(0)) wake(); }
  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 3000);
      this.socket.once('open', () => { clearTimeout(timeout); resolve(); });
      this.socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
  }
  send(value: unknown) { this.socket.send(JSON.stringify(value)); }
  async until(predicate: () => boolean, description: string) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      const left = deadline - Date.now();
      assert.ok(left > 0, `Timed out waiting for ${description}`);
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, Math.min(left, 100));
        this.waiters.push(() => { clearTimeout(timeout); resolve(); });
      });
    }
  }
  async message(predicate: (message: any) => boolean) {
    await this.until(() => this.messages.some(predicate), 'WebSocket message');
    return this.messages.find(predicate);
  }
  async closed() { await this.until(() => this.ended, 'WebSocket close'); }
  destroy() { this.socket.terminate(); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mongle-security-'));
  const dataDir = join(root, 'state');
  const webRoot = join(root, 'web');
  await mkdir(dataDir); await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Mongle security fixture</title>');
  await writeFile(join(root, 'private-secret.txt'), 'MONGLE_OUTSIDE_WEBROOT_SECRET');
  const core = mockCore();
  let gateway: Gateway = await startGateway({ core: core as any, dataDir, webRoot, port: 0 });
  const sockets: SocketProbe[] = [];
  const origin = () => `http://127.0.0.1:${gateway.port}`;
  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: gateway.port, method, path,
        headers: { ...(text === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }), ...headers },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const result = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown; try { parsed = JSON.parse(result); } catch { parsed = undefined; }
          resolve({ status: response.statusCode!, headers: response.headers, body: parsed, text: result });
        });
      });
      req.on('error', reject);
      req.setTimeout(4000, () => req.destroy(new Error('HTTP test request timed out')));
      req.end(text);
    });
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request('POST', path, body, { Origin: origin(), ...headers });
  async function pairing(name = 'Test phone') {
    const code = await gateway.ownerRequest('pairing.create', {});
    const requested = await post('/v1/pairings/request', { code: code.code, name });
    assert.ok(requested.status >= 200 && requested.status < 300, requested.text);
    return { requestId: requested.body.requestId as string, requesterSecret: requested.body.requesterSecret as string };
  }
  async function paired(name = 'Test phone') {
    const pending = await pairing(name);
    await gateway.ownerRequest('pairing.approve', { requestId: pending.requestId });
    const response = await post('/v1/pairings/claim', pending);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.authenticated, true);
    const cookie = (response.headers['set-cookie'] as string[])[0].split(';')[0];
    assert.ok(cookie);
    return { ...pending, cookie, csrf: response.body.csrf as string, response };
  }
  async function ticket(auth: { cookie: string; csrf: string }) {
    const response = await post('/v1/ws-ticket', {}, { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf });
    assert.equal(response.status, 200, response.text);
    assert.equal(typeof response.body.ticket, 'string');
    return response.body.ticket as string;
  }
  function socket(cookie: string, headers: Record<string, string> = {}) {
    const probe = new SocketProbe(`ws://127.0.0.1:${gateway.port}/v1/ws`, { Origin: origin(), Cookie: cookie, ...headers });
    sockets.push(probe);
    return probe;
  }
  return {
    root, dataDir, webRoot, core, origin, request, post, pairing, paired, ticket, socket,
    get gateway() { return gateway; },
    async restart() {
      const port = gateway.port;
      await gateway.close();
      gateway = await startGateway({ core: core as any, dataDir, webRoot, port });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await gateway.close();
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('mongle-security-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function assertDenied(response: JsonResponse) {
  assert.ok([400, 401, 403, 404, 409, 410, 429].includes(response.status), `Expected denied request; got ${response.status}: ${response.text}`);
}

test('file and Git RPC use the paired WebSocket context and cannot bypass first-frame authentication', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    for (const method of ['files.list', 'files.open', 'files.pdf', 'files.save', 'files.reload', 'git.status']) {
      const unauthenticated = f.socket(auth.cookie); await unauthenticated.open();
      unauthenticated.send({ type: 'request', id: 'premature-read', method, params: {} });
      await unauthenticated.closed(); assert.equal(f.core.calls.length, 0);
    }
    const socket = f.socket(auth.cookie); await socket.open();
    socket.send({ type: 'authenticate', ticket: await f.ticket(auth) });
    await socket.message(message => message.type === 'authenticated');
    for (const method of ['files.list', 'files.preview', 'files.open', 'files.pdf', 'files.save', 'files.reload', 'files.close', 'git.status']) {
      socket.send({ type: 'request', id: method, method, params: { path: 'src/readme.txt' } });
      const reply = await socket.message(message => message.id === method);
      assert.equal(reply.ok, true); assert.equal(reply.result.owner, false);
      assert.deepEqual(f.core.calls.at(-1)?.params, { path: 'src/readme.txt' });
      assert.equal(f.core.calls.at(-1)?.context.owner, false);
    }
  } finally { await f.close(); }
});

test('pairing requires local approval, matching requester secret, and one successful claim', async () => {
  const f = await fixture();
  try {
    const pending = await f.pairing();
    assert.equal((await f.post('/v1/pairings/status', pending)).body.status, 'pending');
    assertDenied(await f.post('/v1/pairings/claim', pending));
    await f.gateway.ownerRequest('pairing.approve', { requestId: pending.requestId });
    assertDenied(await f.post('/v1/pairings/status', { ...pending, requesterSecret: 'incorrect-secret' }));
    assertDenied(await f.post('/v1/pairings/claim', { ...pending, requesterSecret: 'incorrect-secret' }));
    const claimed = await f.post('/v1/pairings/claim', pending);
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.body.authenticated, true);
    assert.ok(claimed.headers['set-cookie'][0].includes('HttpOnly'));
    assert.match(claimed.headers['set-cookie'][0], /SameSite=Strict/i);
    assertDenied(await f.post('/v1/pairings/claim', pending));
    const devices = await f.gateway.ownerRequest('devices.list', {});
    assert.equal(devices.devices.length, 1);
  } finally { await f.close(); }
});

test('rejected pairing and invalid pairing code cannot create a device session', async () => {
  const f = await fixture();
  try {
    assertDenied(await f.post('/v1/pairings/request', { code: '000000-invalid', name: 'Intruder' }));
    const pending = await f.pairing();
    await f.gateway.ownerRequest('pairing.reject', { requestId: pending.requestId });
    assert.equal((await f.post('/v1/pairings/status', pending)).body.status, 'rejected');
    assertDenied(await f.post('/v1/pairings/claim', pending));
    assert.equal((await f.gateway.ownerRequest('devices.list', {})).devices.length, 0);
  } finally { await f.close(); }
});

test('Host, exact Origin, and CSRF checks reject cross-site and forged-header requests', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    const headers = { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf };
    assertDenied(await f.post('/v1/ws-ticket', {}, { ...headers, Host: 'evil.example' }));
    assertDenied(await f.post('/v1/ws-ticket', {}, { ...headers, Origin: 'https://evil.example' }));
    assertDenied(await f.post('/v1/ws-ticket', {}, { ...headers, Origin: `${f.origin()}.evil.example` }));
    assertDenied(await f.post('/v1/ws-ticket', {}, { ...headers, Origin: 'null' }));
    assertDenied(await f.request('POST', '/v1/ws-ticket', {}, headers));
    assertDenied(await f.post('/v1/ws-ticket', {}, { Cookie: auth.cookie }));
    assertDenied(await f.post('/v1/ws-ticket', {}, { Cookie: auth.cookie, 'X-CSRF-Token': 'wrong' }));
    assertDenied(await f.post('/v1/ws-ticket', {}, { 'Tailscale-User-Login': 'owner@example.com', 'Tailscale-User-Name': 'Owner', 'X-CSRF-Token': auth.csrf }));
    const anonymous = await f.request('GET', '/v1/session', undefined, { 'Tailscale-User-Login': 'owner@example.com' });
    assert.equal(anonymous.body.authenticated, false);
    assert.equal(f.core.connections.size, 0);
  } finally { await f.close(); }
});

test('a WebSocket requires a first-frame ticket and tickets cannot be replayed', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    const ticket = await f.ticket(auth);
    const unauthenticated = f.socket(auth.cookie);
    await unauthenticated.open();
    unauthenticated.send({ type: 'request', id: 'premature', method: 'terminal.input', params: {} });
    await unauthenticated.closed();
    assert.equal(f.core.calls.length, 0);
    assert.equal(f.core.connections.size, 0);
    const first = f.socket(auth.cookie);
    await first.open(); first.send({ type: 'authenticate', ticket });
    await first.message(message => message.type === 'authenticated');
    assert.equal(f.core.connections.size, 1);
    const replay = f.socket(auth.cookie);
    await replay.open(); replay.send({ type: 'authenticate', ticket });
    await replay.closed();
    assert.ok(!replay.messages.some(message => message.type === 'authenticated'));
    assert.equal(f.core.connections.size, 1);
  } finally { await f.close(); }
});

test('WebSocket upgrade rejects foreign Origin and owner RPC never reaches core from a remote device', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    const foreign = f.socket(auth.cookie, { Origin: 'https://evil.example' });
    await assert.rejects(foreign.open());
    const socket = f.socket(auth.cookie);
    await socket.open(); socket.send({ type: 'authenticate', ticket: await f.ticket(auth) });
    await socket.message(message => message.type === 'authenticated');
    for (const method of ['pairing.status', 'devices.list', 'devices.revoke', 'remote.configure', 'remote.status', 'host.shutdown']) {
      socket.send({ type: 'request', id: method, method, params: {} });
      const response = await socket.message(message => message.type === 'response' && message.id === method);
      assert.equal(response.ok, false, `${method} must not be available to remote devices`);
    }
    assert.equal(f.core.calls.length, 0, 'privileged methods must be blocked before reaching core');
    socket.send({ type: 'request', id: 'ordinary', method: 'state.get', params: {} });
    const ordinary = await socket.message(message => message.type === 'response' && message.id === 'ordinary');
    assert.equal(ordinary.ok, true);
    assert.equal(f.core.calls[0]?.context.owner, false);
    assertDenied(await f.post('/v1/owner/pairing.approve', {}));
  } finally { await f.close(); }
});

async function approver(f: Awaited<ReturnType<typeof fixture>>, auth: { cookie: string; csrf: string }, headers: Record<string, string> = {}) {
  const issued = await f.post('/v1/ws-ticket', {}, { ...headers, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf });
  assert.equal(issued.status, 200, issued.text);
  const socket = f.socket(auth.cookie, headers);
  await socket.open(); socket.send({ type: 'authenticate', ticket: issued.body.ticket });
  await socket.message(message => message.type === 'authenticated');
  let sequence = 0;
  return async (method: string, params: unknown = {}) => {
    const id = `${method}-${++sequence}`;
    socket.send({ type: 'request', id, method, params });
    return socket.message(message => message.type === 'response' && message.id === id);
  };
}

test('a paired device issues codes and decides requests, while device and remote management stay on the PC', async () => {
  const f = await fixture();
  try {
    const call = await approver(f, await f.paired('My phone'));
    const code = await call('pairing.create');
    assert.equal(code.ok, true, JSON.stringify(code));
    assert.match(code.result.code, /^[A-Z0-9]{10}$/);
    const requested = await f.post('/v1/pairings/request', { code: code.result.code, name: 'Home PC' });
    assert.equal(requested.status, 200, requested.text);
    const pending = { requestId: requested.body.requestId as string, requesterSecret: requested.body.requesterSecret as string };
    const listed = await call('pairing.list');
    assert.deepEqual(listed.result.requests.filter((request: any) => request.status === 'pending').map((request: any) => request.name), ['Home PC']);
    assert.equal((await call('pairing.approve', { requestId: pending.requestId })).ok, true);
    const claimed = await f.post('/v1/pairings/claim', pending);
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.body.authenticated, true);
    const devices = (await f.gateway.ownerRequest('devices.list', {})).devices;
    assert.equal(devices.find((device: any) => device.name === 'Home PC')?.approvedBy, 'My phone', 'The PC can see which device approved the new one');
    assert.equal(devices.find((device: any) => device.name === 'My phone')?.approvedBy, undefined, 'A PC approval records no approving device');

    const second = await call('pairing.create');
    const unknown = await f.post('/v1/pairings/request', { code: second.result.code, name: 'Unknown laptop' });
    const refused = { requestId: unknown.body.requestId as string, requesterSecret: unknown.body.requesterSecret as string };
    assert.equal((await call('pairing.reject', { requestId: refused.requestId })).ok, true);
    assert.equal((await f.post('/v1/pairings/status', refused)).body.status, 'rejected');
    assertDenied(await f.post('/v1/pairings/claim', refused));
    assert.equal((await call('pairing.approve', { requestId: refused.requestId })).ok, false, 'A decided request cannot be approved later');

    for (const method of ['devices.list', 'devices.revoke', 'remote.configure', 'remote.status', 'pairing.status']) {
      const response = await call(method);
      assert.equal(response.ok, false, `${method} stays on the PC`);
      assert.equal(response.error.code, 'FORBIDDEN');
    }
    assert.equal(f.core.calls.length, 0, 'Approval requests are answered by the gateway and never reach core');
    assert.equal((await f.gateway.ownerRequest('devices.list', {})).devices.length, 2);
  } finally { await f.close(); }
});

test('a paired device cannot see or decide pairing requests made through another address', async () => {
  const f = await fixture();
  try {
    const remoteOrigin = 'https://mongle.example-tailnet.ts.net';
    const remoteHeaders = { Origin: remoteOrigin, Host: new URL(remoteOrigin).host };
    await f.gateway.ownerRequest('remote.configure', { origin: remoteOrigin });
    const ownerCode = await f.gateway.ownerRequest('pairing.create', {});
    const phoneRequest = await f.post('/v1/pairings/request', { code: ownerCode.code, name: 'Remote phone' }, remoteHeaders);
    await f.gateway.ownerRequest('pairing.approve', { requestId: phoneRequest.body.requestId });
    const phoneClaim = await f.post('/v1/pairings/claim', { requestId: phoneRequest.body.requestId, requesterSecret: phoneRequest.body.requesterSecret }, remoteHeaders);
    assert.equal(phoneClaim.status, 200, phoneClaim.text);
    const call = await approver(f, { cookie: (phoneClaim.headers['set-cookie'] as string[])[0].split(';')[0], csrf: phoneClaim.body.csrf }, remoteHeaders);

    const localRequest = await f.pairing('Local browser');
    const visible = await call('pairing.list');
    assert.equal(visible.result.requests.some((request: any) => request.name === 'Local browser'), false, 'Requests made on the PC loopback address stay hidden from remote devices');
    const crossOrigin = await call('pairing.approve', { requestId: localRequest.requestId });
    assert.equal(crossOrigin.ok, false);
    assert.equal(crossOrigin.error.code, 'INVALID_PAIRING');
    assert.equal((await f.post('/v1/pairings/status', localRequest)).body.status, 'pending', 'The PC can still decide the loopback request');

    const code = await call('pairing.create');
    const office = await f.post('/v1/pairings/request', { code: code.result.code, name: 'Office PC' }, remoteHeaders);
    assert.equal((await call('pairing.approve', { requestId: office.body.requestId })).ok, true);
    const officeClaim = await f.post('/v1/pairings/claim', { requestId: office.body.requestId, requesterSecret: office.body.requesterSecret }, remoteHeaders);
    assert.equal(officeClaim.status, 200, officeClaim.text);
  } finally { await f.close(); }
});

test('a ticket is bound to the authenticated device, rather than being transferable between sessions', async () => {
  const f = await fixture();
  try {
    const first = await f.paired('Phone A');
    const second = await f.paired('Phone B');
    const stolen = await f.ticket(first);
    const socket = f.socket(second.cookie);
    await socket.open(); socket.send({ type: 'authenticate', ticket: stolen });
    await socket.closed();
    assert.equal(f.core.connections.size, 0);
    assert.ok(!socket.messages.some(message => message.type === 'authenticated'));
  } finally { await f.close(); }
});

test('device revocation disconnects its live socket and survives host restart', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    const socket = f.socket(auth.cookie);
    await socket.open(); socket.send({ type: 'authenticate', ticket: await f.ticket(auth) });
    await socket.message(message => message.type === 'authenticated');
    const connectionId = [...f.core.connections.keys()][0];
    const devices = await f.gateway.ownerRequest('devices.list', {});
    await f.gateway.ownerRequest('devices.revoke', { deviceId: devices.devices[0].deviceId });
    await socket.closed();
    assert.ok(f.core.disconnected.includes(connectionId));
    assert.equal(f.core.connections.size, 0);
    assertDenied(await f.post('/v1/ws-ticket', {}, { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf }));
    await f.restart();
    const state = await f.request('GET', '/v1/session', undefined, { Cookie: auth.cookie });
    assert.equal(state.body.authenticated, false);
    const persisted = await f.gateway.ownerRequest('devices.list', {});
    assert.equal(persisted.devices[0].revoked, true);
  } finally { await f.close(); }
});

test('logging out invalidates the device cookie and its live connection', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    const socket = f.socket(auth.cookie);
    await socket.open(); socket.send({ type: 'authenticate', ticket: await f.ticket(auth) });
    await socket.message(message => message.type === 'authenticated');
    const response = await f.post('/v1/logout', {}, { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf });
    assert.equal(response.status, 200);
    await socket.closed();
    assertDenied(await f.post('/v1/ws-ticket', {}, { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf }));
    assert.equal(f.core.connections.size, 0);
  } finally { await f.close(); }
});

test('static serving confines requests to webRoot and API responses disable caching', async () => {
  const f = await fixture();
  try {
    const index = await f.request('GET', '/index.html');
    assert.equal(index.status, 200);
    assert.match(index.text, /Mongle security fixture/);
    for (const [extension, mime] of [['bcmap', 'application/octet-stream'], ['pfb', 'application/octet-stream'], ['ttf', 'font/ttf']]) {
      await writeFile(join(f.webRoot, `pdf-font.${extension}`), 'local PDF resource');
      const asset = await f.request('GET', `/pdf-font.${extension}`);
      assert.equal(asset.status, 200); assert.equal(asset.headers['content-type'], mime); assert.equal(asset.text, 'local PDF resource');
    }
    for (const path of ['/../private-secret.txt', '/%2e%2e/private-secret.txt', '/..%5cprivate-secret.txt', '/%2e%2e%2fprivate-secret.txt', '/%252e%252e%252fprivate-secret.txt']) {
      const response = await f.request('GET', path);
      assert.ok(!response.text.includes('MONGLE_OUTSIDE_WEBROOT_SECRET'), `${path} escaped webRoot`);
    }
    const session = await f.request('GET', '/v1/session');
    assert.match(session.headers['cache-control'] ?? '', /no-store/i);
  } finally { await f.close(); }
});

test('remote configuration accepts only explicit HTTPS Tailscale origins', async () => {
  const f = await fixture();
  try {
    for (const origin of ['http://host.tailnet.ts.net', 'https://evil.example', 'https://host.ts.net.evil.example', 'https://host.ts.net/path', 'https://user@host.ts.net', '*', 'null']) {
      await assert.rejects(async () => f.gateway.ownerRequest('remote.configure', { origin }), `${origin} must not be accepted`);
    }
    const configured = await f.gateway.ownerRequest('remote.configure', { origin: 'https://mongle.example-tailnet.ts.net' });
    assert.equal(configured.enabled, true);
    assert.equal(configured.origin, 'https://mongle.example-tailnet.ts.net');
    const disabled = await f.gateway.ownerRequest('remote.configure', { origin: null });
    assert.equal(disabled.enabled, false);
  } finally { await f.close(); }
});

test('Serve-proxied sessions use secure cookies, remain origin-bound, and are disconnected when remote access is disabled', async () => {
  const f = await fixture();
  try {
    const remoteOrigin = 'https://mongle.example-tailnet.ts.net';
    const remoteHeaders = { Origin: remoteOrigin, Host: new URL(remoteOrigin).host };
    await f.gateway.ownerRequest('remote.configure', { origin: remoteOrigin });
    const code = await f.gateway.ownerRequest('pairing.create', {});
    const requested = await f.post('/v1/pairings/request', { code: code.code, name: 'Remote phone' }, remoteHeaders);
    assert.equal(requested.status, 200, requested.text);
    const pending = { requestId: requested.body.requestId, requesterSecret: requested.body.requesterSecret };
    await f.gateway.ownerRequest('pairing.approve', { requestId: pending.requestId });
    const claimed = await f.post('/v1/pairings/claim', pending, remoteHeaders);
    assert.equal(claimed.status, 200, claimed.text);
    const setCookie = claimed.headers['set-cookie'][0] as string;
    assert.match(setCookie, /;\s*Secure(?:;|$)/i);
    assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0];
    const csrf = claimed.body.csrf as string;
    const ticket = await f.post('/v1/ws-ticket', {}, { ...remoteHeaders, Cookie: cookie, 'X-CSRF-Token': csrf });
    assert.equal(ticket.status, 200, ticket.text);
    assertDenied(await f.post('/v1/ws-ticket', {}, { Cookie: cookie, 'X-CSRF-Token': csrf }));
    const socket = f.socket(cookie, remoteHeaders);
    await socket.open(); socket.send({ type: 'authenticate', ticket: ticket.body.ticket });
    await socket.message(message => message.type === 'authenticated');
    assert.equal(f.core.connections.size, 1);
    await f.gateway.ownerRequest('remote.configure', { origin: null });
    await socket.closed();
    assert.equal(f.core.connections.size, 0);
    assertDenied(await f.post('/v1/ws-ticket', {}, { ...remoteHeaders, Cookie: cookie, 'X-CSRF-Token': csrf }));
  } finally { await f.close(); }
});

test('payload bounds reject HTTP over 16 KiB and WebSocket over 128 KiB without repeated core disconnection', async () => {
  const f = await fixture();
  try {
    const oversized = await f.post('/v1/pairings/request', { code: 'A'.repeat(16_384), name: 'Oversized' });
    assert.equal(oversized.status, 413, oversized.text);
    assert.equal((await f.gateway.ownerRequest('pairing.status', {})).requests.length, 0);
    const auth = await f.paired();
    const socket = f.socket(auth.cookie);
    await socket.open(); socket.send({ type: 'authenticate', ticket: await f.ticket(auth) });
    await socket.message(message => message.type === 'authenticated');
    const connectionId = [...f.core.connections.keys()][0];
    socket.send({ type: 'request', id: 'oversized', method: 'terminal.input', params: { data: 'x'.repeat(131_073) } });
    await socket.closed();
    assert.equal(f.core.calls.length, 0, 'oversized frames must never reach terminal handling');
    assert.equal(f.core.disconnected.filter(id => id === connectionId).length, 1);
    assert.equal(f.core.connections.size, 0);
  } finally { await f.close(); }
});

test('malicious authenticated frames and privileged-method floods remain bounded and never reach core', async () => {
  const f = await fixture();
  try {
    const auth = await f.paired();
    const malformedFrames = [
      { name: 'invalid JSON', data: '{invalid-json' },
      { name: 'binary JSON', data: Buffer.from(JSON.stringify({ type: 'request', id: 'binary', method: 'terminal.input', params: {} })) },
      { name: 'unexpected schema field', data: JSON.stringify({ type: 'request', id: 'extra', method: 'terminal.input', params: {}, owner: true }) },
    ];
    for (const frame of malformedFrames) {
      const socket = f.socket(auth.cookie);
      await socket.open(); socket.send({ type: 'authenticate', ticket: await f.ticket(auth) });
      await socket.message(message => message.type === 'authenticated');
      const connectionId = [...f.core.connections.keys()][0];
      socket.socket.send(frame.data);
      await socket.closed();
      assert.equal(f.core.disconnected.filter(id => id === connectionId).length, 1, frame.name);
      assert.equal(f.core.calls.length, 0, frame.name);
    }
    const flood = f.socket(auth.cookie);
    await flood.open(); flood.send({ type: 'authenticate', ticket: await f.ticket(auth) });
    await flood.message(message => message.type === 'authenticated');
    const connectionId = [...f.core.connections.keys()][0];
    flood.send({ type: 'request', id: 'owner-probe', method: 'owner.unlisted-privileged-method', params: {} });
    const rejection = await flood.message(message => message.type === 'response' && message.id === 'owner-probe');
    assert.equal(rejection.ok, false);
    assert.equal(rejection.error.code, 'FORBIDDEN');
    for (let index = 0; index < 512; index++) {
      flood.send({ type: 'request', id: `flood-${index}`, method: 'owner.unlisted-privileged-method', params: {} });
    }
    await flood.closed();
    assert.equal(f.core.calls.length, 0);
    assert.equal(f.core.disconnected.filter(id => id === connectionId).length, 1);
    assert.equal(f.core.connections.size, 0);
  } finally { await f.close(); }
});

test('pairing-create rate limit refuses the eleventh request in one minute', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 10; index++) {
      const code = await f.gateway.ownerRequest('pairing.create', {});
      const response = await f.post('/v1/pairings/request', { code: code.code, name: `Device ${index}` });
      assert.equal(response.status, 200, response.text);
    }
    const code = await f.gateway.ownerRequest('pairing.create', {});
    const refused = await f.post('/v1/pairings/request', { code: code.code, name: 'Eleventh device' });
    assert.equal(refused.status, 429, refused.text);
    assert.equal(refused.body.error.code, 'RATE_LIMITED');
    assert.equal((await f.gateway.ownerRequest('pairing.status', {})).requests.length, 10);
    assert.equal((await f.gateway.ownerRequest('devices.list', {})).devices.length, 0);
  } finally { await f.close(); }
});
