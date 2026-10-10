import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { AppError } from '../../packages/protocol/index.ts';
import { candidatePeers, ComputerDiscovery, MONGLE_SERVE_PORTS, probeMongle, type Peer } from '../../packages/host/computers.ts';

const hostId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const peer = (name: string, extra: Record<string, unknown> = {}) => ({HostName: name.toUpperCase(), DNSName: `${name}.tail1234.ts.net.`, OS: 'windows', UserID: 7, Online: true, TailscaleIPs: [`100.64.0.${name.length}`, 'fd7a:115c:a1e0::1'], ...extra});
const status = (peers: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  BackendState: 'Running', Self: {UserID: 7, DNSName: 'home-pc.tail1234.ts.net.', OS: 'windows'},
  Peer: Object.fromEntries(peers.map((item, index) => [`nodekey:${index}`, item])), ...extra,
});

test('discovery contacts only online Windows PCs of the same Tailscale user', () => {
  const peers = candidatePeers(status([
    peer('office-pc'), peer('laptop'), peer('phone', {OS: 'android'}), peer('sleeping', {Online: false}), peer('friend', {UserID: 9}),
    peer('shared', {ShareeNode: true}), peer('server', {Tags: ['tag:server']}), peer('other', {DNSName: 'other.example.com.'}),
    peer('ipv6only', {TailscaleIPs: ['fd7a:115c:a1e0::9']}), peer('home-pc'),
  ]));
  assert.deepEqual(peers.map(item => item.name), ['laptop', 'office-pc']);
  assert.deepEqual(peers[1], {name: 'office-pc', dnsName: 'office-pc.tail1234.ts.net', address: '100.64.0.9'});
  assert.deepEqual(candidatePeers({}), []);
  assert.deepEqual(candidatePeers({Self: {UserID: 7}, Peer: null}), []);
  assert.equal(candidatePeers(status(Array.from({length: 40}, (_, index) => peer(`pc-${String(index).padStart(2, '0')}`)))).length, 32, 'A large tailnet is capped');
});

test('discovery keeps the first Mongle port, hides this host, shares a scan and caches it', async () => {
  let clock = 1_000, scans = 0;
  const probes: string[] = [];
  const answers: Record<string, string | Error | undefined> = {
    'office-pc:8443': hostId(2), 'office-pc:10000': hostId(2),
    'laptop:443': hostId(3), 'laptop:8443': new Error('connection reset'),
    'renamed-home:443': hostId(1),
  };
  const discovery = new ComputerDiscovery({
    status: async () => { scans++; return status([peer('office-pc'), peer('laptop'), peer('renamed-home'), peer('plain')]); },
    selfHostId: () => hostId(1).toUpperCase(),
    probe: async (target: Peer, port: number) => {
      probes.push(`${target.name}:${port}`);
      const answer = answers[`${target.name}:${port}`];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => clock,
  });
  const [first, second] = await Promise.all([discovery.list(), discovery.list()]);
  assert.equal(first, second, 'Menus opened together share one scan');
  assert.equal(scans, 1);
  assert.equal(probes.length, 4 * MONGLE_SERVE_PORTS.length);
  assert.equal(first.available, true);
  assert.deepEqual(first.computers, [
    {name: 'laptop', origin: 'https://laptop.tail1234.ts.net'},
    {name: 'office-pc', origin: 'https://office-pc.tail1234.ts.net:8443'},
  ], 'Port 443 has no port in the address, this host is hidden even under another name, and failing ports are ignored');
  clock += 30_000; await discovery.list();
  assert.equal(scans, 1, 'Opening the menu again within a minute reuses the scan');
  await discovery.list(true);
  assert.equal(scans, 2, 'An explicit refresh rescans a result that is a few seconds old');
  clock += 1_000; await discovery.list(true);
  assert.equal(scans, 2, 'Repeated refresh taps reuse a fresh scan');
  clock += 61_000; await discovery.list();
  assert.equal(scans, 3);
});

test('a large tailnet is scanned 16 PCs at a time so the reply arrives within the browser request limit', async () => {
  let active = 0, peak = 0;
  const discovery = new ComputerDiscovery({
    status: async () => status(Array.from({length: 40}, (_, index) => peer(`pc-${String(index).padStart(2, '0')}`))),
    probe: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return undefined; },
  });
  assert.deepEqual((await discovery.list()).computers, []);
  assert.equal(peak, 16 * MONGLE_SERVE_PORTS.length, 'At most two rounds of probes for the 32 PCs that are contacted');
});

