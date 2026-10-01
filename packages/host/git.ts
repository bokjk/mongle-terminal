import { execFile } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError, type GitChange, type GitListing, type GitStatusCode } from '../protocol/index.js';
import { localPath, resolveFileRoot, within } from './files.js';

const execute = promisify(execFile);
export const GIT_CHANGE_LIMIT = 1000;
const codes = new Set(['', 'M', 'A', 'D', 'R', 'C', 'T']);
function code(value: string): GitStatusCode {
  const result = value === '.' ? '' : value;
  if (!codes.has(result)) throw new AppError('GIT_UNAVAILABLE', 'Git 상태 형식을 읽지 못했습니다.');
  return result as GitStatusCode;
}

/** Porcelain v2 -z keeps spaces, Unicode and renames unambiguous. */
export function parseGitStatus(output: string) {
  const changes: GitChange[] = [];
  let branch = '', detached = false;
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# branch.head ')) { branch = record.slice(14); detached = branch === '(detached)'; continue; }
    if (record.startsWith('#')) continue;
    if (record.startsWith('? ')) { changes.push({ path: record.slice(2), index: '', worktree: '', untracked: true, conflicted: false }); continue; }
    // Field counts differ by record type; slice at exactly that many separators,
    // rather than splitting the pathname (which can itself contain spaces).
    const type = record[0], separators = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 0;
    if (!/^[12u] [A-Z.]{2} /.test(record) || !separators) throw new AppError('GIT_UNAVAILABLE', 'Git 상태 형식을 읽지 못했습니다.');
    let offset = 0;
    for (let n = 0; n < separators; n++) { offset = record.indexOf(' ', offset) + 1; if (!offset) throw new AppError('GIT_UNAVAILABLE', 'Git 상태 형식을 읽지 못했습니다.'); }
    const conflicted = type === 'u';
    const originalPath = type === '2' ? records[++i] : undefined;
    if (type === '2' && !originalPath) throw new AppError('GIT_UNAVAILABLE', 'Git 이름 변경 정보를 읽지 못했습니다.');
    changes.push({ path: record.slice(offset), ...(originalPath ? { originalPath } : {}), index: conflicted ? '' : code(record[2]), worktree: conflicted ? '' : code(record[3]), untracked: false, conflicted });
  }
  return { branch, detached, changes };
}

async function safeMetadata(directory: string, protectedRoot: string) {
  if (!localPath(directory)) throw new AppError('GIT_UNAVAILABLE', '로컬 Git 저장소만 확인할 수 있습니다.');
  if ((await lstat(directory)).isSymbolicLink() && /^[\\/]{2}/.test(await readlink(directory))) throw new AppError('GIT_UNAVAILABLE', '로컬 Git 저장소만 확인할 수 있습니다.');
  const resolved = await realpath(directory);
  if (!localPath(resolved) || within(protectedRoot, resolved)) throw new AppError('FILES_PROTECTED', '앱의 인증·세션 데이터 폴더는 탐색할 수 없습니다.');
  return resolved;
}

async function repositoryAt(base: string, protectedRoot: string): Promise<string | undefined> {
  for (let current = base;; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    try {
      const info = await lstat(marker);
      let metadata: string;
      if (info.isDirectory() || info.isSymbolicLink()) metadata = await safeMetadata(marker, protectedRoot);
      else {
        if (!info.isFile() || info.size > 4096) throw new AppError('GIT_UNAVAILABLE', 'Git 저장소 연결 정보를 읽지 못했습니다.');
        const pointer = /^gitdir: (.+)\r?\n?$/.exec(await readFile(marker, 'utf8'))?.[1]?.trim();
        if (!pointer || /^[\\/]{2}/.test(pointer) || pointer.includes('\0')) throw new AppError('GIT_UNAVAILABLE', '로컬 Git 저장소만 확인할 수 있습니다.');
        metadata = await safeMetadata(path.resolve(current, pointer), protectedRoot);
      }
      try {
        const common = path.join(metadata, 'commondir'), stat = await lstat(common);
        if (!stat.isFile() || stat.size > 4096) throw new AppError('GIT_UNAVAILABLE', 'Git 저장소 연결 정보를 읽지 못했습니다.');
        const pointer = (await readFile(common, 'utf8')).trim();
        if (!pointer || /^[\\/]{2}/.test(pointer) || pointer.includes('\0')) throw new AppError('GIT_UNAVAILABLE', '로컬 Git 저장소만 확인할 수 있습니다.');
        await safeMetadata(path.resolve(metadata, pointer), protectedRoot);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return current;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) return undefined;
  }
}

function validRelative(value: string) {
  return value.length <= 4096 && !/[\x00-\x1f:]/.test(value) && !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '..');
}

