import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkReleaseDocuments, writeReleaseChecksums } from '../../scripts/release-check';

const readme = 'Version `0.2.0`. [Changes](CHANGELOG.md)';
const changelog = '# Changes\n\n## [Unreleased]\n\n## [0.2.0] - 2026-09-29\n\n- Add updates.\n\n## [0.1.0] - 2026-09-28\n\n- Initial release.\n';

test('release notes include only the matching stable version', () => {
  assert.equal(checkReleaseDocuments('0.2.0', readme, changelog, 'v0.2.0'), '## [0.2.0] - 2026-09-29\n\n- Add updates.\n');
});

test('release checks reject mismatched, prerelease and undocumented versions', () => {
  assert.throws(() => checkReleaseDocuments('0.2.0', readme, changelog, 'v0.1.0'), /tag must/);
  assert.throws(() => checkReleaseDocuments('0.2.0-beta.1', readme, changelog), /stable/);
  assert.throws(() => checkReleaseDocuments('0.2.0', readme.replace('0.2.0', '0.1.0'), changelog), /README/);
  assert.throws(() => checkReleaseDocuments('0.2.0', 'Version `0.2.0`', changelog), /link/);
  assert.throws(() => checkReleaseDocuments('0.2.0', readme, changelog.replace('2026-09-29', '2026-02-30')), /date/);
  assert.throws(() => checkReleaseDocuments('0.2.0', readme, changelog.replace('- Add updates.', '')), /concrete bullet/);
});

test('packaging verifies update metadata and writes checksums for every deliverable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mongle-release-check-'));
  const installer = 'MongleTerminal-Setup-0.2.0-x64.exe';
  const data = Buffer.from('installer fixture');
  const sha512 = createHash('sha512').update(data).digest('base64');
  const metadata = `version: 0.2.0\nfiles:\n  - url: ${installer}\n    sha512: ${sha512}\n    size: ${data.length}\npath: ${installer}\nsha512: ${sha512}\n`;
  try {
    await writeFile(path.join(directory, installer), data);
    await writeFile(path.join(directory, installer + '.blockmap'), 'blockmap fixture');
    await writeFile(path.join(directory, 'MongleTerminal-0.2.0-x64.zip'), 'zip fixture');
    await writeFile(path.join(directory, 'latest.yml'), metadata);
    const assets = await writeReleaseChecksums(directory, '0.2.0');
    assert.equal(assets.length, 5);
    const checksums = (await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n');
    assert.equal(checksums.length, 4);
    assert.equal(checksums[0], `${createHash('sha256').update(data).digest('hex')}  ${installer}`);
    await writeFile(path.join(directory, installer), 'corrupted');
    await assert.rejects(writeReleaseChecksums(directory, '0.2.0'), /checksum or size/);
    await writeFile(path.join(directory, installer), data);
    await writeFile(path.join(directory, 'latest.yml'), metadata.replaceAll(installer, '../foreign.exe'));
    await assert.rejects(writeReleaseChecksums(directory, '0.2.0'), /does not target/);
    await writeFile(path.join(directory, 'latest.yml'), metadata.replace('version: 0.2.0', 'version: 0.1.0'));
    await assert.rejects(writeReleaseChecksums(directory, '0.2.0'), /does not target/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
