import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('release publisher checks all deliverables and rejects tampering before contacting GitHub', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mongle-publish-check-'));
  const files = ['MongleTerminal-Setup-0.3.1-x64.exe', 'MongleTerminal-Setup-0.3.1-x64.exe.blockmap', 'MongleTerminal-0.3.1-x64.zip', 'latest.yml'];
  const checksum = createHash('sha256').update('fixture').digest('hex');
  const lines = files.map(file => `${checksum}  ${file}`);
  // Windows PowerShell must discover its own modules, not inherit pwsh's paths.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const run = () => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/publish-release.ps1'), '-Version', '0.3.1', '-OutputDir', directory, '-CheckOnly'], { env, windowsHide: true, timeout: 15000 });
  const writeChecksums = (rows: string[]) => writeFile(path.join(directory, 'SHA256SUMS.txt'), rows.join('\n') + '\n');
  try {
    for (const file of files) await writeFile(path.join(directory, file), 'fixture');
    await writeFile(path.join(directory, 'RELEASE-NOTES.md'), '- Fixture only.');
    await writeChecksums(lines);
    assert.match((await run()).stdout, /checksums verified/);
    await writeFile(path.join(directory, files[0]), 'modified');
    await assert.rejects(run(), /Checksum mismatch/);
    await writeFile(path.join(directory, files[0]), 'fixture');
    await writeChecksums([lines[0], lines[0], lines[2], lines[3]]);
    await assert.rejects(run(), /Unexpected checksum filename/);
    await writeChecksums([`${checksum}  ../outside.exe`, ...lines.slice(1)]);
    await assert.rejects(run(), /Invalid checksum record/);
    await writeChecksums(lines);
    await rm(path.join(directory, 'RELEASE-NOTES.md'));
    await assert.rejects(run(), /Missing reviewed release notes/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
