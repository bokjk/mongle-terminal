import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TeamMemberSpec, TeamModel } from '../protocol/index.js';
import { TEAM_MODEL } from './teams.js';
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
  /** The models the installed CLI offers, or undefined when it cannot say. Never sends a model request. */
  models(provider: Provider): Promise<TeamModel[] | undefined>;
}

/**
 * The models Codex's own picker lists, in its order, from `codex debug models` (the catalog Codex keeps
 * up to date itself). Hidden models stay hidden; an id the launch line could not carry is left out.
 */
export function codexModels(output: string): TeamModel[] {
  const data = JSON.parse(output) as { models?: { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; priority?: unknown }[] };
  if (!Array.isArray(data.models)) return [];
  return data.models
    .filter(model => typeof model.slug === 'string' && model.slug !== '' && TEAM_MODEL.test(model.slug) && (model.visibility === undefined || model.visibility === 'list'))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .slice(0, 40)
    .map(model => {
      const id = model.slug as string, label = typeof model.display_name === 'string' && model.display_name.trim() ? model.display_name.trim().slice(0, 80) : id;
      const description = typeof model.description === 'string' ? model.description.trim().slice(0, 200) : '';
      return { id, label, ...(description ? { description } : {}) };
    });
}

const CLAUDE_FAMILIES: Record<string, string> = { opus: '가장 뛰어난 Opus', sonnet: '균형 잡힌 Sonnet', haiku: '빠른 Haiku' };
/**
 * Claude Code has no model list; its --model help names the aliases that always mean a family's latest
 * model. Those come first, then the long-standing families it may not mention.
 */
export function claudeModels(help: string): TeamModel[] {
  const section = /--model <model>([\s\S]*?)(?:\r?\n\s*-{1,2}[A-Za-z]|$)/.exec(help)?.[1] ?? '';
  const named = [...section.matchAll(/'([a-z][a-z0-9-]{1,30})'/g)].map(match => match[1]);
  return [...new Set([...named, 'opus', 'sonnet', 'haiku'])].map(id => ({ id, label: id, description: (CLAUDE_FAMILIES[id] ?? id[0].toUpperCase() + id.slice(1)) + ' 계열의 최신 모델을 가리키는 별칭' }));
}

async function run(file: string, args: string[], cwd?: string, limits = { timeout: 8000, maxBuffer: 256 * 1024 }) {
  const options = { windowsHide: true, ...limits, ...(cwd ? { cwd } : {}), env: safeShellEnvironment() };
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
  async models(provider) {
    const file = await this.executable(provider);
    if (!file) return undefined;
    try {
      // The Codex catalog carries each model's instructions, so it is large.
      if (provider === 'codex') return codexModels((await run(file, ['debug', 'models'], undefined, { timeout: 20000, maxBuffer: 32 * 1024 * 1024 })).stdout);
      return claudeModels((await run(file, ['--help'])).stdout);
    } catch { return undefined; }
  },
  async gitChanges(cwd) {
    try {
      const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--no-renames'], { cwd, windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
      return stdout.split('\n').filter(line => line.trim()).length;
    } catch { return undefined; }
  },
};
