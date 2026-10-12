import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readGitDiff } from '../../packages/host/git';
import { HostCore } from '../../packages/host/core';
import { GIT_DIFF_BYTES, type ConnectionContext, type GitDiff, type TerminalInfo } from '../../packages/protocol';
import { git, gitFixture } from '../helpers/git';

async function fixture(t: test.TestContext, cleanup = true) {
  const result = await gitFixture();
  if (cleanup) t.after(async () => { assert.equal(path.dirname(result.root), tmpdir()); assert.ok(path.basename(result.root).startsWith('mongle-git-')); await rm(result.root, { recursive: true, force: true }); });
  return result;
}
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

test('Git diff reads HEAD, index and working copies for each kind of change without Git writes, hooks or filters', async t => {
  const { repository, data } = await fixture(t);
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 2;\n');
  await writeFile(path.join(repository, 'staged.txt'), 'staged\n'); await git(repository, 'add', '--', 'staged.txt');
  await writeFile(path.join(repository, 'staged.txt'), 'staged and working\n');
  await writeFile(path.join(repository, 'added.txt'), 'added\n'); await git(repository, 'add', '--', 'added.txt');
  await unlink(path.join(repository, 'deleted.txt'));
  await git(repository, 'mv', '--', '이전 이름.txt', '새 이름.txt');
  await writeFile(path.join(repository, '-한글 [새 파일] &.txt'), '새 내용\n');
  // A configured filter or fsmonitor would leave a marker file if Git ran it.
  const marker = path.join(repository, 'program-ran.txt').replace(/\\/g, '/');
  await git(repository, 'config', 'core.fsmonitor', `touch "${marker}"`);
  await git(repository, 'config', 'filter.mark.smudge', `touch "${marker}" && cat`); await git(repository, 'config', 'filter.mark.textconv', `touch "${marker}" && cat`);
  await writeFile(path.join(repository, '.gitattributes'), '*.txt filter=mark diff=mark\n');
  const before = await digest(path.join(repository, '.git', 'index'));
  const read = (request: Parameters<typeof readGitDiff>[2]) => readGitDiff(repository, data, request);

  const modified = await read({ path: 'src/modified.ts', base: 'INDEX', target: 'WORKTREE' });
  assert.equal(modified.original, 'export const value = 1;\n'); assert.equal(modified.modified, 'export const value = 2;\n'); assert.equal(modified.unavailable, undefined);
  assert.equal(modified.absolutePath, path.join(repository, 'src', 'modified.ts'));
  const staged = await read({ path: 'staged.txt', base: 'HEAD', target: 'INDEX' });
  assert.deepEqual([staged.original, staged.modified], ['before\n', 'staged\n']);
  const working = await read({ path: 'staged.txt', base: 'INDEX', target: 'WORKTREE' });
  assert.deepEqual([working.original, working.modified], ['staged\n', 'staged and working\n']);
  const added = await read({ path: 'added.txt', base: 'HEAD', target: 'INDEX' });
  assert.deepEqual([added.original, added.modified], [null, 'added\n']);
  const deleted = await read({ path: 'deleted.txt', base: 'INDEX', target: 'WORKTREE' });
  assert.deepEqual([deleted.original, deleted.modified], ['delete me\n', null]);
  const renamed = await read({ path: '새 이름.txt', originalPath: '이전 이름.txt', base: 'HEAD', target: 'INDEX' });
  assert.deepEqual([renamed.original, renamed.modified, renamed.originalPath], ['rename me\n', 'rename me\n', '이전 이름.txt']);
  const untracked = await read({ path: '-한글 [새 파일] &.txt', base: 'INDEX', target: 'WORKTREE' });
  assert.deepEqual([untracked.original, untracked.modified], [null, '새 내용\n']);
  const scoped = await readGitDiff(path.join(repository, 'src'), data, { path: 'modified.ts', base: 'HEAD', target: 'WORKTREE' });
  assert.deepEqual([scoped.original, scoped.modified], ['export const value = 1;\n', 'export const value = 2;\n']);

  assert.equal(await digest(path.join(repository, '.git', 'index')), before);
  assert.equal(existsSync(marker), false);
});

