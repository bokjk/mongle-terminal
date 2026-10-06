import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { AppError, PDF_CHUNK_BYTES, PDF_PREVIEW_BYTES, type PdfChunk } from '../protocol/index.js';
import { resolvePreviewTarget } from './files.js';

/** Bounded chunks share the ordinary file authorization/queue; never expose a file URL. */
export async function readPdfChunk(root: string, relative: string, dataDir: string, offset: number, expectedVersion?: string): Promise<PdfChunk> {
  const changed = () => new AppError('FILES_CONFLICT', '읽는 동안 PDF가 변경되었습니다. 디스크 파일을 다시 열어 주세요.');
  try {
    const { target, candidate } = await resolvePreviewTarget(root, relative, dataDir);
    if (!/\.pdf$/i.test(relative)) throw new AppError('FILES_NOT_PDF', 'PDF 파일만 열 수 있습니다.');
    if (!Number.isInteger(offset) || offset < 0 || offset % PDF_CHUNK_BYTES !== 0 || (offset > 0 && !expectedVersion)) throw new AppError('INVALID_REQUEST', 'PDF 읽기 범위를 확인해 주세요.');
    const before = await stat(target);
    if (!before.isFile()) throw new AppError('FILES_NOT_PDF', '일반 PDF 파일만 열 수 있습니다.');
    const file = await open(target, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || before.dev !== info.dev || before.ino !== info.ino) throw changed();
      if (info.size > PDF_PREVIEW_BYTES) throw new AppError('FILES_TOO_LARGE', 'PDF 미리보기는 8 MiB 이하 파일을 지원합니다.');
      const revision = (s: typeof info) => createHash('sha256').update(JSON.stringify([target, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs])).digest('hex');
      const version = revision(info);
      if (expectedVersion && expectedVersion !== version) throw changed();
      const header = Buffer.alloc(1024);
      const signature = await file.read(header, 0, header.length, 0);
      if (!header.subarray(0, signature.bytesRead).includes(Buffer.from('%PDF-'))) throw new AppError('FILES_NOT_PDF', '올바른 PDF 파일이 아닙니다.');
      if (offset >= info.size) throw new AppError('INVALID_REQUEST', 'PDF 읽기 범위를 벗어났습니다.');
      const bytes = Buffer.alloc(Math.min(PDF_CHUNK_BYTES, info.size - offset));
      let read = 0;
      while (read < bytes.length) {
        const part = await file.read(bytes, read, bytes.length - read, offset + read);
        if (!part.bytesRead) throw changed();
        read += part.bytesRead;
      }
      if (revision(await file.stat()) !== version) throw changed();
      return { path: relative, absolutePath: candidate, size: info.size, offset, version, contentBase64: bytes.toString('base64') };
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('FILES_UNAVAILABLE', 'PDF를 읽지 못했습니다. 파일 경로와 읽기 권한을 확인해 주세요.');
  }
}
