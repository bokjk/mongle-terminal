import type { ShellProfile } from '../../../packages/protocol/index';

/** Matches the host (packages/host/uploads.ts): a photo or a log, not a disk image. */
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
export type UploadTarget = { id: string; hostId: string; bootId: string; generation: string; root: string };
type Requester = { request<T = unknown>(method: string, params?: unknown): Promise<T> };

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * Sends one file to the terminal's PC in chunks and answers its saved path. A failure or an
 * abort cancels the upload, so the host removes the unfinished file.
 */
export async function uploadToTerminal(client: Requester, target: UploadTarget, file: Blob & { name: string }, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<{ path: string; name: string }> {
  if (file.size === 0) throw new Error('빈 파일은 보낼 수 없습니다.');
  if (file.size > UPLOAD_LIMIT_BYTES) throw new Error('10 MiB 이하 파일만 보낼 수 있습니다.');
  const begun = await client.request<{ uploadId: string; chunkBytes: number }>('files.upload.begin', { ...target, name: file.name || 'file', size: file.size });
  const reference = { hostId: target.hostId, bootId: target.bootId, uploadId: begun.uploadId };
  try {
    for (let offset = 0; offset < file.size; offset += begun.chunkBytes) {
      if (signal?.aborted) throw new DOMException('취소했습니다.', 'AbortError');
      const bytes = new Uint8Array(await file.slice(offset, offset + begun.chunkBytes).arrayBuffer());
      await client.request('files.upload.chunk', { ...reference, offset, dataBase64: base64(bytes) });
      onProgress?.(Math.min(file.size, offset + bytes.length), file.size);
    }
    if (signal?.aborted) throw new DOMException('취소했습니다.', 'AbortError');
    const saved = await client.request<{ path: string; name: string }>('files.upload.finish', reference);
    // Cancelled while the PC was finishing: the file exists, but nothing may be typed for it.
    if (signal?.aborted) throw Object.assign(new DOMException('취소했습니다.', 'AbortError'), { saved });
    return saved;
  } catch (error) {
    void client.request('files.upload.cancel', reference).catch(() => {});
    throw error;
  }
}

/**
 * A Windows path as text for the terminal's input line, read the way that shell reads it. Saved names
 * have no spaces or quotes, so a plain path is left bare (agents and shells both read it as is).
 */
export function pathForShell(path: string, kind: ShellProfile['kind'] | undefined): string {
  if (kind === 'wsl') {
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
    const unix = drive ? '/mnt/' + drive[1]!.toLowerCase() + '/' + drive[2]!.replaceAll('\\', '/') : path.replaceAll('\\', '/');
    return /^[\w@%+=:,./-]+$/.test(unix) ? unix : "'" + unix.replaceAll("'", "'\\''") + "'";
  }
  // Bash reads a backslash as an escape, so a Windows path always needs single quotes there.
  if (kind === 'bash') return "'" + path.replaceAll("'", "'\\''") + "'";
  if (/^[\p{L}\p{N}_:\\./-]+$/u.test(path)) return path;
  if (kind === 'cmd') return '"' + path + '"';
  return "'" + path.replaceAll("'", "''") + "'";
}
