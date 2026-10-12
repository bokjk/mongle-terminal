import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readGitDiff, readGitReview } from '../../packages/host/git';
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
  // The host reports the real path; a temp folder may be reached through a Windows short name.
  assert.equal(modified.absolutePath, path.join(await realpath(repository), 'src', 'modified.ts'));
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
  assert.deepEqual([scoped.original, scoped.modified, scoped.absolutePath], [null, null, path.join(await realpath(repository), 'src', 'README.md')]);
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
  assert.ok(state.capabilities?.includes('git.diff')); assert.ok(state.capabilities?.includes('git.review'));
  const review = await core.handle('git.review', { ...ref, mode: 'branch' }, ctx); assert.equal(review.state, 'repository'); assert.equal(review.mode, 'head');
  await assert.rejects(core.handle('git.review', { ...ref, mode: 'all' }, ctx), { name: 'ZodError' }); await assert.rejects(core.handle('git.review', { ...ref, path: 'src', mode: 'head' }, ctx), { code: 'INVALID_REQUEST' });
  assert.equal((await core.handle('git.diff', { ...ref, path: 'staged.txt', base: review.base, target: 'WORKTREE' }, ctx) as GitDiff).original, 'before\n');
  await assert.rejects(core.handle('git.diff', { ...ref, path: 'staged.txt', base: 'HEAD~1', target: 'WORKTREE' }, ctx), { name: 'ZodError' });
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 3;\n');
  const diff: GitDiff = await core.handle('git.diff', { ...ref, path: 'src/modified.ts', base: 'INDEX', target: 'WORKTREE' }, ctx);
  assert.equal(diff.modified, 'export const value = 3;\n');
  await assert.rejects(core.handle('git.diff', { ...ref, path: 'src/modified.ts', base: 'WORKTREE', target: 'INDEX' }, ctx), { name: 'ZodError' });
  await assert.rejects(core.handle('git.diff', { ...ref, path: 'src/modified.ts', base: 'INDEX', target: 'WORKTREE', extra: true }, ctx), { name: 'ZodError' });
  await assert.rejects(core.handle('git.diff', { ...ref, path: '', base: 'INDEX', target: 'WORKTREE' }, ctx), { name: 'ZodError' });
  await assert.rejects(core.handle('git.diff', { ...ref, root: path.dirname(repository), path: 'x', base: 'INDEX', target: 'WORKTREE' }, ctx), { code: 'FILES_ROOT_CHANGED' });
  const after = core.getState().terminals[0]; assert.equal(after.pid, terminal.pid); assert.equal(after.controller, undefined);
});