test('a missing, stopped or failing Tailscale is reported without contacting any PC', async () => {
  const probe = async () => { throw new Error('No PC may be contacted'); };
  const missing = await new ComputerDiscovery({status: async () => { throw new AppError('TAILSCALE_MISSING', 'Tailscale을 설치한 뒤 네트워크에 연결해 주세요.'); }, probe}).list();
  assert.deepEqual([missing.available, missing.computers, missing.message], [false, [], 'Tailscale을 설치한 뒤 네트워크에 연결해 주세요.']);
  const stopped = await new ComputerDiscovery({status: async () => status([peer('office-pc')], {BackendState: 'Stopped'}), probe}).list();
  assert.equal(stopped.available, false);
  assert.match(stopped.message!, /로그인/);
  const broken = await new ComputerDiscovery({status: async () => { throw new Error('raw CLI output'); }, probe}).list();
  assert.equal(broken.message, 'Tailscale 상태를 확인하지 못했습니다.', 'Raw command output is not shown');
});

test('the probe accepts only a genuine Mongle health record, addressed like a browser and without credentials', async () => {
  const seen: Record<string, unknown>[] = [];
  let reply: (response: ServerResponse) => void = () => {};
  const server = createServer((request, response) => {
    seen.push({host: request.headers.host, path: request.url, method: request.method, cookie: request.headers.cookie, authorization: request.headers.authorization});
    reply(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const target: Peer = {name: 'office-pc', dnsName: 'office-pc.tail1234.ts.net', address: '127.0.0.1'};
  const json = (statusCode: number, body: unknown, type = 'application/json; charset=utf-8') => (response: ServerResponse) => {
    response.writeHead(statusCode, {'Content-Type': type});
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    reply = json(200, {ok: true, hostId: hostId(5).toUpperCase(), bootId: hostId(6), protocolVersion: 1});
    assert.equal(await probeMongle(target, port, httpRequest), hostId(5));
    assert.deepEqual(seen[0], {host: `office-pc.tail1234.ts.net:${port}`, path: '/health', method: 'GET', cookie: undefined, authorization: undefined});
    const options: Record<string, any>[] = [];
    // Port 443 is addressed without a port, exactly like the origin a browser opens.
    assert.equal(await probeMongle(target, 443, (request, callback) => { options.push(request); return httpRequest({...request, port}, callback); }), hostId(5));
    assert.deepEqual([options[0].host, options[0].servername, options[0].headers.Host], ['127.0.0.1', 'office-pc.tail1234.ts.net', 'office-pc.tail1234.ts.net']);
    for (const wrong of [
      json(200, {ok: true, hostId: 'not-a-host-id', protocolVersion: 1}), json(200, {ok: true, hostId: hostId(5)}),
      json(200, {ok: false, hostId: hostId(5), protocolVersion: 1}), json(404, {ok: true, hostId: hostId(5), protocolVersion: 1}),
      json(200, '<!doctype html><title>Other service</title>', 'text/html'), json(200, '{not json'),
      json(200, JSON.stringify({ok: true, hostId: hostId(5), protocolVersion: 1, padding: 'x'.repeat(5000)})),
    ]) {
      reply = wrong;
      assert.equal(await probeMongle(target, port, httpRequest), undefined);
    }
    reply = () => {};
    const started = Date.now();
    assert.equal(await probeMongle(target, port, httpRequest, 200), undefined, 'A silent port times out');
    assert.ok(Date.now() - started < 2_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.equal(await probeMongle(target, port, httpRequest, 1_000), undefined, 'A closed port is not Mongle');
});
