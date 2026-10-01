import { open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, type DirectoryListing, type FilePreview } from '../protocol/index.js';

export const FILE_PREVIEW_BYTES = 64 * 1024;
export const DIRECTORY_LIMIT = 500;
export function within(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function localPath(value: string) {
  // Do not initiate network logins or open Windows device namespaces.
  return path.isAbsolute(value) && !/^[\\/]{2}/.test(value) && !value.includes('\0');
}

export async function resolveFileRoot(root: string, dataDir: string) {
  if (!localPath(root)) throw new AppError('FILES_UNSUPPORTED', '이 셸의 경로는 파일 탐색기에서 열 수 없습니다. 로컬 Windows 폴더를 선택해 주세요.');
  const [base, protectedRoot] = await Promise.all([realpath(root), realpath(dataDir)]);
  if (!localPath(base)) throw new AppError('FILES_UNSUPPORTED', '로컬 폴더만 탐색할 수 있습니다.');
  if (!(await stat(base)).isDirectory()) throw new AppError('FILES_UNAVAILABLE', '터미널의 폴더를 찾을 수 없습니다.');
  if (within(protectedRoot, base)) throw new AppError('FILES_PROTECTED', '앱의 인증·세션 데이터 폴더는 탐색할 수 없습니다.');
  return { base, protectedRoot };
}
function failure(error: unknown): never {
  if (error instanceof AppError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  throw new AppError('FILES_UNAVAILABLE', code === 'EACCES' || code === 'EPERM' ? '이 항목을 읽을 권한이 없습니다.' : '파일이나 폴더를 읽지 못했습니다. 새로고침해 주세요.');
}

/** Read-only, bounded local filesystem access below the selected terminal cwd. */
export async function inspectFiles(root: string, relative: string, dataDir: string, preview: boolean): Promise<DirectoryListing | FilePreview> {
  try {
    if (!localPath(root)) throw new AppError('FILES_UNSUPPORTED', '이 셸의 경로는 파일 탐색기에서 열 수 없습니다. 로컬 Windows 폴더를 선택해 주세요.');
    if (relative.length > 4096 || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new AppError('FILES_OUTSIDE_ROOT', '현재 터미널 폴더 안의 항목만 열 수 있습니다.');
    const { base, protectedRoot } = await resolveFileRoot(root, dataDir);
    const candidate = path.resolve(base, relative);
    if (!within(base, candidate)) throw new AppError('FILES_OUTSIDE_ROOT', '현재 터미널 폴더 안의 항목만 열 수 있습니다.');
    const target = await realpath(candidate);
    if (!localPath(target) || !within(base, target)) throw new AppError('FILES_OUTSIDE_ROOT', '폴더 밖을 가리키는 링크는 열 수 없습니다.');
    if (within(protectedRoot, target)) throw new AppError('FILES_PROTECTED', '앱의 인증·세션 데이터 폴더는 탐색할 수 없습니다.');
    if (!preview) {
      const entries: DirectoryListing['entries'] = [];
      let truncated = false;
      const directory = await opendir(target);
      for await (const entry of directory) {
        if (within(protectedRoot, path.join(target, entry.name))) continue;
        if (entries.length >= DIRECTORY_LIMIT) { truncated = true; break; }
        entries.push({ name: entry.name, path: path.join(relative, entry.name), kind: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' });
      }
      entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'ko', { numeric: true }));
      return { root, path: relative, absolutePath: candidate, entries, truncated };
    }
    // Refuse devices/FIFOs before opening; never read an unbounded file.
    if (!(await stat(target)).isFile()) throw new AppError('FILES_NOT_TEXT', '일반 텍스트 파일만 미리 볼 수 있습니다.');
    const file = await open(target, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new AppError('FILES_NOT_TEXT', '일반 텍스트 파일만 미리 볼 수 있습니다.');
      const buffer = Buffer.alloc(FILE_PREVIEW_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > FILE_PREVIEW_BYTES || info.size > FILE_PREVIEW_BYTES;
      let bytes = buffer.subarray(0, Math.min(bytesRead, FILE_PREVIEW_BYTES));
      let encoding: FilePreview['encoding'] = 'UTF-8';
      if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'UTF-16LE'; bytes = bytes.subarray(2); }
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'UTF-16BE'; bytes = bytes.subarray(2); }
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated }); }
      catch { throw new AppError('FILES_NOT_TEXT', '미리보기는 UTF-8 또는 BOM이 있는 UTF-16 텍스트만 지원합니다.'); }
      if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new AppError('FILES_NOT_TEXT', '바이너리 파일은 미리 볼 수 없습니다.');
      return { path: relative, absolutePath: candidate, text, truncated, encoding };
    } finally { await file.close(); }
  } catch (error) { failure(error); }
}