/** Selected cwd only. No shell, network, hooks, index writes or Git mutations. */
export async function inspectGit(root: string, dataDir: string): Promise<GitListing> {
  const { base, protectedRoot } = await resolveFileRoot(root, dataDir);
  const discovered = await repositoryAt(base, protectedRoot);
  if (!discovered) return { state: 'not-repository', root, message: '이 폴더는 Git 저장소가 아닙니다.' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1' });
  const options = { cwd: base, env, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const };
  const flags = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false'];
  try {
    const { stdout: top } = await execute('git', [...flags, 'rev-parse', '--show-toplevel'], options);
    const repositoryRoot = await safeMetadata(top.trim(), protectedRoot);
    if (repositoryRoot !== discovered || !within(repositoryRoot, base)) throw new AppError('GIT_UNAVAILABLE', 'Git 작업 폴더가 바뀌었습니다. 새로고침해 주세요.');
    const { stdout } = await execute('git', [...flags, 'status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--untracked-files=all', '--ignored=no', '--ignore-submodules=dirty', '--renames', '--', '.'], options);
    const parsed = parseGitStatus(stdout), changes: GitChange[] = [];
    const byPath = new Map<string, GitChange>();
    const parents = new Map<string, Promise<string | undefined>>();
    const parentOf = (directory: string): Promise<string | undefined> => {
      if (!parents.has(directory)) parents.set(directory, realpath(directory).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' && within(base, path.dirname(directory)) ? parentOf(path.dirname(directory)) : undefined));
      return parents.get(directory)!;
    };
    for (const change of parsed.changes) {
      if (!validRelative(change.path)) continue;
      const target = path.resolve(repositoryRoot, change.path);
      if (!within(base, target) || within(protectedRoot, target)) continue;
      const parent = await parentOf(path.dirname(target));
      if (!parent || !within(base, parent) || within(protectedRoot, parent)) continue;
      const relative = path.relative(base, target).split(path.sep).join('/');
      const original = change.originalPath && validRelative(change.originalPath) ? path.resolve(repositoryRoot, change.originalPath) : undefined;
      const next = { ...change, path: relative, originalPath: original && within(base, original) && !within(protectedRoot, original) ? path.relative(base, original).split(path.sep).join('/') : undefined };
      // A staged deletion and its recreated untracked file are separate Git
      // records for the same path. Keep both states, but count the file once.
      const previous = byPath.get(relative);
      if (previous) Object.assign(previous, { index: previous.index || next.index, worktree: previous.worktree || next.worktree, untracked: previous.untracked || next.untracked, conflicted: previous.conflicted || next.conflicted, originalPath: previous.originalPath || next.originalPath });
      else { byPath.set(relative, next); changes.push(next); }
      if (changes.length > GIT_CHANGE_LIMIT) break;
    }
    return { state: 'repository', root, repositoryRoot, branch: parsed.branch, detached: parsed.detached, changes: changes.slice(0, GIT_CHANGE_LIMIT), truncated: changes.length > GIT_CHANGE_LIMIT };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return { state: 'unavailable', root, message: failure.code === 'ENOENT' ? '이 컴퓨터에서 Git을 찾지 못했습니다. Git 설치 후 새로고침해 주세요.' : failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git 조회가 오래 걸리거나 변경이 너무 많습니다. 잠시 후 새로고침해 주세요.' : 'Git 상태를 읽지 못했습니다. 저장소 권한을 확인하고 새로고침해 주세요.' };
  }
}
