import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_FOLDER, attachmentName, Uploads, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../../packages/host/uploads';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol';
import { HostCore } from '../../packages/host/core';

async function fixture(t: test.TestContext, cleanup = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-upload-'));
  const data = path.join(root, '.host'); await mkdir(data);
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data, folder: path.join(root, ATTACHMENT_FOLDER) };
}
async function send(uploads: Uploads, owner: string, uploadId: string, bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) await uploads.chunk(owner, uploadId, offset, bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
}

test('attachment names keep what the file was and nothing a shell or Windows would misread', () => {
  const now = new Date('2026-10-12T15:30:00Z');
  assert.equal(attachmentName('스크린샷 2026-10-12.PNG', now, 'abcd1234'), '20261012-153000-abcd1234-스크린샷_2026-10-12.png');
  assert.equal(attachmentName('..\\..\\evil name;rm -rf.txt', now, 'abcd1234'), '20261012-153000-abcd1234-evil_name_rm_-rf.txt');
  assert.equal(attachmentName('CON.txt', now, 'abcd1234'), '20261012-153000-abcd1234-_CON.txt');
  assert.equal(attachmentName('Makefile', now, 'abcd1234'), '20261012-153000-abcd1234-Makefile');
  assert.equal(attachmentName('...', now, 'abcd1234'), '20261012-153000-abcd1234-file');
  assert.equal(attachmentName('a.$$$', now, 'abcd1234'), '20261012-153000-abcd1234-a');
});

test('a file arrives in order and lands complete under a unique name; mistakes and strangers are refused', async t => {
  const { root, data, folder } = await fixture(t);
  const uploads = new Uploads(data); t.after(() => uploads.close());
  const bytes = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 123, 7); bytes.write('PNG', 0);
  const begun = await uploads.begin('phone', root, 'shot.png', bytes.length);
  assert.equal(begun.chunkBytes, UPLOAD_CHUNK_BYTES);
  await assert.rejects(uploads.chunk('phone', begun.uploadId, 10, bytes.subarray(0, 10)), { code: 'UPLOAD_OFFSET' });
  await assert.rejects(uploads.chunk('other', begun.uploadId, 0, bytes.subarray(0, 10)), { code: 'UPLOAD_EXPIRED' });
  await assert.rejects(uploads.finish('phone', begun.uploadId), { code: 'UPLOAD_INCOMPLETE' });
  await send(uploads, 'phone', begun.uploadId, bytes);
  await assert.rejects(uploads.chunk('phone', begun.uploadId, bytes.length, Buffer.from('x')), { code: 'UPLOAD_OFFSET' }, 'nothing past the declared size');
  const done = await uploads.finish('phone', begun.uploadId);
  assert.equal(path.dirname(done.path), folder);
  assert.match(done.name, /^\d{8}-\d{6}-[0-9a-f]{8}-shot\.png$/);
  assert.deepEqual(await readFile(done.path), bytes);
  assert.deepEqual(await readdir(folder), [done.name], 'no .part file is left');
  await assert.rejects(uploads.finish('phone', begun.uploadId), { code: 'UPLOAD_EXPIRED' });
  await assert.rejects(uploads.begin('phone', root, 'big.bin', UPLOAD_MAX_BYTES + 1), { code: 'UPLOAD_TOO_LARGE' });
  await assert.rejects(uploads.begin('phone', root, 'empty.txt', 0), { code: 'UPLOAD_EMPTY' });
});

test('unfinished uploads are removed on cancel, disconnect and silence, and each connection gets two at a time', async t => {
  const { root, data, folder } = await fixture(t);
  const uploads = new Uploads(data, 50); t.after(() => uploads.close());
  const parts = async () => (await readdir(folder)).filter(name => name.endsWith('.part'));
  const a = await uploads.begin('phone', root, 'a.txt', 10), b = await uploads.begin('phone', root, 'b.txt', 10);
  await assert.rejects(uploads.begin('phone', root, 'c.txt', 10), { code: 'UPLOAD_BUSY' });
  const c = await uploads.begin('laptop', root, 'c.txt', 10);
  assert.equal((await parts()).length, 3);
  await uploads.cancel('phone', a.uploadId);
  await uploads.dropOwner('laptop');
  assert.equal((await parts()).length, 1);
  await assert.rejects(uploads.chunk('laptop', c.uploadId, 0, Buffer.from('x')), { code: 'UPLOAD_EXPIRED' });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(await parts(), [], 'an idle upload is discarded');
  await assert.rejects(uploads.chunk('phone', b.uploadId, 0, Buffer.from('x')), { code: 'UPLOAD_EXPIRED' });
});

