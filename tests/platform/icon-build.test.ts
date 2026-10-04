import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { prepareWindowsIcon } from '../../scripts/build-icons';

async function fixture(run: (root: string, master: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mongle-icon-build-'));
  try {
    const master = path.join(root, 'apps/web/public/mongle-terminal-icon.png');
    await mkdir(path.dirname(master), { recursive: true });
    await run(root, master);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('builds decodable transparent web/ICO assets without a helper executable', async () => {
  await fixture(async (root, master) => {
    const pixels = Buffer.alloc(512 * 512 * 4);
    for (let y = 128; y < 384; y++) for (let x = 128; x < 384; x++) {
      const at = (y * 512 + x) * 4;
      pixels[at] = 255; pixels[at + 3] = 255;
    }
    await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toFile(master);
    const icon = await readFile(await prepareWindowsIcon(root));
    assert.equal(icon.readUInt16LE(0), 0);
    assert.equal(icon.readUInt16LE(2), 1);
    assert.equal(icon.readUInt16LE(4), 7);
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    let end = 6 + sizes.length * 16;
    const pngs: Array<[number, Buffer]> = [];
    for (let index = 0; index < sizes.length; index++) {
      const at = 6 + index * 16, size = sizes[index];
      assert.equal(icon[at] || 256, size);
      assert.equal(icon[at + 1] || 256, size);
      assert.equal(icon.readUInt16LE(at + 4), 1);
      assert.equal(icon.readUInt16LE(at + 6), 32);
      const length = icon.readUInt32LE(at + 8), offset = icon.readUInt32LE(at + 12);
      assert.equal(offset, end);
      end = offset + length;
      pngs.push([size, icon.subarray(offset, end)]);
    }
    assert.equal(end, icon.length);
    for (const size of [32, 192, 512]) pngs.push([size, await readFile(path.join(root, `apps/web/public/icon-${size}.png`))]);
    for (const [size, png] of pngs) {
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, size); assert.equal(info.height, size); assert.equal(info.channels, 4);
      assert.equal(data[3], 0, 'transparent corner');
      const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
      assert.deepEqual([...data.subarray(center, center + 4)], [255, 0, 0, 255], 'opaque red center');
    }
    await assert.rejects(access(path.join(root, 'platform/windows/IconBuilder.exe')), { code: 'ENOENT' });
  });
});

test('regenerates from changed master content even with the same timestamp', async () => {
  await fixture(async (root, master) => {
    const create = (r: number, g: number) => sharp({ create: { width: 256, height: 256, channels: 4, background: { r, g, b: 0, alpha: 1 } } }).png().toBuffer();
    await writeFile(master, await create(255, 0));
    const before = await stat(master);
    const first = await readFile(await prepareWindowsIcon(root));
    await writeFile(master, await create(0, 255));
    await utimes(master, before.atime, before.mtime);
    const second = await readFile(await prepareWindowsIcon(root));
    assert.notDeepEqual(first, second);
    const { data } = await sharp(await readFile(path.join(root, 'apps/web/public/icon-32.png'))).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 4)], [0, 255, 0, 255]);
    assert.deepEqual(await readFile(await prepareWindowsIcon(root)), second, 'same input yields identical ICO bytes');
  });
});

test('rejects invalid master images before replacing existing assets', async () => {
  await fixture(async (root, master) => {
    const icon = path.join(root, 'platform/windows/icon.ico');
    await mkdir(path.dirname(icon), { recursive: true });
    await writeFile(icon, 'existing-icon');
    const create = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: '#ffffff' } });
    for (const bytes of [
      await create(128, 128).png().toBuffer(),
      await create(512, 256).png().toBuffer(),
      await create(256, 256).jpeg().toBuffer(),
      Buffer.from('not an image'),
    ]) {
      await writeFile(master, bytes);
      await assert.rejects(prepareWindowsIcon(root));
      assert.equal(await readFile(icon, 'utf8'), 'existing-icon');
      await assert.rejects(access(path.join(root, 'apps/web/public/icon-32.png')), { code: 'ENOENT' });
    }
  });
});
