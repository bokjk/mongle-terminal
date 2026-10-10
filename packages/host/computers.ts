import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { AppError } from '../protocol/index.ts';

/** Another Mongle host in the same tailnet. Only its remote address leaves this host. */
export type Computer = { name: string; origin: string };
export type ComputerList = { computers: Computer[]; available: boolean; message?: string; checkedAt: number };
export type Peer = { name: string; dnsName: string; address: string };
type HttpRequest = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type Probe = (peer: Peer, port: number) => Promise<string | undefined>;

/** Remote setup (remote.ts) serves Mongle on the first free one of these Tailscale Serve HTTPS ports. */
export const MONGLE_SERVE_PORTS = [443, 8443, 10000] as const;
const MAX_PEERS = 32;
const PROBE_TIMEOUT_MS = 2_500;
const BODY_LIMIT = 4_096;
const dnsPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/;
const tailscaleIPv4 = /^100\.(?:\d{1,3}\.){2}\d{1,3}$/;
const hostIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dnsOf = (value: unknown) => String(value ?? '').replace(/\.$/, '').toLowerCase();
export const originFor = (dnsName: string, port: number) => `https://${dnsName}${port === 443 ? '' : `:${port}`}`;

/**
 * Mongle runs on Windows, and a person's own PCs share their Tailscale user. Offline, shared,
 * tagged and other people's devices are never contacted.
 */
export function candidatePeers(status: unknown): Peer[] {
  const value = status as { Self?: Record<string, unknown>; Peer?: Record<string, unknown> | null } | null;
  const self = value?.Self;
  if (!self || typeof self !== 'object' || self.UserID === undefined) return [];
  const selfDns = dnsOf(self.DNSName);
  const peers: Peer[] = [];
  for (const item of Object.values(value?.Peer ?? {})) {
    const peer = item as Record<string, unknown> | null;
    if (!peer || peer.Online !== true || peer.OS !== 'windows' || peer.UserID !== self.UserID || peer.ShareeNode === true || (Array.isArray(peer.Tags) && peer.Tags.length > 0)) continue;
    const dnsName = dnsOf(peer.DNSName);
    const address = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.find((ip): ip is string => typeof ip === 'string' && tailscaleIPv4.test(ip)) : undefined;
    if (!dnsPattern.test(dnsName) || dnsName === selfDns || !address) continue;
    peers.push({name: dnsName.split('.')[0], dnsName, address});
  }
  return peers.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_PEERS);
}

/**
 * Read a peer's public health record through Tailscale Serve, addressed exactly as a browser would.
 * No cookie or credential is sent, and the certificate must match the peer's MagicDNS name.
 * Resolves with the peer's host ID, or undefined when that port does not serve Mongle.
 */
export function probeMongle(peer: Peer, port: number, request: HttpRequest = httpsRequest, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false;
    let client: ClientRequest | undefined;
    const finish = (hostId?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      resolve(hostId);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      client = request({
        // Connect to the Tailscale address so discovery does not depend on this PC's DNS settings.
        host: peer.address, port, servername: peer.dnsName, method: 'GET', path: '/health', agent: false,
        headers: {Host: port === 443 ? peer.dnsName : `${peer.dnsName}:${port}`, Accept: 'application/json'},
      }, response => {
        if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(String(response.headers['content-type'] ?? ''))) { response.resume(); finish(); return; }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > BODY_LIMIT) finish(); else chunks.push(chunk); });
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body?.ok === true && typeof body.hostId === 'string' && hostIdPattern.test(body.hostId) && Number.isInteger(body.protocolVersion) ? body.hostId.toLowerCase() : undefined);
          } catch { finish(); }
        });
        response.on('error', () => finish());
      });
      client.on('error', () => finish());
      client.end();
    } catch { finish(); }
  });
}

type DiscoveryOptions = {
  status(): Promise<unknown>;
  selfHostId?(): string | undefined;
  probe?: Probe;
  now?(): number;
  ttlMs?: number;
  refreshAfterMs?: number;
  concurrency?: number;
};

/** Finds other Mongle PCs for paired devices. Scans are cached so opening the menu again does not rescan the tailnet. */
export class ComputerDiscovery {
  private cached?: {value: ComputerList; at: number};
  private pending?: Promise<ComputerList>;
  constructor(private options: DiscoveryOptions) {}
  private now() { return (this.options.now ?? Date.now)(); }
  list(refresh = false): Promise<ComputerList> {
    const age = this.cached ? this.now() - this.cached.at : Infinity;
    if (this.cached && age < (refresh ? this.options.refreshAfterMs ?? 5_000 : this.options.ttlMs ?? 60_000)) return Promise.resolve(this.cached.value);
    // Menus opened while a scan runs share it.
    if (!this.pending) this.pending = this.scan().then(value => { this.cached = {value, at: this.now()}; return value; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async scan(): Promise<ComputerList> {
    const checkedAt = this.now();
    let status: { BackendState?: unknown } | null;
    try { status = await this.options.status() as { BackendState?: unknown } | null; }
    catch (error) { return {computers: [], available: false, message: error instanceof AppError ? error.message : 'Tailscale 상태를 확인하지 못했습니다.', checkedAt}; }
    if (status?.BackendState !== 'Running') return {computers: [], available: false, message: 'Tailscale에서 로그인하고 네트워크에 연결해 주세요.', checkedAt};
    const queue = candidatePeers(status), probe = this.options.probe ?? probeMongle, found: (Computer & {hostId: string})[] = [];
    const worker = async () => {
      for (let peer = queue.shift(); peer; peer = queue.shift()) {
        const target = peer;
        // Ask every port at once but take them in setup order, so a match on 443 does not wait for silent ports.
        const attempts = MONGLE_SERVE_PORTS.map(port => probe(target, port).catch(() => undefined));
        for (const [index, attempt] of attempts.entries()) {
          const hostId = await attempt;
          if (hostId) { found.push({name: target.name, origin: originFor(target.dnsName, MONGLE_SERVE_PORTS[index]), hostId}); break; }
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(this.options.concurrency ?? 8, queue.length)}, worker));
    const self = this.options.selfHostId?.()?.toLowerCase(), seen = new Set<string>();
    const computers = found
      .filter(item => item.hostId !== self && !seen.has(item.hostId) && Boolean(seen.add(item.hostId)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin))
      .map(({name, origin}) => ({name, origin}));
    return {computers, available: true, checkedAt};
  }
}
