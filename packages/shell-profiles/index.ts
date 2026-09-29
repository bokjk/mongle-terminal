import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AppError, type ShellProfile } from '../protocol/index.js';

const WINDOWS = process.platform === 'win32';

function environmentValue(name: string): string | undefined {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : process.env[key];
}

async function isFile(candidate: string): Promise<boolean> {
  try { return (await stat(candidate)).isFile(); } catch { return false; }
}

async function firstFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of [...new Set(candidates)]) {
    if (path.isAbsolute(candidate) && await isFile(candidate)) return candidate;
  }
  return undefined;
}

function pathCandidates(filename: string): string[] {
  return (environmentValue('PATH') ?? '').split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    // Never search the host's working directory through an empty/relative PATH entry.
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.join(entry, filename));
}

async function installedPowerShellCandidates(): Promise<string[]> {
  const roots = [environmentValue('ProgramW6432'), environmentValue('ProgramFiles'), environmentValue('ProgramFiles(x86)')]
    .filter((entry): entry is string => Boolean(entry));
  const result: string[] = [];
  for (const root of [...new Set(roots)]) {
    const directory = path.join(root, 'PowerShell');
    try {
      const versions = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      result.push(...versions.map((version) => path.join(directory, version, 'pwsh.exe')));
    } catch { /* PowerShell 7 is optional. */ }
  }
  return result;
}

async function wslDistributions(executable: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(executable, ['--list', '--quiet'], {
      encoding: 'buffer', windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024,
      env: safeShellEnvironment(),
    }, (error, stdout) => {
      // Missing WSL, no installed distributions, and disabled virtualization are normal.
      if (error) { resolve([]); return; }
      const utf16 = stdout.length >= 2 && (stdout[0] === 0xff && stdout[1] === 0xfe || stdout.includes(0));
      const decoded = stdout.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
      resolve([...new Set(decoded.split(/\r?\n/).map((name) => name.trim())
        .filter((name) => name.length > 0 && name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(name)))]);
    });
  });
}

/** Discover executables and real installed WSL distributions; never invent a profile. */
export async function detectShellProfiles(): Promise<ShellProfile[]> {
  const profiles: ShellProfile[] = [];
  if (!WINDOWS) {
    const executable = await firstFile([...pathCandidates('bash'), '/bin/bash', '/usr/bin/bash']);
    if (executable) profiles.push({ id: 'bash', name: 'Bash', executable, args: ['-l'], kind: 'bash' });
    return profiles;
  }

  const systemRoot = environmentValue('SystemRoot') ?? 'C:\\Windows';
  const powershell = await firstFile([
    ...pathCandidates('pwsh.exe').filter((candidate) => !/preview/i.test(candidate)),
    ...await installedPowerShellCandidates(),
  ]);
  if (powershell) profiles.push({ id: 'powershell', name: 'PowerShell', executable: powershell, args: ['-NoLogo'], kind: 'powershell' });

  const legacy = await firstFile([path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
  if (legacy) profiles.push({ id: 'powershell-legacy', name: 'Windows PowerShell', executable: legacy, args: ['-NoLogo'], kind: 'powershell' });

  const cmd = await firstFile([path.join(systemRoot, 'System32', 'cmd.exe')]);
  if (cmd) profiles.push({ id: 'cmd', name: '명령 프롬프트', executable: cmd, args: ['/d'], kind: 'cmd' });

  const gitRoots = [environmentValue('ProgramW6432'), environmentValue('ProgramFiles'), environmentValue('ProgramFiles(x86)')]
    .filter((entry): entry is string => Boolean(entry)).map((entry) => path.join(entry, 'Git'));
  const localAppData = environmentValue('LOCALAPPDATA');
  if (localAppData) gitRoots.push(path.join(localAppData, 'Programs', 'Git'));
  const gitPathRoots = pathCandidates('git.exe').map((candidate) => path.dirname(path.dirname(candidate)));
  const gitBash = await firstFile([...gitRoots, ...gitPathRoots]
    .flatMap((root) => [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]));
  if (gitBash) profiles.push({ id: 'git-bash', name: 'Git Bash', executable: gitBash, args: ['--login', '-i'], kind: 'bash' });

  const wsl = await firstFile([path.join(systemRoot, 'System32', 'wsl.exe')]);
  if (wsl) {
    for (const distribution of await wslDistributions(wsl)) {
      profiles.push({ id: `wsl:${distribution}`, name: `WSL · ${distribution}`, executable: wsl, args: ['-d', distribution], kind: 'wsl' });
    }
  }
  return profiles;
}

/** Arguments are passed separately to PTY spawn, never joined into a shell command. */
export async function resolveShellLaunch(profile: ShellProfile, cwd?: string): Promise<{ executable: string; args: string[]; cwd: string }> {
  if (!path.isAbsolute(profile.executable) || !await isFile(profile.executable)) {
    throw new AppError('SHELL_NOT_FOUND', '선택한 셸 실행 파일을 찾을 수 없습니다. 설치 상태를 확인해 주세요.');
  }
  if (cwd !== undefined && typeof cwd !== 'string' || cwd?.includes('\0')) {
    throw new AppError('INVALID_CWD', '작업 폴더 경로가 올바르지 않습니다.');
  }
  if (cwd !== undefined && cwd.trim() !== '' && (!path.isAbsolute(cwd) || WINDOWS && path.parse(cwd).root.length === 1)) {
    throw new AppError('INVALID_CWD', '작업 폴더는 접속한 컴퓨터의 절대 경로로 지정해 주세요.');
  }
  const directory = path.resolve(cwd === undefined || cwd.trim() === '' ? homedir() : cwd);
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new AppError('INVALID_CWD', '작업 폴더가 없거나 접근할 수 없습니다. 폴더를 다시 선택해 주세요.');
  }
  const args = [...profile.args];
  // WSL itself translates the Windows path; drive-letter substitution breaks custom mounts.
  if (profile.kind === 'wsl') args.push('--cd', directory);
  return { executable: profile.executable, args, cwd: directory };
}

/** Keep the user's CLI configuration, but do not inherit host secrets or launcher hooks. */
export function safeShellEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (/^(MONGLE_|ELECTRON_|NPM_|VSCODE_|CODEX_|TSX_)/.test(upper)) continue;
    if (['NODE_OPTIONS', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID',
      'NODE_INSPECT_RESUME_ON_START', 'NODE_V8_COVERAGE', 'INIT_CWD'].includes(upper)) continue;
    result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  // Git Bash's login profile otherwise changes an explicitly chosen cwd to HOME.
  result.CHERE_INVOKING = '1';
  return result;
}
