import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const windowsSizes = [16, 24, 32, 48, 64, 128, 256];
const webSizes = [32, 192, 512];

/** Build assets only: no generated executable or desktop runtime dependency. */
export async function prepareWindowsIcon(root: string): Promise<string> {
  const web = path.join(root, 'apps/web/public');
  const master = await readFile(path.join(web, 'mongle-terminal-icon.png'));
  const source = sharp(master, { limitInputPixels: 8192 * 8192 });
  const metadata = await source.metadata();
  if (metadata.format !== 'png' || !metadata.width || metadata.width !== metadata.height ||
      metadata.width < 256 || metadata.width > 8192 || (metadata.pages ?? 1) !== 1) {
    throw new Error('Icon master must be a single square PNG between 256 and 8192 pixels.');
  }

  // Render every size from the same input bytes, including when mtimes match.
  const images = new Map(await Promise.all([...new Set([...windowsSizes, ...webSizes])].map(async size => [
    size, await source.clone().resize(size, size, { kernel: 'lanczos3' })
      .toColourspace('srgb').ensureAlpha().png({ palette: false }).toBuffer(),
  ] as const)));
  const header = Buffer.alloc(6 + 16 * windowsSizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(windowsSizes.length, 4);
  let offset = header.length;
  const frames = windowsSizes.map((size, index) => {
    const frame = images.get(size)!;
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(frame.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += frame.length;
    return frame;
  });

  const icon = path.join(root, 'platform/windows/icon.ico');
  await mkdir(path.dirname(icon), { recursive: true });
  await Promise.all([
    writeFile(icon, Buffer.concat([header, ...frames])),
    ...webSizes.map(size => writeFile(path.join(web, `icon-${size}.png`), images.get(size)!)),
  ]);
  return icon;
}
