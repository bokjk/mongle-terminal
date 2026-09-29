import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

// Read-only PE resource inspection. Format references:
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
// https://devblogs.microsoft.com/oldnewthing/20120720-00/?p=7083
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_ICON_BYTES = 16 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type ResourceName = number | string;
type Resource = { id: ResourceName; language: ResourceName; bytes: Buffer };
type Frame = { width: number; height: number; bytes: number; sha256: string; metadata: string };
export interface WindowsIconVerification {
  frameCount: number; groupCount: number; resourceCount: number; sizes: number[];
  icoSha256: string; exeSha256: string;
  frames: { width: number; height: number; bytes: number; sha256: string }[];
  groups: { id: ResourceName; language: ResourceName }[];
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Windows icon verification: ' + message);
}
function range(bytes: Buffer, offset: number, length: number) {
  check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length >= 0 && offset + length <= bytes.length, 'truncated or out-of-bounds resource');
  return bytes.subarray(offset, offset + length);
}
function hash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
async function read(file: FileHandle, offset: number, length: number, fileSize: number) {
  check(offset >= 0 && length >= 0 && length <= MAX_RESOURCE_BYTES && offset + length <= fileSize, 'invalid file range');
  const bytes = Buffer.alloc(length);
  for (let at = 0; at < length;) {
    const result = await file.read(bytes, at, length - at, offset + at);
    check(result.bytesRead > 0, 'file was truncated during verification'); at += result.bytesRead;
  }
  return bytes;
}
function parseIcon(bytes: Buffer): Frame[] {
  range(bytes, 0, 6);
  check(bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1, 'not an ICO file');
  const count = bytes.readUInt16LE(4);
  check(count > 0 && count <= 256, 'invalid ICO frame count');
  range(bytes, 6, count * 16);
  const frames: Frame[] = [];
  for (let index = 0; index < count; index++) {
    const entry = range(bytes, 6 + index * 16, 16);
    const width = entry[0] || 256, height = entry[1] || 256;
    const size = entry.readUInt32LE(8), offset = entry.readUInt32LE(12);
    check(offset >= 6 + count * 16 && size >= 33, 'invalid ICO image range');
    const image = range(bytes, offset, size);
    check(image.subarray(0, 8).equals(PNG) && image.readUInt32BE(8) === 13 && image.toString('ascii', 12, 16) === 'IHDR', 'ICO frame must contain PNG data');
    check(image.readUInt32BE(16) === width && image.readUInt32BE(20) === height, 'ICO dimensions disagree with PNG');
    frames.push({ width, height, bytes: size, sha256: hash(image), metadata: entry.subarray(0, 8).toString('hex') });
  }
  return frames;
}
async function readIconResources(file: FileHandle, fileSize: number) {
  const dos = await read(file, 0, 64, fileSize);
  check(dos.toString('ascii', 0, 2) === 'MZ', 'missing DOS header');
  const peOffset = dos.readUInt32LE(60);
  check(peOffset >= 64 && peOffset <= 1024 * 1024, 'invalid PE header offset');
  const pe = await read(file, peOffset, 24, fileSize);
  check(pe.readUInt32LE(0) === 0x4550, 'missing PE signature');
  const sectionCount = pe.readUInt16LE(6), optionalSize = pe.readUInt16LE(20);
  check(sectionCount > 0 && sectionCount <= 96 && optionalSize <= 4096, 'invalid PE section or optional-header count');
  const optional = await read(file, peOffset + 24, optionalSize, fileSize);
  range(optional, 0, 2);
  const magic = optional.readUInt16LE(0);
  check(magic === 0x10b || magic === 0x20b, 'unsupported PE optional-header format');
  const directoryBase = magic === 0x20b ? 112 : 96;
  range(optional, directoryBase - 4, 28);
  check(optional.readUInt32LE(directoryBase - 4) >= 3, 'PE resource directory missing');
  const resourceRva = optional.readUInt32LE(directoryBase + 16), resourceSize = optional.readUInt32LE(directoryBase + 20);
  check(resourceRva > 0 && resourceSize >= 16 && resourceSize <= MAX_RESOURCE_BYTES, 'invalid PE resource size');
  const sectionBytes = await read(file, peOffset + 24 + optionalSize, sectionCount * 40, fileSize);
  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const section = sectionBytes.subarray(index * 40, index * 40 + 40);
    return { rva: section.readUInt32LE(12), size: section.readUInt32LE(16), offset: section.readUInt32LE(20) };
  });
  function fileOffset(rva: number, length: number) {
    const candidates = sections.filter(section => rva >= section.rva && rva - section.rva + length <= section.size);
    check(candidates.length === 1, 'resource RVA is not in one file-backed section');
    return candidates[0].offset + rva - candidates[0].rva;
  }
  const resources = await read(file, fileOffset(resourceRva, resourceSize), resourceSize, fileSize);
  let entryBudget = 4096;
  function directory(offset: number) {
    const header = range(resources, offset, 16);
    const count = header.readUInt16LE(12) + header.readUInt16LE(14);
    check(count <= 1024 && (entryBudget -= count) >= 0, 'too many resource entries');
    const entries = range(resources, offset + 16, count * 8), seen = new Set<ResourceName>();
    return Array.from({ length: count }, (_, index) => {
      const nameBits = entries.readUInt32LE(index * 8), target = entries.readUInt32LE(index * 8 + 4);
      let name: ResourceName = nameBits;
      if (nameBits & 0x80000000) {
        const stringOffset = nameBits & 0x7fffffff;
        const length = range(resources, stringOffset, 2).readUInt16LE(0);
        check(length > 0 && length <= 256, 'invalid resource name length');
        name = range(resources, stringOffset + 2, length * 2).toString('utf16le');
      }
      check(!seen.has(name), 'duplicate resource ID'); seen.add(name);
      return { name, offset: target & 0x7fffffff, directory: Boolean(target & 0x80000000) };
    });
  }
  const icons: Resource[] = [], groups: Resource[] = [];
  let imageBudget = MAX_RESOURCE_BYTES;
  for (const type of directory(0).filter(entry => entry.name === 3 || entry.name === 14)) {
    check(type.directory, 'resource type must be a directory');
    for (const id of directory(type.offset)) {
      check(id.directory, 'resource ID must be a directory');
      for (const language of directory(id.offset)) {
        check(!language.directory, 'resource tree exceeds type/ID/language depth');
        const entry = range(resources, language.offset, 16);
        const dataRva = entry.readUInt32LE(0), size = entry.readUInt32LE(4);
        check(size > 0 && size <= MAX_ICON_BYTES && (imageBudget -= size) >= 0, 'invalid icon resource size or total image budget');
        // Data RVAs are absolute image RVAs, unlike directory-relative offsets.
        const offset = fileOffset(dataRva, size);
        const bytes = await read(file, offset, size, fileSize);
        (type.name === 3 ? icons : groups).push({ id: id.name, language: language.name, bytes });
      }
    }
  }
  check(icons.length > 0 && groups.length > 0, 'RT_ICON or RT_GROUP_ICON resources are missing');
  return { icons, groups };
}
/** Verifies every icon group and referenced PNG frame without executing/loading the EXE. */
export async function verifyWindowsIcon(exePath: string, icoPath: string): Promise<WindowsIconVerification> {
  const ico = await open(icoPath, 'r');
  let icoBytes: Buffer;
  try {
    const stat = await ico.stat();
    check(stat.isFile() && stat.size <= MAX_ICON_BYTES, 'ICO exceeds size limit');
    icoBytes = await read(ico, 0, stat.size, stat.size);
  } finally { await ico.close(); }
  const frames = parseIcon(icoBytes);
  const exe = await open(exePath, 'r');
  try {
    const stat = await exe.stat();
    check(stat.isFile() && stat.size <= 1024 * 1024 * 1024, 'EXE exceeds size limit');
    const { icons, groups } = await readIconResources(exe, stat.size);
    const signature = (frame: Pick<Frame, 'metadata' | 'bytes' | 'sha256'>) => `${frame.metadata}:${frame.bytes}:${frame.sha256}`;
    const expected = frames.map(signature).sort();
    const expectedHashes = new Set(frames.map(frame => frame.sha256));
    for (const icon of icons) check(expectedHashes.has(hash(icon.bytes)), `RT_ICON ${String(icon.id)}/${String(icon.language)} does not match supplied ICO`);
    for (const group of groups) {
      const header = range(group.bytes, 0, 6);
      check(header.readUInt16LE(0) === 0 && header.readUInt16LE(2) === 1, 'invalid RT_GROUP_ICON header');
      const count = header.readUInt16LE(4);
      check(count === frames.length && group.bytes.length === 6 + count * 14, 'RT_GROUP_ICON frame count/size does not match ICO');
      const actual: string[] = [];
      for (let index = 0; index < count; index++) {
        const entry = range(group.bytes, 6 + index * 14, 14), id = entry.readUInt16LE(12);
        const candidates = icons.filter(icon => icon.id === id);
        const icon = candidates.find(icon => icon.language === group.language) ?? candidates.find(icon => icon.language === 0);
        check(icon, `RT_GROUP_ICON references missing RT_ICON ${id}/${String(group.language)}`);
        check(icon.bytes.length === entry.readUInt32LE(8), 'RT_GROUP_ICON image size disagrees with RT_ICON');
        actual.push(signature({ metadata: entry.subarray(0, 8).toString('hex'), bytes: icon.bytes.length, sha256: hash(icon.bytes) }));
      }
      check(JSON.stringify(actual.sort()) === JSON.stringify(expected), `RT_GROUP_ICON ${String(group.id)}/${String(group.language)} does not match supplied ICO frames`);
    }
    const exeHash = createHash('sha256');
    for await (const chunk of createReadStream(exePath, { fd: exe.fd, autoClose: false, start: 0, end: stat.size - 1 })) exeHash.update(chunk);
    return {
      frameCount: frames.length, groupCount: groups.length, resourceCount: icons.length,
      sizes: [...new Set(frames.map(frame => frame.width))].sort((a, b) => a - b),
      icoSha256: hash(icoBytes), exeSha256: exeHash.digest('hex'),
      frames: frames.map(({ metadata: _metadata, ...frame }) => frame),
      groups: groups.map(({ id, language }) => ({ id, language })),
    };
  } finally { await exe.close(); }
}