test('attachments never land outside the terminal folder or inside the app data folder', async t => {
  const { root, data, folder } = await fixture(t);
  const uploads = new Uploads(data); t.after(() => uploads.close());
  const outside = path.join(root, 'elsewhere'); await mkdir(outside);
  const project = path.join(root, 'project'); await mkdir(project);
  await symlink(outside, path.join(project, ATTACHMENT_FOLDER), 'junction');
  await assert.rejects(uploads.begin('phone', project, 'a.txt', 3), { code: 'UPLOAD_FOLDER' });
  const blocked = path.join(root, 'blocked'); await mkdir(blocked); await writeFile(path.join(blocked, ATTACHMENT_FOLDER), 'a file');
  await assert.rejects(uploads.begin('phone', blocked, 'a.txt', 3), { code: 'UPLOAD_FOLDER' });
  await assert.rejects(uploads.begin('phone', data, 'a.txt', 3), { code: 'FILES_PROTECTED' });
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(readdir(folder), { code: 'ENOENT' }, 'nothing was created in the root by refused requests');
});

test('attachments stay out of Git: one local exclude line, shared by worktrees, nothing outside a repository', async t => {
  const { execFileSync } = await import('node:child_process');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const { root, data } = await fixture(t);
  const repo = path.join(root, 'repo'); await mkdir(repo);
  git(repo, 'init', '-q'); git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  await writeFile(path.join(repo, '.git', 'info', 'exclude'), '# existing\n*.log');
  const uploads = new Uploads(data); t.after(() => uploads.close());
  for (const name of ['a.png', 'b.png']) {
    const begun = await uploads.begin('phone', repo, name, 3);
    await uploads.chunk('phone', begun.uploadId, 0, Buffer.from('abc'));
    await uploads.finish('phone', begun.uploadId);
  }
  assert.equal(await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), '# existing\n*.log\n# Mongle Terminal attachments\n.mongle-attachments/\n');
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '', 'git sees no attachment');
  git(repo, 'worktree', 'add', '-q', path.join(root, 'wt'));
  const begun = await uploads.begin('phone', path.join(root, 'wt'), 'c.png', 3);
  await uploads.cancel('phone', begun.uploadId);
  assert.equal((await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).match(/\.mongle-attachments\//g)?.length, 1, 'a worktree shares the main exclude file');
  assert.equal(git(path.join(root, 'wt'), 'status', '--porcelain', '--untracked-files=all'), '');
  const plain = path.join(root, 'plain'); await mkdir(plain);
  const other = await uploads.begin('phone', plain, 'd.png', 3);
  await uploads.cancel('phone', other.uploadId);
  assert.deepEqual(await readdir(plain), [ATTACHMENT_FOLDER], 'outside a repository only the attachment folder appears');
});

test('simultaneous begins cannot pass the limits, and a disconnect or shutdown during a begin leaves no file', async t => {
  const { root, data, folder } = await fixture(t);
  const uploads = new Uploads(data); t.after(() => uploads.close());
  const many = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => uploads.begin('device-' + index, root, 'a.txt', 3)));
  assert.equal(many.filter(result => result.status === 'fulfilled').length, 8, 'eight in total');
  assert.ok(many.filter(result => result.status === 'rejected').every(result => (result as PromiseRejectedResult).reason.code === 'UPLOAD_BUSY'));
  await uploads.close();
  const fresh = new Uploads(data); t.after(() => fresh.close());
  const mine = await Promise.allSettled([1, 2, 3].map(() => fresh.begin('phone', root, 'b.txt', 3)));
  assert.equal(mine.filter(result => result.status === 'fulfilled').length, 2, 'two per connection');
  await fresh.dropOwner('phone');
  const dropped = fresh.begin('phone', root, 'c.txt', 3);
  await fresh.dropOwner('phone');
  await assert.rejects(dropped, { code: 'UPLOAD_EXPIRED' });
  const closing = fresh.begin('laptop', root, 'd.txt', 3);
  await fresh.close();
  await assert.rejects(closing, { code: 'UPLOAD_EXPIRED' });
  await assert.rejects(fresh.begin('laptop', root, 'e.txt', 3), { code: 'HOST_UNAVAILABLE' });
  assert.deepEqual((await readdir(folder)).filter(name => name.endsWith('.part')), [], 'no unfinished file is left behind');
});

