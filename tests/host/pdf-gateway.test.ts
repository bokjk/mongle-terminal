import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { HostCore } from '../../packages/host/core';
import { startGateway } from '../../packages/host/gateway';
import { loadPdfDocument } from '../../apps/web/src/pdf-document';
import { explorerClient } from '../../apps/web/src/explorer-queue';

test('paired WebSocket transfers an 8 MiB PDF exactly; cancellation and revoked access stop subsequent chunks', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-pdf-gateway-'));
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'workspace');
  await mkdir(dataDir); await mkdir(workspace);
  const core = new HostCore({ dataDir }); await core.init();
  const gateway = await startGateway({ core, dataDir, webRoot: workspace });
  const origin = `http://127.0.0.1:${gateway.port}`;
  let socket: WebSocket | undefined;
  try {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61); bytes.write('%PDF-1.7\n');
    // This fixture exercises transport bounds, not PDF parsing (covered in UI).
    await writeFile(path.join(workspace, 'large.pdf'), bytes);
    const owner = { id: randomUUID(), deviceId: 'pdf-test-owner', deviceName: 'PDF test', owner: true };
    core.connect(owner, () => {});
    const state = core.getState();
    // Hosted Windows TEMP may use RUNNER~1. Use the same canonical spelling
    // for shell creation and RPC scope, as the UI uses the host's cwd verbatim.
    const cwd = await realpath(workspace);
    const terminal = await core.handle('terminals.create', { groupId: state.groups[0].id, profileId: 'cmd', cwd }, owner);
    const ref = { hostId: state.hostId, bootId: state.bootId, id: terminal.id, generation: terminal.generation, root: cwd };
    const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(origin + url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const value = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(value)); return { response, value };
    };
    const code = await gateway.ownerRequest('pairing.create');
    const { value: pending } = await post('/v1/pairings/request', { code: code.code, name: 'PDF gateway test' });
    await gateway.ownerRequest('pairing.approve', { requestId: pending.requestId });
    const { value: auth, response } = await post('/v1/pairings/claim', { requestId: pending.requestId, requesterSecret: pending.requesterSecret });
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    const { value: ticket } = await post('/v1/ws-ticket', {}, { Cookie: cookie, 'X-CSRF-Token': auth.csrf });
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/ws', { headers: { Origin: origin, Cookie: cookie } });
    await once(socket, 'open');
    const waiters = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
    let authenticated!: () => void;
    const ready = new Promise<void>(resolve => { authenticated = resolve; });
    const sizes: number[] = [];
    socket.on('message', raw => {
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      sizes.push(bytes.length); const message = JSON.parse(bytes.toString());
      if (message.type === 'authenticated') authenticated();
      if (message.type !== 'response') return;
      const pending = waiters.get(message.id); waiters.delete(message.id);
      if (message.ok) pending?.resolve(message.result); else pending?.reject(new Error(message.error?.message));
    });
    socket.on('close', () => { for (const pending of waiters.values()) pending.reject(new Error('closed')); waiters.clear(); });
    socket.send(JSON.stringify({ type: 'authenticate', ticket: ticket.ticket })); await ready;
    let requests = 0, dropAfterFirst = false;
    const transport = { request: <T>(method: string, params?: unknown) => new Promise<T>((resolve, reject) => {
      if (socket!.readyState !== WebSocket.OPEN) { reject(new Error('closed')); return; }
      const id = String(++requests);
      waiters.set(id, { resolve: async value => {
        try {
          if (dropAfterFirst) {
            dropAfterFirst = false;
            const closed = once(socket!, 'close');
            const { devices } = await gateway.ownerRequest('devices.list');
            await gateway.ownerRequest('devices.revoke', { deviceId: devices[0].deviceId }); await closed;
          }
          resolve(value);
        } catch (error) { reject(error); }
      }, reject });
      socket!.send(JSON.stringify({ type: 'request', id, method, params }));
    }), subscribe: () => () => {}, close: () => socket?.close() };
    const client = explorerClient(transport);
    const loaded = await loadPdfDocument(client, ref, 'large.pdf', new AbortController().signal, () => {}, () => {});
    assert.deepEqual(Buffer.from(loaded.data), bytes); assert.equal(requests, 128);
    assert.ok(sizes.every(size => size < 131072), 'Every frame stays under the WebSocket limit');
    const abort = new AbortController(), beforeAbort = requests;
    await assert.rejects(loadPdfDocument(client, ref, 'large.pdf', abort.signal, () => {}, () => abort.abort()), { name: 'AbortError' });
    assert.equal(requests, beforeAbort + 1, 'Closing a tab must not queue more chunks');
    dropAfterFirst = true;
    await assert.rejects(loadPdfDocument(client, ref, 'large.pdf', new AbortController().signal, () => {}, () => {}), /closed/);
    assert.deepEqual(Buffer.from(loaded.data), bytes, 'Previously loaded bytes survive connection loss');
    assert.equal(core.getState().terminals[0].controller, undefined);
  } finally {
    socket?.terminate(); await gateway.close(); await core.close();
    assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true });
  }
});