test('Git review lists every change since the branch left its base, falls back to HEAD and stays inside the folder', async t => {
  const { repository, data } = await fixture(t);
  await git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(repository, 'checkout', '-qb', 'feature');
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 2;\n'); await writeFile(path.join(repository, 'committed.txt'), 'committed\n');
  await git(repository, 'mv', '--', '이전 이름.txt', '새 이름.txt'); await git(repository, 'rm', '-q', '--', 'deleted.txt');
  await git(repository, 'add', '--', '.'); await git(repository, 'commit', '-qm', 'feature work');
  await writeFile(path.join(repository, 'staged.txt'), 'uncommitted\n'); await writeFile(path.join(repository, 'new.txt'), 'new\n');
  await writeFile(path.join(repository, 'added.txt'), 'added\n'); await git(repository, 'add', '--', 'added.txt');
  const marker = path.join(repository, 'program-ran.txt').replace(/\\/g, '/');
  await git(repository, 'config', 'diff.mark.textconv', `touch "${marker}" && cat`); await writeFile(path.join(repository, '.git', 'info', 'attributes'), '* diff=mark\n');
  const before = await digest(path.join(repository, '.git', 'index'));
  const fork = (await git(repository, 'rev-parse', 'origin/main')).trim();

  const branch = await readGitReview(repository, data, 'branch');
  assert.equal(branch.state, 'repository'); if (branch.state !== 'repository') return;
  assert.deepEqual([branch.mode, branch.base, branch.baseLabel, branch.branch, branch.notice], ['branch', fork, 'origin/main', 'feature', undefined]);
  assert.deepEqual(branch.files, [
    { path: 'added.txt', status: 'added' }, { path: 'committed.txt', status: 'added' }, { path: 'deleted.txt', status: 'deleted' }, { path: 'new.txt', status: 'added' },
    { path: 'src/modified.ts', status: 'modified' }, { path: 'staged.txt', status: 'modified' }, { path: '새 이름.txt', originalPath: '이전 이름.txt', status: 'renamed' },
  ]);
  const renamed = await readGitDiff(repository, data, { path: '새 이름.txt', originalPath: '이전 이름.txt', base: branch.base, target: 'WORKTREE' });
  assert.deepEqual([renamed.original, renamed.modified], ['rename me\n', 'rename me\n']);
  const committed = await readGitDiff(repository, data, { path: 'src/modified.ts', base: branch.base, target: 'WORKTREE' });
  assert.deepEqual([committed.original, committed.modified], ['export const value = 1;\n', 'export const value = 2;\n']);

  const head = await readGitReview(repository, data, 'head');
  assert.equal(head.state, 'repository'); if (head.state !== 'repository') return;
  assert.equal(head.mode, 'head'); assert.equal(head.base, (await git(repository, 'rev-parse', 'HEAD')).trim());
  assert.deepEqual(head.files.map(file => file.path + ':' + file.status), ['added.txt:added', 'new.txt:added', 'staged.txt:modified']);

  const preferred = await readGitReview(repository, data, 'branch', () => 'main');
  assert.equal(preferred.state === 'repository' && preferred.baseLabel, 'main');
  const scoped = await readGitReview(path.join(repository, 'src'), data, 'branch');
  assert.deepEqual(scoped.state === 'repository' && scoped.files, [{ path: 'modified.ts', status: 'modified' }]);
  await git(repository, 'update-ref', '-d', 'refs/remotes/origin/HEAD'); await git(repository, 'update-ref', '-d', 'refs/remotes/origin/main');
  const fallback = await readGitReview(repository, data, 'branch', () => 'missing-branch');
  assert.equal(fallback.state === 'repository' && fallback.mode, 'head'); assert.match(fallback.state === 'repository' && fallback.notice || '', /기준 브랜치를 찾지 못해/);
  assert.equal(await digest(path.join(repository, '.git', 'index')), before); assert.equal(existsSync(marker), false);
  await assert.rejects(readGitDiff(repository, data, { path: 'staged.txt', base: 'HEAD~1', target: 'WORKTREE' }), { code: 'INVALID_REQUEST' });
});

test('Git review leaves out files the working folder brought back to the base, including a reverted rename', async t => {
  // PR #74 review: a committed change undone in the working folder is no change at all.
  const { repository, data } = await fixture(t);
  await git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(repository, 'checkout', '-qb', 'feature');
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 2;\n'); await writeFile(path.join(repository, 'staged.txt'), 'changed on the branch\n');
  await git(repository, 'mv', '--', '이전 이름.txt', '새 이름.txt');
  await git(repository, 'add', '--', '.'); await git(repository, 'commit', '-qm', 'feature work');
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 1;\n');
  await git(repository, 'mv', '--', '새 이름.txt', '이전 이름.txt');
  await writeFile(path.join(repository, 'README.md'), '# Test project\n'); await git(repository, 'add', '--', 'README.md');
  const before = await digest(path.join(repository, '.git', 'index'));
  const review = await readGitReview(repository, data, 'branch');
  assert.equal(review.state, 'repository'); if (review.state !== 'repository') return;
  assert.deepEqual(review.files, [{ path: 'staged.txt', status: 'modified' }], 'only the change that still differs from the base');
  await writeFile(path.join(repository, 'staged.txt'), 'before\n');
  const reverted = await readGitReview(repository, data, 'branch');
  assert.deepEqual(reverted.state === 'repository' && reverted.files, []);
  assert.equal(await digest(path.join(repository, '.git', 'index')), before, 'hashing the files writes nothing');
});