test('the Git exclude file is written only where Git keeps it, and only a rule that covers every folder counts', async t => {
  const { execFileSync } = await import('node:child_process');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const { root, data } = await fixture(t);
  const uploads = new Uploads(data); t.after(() => uploads.close());
  // .git/info is a junction into the protected app data folder: refused before anything is saved.
  const trap = path.join(root, 'trap'); await mkdir(trap); git(trap, 'init', '-q');
  await rm(path.join(trap, '.git', 'info'), { recursive: true, force: true });
  const protectedInfo = path.join(data, 'info'); await mkdir(protectedInfo); await writeFile(path.join(protectedInfo, 'exclude'), 'secret\n');
  await symlink(protectedInfo, path.join(trap, '.git', 'info'), 'junction');
  await assert.rejects(uploads.begin('phone', trap, 'a.png', 3), { code: 'UPLOAD_GIT_EXCLUDE' });
  assert.equal(await readFile(path.join(protectedInfo, 'exclude'), 'utf8'), 'secret\n');
  assert.deepEqual((await readdir(trap)).sort(), ['.git'], 'no attachment folder is made when exclusion fails');
  // A hard-linked exclude file would write somewhere else too.
  const linked = path.join(root, 'linked'); await mkdir(linked); git(linked, 'init', '-q');
  const elsewhere = path.join(root, 'elsewhere.txt'); await writeFile(elsewhere, '');
  await rm(path.join(linked, '.git', 'info', 'exclude'), { force: true });
  await link(elsewhere, path.join(linked, '.git', 'info', 'exclude'));
  await assert.rejects(uploads.begin('phone', linked, 'a.png', 3), { code: 'UPLOAD_GIT_EXCLUDE' });
  assert.equal(await readFile(elsewhere, 'utf8'), '');
  // A root-only rule does not cover a subfolder: the general rule is added and Git sees nothing.
  const repo = path.join(root, 'repo'); await mkdir(path.join(repo, 'sub'), { recursive: true }); git(repo, 'init', '-q');
  await writeFile(path.join(repo, '.git', 'info', 'exclude'), '/.mongle-attachments/\n');
  const begun = await uploads.begin('phone', path.join(repo, 'sub'), 'a.png', 3);
  await uploads.chunk('phone', begun.uploadId, 0, Buffer.from('abc'));
  await uploads.finish('phone', begun.uploadId);
  assert.equal(await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), '/.mongle-attachments/\n# Mongle Terminal attachments\n.mongle-attachments/\n');
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all'), '');
});


