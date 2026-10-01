import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { inspectGit, parseGitStatus, GIT_CHANGE_LIMIT } from '../../packages/host/git';
import { HostCore } from '../../packages/host/core';
import type { ConnectionContext, GitListing, TerminalInfo } from '../../packages/protocol';
import { git, gitFixture } from '../helpers/git';

async function fixture(t: test.TestContext, cleanup = true) {
  const result = await gitFixture();
  if (cleanup) t.after(async () => { assert.equal(path.dirname(result.root), tmpdir()); assert.ok(path.basename(result.root).startsWith('mongle-git-')); await rm(result.root, { recursive: true, force: true }); });
  return result;
}
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

test('Git status reads actual modified, staged+unstaged, added, deleted, renamed and Unicode paths without index writes or hooks', async t => {
  const { repository, data } = await fixture(t);
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 2;\n');
  await writeFile(path.join(repository, 'staged.txt'), 'staged\n'); await git(repository, 'add', '--', 'staged.txt');
  await writeFile(path.join(repository, 'staged.txt'), 'staged and more\n');
  await writeFile(path.join(repository, 'added.txt'), 'added\n'); await git(repository, 'add', '--', 'added.txt');
  await unlink(path.join(repository, 'deleted.txt'));
  await git(repository, 'rm', '--', 'README.md'); await writeFile(path.join(repository, 'README.md'), 'recreated file\n');
  await git(repository, 'mv', '--', '이전 이름.txt', '새 이름.txt');
  await writeFile(path.join(repository, '-한글 [새 파일] &.txt'), 'new\n');
  await mkdir(path.join(repository, 'ignored')); await writeFile(path.join(repository, 'ignored', 'secret.txt'), 'ignored');
  await writeFile(path.join(data, 'secret.txt'), 'private');
  await git(repository, 'config', 'core.fsmonitor', `touch "${path.join(repository, 'hook-ran.txt').replace(/\\/g, '/')}"`);
  const before = await digest(path.join(repository, '.git', 'index'));
  const listing = await inspectGit(repository, data); assert.equal(listing.state, 'repository');
  if (listing.state !== 'repository') throw new Error('expected repository');
  assert.equal(listing.branch, 'main'); assert.equal(listing.detached, false); assert.equal(listing.truncated, false);
  const changes = new Map(listing.changes.map(change => [change.path, change]));
  assert.equal(changes.get('src/modified.ts')?.worktree, 'M');
  assert.equal(changes.get('staged.txt')?.index, 'M'); assert.equal(changes.get('staged.txt')?.worktree, 'M');
  assert.equal(changes.get('added.txt')?.index, 'A'); assert.equal(changes.get('deleted.txt')?.worktree, 'D');
  assert.equal(changes.get('README.md')?.index, 'D'); assert.equal(changes.get('README.md')?.untracked, true);
  assert.equal(listing.changes.filter(change => change.path === 'README.md').length, 1);
  assert.equal(changes.get('새 이름.txt')?.index, 'R'); assert.equal(changes.get('새 이름.txt')?.originalPath, '이전 이름.txt');
  assert.equal(changes.get('-한글 [새 파일] &.txt')?.untracked, true);
  assert.ok(!listing.changes.some(change => /ignored|app-private|hook-ran/.test(change.path)));
  assert.equal(await digest(path.join(repository, '.git', 'index')), before); assert.equal(existsSync(path.join(repository, 'hook-ran.txt')), false);
});

test('Git cwd scope, worktrees, detached and unborn branches use real repository data', async t => {
  const { root, repository, data } = await fixture(t);
  await writeFile(path.join(repository, 'README.md'), 'outside scope'); await writeFile(path.join(repository, 'src', 'modified.ts'), 'changed');
  const scoped = await inspectGit(path.join(repository, 'src'), data); assert.equal(scoped.state, 'repository');
  if (scoped.state !== 'repository') throw new Error('expected repository');
  assert.deepEqual(scoped.changes.map(change => change.path), ['modified.ts']); assert.equal(scoped.repositoryRoot, await realpath(repository));
  const linked = path.join(root, 'linked'); await git(repository, 'worktree', 'add', '--detach', linked, 'HEAD');
  const worktree = await inspectGit(linked, data); assert.equal(worktree.state, 'repository');
  if (worktree.state !== 'repository') throw new Error('expected worktree'); assert.equal(worktree.detached, true); assert.deepEqual(worktree.changes, []);
  const unborn = path.join(root, 'unborn'); await mkdir(unborn); await git(unborn, 'init', '-q', '--initial-branch=new-branch'); await writeFile(path.join(unborn, 'new.txt'), 'new');
  const initial = await inspectGit(unborn, data); assert.equal(initial.state, 'repository');
  if (initial.state !== 'repository') throw new Error('expected unborn'); assert.equal(initial.branch, 'new-branch'); assert.equal(initial.changes[0].untracked, true);
});