test('Git diff explains binary, oversized and CRLF-only files and refuses paths outside the terminal folder', async t => {
  const { root, repository, data } = await fixture(t);
  const read = (request: Parameters<typeof readGitDiff>[2], base = repository) => readGitDiff(base, data, request);
  await writeFile(path.join(repository, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const binary = await read({ path: 'image.bin', base: 'INDEX', target: 'WORKTREE' });
  assert.match(binary.unavailable || '', /바이너리/); assert.equal(binary.original, null); assert.equal(binary.modified, null);
  await writeFile(path.join(repository, 'large.txt'), 'a'.repeat(GIT_DIFF_BYTES + 1));
  assert.match((await read({ path: 'large.txt', base: 'INDEX', target: 'WORKTREE' })).unavailable || '', /KiB를 넘는/);
  await git(repository, 'add', '--', 'large.txt');
  assert.match((await read({ path: 'large.txt', base: 'HEAD', target: 'INDEX' })).unavailable || '', /KiB를 넘는/);
  await writeFile(path.join(repository, 'staged.txt'), 'before\r\n');
  const crlf = await read({ path: 'staged.txt', base: 'INDEX', target: 'WORKTREE' });
  assert.deepEqual([crlf.original, crlf.modified], ['before\n', 'before\r\n']);
  await writeFile(path.join(repository, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('한글', 'utf16le')]));
  assert.equal((await read({ path: 'utf16.txt', base: 'INDEX', target: 'WORKTREE' })).modified, '한글');

  for (const outside of ['../x.txt', 'C:\\Windows\\win.ini', 'a:b.txt', '']) await assert.rejects(read({ path: outside, base: 'INDEX', target: 'WORKTREE' }), { code: 'FILES_OUTSIDE_ROOT' });
  await assert.rejects(read({ path: 'staged.txt', originalPath: '../README.md', base: 'HEAD', target: 'INDEX' }), { code: 'FILES_OUTSIDE_ROOT' });
  // Paths are resolved below the terminal folder, so a subfolder cannot name the repository's top-level file.
  const scoped = await read({ path: 'README.md', base: 'HEAD', target: 'INDEX' }, path.join(repository, 'src'));
  assert.deepEqual([scoped.original, scoped.modified, scoped.absolutePath], [null, null, path.join(repository, 'src', 'README.md')]);
  await assert.rejects(read({ path: 'staged.txt', base: 'INDEX', target: 'INDEX' as never }), { code: 'INVALID_REQUEST' });
  await writeFile(path.join(data, 'secret.txt'), 'private');
  await assert.rejects(read({ path: '.app-private/secret.txt', base: 'INDEX', target: 'WORKTREE' }), { code: 'FILES_OUTSIDE_ROOT' });
  const outsideFile = path.join(root, 'outside.txt'); await writeFile(outsideFile, 'outside');
  await symlink(path.dirname(outsideFile), path.join(repository, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await read({ path: 'escape/outside.txt', base: 'INDEX', target: 'WORKTREE' })).unavailable || '', /폴더 밖/);
  await assert.rejects(readGitDiff(path.join(root), data, { path: 'outside.txt', base: 'INDEX', target: 'WORKTREE' }), { code: 'GIT_UNAVAILABLE' });
});

test('Git diff RPC advertises the capability and validates the compared versions', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, repository, data } = await fixture(t, false);
  const core = new HostCore({ dataDir: data }); await core.init(); t.after(async () => { await core.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'git-diff', deviceName: 'Approved browser', owner: false }; core.connect(ctx, () => {});
  const terminal: TerminalInfo = await core.handle('terminals.create', { groupId: core.getState().groups[0].id, profileId: 'cmd', cwd: repository }, ctx);
  const state = core.getState(), ref = { id: terminal.id, hostId: state.hostId, bootId: state.bootId, generation: terminal.generation, root: terminal.currentCwd || terminal.cwd };
  assert.ok(state.capabilities?.includes('git.diff'));
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 3;\n');
  const diff: GitDiff = await core.handle('git.diff', { ...ref, path: 'src/modified.ts', base: 'INDEX', target: 'WORKTREE' }, ctx);
  assert.equal(diff.modified, 'export const value = 3;\n');
  await assert.rejects(core.handle('git.diff', { ...ref, path: 'src/modified.ts', base: 'WORKTREE', target: 'INDEX' }, ctx), { name: 'ZodError' });
  await assert.rejects(core.handle('git.diff', { ...ref, path: 'src/modified.ts', base: 'INDEX', target: 'WORKTREE', extra: true }, ctx), { name: 'ZodError' });
  await assert.rejects(core.handle('git.diff', { ...ref, path: '', base: 'INDEX', target: 'WORKTREE' }, ctx), { name: 'ZodError' });
  await assert.rejects(core.handle('git.diff', { ...ref, root: path.dirname(repository), path: 'x', base: 'INDEX', target: 'WORKTREE' }, ctx), { code: 'FILES_ROOT_CHANGED' });
  const after = core.getState().terminals[0]; assert.equal(after.pid, terminal.pid); assert.equal(after.controller, undefined);
});