test('Git itself decides: an existing ignore is enough, and a rule that brings the folder back stops the upload', async t => {
  const { execFileSync } = await import('node:child_process');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  const { root, data } = await fixture(t);
  const uploads = new Uploads(data); t.after(() => uploads.close());
  const ignored = path.join(root, 'ignored'); await mkdir(ignored); git(ignored, 'init', '-q');
  await writeFile(path.join(ignored, '.gitignore'), '.mongle-attachments/\n');
  await writeFile(path.join(ignored, '.git', 'info', 'exclude'), '');
  const kept = await uploads.begin('phone', ignored, 'a.png', 3); await uploads.cancel('phone', kept.uploadId);
  assert.equal(await readFile(path.join(ignored, '.git', 'info', 'exclude'), 'utf8'), '', 'a .gitignore that already ignores the folder needs no line');
  for (const [name, exclude, gitignore] of [['negated-exclude', '.mongle-attachments/\n!.mongle-attachments/\n', ''], ['negated-gitignore', '', '!.mongle-attachments/\n']] as const) {
    const repo = path.join(root, name); await mkdir(repo); git(repo, 'init', '-q');
    await writeFile(path.join(repo, '.git', 'info', 'exclude'), exclude);
    if (gitignore) await writeFile(path.join(repo, '.gitignore'), gitignore);
    await assert.rejects(uploads.begin('phone', repo, 'a.png', 3), { code: 'UPLOAD_GIT_EXCLUDE', message: /다시 포함/ });
    assert.ok(!(await readdir(repo)).includes(ATTACHMENT_FOLDER), name + ': nothing is saved where Git would see it');
  }
  const once = await readFile(path.join(root, 'negated-exclude', '.git', 'info', 'exclude'), 'utf8');
  await assert.rejects(uploads.begin('phone', path.join(root, 'negated-exclude'), 'a.png', 3), { code: 'UPLOAD_GIT_EXCLUDE' });
  assert.equal(await readFile(path.join(root, 'negated-exclude', '.git', 'info', 'exclude'), 'utf8'), once, 'a refused folder does not collect more lines');
  // Only some files brought back (".mongle-attachments/*" then "!.mongle-attachments/*.png"): the name this upload will
  // really have is asked of Git, so the PNG is seen as not ignored and the folder rule is added. Git never
  // re-includes a file whose folder is excluded, so after that the PNG is ignored too.
  const partial = path.join(root, 'partial'); await mkdir(partial); git(partial, 'init', '-q');
  await writeFile(path.join(partial, '.gitignore'), '.mongle-attachments/*\n!.mongle-attachments/*.png\n');
  await writeFile(path.join(partial, '.git', 'info', 'exclude'), '');
  for (const name of ['shot.png', 'notes.txt']) {
    const begun = await uploads.begin('phone', partial, name, 3);
    await uploads.chunk('phone', begun.uploadId, 0, Buffer.from('abc'));
    await uploads.finish('phone', begun.uploadId);
  }
  assert.equal(await readFile(path.join(partial, '.git', 'info', 'exclude'), 'utf8'), '# Mongle Terminal attachments\n.mongle-attachments/\n');
  assert.equal(git(partial, 'status', '--porcelain', '--untracked-files=all'), '?? .gitignore\n', 'neither saved file is in Git');
});


test('the host takes an upload only for a live terminal in its current folder and from the connection that began it', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, data, folder } = await fixture(t, false);
  // The shell runs in the folder: close the host first, then remove the folder.
  const core = new HostCore({ dataDir: data }); await core.init(); t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'phone', deviceName: 'Phone', owner: false };
  const other = { ...ctx, id: randomUUID(), deviceId: 'other' }; core.connect(ctx, () => {}); core.connect(other, () => {});
  const terminal: TerminalInfo = await core.handle('terminals.create', { groupId: core.getState().groups[0].id, profileId: 'cmd', cwd: root }, ctx);
  const state = core.getState();
  assert.ok(state.capabilities?.includes('files.upload'));
  const reference = { id: terminal.id, generation: terminal.generation, hostId: state.hostId, bootId: state.bootId };
  await assert.rejects(core.handle('files.upload.begin', { ...reference, root: path.join(root, 'other'), name: 'a.txt', size: 2 }, ctx), { code: 'FILES_ROOT_CHANGED' });
  const begun = await core.handle('files.upload.begin', { ...reference, root, name: '메모.txt', size: 5 }, ctx);
  const chunk = { hostId: state.hostId, bootId: state.bootId, uploadId: begun.uploadId, offset: 0, dataBase64: Buffer.from('hello').toString('base64') };
  await assert.rejects(core.handle('files.upload.chunk', chunk, other), { code: 'UPLOAD_EXPIRED' });
  await assert.rejects(core.handle('files.upload.chunk', { ...chunk, bootId: randomUUID() }, ctx), { code: 'HOST_CHANGED' });
  await assert.rejects(core.handle('files.upload.chunk', { ...chunk, dataBase64: 'A'.repeat(Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 4) }, ctx));
  await core.handle('files.upload.chunk', chunk, ctx);
  const done = await core.handle('files.upload.finish', { hostId: state.hostId, bootId: state.bootId, uploadId: begun.uploadId }, ctx);
  assert.equal(await readFile(done.path, 'utf8'), 'hello');
  assert.match(done.name, /-메모\.txt$/);
  const pending = await core.handle('files.upload.begin', { ...reference, root, name: 'b.txt', size: 5 }, ctx);
  core.disconnect(ctx.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual((await readdir(folder)).filter(name => name.endsWith('.part')), [], 'a disconnect removes the unfinished file');
  assert.ok(pending.uploadId);
});
