import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError, GIT_COMMIT_PATTERN, GIT_DIFF_BYTES, type GitChange, type GitDiff, type GitDiffBase, type GitDiffTarget, type GitListing, type GitReview, type GitReviewFile, type GitReviewMode, type GitStatusCode } from '../protocol/index.js';
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

export async function safeMetadata(directory: string, protectedRoot: string) {
  if (!localPath(directory)) throw new AppError('GIT_UNAVAILABLE', '로컬 Git 저장소만 확인할 수 있습니다.');
  if ((await lstat(directory)).isSymbolicLink() && /^[\\/]{2}/.test(await readlink(directory))) throw new AppError('GIT_UNAVAILABLE', '로컬 Git 저장소만 확인할 수 있습니다.');
  const resolved = await realpath(directory);
  if (!localPath(resolved) || within(protectedRoot, resolved)) throw new AppError('FILES_PROTECTED', '앱의 인증·세션 데이터 폴더는 탐색할 수 없습니다.');
  return resolved;
}

export async function repositoryAt(base: string, protectedRoot: string): Promise<string | undefined> {
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

const gitFlags = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false'];
function gitOptions(base: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1' });
  return { cwd: base, env, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' as const };
}

/** Selected cwd only. No shell, network, hooks, index writes or Git mutations. */
export async function inspectGit(root: string, dataDir: string): Promise<GitListing> {
  const { base, protectedRoot } = await resolveFileRoot(root, dataDir);
  const discovered = await repositoryAt(base, protectedRoot);
  if (!discovered) return { state: 'not-repository', root, message: '이 폴더는 Git 저장소가 아닙니다.' };
  const options = gitOptions(base), flags = gitFlags;
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

/** Same encodings as the file preview: UTF-8 (optional BOM) or UTF-16 with BOM. */
export function decodeDiffText(bytes: Uint8Array): string | undefined {
  let encoding = 'utf-8', start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start));
    return /[\x00-\x08\x0e-\x1f]/.test(text) ? undefined : text;
  } catch { return undefined; }
}

type DiffSide = { text: string | null } | { unavailable: string };
const tooLarge = `${GIT_DIFF_BYTES / 1024} KiB를 넘는 파일은 비교 화면에서 열 수 없습니다. 외부 도구로 확인해 주세요.`;
const notText = '바이너리이거나 지원하지 않는 인코딩이라 비교할 수 없습니다. UTF-8 또는 BOM이 있는 UTF-16 텍스트만 비교합니다.';

/**
 * Reads both sides of one changed file for a read-only comparison.
 * Blobs come from `git cat-file` without textconv or smudge filters, so no
 * configured program runs; the working copy is read directly and bounded.
 */
