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

const GIT_EXCLUDE_FAILED = '이 폴더의 Git 저장소 제외 목록(.git/info/exclude)에 첨부 폴더를 추가하지 못해 파일을 저장하지 않았습니다. 저장소 설정을 확인하거나 Git 저장소가 아닌 폴더에서 다시 보내 주세요.';
/** Lines that leave .mongle-attachments out at every depth; an anchored "/.mongle-attachments/" covers only the root. */
const COVERS_EVERY_DEPTH = /^(?:\*\*\/)?\.mongle-attachments\/?$/;

/** A real directory or file (no link, junction or second hard link) whose resolved path stays inside parent. */
async function ownedEntry(entry: string, parent: string, protectedRoot: string, kind: 'directory' | 'file') {
  const info = await lstat(entry);
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) throw new AppError('UPLOAD_GIT_EXCLUDE', GIT_EXCLUDE_FAILED);
  const real = await realpath(entry);
  if (!within(parent, real) || within(protectedRoot, real)) throw new AppError('UPLOAD_GIT_EXCLUDE', GIT_EXCLUDE_FAILED);
  return real;
}

/**
 * Keeps attachments out of Git in the repository the folder belongs to, so an agent's "git add -A" does
 * not commit a phone screenshot. Only the repository's local exclude file (never committed) gets one line,
 * once. The repository is found by reading .git as the Git view does, without running Git. Every step of
 * the path to the exclude file is checked like the attachment folder itself: a link or junction anywhere
 * is refused. Any failure throws, so no file is saved where Git would pick it up.
 */
export async function excludeFromGit(base: string, protectedRoot: string): Promise<string | undefined> {
  try {
    const repository = await repositoryAt(base, protectedRoot);
    if (!repository) return undefined;
    const marker = path.join(repository, '.git');
    let metadata: string;
    if ((await lstat(marker)).isFile()) {
      const pointer = /^gitdir: (.+)\r?\n?$/.exec(await readFile(marker, 'utf8'))?.[1]?.trim();
      if (!pointer) throw new AppError('UPLOAD_GIT_EXCLUDE', GIT_EXCLUDE_FAILED);
      metadata = await safeMetadata(path.resolve(repository, pointer), protectedRoot);
    } else metadata = await safeMetadata(marker, protectedRoot);
    const common = await readFile(path.join(metadata, 'commondir'), 'utf8').then(pointer => safeMetadata(path.resolve(metadata, pointer.trim()), protectedRoot), () => metadata);
    const infoPath = path.join(common, 'info');
    await mkdir(infoPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await ownedEntry(infoPath, common, protectedRoot, 'directory');
    const exclude = path.join(info, 'exclude');
    const exists = await lstat(exclude).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) await ownedEntry(exclude, info, protectedRoot, 'file');
    const covered = (text: string) => text.split(/\r?\n/).some(line => COVERS_EVERY_DEPTH.test(line.trim()));
    const current = exists ? await readFile(exclude, 'utf8') : '';
    if (covered(current)) return exclude;
    await appendFile(exclude, (current && !current.endsWith('\n') ? '\n' : '') + '# Mongle Terminal attachments\n' + ATTACHMENT_FOLDER + '/\n', { flag: exists ? 'a' : 'wx' });
    await ownedEntry(exclude, info, protectedRoot, 'file');
    if (!covered(await readFile(exclude, 'utf8'))) throw new AppError('UPLOAD_GIT_EXCLUDE', GIT_EXCLUDE_FAILED);
    return exclude;
  } catch (error) {
    if (error instanceof AppError && error.code === 'UPLOAD_GIT_EXCLUDE') throw error;
    throw new AppError('UPLOAD_GIT_EXCLUDE', GIT_EXCLUDE_FAILED);
  }
}

type Upload = { owner: string; directory: string; part: string; name: string; size: number; received: number; handle: FileHandle; busy: boolean; timer: ReturnType<typeof setTimeout> };
/** A begin still resolving folders: it holds its slot, and a disconnect or shutdown meanwhile cancels it. */
type Starting = { owner: string; cancelled: boolean };

export class Uploads {
  private uploads = new Map<string, Upload>();
  private starting = new Set<Starting>();
  private closed = false;
  constructor(private readonly dataDir: string, private readonly idleMs = IDLE_MS) {}

  async begin(owner: string, root: string, originalName: string, size: number): Promise<{ uploadId: string; chunkBytes: number; name: string }> {
    if (this.closed) throw new AppError('HOST_UNAVAILABLE', '호스트가 종료 중입니다.');
    if (!Number.isSafeInteger(size) || size < 1) throw new AppError('UPLOAD_EMPTY', '빈 파일은 보낼 수 없습니다.');
    if (size > UPLOAD_MAX_BYTES) throw new AppError('UPLOAD_TOO_LARGE', '10 MiB 이하 파일만 보낼 수 있습니다.');
    // The slot is taken before the first await, so simultaneous begins cannot all pass the count.
    const mine = [...this.uploads.values(), ...this.starting].filter(item => item.owner === owner).length;
    if (mine >= PER_CONNECTION || this.uploads.size + this.starting.size >= TOTAL) throw new AppError('UPLOAD_BUSY', '다른 파일을 보내는 중입니다. 잠시 후 다시 시도해 주세요.');
    const slot: Starting = { owner, cancelled: false };
    this.starting.add(slot);
    let handle: FileHandle | undefined, part: string | undefined;
    try {
      const { base, protectedRoot } = await resolveFileRoot(root, this.dataDir);
      await excludeFromGit(base, protectedRoot);
      const directory = await attachmentDirectory(base, protectedRoot);
      await removeStaleParts(directory);
      const uploadId = randomUUID();
      part = path.join(directory, '.' + uploadId + '.part');
      handle = await open(part, 'wx', 0o600);
      if (slot.cancelled || this.closed) throw new AppError('UPLOAD_EXPIRED', '연결이 끊겨 파일 보내기를 중단했습니다. 다시 보내 주세요.');
      const upload: Upload = { owner, directory, part, name: attachmentName(originalName), size, received: 0, handle, busy: false, timer: setTimeout(() => void this.discard(uploadId), this.idleMs) };
      this.uploads.set(uploadId, upload);
      return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES, name: upload.name };
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); await unlink(part!).catch(() => {}); }
      throw error;
    } finally { this.starting.delete(slot); }
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
  /** A connection that closed takes its unfinished uploads with it, including ones still starting. */
  async dropOwner(owner: string): Promise<void> {
    for (const slot of this.starting) if (slot.owner === owner) slot.cancelled = true;
    await Promise.all([...this.uploads].filter(([, item]) => item.owner === owner).map(([id]) => this.discard(id)));
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const slot of this.starting) slot.cancelled = true;
    await Promise.all([...this.uploads.keys()].map(id => this.discard(id)));
  }
  get active(): number { return this.uploads.size + this.starting.size; }

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
