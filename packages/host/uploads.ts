import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../protocol/index.js';
import { resolveFileRoot, within } from './files.js';
import { repositoryAt, safeMetadata } from './git.js';

/**
 * Files a phone or browser sends to a terminal's PC, so an agent there can read them by path.
 * The connection's message limit is far below a photo, so a file arrives in numbered chunks:
 * begin → chunk… → finish. Until it is complete it is a hidden .part file; an abandoned one is removed.
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 48 * 1024;
export const ATTACHMENT_FOLDER = '.mongle-attachments';
const IDLE_MS = 120_000;
const STALE_PART_MS = 10 * 60_000;
const PER_CONNECTION = 2;
const TOTAL = 8;

/** A safe, unique name that still says what the file was: 20261012-153000-1a2b3c4d-screenshot.png */
export function attachmentName(original: string, now = new Date(), unique = randomUUID().slice(0, 8)): string {
  const clean = original.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '');
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  let base = (dot > 0 ? clean.slice(0, dot) : clean).replace(/[._]+$/, '').slice(0, 60) || 'file';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(base)) base = '_' + base;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return stamp + '-' + unique + '-' + base + (/^[a-z0-9]{1,10}$/.test(extension) ? '.' + extension : '');
}

/** Where a terminal folder's attachments go: a real folder inside it, never a link out of it. */
export async function attachmentDirectory(base: string, protectedRoot: string): Promise<string> {
  const directory = path.join(base, ATTACHMENT_FOLDER);
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('UPLOAD_FOLDER', ATTACHMENT_FOLDER + ' 이름의 파일이나 링크가 있어 첨부를 저장할 수 없습니다.');
  const real = await realpath(directory);
  if (!within(base, real) || within(protectedRoot, real)) throw new AppError('UPLOAD_FOLDER', '첨부를 저장할 폴더가 터미널 폴더 밖에 있습니다.');
  return real;
}

/**
 * Keeps attachments out of Git in the repository the folder belongs to, so an agent's "git add -A" does
 * not commit a phone screenshot. Only the repository's local exclude file (never committed) gets one line,
 * once. The repository is found by reading .git as the Git view does, without running Git.
 */
