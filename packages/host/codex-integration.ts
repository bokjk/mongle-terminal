import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink, lstat, open, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CODEX_HOOK_EVENTS, CODEX_HOOK_SOURCE } from './codex-hook-source.js';
import { resolveAgentExecutable } from '../shell-profiles/agent-resume.js';
import type { CodexIntegration } from '../protocol/index.js';

const exec = promisify(execFile);
export type { CodexIntegration };
export const CODEX_HOOK_MARKER = '--mongle-codex-hook-v1';
const SCRIPT = 'mongle-terminal-codex-hook.cjs';
const HEADER = '// Mongle Terminal managed Codex hook v1\n';
/** Minimum targeted CLI version (has --no-daemon and SessionStart/SessionEnd hooks). Not yet verified with normal hook trust. */
export const MIN_CODEX_VERSION = '0.160.0';
const plain = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unavailable = (message: string): CodexIntegration => ({status:'unavailable', message});

/**
 * Codex runs Windows hook commands as cmd.exe /C "<command>" (codex-rs
 * hooks/src/engine/command_runner.rs); commands with embedded quotes can fail
 * there (openai/codex#38168, and a quoted command exited 1 in our isolated
 * probe). So only plain absolute paths without spaces or shell metacharacters
 * are written, unquoted. A Codex home with spaces is reported as unsupported.
 */
export function plainCommandPath(value: string) {
  return /^[a-z]:\\/i.test(value) && !/[\s"'%!^&|<>()`$;,=@{}\[\]\x00-\x1f\x7f]/.test(value);
}

export function codexHookCommand(node: string, script: string) {
  if (!plainCommandPath(node) || !plainCommandPath(script)) throw new Error('unsupported path');
  return `${node} ${script} ${CODEX_HOOK_MARKER}`;
}

/** Exactly our own generated command for this script path; any other command is the user's. */
export function isManagedCodexHook(entry: unknown, script: string) {
  if (!plain(entry) || entry.type !== 'command' || typeof entry.command !== 'string') return false;
  const parts = entry.command.split(' ');
  return parts.length === 3 && parts[2] === CODEX_HOOK_MARKER && parts[1].toLowerCase() === script.toLowerCase()
    && plainCommandPath(parts[0]) && /^node-[a-f0-9]{64}\.exe$/i.test(path.win32.basename(parts[0]));
}

/** Adds one managed SessionStart/SessionEnd command; every other hook group and entry is preserved. */
export function mergeCodexHooks(config: unknown, node: string, script: string): Record<string, unknown> {
  if (!plain(config)) throw new Error('invalid hooks.json');
  if (config.hooks !== undefined && !plain(config.hooks)) throw new Error('invalid hooks');
  const command = codexHookCommand(node, script);
  const hooks = {...config.hooks};
  for (const event of CODEX_HOOK_EVENTS) {
    const old = hooks[event];
    if (old !== undefined && !Array.isArray(old)) throw new Error('invalid event');
    const kept = (old || []).flatMap((group: unknown) => {
      if (!plain(group) || !Array.isArray(group.hooks)) throw new Error('invalid group');
      const entries = group.hooks.filter((entry: unknown) => !isManagedCodexHook(entry, script));
      return entries.length === group.hooks.length ? [group] : entries.length ? [{...group, hooks:entries}] : [];
    });
    // SessionEnd hooks are capped at 3 seconds by Codex; use the same bound for both events.
    hooks[event] = [...kept, {hooks:[{type:'command', command, timeout:3}]}];
  }
  return {...config, hooks};
}

/** The existing managed runtime path is kept while it is valid so the trusted command text does not change. */
function managedRuntime(config: unknown, script: string): string | undefined {
  if (!plain(config) || !plain(config.hooks)) return;
  for (const event of CODEX_HOOK_EVENTS) for (const group of Array.isArray(config.hooks[event]) ? config.hooks[event] : [])
    for (const entry of plain(group) && Array.isArray(group.hooks) ? group.hooks : [])
      if (isManagedCodexHook(entry, script)) return entry.command.split(' ')[0];
}

export function supportsCodexHooks(version: string | undefined) {
  const parts = version?.split('.').map(Number), min = MIN_CODEX_VERSION.split('.').map(Number);
  if (!parts || parts.length !== 3 || !parts.every(Number.isInteger)) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== min[i]) return parts[i] > min[i];
  return true;
}

export async function installedCodexVersion(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const cli = await resolveAgentExecutable('codex', env);
  if (!cli) return;
  try {
    const {stdout} = cli.kind === 'exe'
      ? await exec(cli.path, ['--version'], {windowsHide:true, timeout:5000, maxBuffer:4096})
      : await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cli.path}" --version`], {windowsHide:true, timeout:5000, maxBuffer:4096, windowsVerbatimArguments:true});
    return stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  } catch { return; }
}