test('Git conflicts, clean and non-repository states stay distinct', async t => {
  const { root, repository, data } = await fixture(t);
  const clean = await inspectGit(repository, data); assert.equal(clean.state, 'repository'); if (clean.state === 'repository') assert.deepEqual(clean.changes, []);
  await git(repository, 'checkout', '-qb', 'other'); await writeFile(path.join(repository, 'staged.txt'), 'other\n'); await git(repository, 'commit', '-qam', 'other');
  await git(repository, 'checkout', '-q', 'main'); await writeFile(path.join(repository, 'staged.txt'), 'main\n'); await git(repository, 'commit', '-qam', 'main');
  await assert.rejects(git(repository, 'merge', 'other'));
  const conflict = await inspectGit(repository, data); assert.equal(conflict.state, 'repository');
  if (conflict.state !== 'repository') throw new Error('expected conflict'); assert.equal(conflict.changes.find(change => change.path === 'staged.txt')?.conflicted, true);
  const plain = path.join(root, 'plain'); await mkdir(plain); assert.equal((await inspectGit(plain, data)).state, 'not-repository');
});

test('a missing Git executable is unavailable rather than a clean repository', async t => {
  const { repository, data } = await fixture(t);
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    const result = await inspectGit(repository, data);
    assert.equal(result.state, 'unavailable'); if (result.state === 'unavailable') assert.match(result.message, /Git을 찾지 못/);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test('Git protects private data, escaping links, metadata redirects and limits large change lists', async t => {
  const { root, repository, data } = await fixture(t);
  await assert.rejects(inspectGit(data, data), { code: 'FILES_PROTECTED' });
  await assert.rejects(inspectGit('\\\\server\\share', data), { code: 'FILES_UNSUPPORTED' });
  const privateFolder = path.join(repository, 'private-link'); await symlink(data, privateFolder, process.platform === 'win32' ? 'junction' : 'dir');
  const listing = await inspectGit(repository, data); assert.equal(listing.state, 'repository'); if (listing.state === 'repository') assert.ok(!listing.changes.some(change => change.path.startsWith('private-link/')));
  const redirected = path.join(root, 'redirected'); await mkdir(redirected); await writeFile(path.join(redirected, '.git'), `gitdir: ${data}\n`);
  await assert.rejects(inspectGit(redirected, data), { code: 'FILES_PROTECTED' });
  const network = path.join(root, 'network'); await mkdir(network); await writeFile(path.join(network, '.git'), 'gitdir: \\\\server\\share\\repo\n');
  await assert.rejects(inspectGit(network, data), { code: 'GIT_UNAVAILABLE' });
  await mkdir(path.join(repository, 'many')); await Promise.all(Array.from({ length: GIT_CHANGE_LIMIT + 2 }, (_, i) => writeFile(path.join(repository, 'many', `${i}.txt`), '')));
  const large = await inspectGit(repository, data); assert.equal(large.state, 'repository'); if (large.state === 'repository') { assert.equal(large.changes.length, GIT_CHANGE_LIMIT); assert.equal(large.truncated, true); }
  assert.throws(() => parseGitStatus('not porcelain\0'), { code: 'GIT_UNAVAILABLE' });
});

test('Git RPC rejects obsolete references and disconnected clients without changing control or shell lifecycle', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, repository, data } = await fixture(t, false);
  const core = new HostCore({ dataDir: data }); await core.init(); t.after(async () => { await core.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  const ctx: ConnectionContext = { id: randomUUID(), deviceId: 'git-reader', deviceName: 'Approved browser', owner: false }; core.connect(ctx, () => {});
  const terminal: TerminalInfo = await core.handle('terminals.create', { groupId: core.getState().groups[0].id, profileId: 'cmd', cwd: repository }, ctx);
  const state = core.getState(), ref = { id: terminal.id, hostId: state.hostId, bootId: state.bootId, generation: terminal.generation, root: terminal.currentCwd || terminal.cwd };
  assert.ok(state.capabilities?.includes('git.read')); assert.equal((await core.handle('git.status', ref, ctx) as GitListing).state, 'repository');
  await assert.rejects(core.handle('git.status', { ...ref, bootId: randomUUID() }, ctx), { code: 'HOST_CHANGED' });
  await assert.rejects(core.handle('git.status', { ...ref, generation: randomUUID() }, ctx), { code: 'SESSION_CHANGED' });
  await assert.rejects(core.handle('git.status', { ...ref, root: path.dirname(repository) }, ctx), { code: 'FILES_ROOT_CHANGED' });
  await assert.rejects(core.handle('git.status', { ...ref, path: '../' }, ctx), { code: 'INVALID_REQUEST' });
  const pending = core.handle('git.status', ref, ctx); assert.ok(await core.handle('heartbeat', {}, ctx)); await pending;
  const after = core.getState().terminals[0]; assert.equal(after.pid, terminal.pid); assert.equal(after.generation, terminal.generation); assert.equal(after.controller, undefined);
  const revoked = core.handle('git.status', ref, ctx); core.disconnect(ctx.id); await assert.rejects(revoked, { code: 'NOT_CONNECTED' });
});