export async function readGitDiff(root: string, dataDir: string, request: { path: string; originalPath?: string; base: GitDiffBase; target: GitDiffTarget }): Promise<GitDiff> {
  if ((request.base === 'INDEX' && request.target === 'INDEX') || (request.base !== 'HEAD' && request.base !== 'INDEX' && !GIT_COMMIT_PATTERN.test(request.base))) throw new AppError('INVALID_REQUEST', '비교할 두 버전을 확인해 주세요.');
  if (!validRelative(request.path) || !request.path || (request.originalPath !== undefined && !validRelative(request.originalPath))) throw new AppError('FILES_OUTSIDE_ROOT', '현재 터미널 폴더 안의 파일만 비교할 수 있습니다.');
  const { base, protectedRoot } = await resolveFileRoot(root, dataDir);
  const discovered = await repositoryAt(base, protectedRoot);
  if (!discovered) throw new AppError('GIT_UNAVAILABLE', '이 폴더는 Git 저장소가 아닙니다.');
  const options = gitOptions(base);
  const run = (args: string[]) => execute('git', [...gitFlags, ...args], options);
  try {
    const { stdout: top } = await run(['rev-parse', '--show-toplevel']);
    const repositoryRoot = await safeMetadata(top.trim(), protectedRoot);
    if (repositoryRoot !== discovered || !within(repositoryRoot, base)) throw new AppError('GIT_UNAVAILABLE', 'Git 작업 폴더가 바뀌었습니다. 새로고침해 주세요.');
    const locate = (relative: string) => {
      const target = path.resolve(base, relative);
      if (!within(base, target) || within(protectedRoot, target)) throw new AppError('FILES_OUTSIDE_ROOT', '현재 터미널 폴더 안의 파일만 비교할 수 있습니다.');
      return { target, repositoryPath: path.relative(repositoryRoot, target).split(path.sep).join('/') };
    };
    const current = locate(request.path), previous = request.originalPath ? locate(request.originalPath) : current;
    async function stored(area: GitDiffBase, location: { repositoryPath: string }): Promise<DiffSide> {
      // `<commit>:path` and `:path` are repository-relative; validRelative rules out ':' and '..'.
      const spec = `${area === 'INDEX' ? '' : area}:${location.repositoryPath}`;
      let type: string;
      try { type = (await run(['cat-file', '-t', spec])).stdout.trim(); }
      catch (error) { if (typeof (error as { code?: unknown }).code === 'number') return { text: null }; throw error; }
      if (type !== 'blob') return { unavailable: '하위 모듈처럼 파일이 아닌 항목은 비교할 수 없습니다.' };
      if (Number((await run(['cat-file', '-s', spec])).stdout.trim()) > GIT_DIFF_BYTES) return { unavailable: tooLarge };
      const { stdout } = await execute('git', [...gitFlags, 'cat-file', 'blob', spec], { ...options, encoding: 'buffer', maxBuffer: GIT_DIFF_BYTES + 1024 });
      const text = decodeDiffText(stdout);
      return text === undefined ? { unavailable: notText } : { text };
    }
    async function working(location: { target: string }): Promise<DiffSide> {
      // Git stores a symbolic link as the text of its target, so a link is compared as that text.
      try { if ((await lstat(location.target)).isSymbolicLink()) return { text: (await readlink(location.target)).split(path.sep).join('/') }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null }; throw error; }
      let real: string;
      try { real = await realpath(location.target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null }; throw error; }
      if (!localPath(real) || !within(base, real) || within(protectedRoot, real)) return { unavailable: '현재 폴더 밖을 가리키는 링크는 비교할 수 없습니다.' };
      const file = await open(real, 'r');
      try {
        const info = await file.stat();
        if (!info.isFile()) return { unavailable: '일반 파일만 비교할 수 있습니다.' };
        if (info.size > GIT_DIFF_BYTES) return { unavailable: tooLarge };
        const buffer = Buffer.alloc(GIT_DIFF_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > GIT_DIFF_BYTES) return { unavailable: tooLarge };
        const text = decodeDiffText(buffer.subarray(0, bytesRead));
        return text === undefined ? { unavailable: notText } : { text };
      } finally { await file.close(); }
    }
    const original = await stored(request.base, request.base === 'INDEX' ? current : previous);
    const modified = request.target === 'WORKTREE' ? await working(current) : await stored('INDEX', current);
    const result: GitDiff = { path: request.path, ...(request.originalPath ? { originalPath: request.originalPath } : {}), absolutePath: current.target, base: request.base, target: request.target, original: null, modified: null };
    const unavailable = 'unavailable' in original ? original.unavailable : 'unavailable' in modified ? modified.unavailable : undefined;
    if (unavailable) return { ...result, unavailable };
    return { ...result, original: (original as { text: string | null }).text, modified: (modified as { text: string | null }).text };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.code === 'EACCES' || failure.code === 'EPERM') throw new AppError('FILES_UNAVAILABLE', '이 파일을 읽을 권한이 없습니다.');
    throw new AppError('GIT_UNAVAILABLE', failure.code === 'ENOENT' ? '이 컴퓨터에서 Git을 찾지 못했습니다. Git 설치 후 다시 시도해 주세요.' : failure.killed ? 'Git 조회가 오래 걸립니다. 잠시 후 다시 시도해 주세요.' : '변경 내용을 읽지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.');
  }
}

/** Parses `git diff --name-status -z`; renames and copies carry the old path first. */
export function parseNameStatus(output: string) {
  const entries: Array<{ code: string; path: string; originalPath?: string }> = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]; if (!code) continue;
    if (/^[RC]\d*$/.test(code)) { const originalPath = tokens[++i], next = tokens[++i]; if (originalPath && next) entries.push({ code: code[0], path: next, originalPath }); }
    else { const next = tokens[++i]; if (next) entries.push({ code: code[0], path: next }); }
  }
  return entries;
}