export async function excludeFromGit(base: string, protectedRoot: string): Promise<string | undefined> {
  const repository = await repositoryAt(base, protectedRoot).catch(() => undefined);
  if (!repository) return undefined;
  const marker = path.join(repository, '.git');
  const info = await lstat(marker);
  let metadata: string;
  if (info.isFile()) {
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(await readFile(marker, 'utf8'))?.[1]?.trim();
    if (!pointer) return undefined;
    metadata = await safeMetadata(path.resolve(repository, pointer), protectedRoot);
  } else metadata = await safeMetadata(marker, protectedRoot);
  const common = await readFile(path.join(metadata, 'commondir'), 'utf8').then(pointer => safeMetadata(path.resolve(metadata, pointer.trim()), protectedRoot), () => metadata);
  const exclude = path.join(common, 'info', 'exclude');
  const current = await readFile(exclude, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
  if (current.split(/\r?\n/).some(line => /^\/?\.mongle-attachments\/?$/.test(line.trim()))) return exclude;
  await mkdir(path.dirname(exclude), { recursive: true });
  await appendFile(exclude, (current && !current.endsWith('\n') ? '\n' : '') + '# Mongle Terminal attachments\n' + ATTACHMENT_FOLDER + '/\n');
  return exclude;
}

type Upload = { owner: string; directory: string; part: string; name: string; size: number; received: number; handle: FileHandle; busy: boolean; timer: ReturnType<typeof setTimeout> };

export class Uploads {
  private uploads = new Map<string, Upload>();
  constructor(private readonly dataDir: string, private readonly idleMs = IDLE_MS) {}

  async begin(owner: string, root: string, originalName: string, size: number): Promise<{ uploadId: string; chunkBytes: number; name: string }> {
    if (!Number.isSafeInteger(size) || size < 1) throw new AppError('UPLOAD_EMPTY', '빈 파일은 보낼 수 없습니다.');
    if (size > UPLOAD_MAX_BYTES) throw new AppError('UPLOAD_TOO_LARGE', '10 MiB 이하 파일만 보낼 수 있습니다.');
    if ([...this.uploads.values()].filter(item => item.owner === owner).length >= PER_CONNECTION || this.uploads.size >= TOTAL) throw new AppError('UPLOAD_BUSY', '다른 파일을 보내는 중입니다. 잠시 후 다시 시도해 주세요.');
    const { base, protectedRoot } = await resolveFileRoot(root, this.dataDir);
    const directory = await attachmentDirectory(base, protectedRoot);
    // Best effort: a repository Git cannot describe must not stop the file from arriving.
    await excludeFromGit(base, protectedRoot).catch(() => undefined);
    await removeStaleParts(directory);
    const uploadId = randomUUID(), part = path.join(directory, '.' + uploadId + '.part');
    const handle = await open(part, 'wx', 0o600);
    const upload: Upload = { owner, directory, part, name: attachmentName(originalName), size, received: 0, handle, busy: false, timer: setTimeout(() => void this.discard(uploadId), this.idleMs) };
    this.uploads.set(uploadId, upload);
    return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES, name: upload.name };
  }

  async chunk(owner: string, uploadId: string, offset: number, data: Buffer): Promise<{ received: number }> {
    const upload = this.own(owner, uploadId);
    if (upload.busy) throw new AppError('UPLOAD_BUSY', '이전 조각을 저장하는 중입니다.');
    if (offset !== upload.received || data.length === 0 || data.length > UPLOAD_CHUNK_BYTES || upload.received + data.length > upload.size) throw new AppError('UPLOAD_OFFSET', '파일 조각의 순서가 맞지 않습니다. 다시 보내 주세요.');
    upload.busy = true;
    try {
      await upload.handle.write(data, 0, data.length, offset);
      upload.received += data.length;
      this.touch(uploadId, upload);
      return { received: upload.received };
    } finally { upload.busy = false; }
  }

  async finish(owner: string, uploadId: string): Promise<{ path: string; name: string }> {
    const upload = this.own(owner, uploadId);
    if (upload.busy || upload.received !== upload.size) throw new AppError('UPLOAD_INCOMPLETE', '파일을 아직 다 받지 못했습니다.');
    this.uploads.delete(uploadId); clearTimeout(upload.timer);
    const target = path.join(upload.directory, upload.name);
    try {
      await upload.handle.close();
      // The name is unique already; never replace a file that is somehow there.
      if (await stat(target).then(() => true, () => false)) throw new AppError('UPLOAD_EXISTS', '같은 이름의 파일이 있습니다. 다시 보내 주세요.');
      await rename(upload.part, target);
    } catch (error) { await unlink(upload.part).catch(() => {}); throw error; }
    return { path: target, name: upload.name };
  }

  async cancel(owner: string, uploadId: string): Promise<void> { this.own(owner, uploadId); await this.discard(uploadId); }
  /** A connection that closed takes its unfinished uploads with it. */
  async dropOwner(owner: string): Promise<void> { await Promise.all([...this.uploads].filter(([, item]) => item.owner === owner).map(([id]) => this.discard(id))); }
  async close(): Promise<void> { await Promise.all([...this.uploads.keys()].map(id => this.discard(id))); }
  get active(): number { return this.uploads.size; }

  private own(owner: string, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.owner !== owner) throw new AppError('UPLOAD_EXPIRED', '파일 보내기가 중단되었습니다. 다시 보내 주세요.');
    return upload;
  }
  private touch(uploadId: string, upload: Upload) { clearTimeout(upload.timer); upload.timer = setTimeout(() => void this.discard(uploadId), this.idleMs); }
  private async discard(uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    this.uploads.delete(uploadId); clearTimeout(upload.timer);
    await upload.handle.close().catch(() => {});
    await unlink(upload.part).catch(() => {});
  }
}

/** .part files a crashed host left behind; only our own pattern, only old ones. */
async function removeStaleParts(directory: string) {
  const now = Date.now();
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!/^\.[0-9a-f-]{36}\.part$/.test(name)) continue;
    const file = path.join(directory, name);
    const info = await lstat(file).catch(() => undefined);
    if (info?.isFile() && now - info.mtimeMs > STALE_PART_MS) await unlink(file).catch(() => {});
  }
}