test('Git diff compares a symbolic link as its target text, as Git stores it', async t => {
  // PR #74 review: following the link compared the contents of the files it points to.
  const { repository, data } = await fixture(t);
  await writeFile(path.join(repository, 'first.txt'), 'first contents\n');
  try { await symlink('first.txt', path.join(repository, 'link'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { t.skip('creating a symbolic link needs Developer Mode on this Windows'); return; } throw error; }
  const diff = await readGitDiff(repository, data, { path: 'link', base: 'INDEX', target: 'WORKTREE' });
  assert.deepEqual([diff.original, diff.modified], [null, 'first.txt']);
});

test('Git review keeps a file whose executable bit differs from the base on POSIX', async t => {
  // PR #74 review: chmod alone is a mode change Git reports while core.fileMode is on.
  if (process.platform === 'win32') { t.skip('Windows has no executable bit; Git sets core.fileMode off there'); return; }
  const { repository, data } = await fixture(t);
  await git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(repository, 'checkout', '-qb', 'feature');
  await writeFile(path.join(repository, 'staged.txt'), 'changed on the branch\n'); await git(repository, 'commit', '-qam', 'feature work');
  await writeFile(path.join(repository, 'staged.txt'), 'before\n'); await chmod(path.join(repository, 'staged.txt'), 0o755);
  const executable = await readGitReview(repository, data, 'branch');
  assert.deepEqual(executable.state === 'repository' && executable.files, [{ path: 'staged.txt', status: 'modified' }], 'same content, new executable bit');
  await chmod(path.join(repository, 'staged.txt'), 0o644);
  const restored = await readGitReview(repository, data, 'branch');
  assert.deepEqual(restored.state === 'repository' && restored.files, [], 'content and mode are back at the base');
});

test('Git review keeps a staged deletion, and a symbolic link restored to the base drops out', async t => {
  // PR #74 review: a git rm is a path that existed at HEAD; a restored link equals its base blob.
  const { repository, data } = await fixture(t);
  await git(repository, 'rm', '-q', '--', 'deleted.txt');
  const staged = await readGitReview(repository, data, 'head');
  assert.deepEqual(staged.state === 'repository' && staged.files, [{ path: 'deleted.txt', status: 'deleted' }]);
  try { await symlink('first.txt', path.join(repository, 'link'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { t.skip('creating a symbolic link needs Developer Mode on this Windows'); return; } throw error; }
  await writeFile(path.join(repository, 'first.txt'), 'first\n'); await writeFile(path.join(repository, 'second.txt'), 'second\n');
  await git(repository, '-c', 'core.symlinks=true', 'add', '--', 'link', 'first.txt', 'second.txt'); await git(repository, 'commit', '-qm', 'link');
  await git(repository, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); await git(repository, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git(repository, 'checkout', '-qb', 'feature');
  await unlink(path.join(repository, 'link')); await symlink('second.txt', path.join(repository, 'link'), 'file');
  await git(repository, '-c', 'core.symlinks=true', 'add', '--', 'link'); await git(repository, 'commit', '-qm', 'point elsewhere');
  await unlink(path.join(repository, 'link')); await symlink('first.txt', path.join(repository, 'link'), 'file');
  const restored = await readGitReview(repository, data, 'branch');
  assert.deepEqual(restored.state === 'repository' && restored.files.map(file => file.path), [], 'the link is back at its base target');
  await unlink(path.join(repository, 'link')); await writeFile(path.join(repository, 'link'), 'first.txt');
  const retyped = await readGitReview(repository, data, 'branch');
  assert.deepEqual(retyped.state === 'repository' && retyped.files, [{ path: 'link', status: 'modified' }], 'a regular file with the same text is still a change');
});
