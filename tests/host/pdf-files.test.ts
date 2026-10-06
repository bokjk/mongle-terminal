import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readPdfChunk } from '../../packages/host/pdf-files';
import { HostCore } from '../../packages/host/core';
import { PDF_CHUNK_BYTES, PDF_PREVIEW_BYTES, type ConnectionContext, type TerminalInfo } from '../../packages/protocol';

async function fixture(t: test.TestContext, cleanup = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-pdf-'));
  const data = path.join(root, '.host'); await mkdir(data);
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data };
}
test('PDF chunks are bounded, exact, read-only and reject mixed file revisions', async t => {
  const { root, data } = await fixture(t);
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(PDF_CHUNK_BYTES * 2 + 17, 0xc1)]);
  await writeFile(path.join(root, 'report.PDF'), bytes);
  const chunks: Buffer[] = []; let version: string | undefined;
  for (let offset = 0; offset < bytes.length; offset += PDF_CHUNK_BYTES) {
    const chunk = await readPdfChunk(root, 'report.PDF', data, offset, version);
    assert.equal(chunk.size, bytes.length); assert.equal(chunk.offset, offset);
    assert.ok(chunk.contentBase64.length <= 87384);
    if (version) assert.equal(chunk.version, version);
    version = chunk.version; chunks.push(Buffer.from(chunk.contentBase64, 'base64'));
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.deepEqual(await readFile(path.join(root, 'report.PDF')), bytes);
  await writeFile(path.join(root, 'report.PDF'), Buffer.concat([bytes, Buffer.from('changed')]));
  await assert.rejects(readPdfChunk(root, 'report.PDF', data, PDF_CHUNK_BYTES, version), { code: 'FILES_CONFLICT' });
  for (const offset of [-1, 1, 1.5, PDF_CHUNK_BYTES]) await assert.rejects(readPdfChunk(root, 'report.PDF', data, offset), { code: 'INVALID_REQUEST' });
});
test('PDF reading rejects oversized, non-PDF, protected and escaping paths', async t => {
  const { root, data } = await fixture(t);
  await writeFile(path.join(root, 'invalid.pdf'), 'not a PDF');
  await writeFile(path.join(root, 'other.txt'), '%PDF-1.7');
  await writeFile(path.join(root, 'large.pdf'), Buffer.alloc(PDF_PREVIEW_BYTES + 1));
  await writeFile(path.join(data, 'private.pdf'), '%PDF-1.7');
  for (const name of ['invalid.pdf', 'other.txt']) await assert.rejects(readPdfChunk(root, name, data, 0), { code: 'FILES_NOT_PDF' });
  await assert.rejects(readPdfChunk(root, 'large.pdf', data, 0), { code: 'FILES_TOO_LARGE' });
  await assert.rejects(readPdfChunk(root, '.host/private.pdf', data, 0), { code: 'FILES_PROTECTED' });
  for (const name of ['../outside.pdf', 'a.pdf:stream', 'CON.pdf']) await assert.rejects(readPdfChunk(root, name, data, 0), { code: 'FILES_OUTSIDE_ROOT' });
  const folder = path.join(root, 'workspace'); await mkdir(folder);
  await symlink(data, path.join(folder, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readPdfChunk(folder, 'escape/private.pdf', data, 0), { code: 'FILES_OUTSIDE_ROOT' });
});
test('PDF RPC retains host/session/cwd/connection checks and does not acquire terminal control', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, data } = await fixture(t, false), cwd = await realpath(root);
  const core = new HostCore({ dataDir: data }); await core.init();
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'report.pdf'), '%PDF-1.7\nfixture');
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'pdf-reader', deviceName: 'PDF test', owner: false };
  core.connect(ctx, () => {});
  const terminal: TerminalInfo = await core.handle('terminals.create', { groupId: core.getState().groups[0].id, profileId: 'cmd', cwd }, ctx);
  const state = core.getState();
  const ref = { id: terminal.id, generation: terminal.generation, hostId: state.hostId, bootId: state.bootId, root: cwd, path: 'report.pdf', offset: 0 };
  assert.ok(state.capabilities?.includes('files.pdf'));
  assert.equal((await core.handle('files.pdf', ref, ctx)).size, 16);
  assert.equal(core.getState().terminals[0].controller, undefined);
  await assert.rejects(core.handle('files.pdf', { ...ref, bootId: randomUUID() }, ctx), { code: 'HOST_CHANGED' });
  await assert.rejects(core.handle('files.pdf', { ...ref, generation: randomUUID() }, ctx), { code: 'SESSION_CHANGED' });
  await assert.rejects(core.handle('files.pdf', { ...ref, root: data }, ctx), { code: 'FILES_ROOT_CHANGED' });
  const pending = core.handle('files.pdf', ref, ctx); core.disconnect(ctx.id);
  await assert.rejects(pending, { code: 'NOT_CONNECTED' });
});
