import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { TeamScopeFolder } from '../protocol/index.js';
import { resolveFileRoot } from './files.js';
import { repositoryAt } from './git.js';
import { TEAM_BRANCH } from './teams.js';
import { git, parseWorktreeList, samePath } from './worktrees.js';

/** One record per changed path; renames are reported as a deletion and an addition. */
const statusEntries = (output: string) => output.split('\0').filter(Boolean);

/**
 * A folder offered for a team's scope: the top of the Git working tree that holds it, with its branch
 * (undefined when HEAD is detached) and uncommitted changes, or the folder itself when it is not in Git.
 */
export async function scopeFolder(directory: string, dataDir: string): Promise<TeamScopeFolder> {
  const { base, protectedRoot } = await resolveFileRoot(directory, dataDir);
  const root = await repositoryAt(base, protectedRoot).catch(() => undefined);
  if (!root) return { path: base, name: path.basename(base) || base, git: false };
  const [branch, status, repository] = await Promise.all([
    git(root, ['branch', '--show-current']).then(value => value.trim()),
    git(root, ['status', '--porcelain=v1', '-z', '--no-renames']),
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(value => path.resolve(value.trim())),
  ]);
  return { path: root, name: path.basename(root) || root, git: true, ...(branch ? { branch } : {}), changes: statusEntries(status).length, repository };
}

export interface BranchPlan {
  /** The branch checked out now; undefined when HEAD is detached. */
  current?: string;
  /** stay: already on it; switch: a local branch; track: a new local branch from the one remote that has it; create: a new branch from HEAD. */
  action: 'stay' | 'switch' | 'track' | 'create';
  remote?: string;
  changes: number;
  /** Why Git would refuse; the team does not start then. */
  problem?: string;
}

async function exists(file: string) { try { await lstat(file); return true; } catch { return false; } }

/** What aligning a working tree to `branch` would do, and whether Git would refuse it. Reads only. */
export async function branchPlan(root: string, branch: string): Promise<BranchPlan> {
  const [current, locals, remotes, status, worktrees, hasCommit, statePaths] = await Promise.all([
    git(root, ['branch', '--show-current']).then(value => value.trim() || undefined),
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/' + branch]).then(value => value.split(/\r?\n/)),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']).then(value => value.split(/\r?\n/).filter(name => name.endsWith('/' + branch) && name.split('/').length === branch.split('/').length + 1)),
    git(root, ['status', '--porcelain=v1', '-z', '--no-renames']).then(statusEntries),
    git(root, ['worktree', 'list', '--porcelain', '-z']).then(parseWorktreeList),
    git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(() => true, () => false),
    git(root, ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD']).then(value => value.split(/\r?\n/).filter(Boolean)),
  ]);
  const local = locals.includes('refs/heads/' + branch);
  const action: BranchPlan['action'] = current === branch ? 'stay' : local ? 'switch' : remotes.length === 1 ? 'track' : 'create';
  const plan: BranchPlan = { ...(current ? { current } : {}), action, ...(action === 'track' ? { remote: remotes[0] } : {}), changes: status.length };
  if (action === 'stay') return plan;
  if (!hasCommit) return { ...plan, problem: '아직 커밋이 없어 브랜치를 만들 수 없습니다. 첫 커밋을 만든 뒤 다시 확인해 주세요.' };
  if ((await Promise.all(statePaths.map(item => exists(path.resolve(root, item))))).some(Boolean)) return { ...plan, problem: '병합이나 리베이스 같은 Git 작업이 진행 중이라 브랜치를 바꿀 수 없습니다. 끝내거나 취소한 뒤 다시 확인해 주세요.' };
  const elsewhere = worktrees.find(item => item.branch === branch && !samePath(item.path, root));
  if (elsewhere) return { ...plan, problem: '이 브랜치는 다른 작업 폴더(' + elsewhere.path + ')에서 쓰고 있어 여기서 바꿀 수 없습니다.' };
  if (action !== 'create') {
    // Git refuses to switch when a tracked file with local changes differs between HEAD and the target.
    const changed = new Set(status.filter(entry => !entry.startsWith('??')).map(entry => entry.slice(3)));
    if (changed.size) {
      const target = action === 'switch' ? 'refs/heads/' + branch : 'refs/remotes/' + plan.remote;
      const overlap = (await git(root, ['diff', '--name-only', '-z', 'HEAD', target, '--'])).split('\0').filter(file => changed.has(file));
      if (overlap.length) return { ...plan, problem: '저장하지 않은 변경이 이 브랜치와 겹치는 파일 ' + overlap.length + '개(' + overlap.slice(0, 2).join(', ') + (overlap.length > 2 ? ' 등' : '') + ')가 있어 바꿀 수 없습니다. 커밋하거나 stash한 뒤 다시 확인해 주세요.' };
    }
  }
  return plan;
}

/** Git's own check of a branch name, beyond the characters TEAM_BRANCH already refuses. */
export async function validBranchName(root: string, branch: string) {
  return TEAM_BRANCH.test(branch) && await git(root, ['check-ref-format', '--branch', branch]).then(() => true, () => false);
}

/** Puts a working tree on the planned branch; Git carries uncommitted changes along. */
export async function alignBranch(root: string, branch: string, plan: BranchPlan) {
  if (plan.action === 'stay') return;
  const args = plan.action === 'switch' ? ['switch', '--no-guess', branch] : plan.action === 'track' ? ['switch', '-c', branch, '--track', plan.remote!] : ['switch', '-c', branch];
  await git(root, args, true);
}
