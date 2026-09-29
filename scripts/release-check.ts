import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkReleaseDocuments(version: string, readme: string, changelog: string, tag?: string): string {
  if (!stableVersion.test(version)) throw new Error('Only stable X.Y.Z versions can use the latest update channel.');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Release tag must be v${version}, got ${tag}.`);
  if (!new RegExp(`(?<![\\w.-])v?${escapeRegex(version)}(?![\\w.-])`).test(readme)) throw new Error(`README must identify the current version as ${version}.`);
  if (!/\]\((?:\.\/)?CHANGELOG\.md(?:#[^)]*)?\)/.test(readme)) throw new Error('README must link to CHANGELOG.md.');
  const heading = new RegExp(`^## \\[${escapeRegex(version)}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG needs a dated "## [${version}] - YYYY-MM-DD" entry.`);
  if (!Number.isFinite(Date.parse(match[1] + 'T00:00:00Z')) || new Date(match[1] + 'T00:00:00Z').toISOString().slice(0, 10) !== match[1]) throw new Error('CHANGELOG release date is invalid.');
  const next = changelog.slice(match.index + match[0].length).search(/^## /m);
  const body = changelog.slice(match.index + match[0].length, next < 0 ? undefined : match.index + match[0].length + next).trim();
  if (!body || !/^[-*] \S/m.test(body)) throw new Error('CHANGELOG release entry must contain concrete bullet notes.');
  return `${match[0].trim()}\n\n${body}\n`;
}

export async function checkRelease(root: string, tag?: string) {
  const [packageText, lockText, readme, changelog] = await Promise.all(['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md'].map(file => readFile(path.join(root, file), 'utf8')));
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  if (pkg.name !== 'mongle-terminal') throw new Error('Run release checks from the Mongle Terminal project directory.');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('package-lock.json version must match package.json.');
  const notes = checkReleaseDocuments(pkg.version, readme, changelog, tag);
  if (tag !== undefined) {
    const { stdout } = await exec('git', ['status', '--porcelain', '--', 'README.md', 'CHANGELOG.md'], { cwd: root, windowsHide: true });
    if (stdout.trim()) throw new Error('Commit README and CHANGELOG before a tagged release.');
    const [head, tagged] = await Promise.all([
      exec('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }),
      exec('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { cwd: root, windowsHide: true }),
    ]);
    if (head.stdout.trim() !== tagged.stdout.trim()) throw new Error('Release tag must point at the checked-out commit.');
  }
  return { version: pkg.version as string, tag: `v${pkg.version}`, notes };
}

async function hashFile(file: string, algorithm: string, encoding: 'hex' | 'base64') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

/** Check what the updater will download, then write checksums of every release asset. */
export async function writeReleaseChecksums(outputDir: string, version: string) {
  if (!stableVersion.test(version)) throw new Error('Release assets require a stable version.');
  const installer = `MongleTerminal-Setup-${version}-x64.exe`;
  const zip = `MongleTerminal-${version}-x64.zip`;
  const assets = [installer, installer + '.blockmap', zip, 'latest.yml'];
  // electron-builder already depends on js-yaml; no parser is shipped in the app.
  const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
  const metadata = yaml.load(await readFile(path.join(outputDir, 'latest.yml'), 'utf8')) as {
    version?: string; path?: string; sha512?: string; files?: Array<{ url?: string; sha512?: string; size?: number }>;
  };
  if (!metadata || metadata.version !== version || metadata.path !== installer) throw new Error('latest.yml does not target this release installer.');
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1 || metadata.files[0].url !== installer) throw new Error('latest.yml must contain exactly the Windows x64 installer.');
  const installerHash = await hashFile(path.join(outputDir, installer), 'sha512', 'base64');
  if (metadata.sha512 !== installerHash || metadata.files[0].sha512 !== installerHash || metadata.files[0].size !== (await stat(path.join(outputDir, installer))).size) throw new Error('latest.yml installer checksum or size is incorrect.');
  const lines: string[] = [];
  for (const asset of assets) {
    const file = path.join(outputDir, asset);
    if ((await stat(file)).size === 0) throw new Error(`Release asset is empty: ${asset}`);
    lines.push(`${await hashFile(file, 'sha256', 'hex')}  ${asset}`);
  }
  await writeFile(path.join(outputDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');
  return [...assets, 'SHA256SUMS.txt'];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (process.argv.length > 3) throw new Error('Usage: node --import tsx scripts/release-check.ts [vX.Y.Z]');
  const release = await checkRelease(process.cwd(), tag);
  if (process.env.GITHUB_ACTIONS === 'true') {
    await mkdir('release', { recursive: true });
    await writeFile('release/RELEASE-NOTES.md', release.notes, 'utf8');
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${release.version}\ntag=${release.tag}\n`, 'utf8');
  }
  console.log(`Release documentation verified: ${release.tag}`);
}