/**
 * Lists every file that differs between a base commit and the working folder, like a pull request.
 * In branch mode the base is where HEAD left `preferredBase` (or the remote default branch);
 * otherwise, and as a fallback, it is HEAD. Only tree-to-tree diffs run here; file content is read by readGitDiff.
 */
export async function readGitReview(root: string, dataDir: string, mode: GitReviewMode, preferredBase?: (repositoryRoot: string) => string | undefined): Promise<GitReview> {
  const listing = await inspectGit(root, dataDir);
  if (listing.state !== 'repository') return listing;
  const { base, protectedRoot } = await resolveFileRoot(root, dataDir);
  const options = gitOptions(base);
  const run = async (args: string[]) => (await execute('git', [...gitFlags, ...args], options)).stdout.trim();
  const attempt = async (args: string[]) => { try { return await run(args); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error; return ''; } };
  try {
    const head = await attempt(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    let baseCommit = head || 'HEAD', baseLabel = 'HEAD', used: GitReviewMode = 'head', notice: string | undefined;
    if (mode === 'branch') {
      const preferred = preferredBase?.(listing.repositoryRoot);
      for (const reference of [...new Set([preferred, 'origin/HEAD'].filter((value): value is string => Boolean(value)))]) {
        if (!head) break;
        const commit = await attempt(['rev-parse', '--verify', '--quiet', '--end-of-options', reference + '^{commit}']);
        const fork = commit && GIT_COMMIT_PATTERN.test(commit) ? await attempt(['merge-base', head, commit]) : '';
        if (!fork || !GIT_COMMIT_PATTERN.test(fork)) continue;
        baseCommit = fork; used = 'branch';
        baseLabel = reference === 'origin/HEAD' ? (await attempt(['rev-parse', '--abbrev-ref', 'origin/HEAD'])) || reference : reference;
        break;
      }
      if (used !== 'branch') notice = head ? '비교할 기준 브랜치를 찾지 못해 커밋하지 않은 변경만 보여 줍니다.' : '아직 커밋이 없어 커밋하지 않은 변경만 보여 줍니다.';
    }
    // Each path's existence at the base and in the working folder decides its status. Paths the tree
    // diff does not name are the same at the base and at HEAD, so git status alone describes them.
    type Tree = { code: string; originalPath?: string };
    const tree = new Map<string, Tree>();
    const inside = (relative: string) => validRelative(relative) && within(base, path.resolve(base, relative)) && !within(protectedRoot, path.resolve(base, relative));
    if (used === 'branch' && baseCommit !== head) {
      // Tree-to-tree only: no working-folder reads, so no clean filters or index refresh run here.
      for (const entry of parseNameStatus(await run(['diff', '--relative', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-color', baseCommit, head]))) {
        if (!inside(entry.path) || (entry.originalPath && !inside(entry.originalPath))) continue;
        if (entry.code === 'R' && entry.originalPath) { tree.set(entry.path, { code: 'R', originalPath: entry.originalPath }); tree.set(entry.originalPath, { code: 'R-' }); }
        else tree.set(entry.path, { code: entry.code === 'C' ? 'A' : entry.code });
      }
    }
    const status = new Map(listing.changes.map(change => [change.path, change]));
    const renamedAway = new Set(listing.changes.flatMap(change => change.index === 'R' && change.originalPath ? [change.originalPath] : []));
    const inHead = (file: string) => { const change = status.get(file); return !change || (!(change.untracked && !change.index) && change.index !== 'A' && change.index !== 'R' && change.index !== 'C'); };
    const atBase = (file: string) => { const entry = tree.get(file); return entry ? entry.code !== 'A' && entry.code !== 'R' : inHead(file); };
    const inWorktree = (file: string) => {
      const change = status.get(file);
      if (change) return change.conflicted || change.untracked || (change.worktree !== 'D' && !(change.index === 'D' && !change.untracked));
      if (renamedAway.has(file)) return false;
      const entry = tree.get(file);
      return !entry || (entry.code !== 'D' && entry.code !== 'R-');
    };
    // A staged rename may continue a committed one; only a path that existed at the base can be a source.
    const source = (file: string) => {
      const change = status.get(file), staged = change?.index === 'R' && change.originalPath ? change.originalPath : undefined;
      const entry = tree.get(staged ?? file);
      return entry?.code === 'R' ? entry.originalPath : staged;
    };
    const paths = new Set([...tree.keys(), ...status.keys(), ...renamedAway]);
    const files: GitReviewFile[] = [], consumed = new Set<string>(), recheck: string[] = [];
    for (const file of paths) {
      if (status.get(file)?.conflicted) { files.push({ path: file, status: 'conflicted' }); continue; }
      if (atBase(file) || !inWorktree(file)) continue;
      const from = source(file);
      if (from && atBase(from) && !inWorktree(from)) { consumed.add(from); files.push({ path: file, originalPath: from, status: 'renamed' }); }
      else files.push({ path: file, status: 'added' });
    }
    for (const file of paths) {
      if (status.get(file)?.conflicted || consumed.has(file) || !atBase(file)) continue;
      if (!inWorktree(file)) files.push({ path: file, status: 'deleted' });
      // Changed again after the branch committed it, or staged and then edited back: it may equal the base.
      else if (status.has(file)) recheck.push(file);
      else files.push({ path: file, status: 'modified' });
    }
    const unchanged = new Set<string>();
    if (GIT_COMMIT_PATTERN.test(baseCommit)) for (let start = 0; start < recheck.length; start += 100) {
      const part = recheck.slice(start, start + 100);
      const stored = new Map<string, string>();
      // --full-tree with repository paths; --no-filters hashes the working file as is, running no filter program.
      for (const record of (await attempt(['ls-tree', '-z', '--full-tree', '--full-name', baseCommit, '--', ...part.map(file => path.relative(listing.repositoryRoot, path.resolve(base, file)).split(path.sep).join('/'))])).split('\0')) {
        const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(record);
        if (match) stored.set(match[2], match[1]);
      }
      const repositoryPath = (file: string) => path.relative(listing.repositoryRoot, path.resolve(base, file)).split(path.sep).join('/');
      // A symbolic link is stored as its target text; hash-object would hash the file it points to.
      const actual = new Map<string, string>(), regular: string[] = [];
      for (const file of part) {
        const target = path.resolve(base, file);
        const link = await lstat(target).then(info => info.isSymbolicLink() ? readlink(target) : undefined, () => undefined);
        const want = stored.get(repositoryPath(file));
        if (link === undefined) { regular.push(file); continue; }
        if (!want) continue;
        const value = Buffer.from(link.split(path.sep).join('/'));
        actual.set(file, createHash(want.length === 64 ? 'sha256' : 'sha1').update('blob ' + value.length + '\0').update(value).digest('hex'));
      }
      const hashes = regular.length ? (await attempt(['hash-object', '--no-filters', '--', ...regular])).split(/\r?\n/) : [];
      if (hashes.length === regular.length) regular.forEach((file, index) => actual.set(file, hashes[index]));
      for (const file of part) if (actual.has(file) && stored.get(repositoryPath(file)) === actual.get(file)) unchanged.add(file);
    }
    for (const file of recheck) if (!unchanged.has(file)) files.push({ path: file, status: 'modified' });
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const truncated = listing.truncated || files.length > GIT_CHANGE_LIMIT;
    return { state: 'repository', root, repositoryRoot: listing.repositoryRoot, branch: listing.branch, detached: listing.detached, mode: used, base: baseCommit, baseLabel, ...(notice ? { notice } : {}), files: files.slice(0, GIT_CHANGE_LIMIT), truncated };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    return { state: 'unavailable', root, message: failure.code === 'ENOENT' ? '이 컴퓨터에서 Git을 찾지 못했습니다. Git 설치 후 새로고침해 주세요.' : failure.killed || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git 조회가 오래 걸리거나 변경이 너무 많습니다. 잠시 후 새로고침해 주세요.' : '변경 목록을 읽지 못했습니다. 새로고침해 주세요.' };
  }
}
