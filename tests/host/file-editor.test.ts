import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openFileDocument, saveFileDocument } from '../../packages/host/file-editor';
import { AppError, FILE_EDIT_BYTES, type ConnectionContext, type FileDocument, type TerminalInfo } from '../../packages/protocol';
import { HostCore } from '../../packages/host/core';

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
async function fixture(t: test.TestContext, cleanup = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-edit-'));
  const data = path.join(root, '.host'); await mkdir(data);
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data };
}
test('editor preserves UTF-8 BOM, UTF-16 byte order, line endings and Korean text', async t => {
  const { root, data } = await fixture(t);
  const original = '첫 줄\r\n둘째 줄\r\n', changed = '# 수정됨\r\n한글과 🐈\r\n';
  for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be']) {
    const toBytes = (text: string) => encoding === 'utf8' ? Buffer.from(text) : encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) : Buffer.concat([Buffer.from(encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]), encoding === 'utf16le' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf16le').swap16()]);
    const name = `${encoding}.md`; await writeFile(path.join(root, name), toBytes(original));
    const doc = await openFileDocument(root, name, data); assert.equal(doc.text, original); assert.ok(doc.version);
    const saved = await saveFileDocument(root, name, data, doc.version!, encode(changed), () => {});
    assert.equal(saved.text, changed); assert.notEqual(saved.version, doc.version);
    assert.deepEqual(await readFile(path.join(root, name)), toBytes(changed));
  }
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.mongle-save-')));
});
test('stale versions, competing saves, and revoked authorization never silently overwrite files', async t => {
  const { root, data } = await fixture(t), name = 'notes.md', file = path.join(root, name);
  await writeFile(file, 'original'); const original = await openFileDocument(root, name, data);
  await writeFile(file, 'external change');
  await assert.rejects(saveFileDocument(root, name, data, original.version!, encode('stale'), () => {}), { code: 'FILES_CONFLICT' });
  assert.equal(await readFile(file, 'utf8'), 'external change');
  const current = await openFileDocument(root, name, data);
  const attempts = await Promise.allSettled(['one', 'two'].map(text => saveFileDocument(root, name, data, current.version!, encode(text), () => {})));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'FILES_CONFLICT').length, 1);
  const latest = await openFileDocument(root, name, data); let checks = 0;
  await assert.rejects(saveFileDocument(root, name, data, latest.version!, encode('revoked'), () => { if (++checks === 3) throw new AppError('NOT_CONNECTED', 'revoked'); }), { code: 'NOT_CONNECTED' });
  assert.equal(await readFile(file, 'utf8'), latest.text);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.mongle-save-')));
});
test('editor refuses oversized, binary, malformed data, protected files, hard links and junctions', async t => {
  const { root, data } = await fixture(t), name = 'test.txt';
  await writeFile(path.join(root, name), 'safe');
  const doc = await openFileDocument(root, name, data);
  for (const content of ['not base64', encode('a'.repeat(FILE_EDIT_BYTES + 1)), encode('\0binary'), Buffer.from([0xff]).toString('base64')]) {
    await assert.rejects(saveFileDocument(root, name, data, doc.version!, content, () => {}));
    assert.equal(await readFile(path.join(root, name), 'utf8'), 'safe');
  }
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(FILE_EDIT_BYTES + 1));
  const large = await openFileDocument(root, 'large.txt', data); assert.equal(large.truncated, true); assert.ok(large.readOnlyReason); assert.equal(large.version, undefined);
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await assert.rejects(openFileDocument(root, 'binary', data), { code: 'FILES_NOT_TEXT' });
  await writeFile(path.join(data, 'secret'), 'secret');
  await assert.rejects(openFileDocument(root, '.host/secret', data), { code: 'FILES_PROTECTED' });
  for (const relative of ['../outside', 'C:\\outside', 'test.txt:ads', 'CON', 'a/../test.txt']) await assert.rejects(openFileDocument(root, relative, data), { code: 'FILES_OUTSIDE_ROOT' });
  const dir = path.join(root, 'dir'); await mkdir(dir); await writeFile(path.join(dir, 'file.txt'), 'linked');
  await symlink(dir, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok((await openFileDocument(root, 'junction/file.txt', data)).readOnlyReason);
  await link(path.join(root, name), path.join(root, 'hard.txt'));
  assert.ok((await openFileDocument(root, 'hard.txt', data)).readOnlyReason);
  await assert.rejects(saveFileDocument(root, 'hard.txt', data, doc.version!, encode('bad'), () => {}), { code: 'FILES_READ_ONLY' });
});
test('file grants survive cd, are private to a connection, expire on disconnect and keep the shell alive', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, data } = await fixture(t, false); await writeFile(path.join(root, 'README.md'), '# hello');
  const core = new HostCore({ dataDir: data }); await core.init(); t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'editor-test', deviceName: 'Editor', owner: false };
  const other = { ...ctx, id: randomUUID(), deviceId: 'other' }; core.connect(ctx, () => {}); core.connect(other, () => {});
  const terminal: TerminalInfo = await core.handle('terminals.create', { groupId: core.getState().groups[0].id, profileId: 'cmd', cwd: root }, ctx);
  const state = core.getState(), reference = { id: terminal.id, generation: terminal.generation, hostId: state.hostId, bootId: state.bootId, root, path: 'README.md' };
  assert.ok(state.capabilities?.includes('files.edit'));
  const doc: FileDocument = await core.handle('files.open', reference, ctx); assert.ok(doc.documentId);
  const save = { hostId: state.hostId, bootId: state.bootId, documentId: doc.documentId, version: doc.version, contentBase64: encode('# saved') };
  await assert.rejects(core.handle('files.save', save, other), { code: 'FILES_DOCUMENT_EXPIRED' });
  await assert.rejects(core.handle('files.save', { ...save, bootId: randomUUID() }, ctx), { code: 'HOST_CHANGED' });
  // A real shell reports cwd independently; emulate only that notification, not file IO or saving.
  (core as any).terminals.find((item: TerminalInfo) => item.id === terminal.id).currentCwd = data;
  const saved: FileDocument = await core.handle('files.save', save, ctx); assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# saved');
  assert.equal((await core.handle('files.reload', { hostId: state.hostId, bootId: state.bootId, documentId: doc.documentId }, ctx)).version, saved.version);
  assert.equal(core.getState().terminals[0].pid, terminal.pid); assert.equal(core.getState().terminals[0].controller, undefined);
  core.disconnect(ctx.id); core.connect(ctx, () => {});
  await assert.rejects(core.handle('files.save', { ...save, version: saved.version }, ctx), { code: 'FILES_DOCUMENT_EXPIRED' });
});
