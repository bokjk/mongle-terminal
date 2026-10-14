import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TeamMemberSpec } from '../protocol/index.js';
import { resolveAgentExecutable } from '../shell-profiles/agent-resume.js';
import { safeShellEnvironment } from '../shell-profiles/index.js';
import { installedClaudeVersion } from './claude-integration.js';
import { installedCodexVersion } from './codex-integration.js';

const exec = promisify(execFile);
type Provider = TeamMemberSpec['provider'];

/** What the pre-start check asks this PC. Replaced in tests; never sends a model request. */
export interface TeamEnvironment {
  executable(provider: Provider): Promise<string | undefined>;
  version(provider: Provider): Promise<string | undefined>;
  /** undefined when the CLI did not say. */
  loggedIn(provider: Provider): Promise<boolean | undefined>;
  /** Uncommitted changes in the folder's Git working tree, or undefined outside a repository. */
  gitChanges(cwd: string): Promise<number | undefined>;
}

async function run(file: string, args: string[], cwd?: string) {
  const options = { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024, ...(cwd ? { cwd } : {}), env: safeShellEnvironment() };
  // npm shims are .cmd files, which need cmd; the path is host-resolved and contains no quote.
  if (/\.cmd$/i.test(file)) return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + file + '" ' + args.join(' ')], { ...options, windowsVerbatimArguments: true });
  return exec(file, args, options);
}

export const defaultTeamEnvironment: TeamEnvironment = {
  async executable(provider) { return (await resolveAgentExecutable(provider, safeShellEnvironment()))?.path; },
  version(provider) { return provider === 'claude' ? installedClaudeVersion() : installedCodexVersion(safeShellEnvironment()); },
  async loggedIn(provider) {
    const file = await this.executable(provider);
    if (!file) return false;
    try {
      if (provider === 'claude') {
        const { stdout } = await run(file, ['auth', 'status']);
        const value = JSON.parse(stdout) as { loggedIn?: unknown };
        return typeof value.loggedIn === 'boolean' ? value.loggedIn : undefined;
      }
      const { stdout, stderr } = await run(file, ['login', 'status']);
      return /logged in/i.test(stdout + stderr) ? true : undefined;
    } catch (error) {
      // Both CLIs exit with an error status when nobody is logged in.
      const output = String((error as { stdout?: unknown }).stdout ?? '') + String((error as { stderr?: unknown }).stderr ?? '');
      if (/"loggedIn"\s*:\s*false|not logged in/i.test(output)) return false;
      return undefined;
    }
  },
  async gitChanges(cwd) {
    try {
      const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--no-renames'], { cwd, windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
      return stdout.split('\n').filter(line => line.trim()).length;
    } catch { return undefined; }
  },
};