async function digest(file: string) { const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex'); }

/** Same durable, digest-named Node copy (with its license) as the Claude integration. */
async function durableRuntime(home: string, node: string) {
  const directory=path.join(home,'mongle-terminal-runtime');
  await mkdir(directory,{recursive:true});
  if((await lstat(directory)).isSymbolicLink())throw new Error('linked runtime');
  const hash=await digest(node), destination=path.join(directory,`node-${hash}.exe`);
  for(const name of ['NODE-LICENSE.txt','LICENSE']) {
    let license:string;
    try {license=await readFile(path.join(path.dirname(node),name),'utf8');}
    catch(e:any){if(e.code==='ENOENT')continue;throw e;}
    try {await writeFile(path.join(directory,`node-${hash}-LICENSE.txt`),license,{flag:'wx',mode:0o600});}
    catch(e:any){if(e.code!=='EEXIST')throw e;}
    break;
  }
  try {
    const info=await lstat(destination);
    if(!info.isFile()||info.isSymbolicLink()||await digest(destination)!==hash)throw new Error('invalid cached runtime');
    return destination;
  } catch(e:any){if(e.code!=='ENOENT')throw e;}
  const temp=destination+'.'+randomUUID()+'.tmp';
  try {await copyFile(node,temp);if(await digest(temp)!==hash)throw new Error('runtime changed');await rename(temp,destination);}
  finally {await unlink(temp).catch(()=>{});}
  return destination;
}

async function validRuntime(file: string) {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) return false;
    return path.win32.basename(file).toLowerCase() === `node-${await digest(file)}.exe`; } catch { return false; }
}

/**
 * Writes the managed hook into <codexHome>/hooks.json. Never edits config.toml
 * (so the user's notify and hook trust state stay untouched), auth or sessions.
 */
export async function installCodexIntegration(options: {codexHome: string; node?: string; version?: string}): Promise<CodexIntegration> {
  if (!supportsCodexHooks(options.version)) return unavailable(`Codex CLI ${MIN_CODEX_VERSION} 이상을 설치한 뒤 실행부를 다시 시작하면 자동 재개를 준비합니다.`);
  if (!path.isAbsolute(options.codexHome)) return unavailable('Codex 설정 폴더는 절대 경로여야 자동 재개를 준비할 수 있습니다.');
  const home = path.resolve(options.codexHome);
  const file = path.join(home, 'hooks.json'), script = path.join(home, SCRIPT), lockPath = path.join(home, 'mongle-terminal-codex-hook.lock');
  if (!plainCommandPath(script)) return unavailable('Codex 설정 폴더 경로에 공백이나 특수 문자가 있어 자동 재개 훅을 등록할 수 없습니다.');
  const temp = `${file}.mongle-${randomUUID()}.tmp`, scriptTemp = `${script}.${randomUUID()}.tmp`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(home, {recursive:true});
    if ((await lstat(home)).isSymbolicLink()) throw new Error('linked directory');
    lock = await open(lockPath, 'wx', 0o600);
    let original: string | undefined;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('invalid hooks.json');
      original = await readFile(file, 'utf8');
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const config = original === undefined ? {} : JSON.parse(original.replace(/^\uFEFF/, ''));
    // Validate the user's structure before preparing any managed executable.
    if (!plain(config) || (config.hooks !== undefined && !plain(config.hooks))) throw new Error('invalid hooks.json');
    let oldScript: string | undefined;
    try {
      const info = await lstat(script);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('invalid script');
      oldScript = await readFile(script, 'utf8');
      if (!oldScript.startsWith(HEADER)) throw new Error('unowned script');
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const existing = managedRuntime(config, script);
    const runtime = existing && await validRuntime(existing) ? existing : await durableRuntime(home, options.node || process.execPath);
    const next = mergeCodexHooks(config, runtime, script);
    if (oldScript !== CODEX_HOOK_SOURCE) {
      await writeFile(scriptTemp, CODEX_HOOK_SOURCE, {flag:'wx', mode:0o600});
      await rename(scriptTemp, script);
    }
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      if (original !== undefined) await writeFile(`${file}.mongle-backup-${randomUUID()}`, original, {flag:'wx', mode:0o600});
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', {flag:'wx', mode:0o600});
      const latest = await readFile(file, 'utf8').catch((e: any) => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (latest !== original) throw new Error('concurrent edit');
      await rename(temp, file);
    }
    return {status:'installed', message:'Codex 훅을 등록했습니다. Codex에서 /hooks를 열어 몽글터미널 훅을 한 번 신뢰해야 동작합니다.'};
  } catch {
    return unavailable('Codex 자동 재개를 준비하지 못했습니다. Codex 설정 폴더의 hooks.json 형식과 접근 권한을 확인해 주세요.');
  } finally {
    await unlink(temp).catch(()=>{});
    await unlink(scriptTemp).catch(()=>{});
    if (lock) { await lock.close(); await unlink(lockPath).catch(()=>{}); }
  }
}
