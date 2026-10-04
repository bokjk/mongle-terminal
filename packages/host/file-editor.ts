import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError, FILE_EDIT_BYTES, type FileDocument } from '../protocol/index.js';
import { inspectFiles, localPath, resolveFileRoot, within } from './files.js';

const writes = new Map<string, Promise<unknown>>();
const conflict = () => new AppError('FILES_CONFLICT', '다른 프로그램에서 파일을 변경했습니다. 내 수정 내용을 복사한 뒤 디스크 파일을 다시 열어 비교해 주세요.');
const fail = (error: unknown): never => {
  if (error instanceof AppError) throw error;
  throw new AppError('FILES_UNAVAILABLE', '파일을 열거나 저장하지 못했습니다. 경로와 쓰기 권한을 확인해 주세요.');
};

async function targetForEdit(root: string, relative: string, dataDir: string) {
  if (!relative || relative.length > 4096 || /[\x00-\x1f:]/.test(relative) || path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new AppError('FILES_OUTSIDE_ROOT', '현재 폴더 안의 일반 파일만 편집할 수 있습니다.');
  const { base, protectedRoot } = await resolveFileRoot(root, dataDir);
  let candidate = base;
  for (const part of relative.split(/[\\/]/).filter(Boolean)) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new AppError('FILES_READ_ONLY', '링크를 거치는 파일은 읽기 전용입니다.');
  }
  const target = await realpath(candidate);
  if (!localPath(target) || !within(base, target)) throw new AppError('FILES_OUTSIDE_ROOT', '현재 폴더 밖의 파일은 저장할 수 없습니다.');
  if (within(protectedRoot, target)) throw new AppError('FILES_PROTECTED', '앱의 인증·세션 데이터는 편집할 수 없습니다.');
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1) throw new AppError('FILES_READ_ONLY', '일반 파일만 편집할 수 있으며 하드 링크는 읽기 전용입니다.');
  if (!(info.mode & 0o222)) throw new AppError('FILES_READ_ONLY', '읽기 전용 파일입니다.');
  return { target, info };
}

async function readDocument(root: string, relative: string, dataDir: string) {
  const resolved = await targetForEdit(root, relative, dataDir);
  const file = await open(resolved.target, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== resolved.info.dev || info.ino !== resolved.info.ino) throw conflict();
    if (info.size > FILE_EDIT_BYTES) throw new AppError('FILES_TOO_LARGE', '64 KiB를 넘는 파일은 읽기 전용입니다.');
    const buffer = Buffer.alloc(FILE_EDIT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_EDIT_BYTES) throw new AppError('FILES_TOO_LARGE', '64 KiB를 넘는 파일은 읽기 전용입니다.');
    const bytes = buffer.subarray(0, bytesRead);
    let encoding: FileDocument['encoding'] = 'UTF-8', bom = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'UTF-16LE'; bom = 2; }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'UTF-16BE'; bom = 2; }
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom = 3;
    let text: string;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(bom)); }
    catch { throw new AppError('FILES_NOT_TEXT', 'UTF-8 또는 BOM이 있는 UTF-16 텍스트만 편집할 수 있습니다.'); }
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new AppError('FILES_NOT_TEXT', '바이너리 파일은 편집할 수 없습니다.');
    if (Buffer.byteLength(text, 'utf8') > FILE_EDIT_BYTES) throw new AppError('FILES_TOO_LARGE', 'UTF-8 기준 64 KiB를 넘는 내용은 읽기 전용입니다.');
    const after = await file.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || bytesRead !== after.size) throw conflict();
    const version = createHash('sha256').update(`${info.dev}:${info.ino}:`).update(bytes).digest('hex');
    return { ...resolved, bytes, bom, document: { path: relative, absolutePath: resolved.target, text, encoding, truncated: false, version } satisfies FileDocument };
  } finally { await file.close(); }
}

export async function openFileDocument(root: string, relative: string, dataDir: string): Promise<FileDocument> {
  try { return (await readDocument(root, relative, dataDir)).document; }
  catch (error) {
    if (error instanceof AppError && ['FILES_TOO_LARGE', 'FILES_READ_ONLY'].includes(error.code)) {
      const preview = await inspectFiles(root, relative, dataDir, true) as FileDocument;
      return { ...preview, readOnlyReason: error.message };
    }
    return fail(error);
  }
}

/** Stage a complete replacement, recheck content and authorization, then commit. */
export async function saveFileDocument(root: string, relative: string, dataDir: string, version: string, contentBase64: string, check: () => void): Promise<FileDocument> {
  let resolved: Awaited<ReturnType<typeof targetForEdit>>;
  try { check(); resolved = await targetForEdit(root, relative, dataDir); } catch (error) { return fail(error); }
  const key = process.platform === 'win32' ? resolved.target.toLowerCase() : resolved.target;
  const previous = writes.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    let temporary: string | undefined;
    try {
      check();
      const current = await readDocument(root, relative, dataDir);
      if (current.document.version !== version) throw conflict();
      const utf8 = Buffer.from(contentBase64, 'base64');
      if (utf8.toString('base64') !== contentBase64 || utf8.length > FILE_EDIT_BYTES) throw new AppError('FILES_TOO_LARGE', '저장할 내용은 UTF-8 기준 64 KiB 이하여야 합니다.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(utf8); }
      catch { throw new AppError('FILES_NOT_TEXT', '올바른 UTF-8 텍스트만 저장할 수 있습니다.'); }
      if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new AppError('FILES_NOT_TEXT', '바이너리 제어문자는 저장할 수 없습니다.');
      let bytes = current.document.encoding === 'UTF-8' ? utf8 : Buffer.from(text, 'utf16le');
      if (current.document.encoding === 'UTF-16BE') bytes.swap16();
      if (current.bom) bytes = Buffer.concat([current.bytes.subarray(0, current.bom), bytes]);
      if (bytes.length > FILE_EDIT_BYTES) throw new AppError('FILES_TOO_LARGE', '원래 인코딩으로 저장한 파일은 64 KiB 이하여야 합니다.');
      temporary = path.join(path.dirname(current.target), `.mongle-save-${randomUUID()}.tmp`);
      const staged = await open(temporary, 'wx', current.info.mode & 0o777);
      try { await staged.writeFile(bytes); await staged.sync(); } finally { await staged.close(); }
      const latest = await readDocument(root, relative, dataDir);
      if (latest.target !== current.target || latest.document.version !== version) throw conflict();
      check();
      await rename(temporary, current.target);
      temporary = undefined;
      // Return the committed revision. A subsequent external change is detected by the next save.
      const committed = await readDocument(root, relative, dataDir);
      if (!committed.bytes.equals(bytes)) throw conflict();
      return committed.document;
    } catch (error) { return fail(error); }
    finally { if (temporary) await unlink(temporary).catch(() => {}); }
  });
  writes.set(key, task);
  try { return await task; } finally { if (writes.get(key) === task) writes.delete(key); }
}
