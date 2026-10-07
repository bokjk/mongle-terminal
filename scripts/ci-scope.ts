import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const rootDocuments = new Set(['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'AGENTS.md']);
const isDocument = (file: string) => rootDocuments.has(file) || /^docs\/.+\.md$/.test(file);

/** UI-only changes still run the entire regression suite, but need no extra NSIS rehearsal. */
export function requiresInstaller(files: readonly string[], force = false, destructiveFiles: readonly string[] = []): boolean {
  return force || destructiveFiles.length > 0 || files.length === 0 || files.some(file => {
    if (file.split('/').some(part => part === '..' || part === '.' || part === '')) return true;
    // These documents are shipped in the installer, unlike developer prose.
    if (file === 'docs/USER-GUIDE.md' || file === 'docs/THIRD-PARTY-NOTICES.md' || file.startsWith('docs/licenses/')) return true;
    // The web icon master also supplies the Windows installer/uninstaller icon.
    if (file === 'apps/web/public/mongle-terminal-icon.png') return true;
    return !isDocument(file) && !file.startsWith('apps/web/');
  });
}

/** Only known prose paths may omit runtime tests. Unknown or empty changes fail closed. */
export function requiresWindows(files: readonly string[], force = false, deletedFiles: readonly string[] = []): boolean {
  return force || deletedFiles.length > 0 || files.length === 0 || files.some(file =>
    !rootDocuments.has(file) && !(/^docs\/.+\.md$/.test(file) && !file.split('/').some(part => part === '..' || part === '.' || part === '')));
}

export function comparison(event: unknown): { base: string; head: string; force: boolean } {
  const pr = (event as { pull_request?: { base?: { sha?: unknown; ref?: unknown }; head?: { sha?: unknown } } } | null)?.pull_request;
  const base = pr?.base?.sha, head = pr?.head?.sha;
  if (typeof base !== 'string' || typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('CI scope requires full pull request base/head SHAs.');
  }
  // Every release PR receives the full Windows verification, even if it only changes docs.
  return { base, head, force: pr?.base?.ref !== 'dev' };
}

export async function changedFiles(base: string, head: string, cwd = process.cwd()): Promise<{ files: string[]; deletedFiles: string[] }> {
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Invalid comparison SHA.');
  // --no-renames includes both sides of a code -> documentation rename; deletions also count.
  const { stdout } = await exec('git', ['diff', '--name-status', '--no-renames', '-z', `${base}...${head}`, '--'], { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const fields = stdout.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('Incomplete git change list.');
  const files: string[] = [], deletedFiles: string[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    if (!/^[AMDTUXB]$/.test(fields[i]) || !fields[i + 1]) throw new Error('Unknown git change status.');
    files.push(fields[i + 1]);
    // Deleted docs can be packaging inputs; type changes may turn a doc into a symlink.
    if (fields[i] !== 'A' && fields[i] !== 'M') deletedFiles.push(fields[i + 1]);
  }
  return { files, deletedFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let required = true;
  const installer = process.argv[2] === '--installer';
  if (process.argv.length > 3 || (process.argv[2] && !installer)) throw new Error('Usage: node scripts/ci-scope.ts [--installer]');
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required.');
    const { base, head, force } = comparison(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')));
    const changes = await changedFiles(base, head);
    required = (installer ? requiresInstaller : requiresWindows)(changes.files, force, changes.deletedFiles);
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `${installer ? 'installer_required' : 'windows_required'}=${required}\n`);
  if (installer) console.log(required ? 'Full installed upgrade verification required.' : 'UI or developer prose only; full code regression is handled by Contribution checks.');
  else console.log(required ? 'Full Windows verification required.' : 'Known documentation paths only; validate documents without installing or building the app.');
}
