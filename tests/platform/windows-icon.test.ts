import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { verifyWindowsIcon } from '../../scripts/verify-windows-icon';

function png(size: number, color: number) {
  function chunk(name: string, data: Buffer) {
    const typeAndData = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of typeAndData) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, typeAndData, checksum]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc(size * (size * 4 + 1), color);
  for (let row = 0; row < size; row++) pixels[row * (size * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 32], images = sizes.map(size => png(size, 80)), ids = [11, 27];
function iconFile() {
  const header = Buffer.alloc(6 + 16 * images.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    header[at] = sizes[index]; header[at + 1] = sizes[index]; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}
type TreeEntry = { id: string | number; children: TreeEntry[] } | { id: string | number; data: Buffer };
function executable(options: { pe32?: boolean; wrongImage?: boolean; missingId?: boolean; wrongMetadata?: boolean } = {}) {
  const group = Buffer.alloc(6 + 14 * images.length); group.writeUInt16LE(1, 2); group.writeUInt16LE(images.length, 4);
  images.forEach((image, index) => {
    const at = 6 + 14 * index;
    group[at] = sizes[index]; group[at + 1] = sizes[index]; group.writeUInt16LE(1, at + 4); group.writeUInt16LE(32, at + 6);
    group.writeUInt32LE(image.length, at + 8); group.writeUInt16LE(options.missingId ? 999 : ids[index], at + 12);
  });
  if (options.wrongMetadata) group[6] = 24;
  const iconEntries = images.map((image, index): TreeEntry => ({ id: ids[index], children: [
    { id: 0, data: options.wrongImage ? png(sizes[index], 90) : image },
    { id: 1033, data: image },
  ] }));
  const tree: TreeEntry[] = [{ id: 3, children: iconEntries }, { id: 14, children: [
    { id: 'MAINICON', children: [{ id: 1033, data: group }] },
    { id: 7, children: [{ id: 1042, data: group }] },
  ] }];
  const resource = Buffer.alloc(16384); let cursor = 0;
  function allocate(size: number) { const offset = cursor; cursor = (cursor + size + 3) & ~3; return offset; }
  function writeDirectory(entries: TreeEntry[]): number {
    const offset = allocate(16 + entries.length * 8);
    resource.writeUInt16LE(entries.filter(entry => typeof entry.id === 'string').length, offset + 12);
    resource.writeUInt16LE(entries.filter(entry => typeof entry.id === 'number').length, offset + 14);
    entries.forEach((entry, index) => {
      const at = offset + 16 + index * 8;
      if (typeof entry.id === 'string') {
        const name = Buffer.from(entry.id, 'utf16le'), nameOffset = allocate(name.length + 2);
        resource.writeUInt16LE(entry.id.length, nameOffset); name.copy(resource, nameOffset + 2); resource.writeUInt32LE((0x80000000 + nameOffset) >>> 0, at);
      } else resource.writeUInt32LE(entry.id, at);
      if ('children' in entry) resource.writeUInt32LE((0x80000000 + writeDirectory(entry.children)) >>> 0, at + 4);
      else {
        const dataEntry = allocate(16), dataOffset = allocate(entry.data.length);
        resource.writeUInt32LE(dataEntry, at + 4); resource.writeUInt32LE(0x5000 + dataOffset, dataEntry); resource.writeUInt32LE(entry.data.length, dataEntry + 4);
        entry.data.copy(resource, dataOffset);
      }
    });
    return offset;
  }
  writeDirectory(tree);
  const optionalSize = options.pe32 ? 224 : 240, directoryBase = options.pe32 ? 96 : 112;
  const header = Buffer.alloc(512); header.write('MZ'); header.writeUInt32LE(128, 60); header.writeUInt32LE(0x4550, 128);
  header.writeUInt16LE(options.pe32 ? 0x14c : 0x8664, 132); header.writeUInt16LE(1, 134); header.writeUInt16LE(optionalSize, 148);
  const optionalAt = 152; header.writeUInt16LE(options.pe32 ? 0x10b : 0x20b, optionalAt); header.writeUInt32LE(16, optionalAt + directoryBase - 4);
  header.writeUInt32LE(0x5000, optionalAt + directoryBase + 16); header.writeUInt32LE(cursor, optionalAt + directoryBase + 20);
  const sectionAt = optionalAt + optionalSize;
  header.write('.icons', sectionAt); header.writeUInt32LE(cursor, sectionAt + 8); header.writeUInt32LE(0x5000, sectionAt + 12);
  header.writeUInt32LE(cursor, sectionAt + 16); header.writeUInt32LE(512, sectionAt + 20);
  return Buffer.concat([header, resource.subarray(0, cursor)]);
}
async function fixture(exe: Buffer, run: (exePath: string, icoPath: string) => Promise<void>, ico = iconFile()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mongle-icon-test-'));
  try {
    const exePath = path.join(directory, 'fixture.exe'), icoPath = path.join(directory, 'expected.ico');
    await writeFile(exePath, exe); await writeFile(icoPath, ico); await run(exePath, icoPath);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
for (const pe32 of [false, true]) test(`matches all PNG resources in ${pe32 ? 'PE32' : 'PE32+'}, named groups and language fallback`, async () => {
  await fixture(executable({ pe32 }), async (exePath, icoPath) => {
    const result = await verifyWindowsIcon(exePath, icoPath);
    assert.equal(result.frameCount, 2); assert.equal(result.groupCount, 2); assert.equal(result.resourceCount, 4);
    assert.deepEqual(result.sizes, [16, 32]); assert.deepEqual(result.groups, [{ id: 'MAINICON', language: 1033 }, { id: 7, language: 1042 }]);
    assert.match(result.icoSha256, /^[a-f0-9]{64}$/); assert.match(result.exeSha256, /^[a-f0-9]{64}$/);
  });
});
for (const [name, options, expected] of [
  ['different actual pixels', { wrongImage: true }, /RT_ICON .*does not match/],
  ['missing group frame reference', { missingId: true }, /references missing RT_ICON/],
  ['incorrect group frame dimensions', { wrongMetadata: true }, /does not match supplied ICO frames/],
] as const) test(`rejects ${name}`, async () => {
  await fixture(executable(options), async (exePath, icoPath) => { await assert.rejects(verifyWindowsIcon(exePath, icoPath), expected); });
});
test('rejects malformed PE ranges and oversized resource tables without loading code', async () => {
  const truncated = executable().subarray(0, 100);
  const outOfRange = executable(); outOfRange.writeUInt32LE(0x7fffffff, 152 + 112 + 20);
  const cyclicDirectory = executable(); cyclicDirectory.writeUInt32LE(0x80000000, 512 + 20);
  const hugeTable = executable(); hugeTable.writeUInt16LE(65535, 512 + 14);
  for (const bytes of [truncated, outOfRange, cyclicDirectory, hugeTable]) {
    await fixture(bytes, async (exePath, icoPath) => { await assert.rejects(verifyWindowsIcon(exePath, icoPath), /Windows icon verification:/); });
  }
});
test('rejects ICO directory dimensions that disagree with embedded PNG', async () => {
  const malformed = iconFile(); malformed[6] = 48;
  await fixture(executable(), async (exePath, icoPath) => { await assert.rejects(verifyWindowsIcon(exePath, icoPath), /dimensions disagree/); }, malformed);
});
test('rebuilt packaged EXE embeds the supplied ICO frames', { skip: !process.env.MONGLE_ICON_TEST_EXE }, async () => {
  const result = await verifyWindowsIcon(process.env.MONGLE_ICON_TEST_EXE!, process.env.MONGLE_ICON_TEST_ICO || path.resolve('platform/windows/icon.ico'));
  assert.deepEqual(result.sizes, [16, 24, 32, 48, 64, 128, 256]); assert.equal(result.frameCount, 7);
});
test('previous packaged EXE does not contain the new icon', { skip: !process.env.MONGLE_ICON_BASELINE_EXE }, async () => {
  await assert.rejects(verifyWindowsIcon(process.env.MONGLE_ICON_BASELINE_EXE!, process.env.MONGLE_ICON_TEST_ICO || path.resolve('platform/windows/icon.ico')), /does not match supplied ICO/);
});
