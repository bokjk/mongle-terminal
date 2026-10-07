import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink, lstat, stat, open, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { CLAUDE_HOOK_EVENTS, CLAUDE_HOOK_SOURCE } from './claude-hook-source.js';
import type { ClaudeIntegration } from '../protocol/index.js';

const exec = promisify(execFile);
const marker = '--mongle-claude-hook-v1';
const plain = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unavailable = (message: string): ClaudeIntegration => ({status:'unavailable', message});

async function installationLock(file: string) {
  try { return await open(file, 'wx', 0o600); }
  catch(e:any) {
    if(e.code !== 'EEXIST')throw e;
    const info=await lstat(file);
    if(!info.isFile() || info.isSymbolicLink() || info.size>1024 || Date.now()-info.mtimeMs<30000)throw e;
    const raw=await readFile(file,'utf8');
    let pid:number;try {pid=JSON.parse(raw).pid;}catch{throw e;}
    if(!Number.isSafeInteger(pid)||pid<1)throw e;
    try {process.kill(pid,0);throw e;}catch(probe:any){if(probe.code!=='ESRCH')throw e;}
    if(await readFile(file,'utf8')!==raw)throw e;
    await unlink(file);
    return await open(file,'wx',0o600);
  }
}

export async function installedClaudeVersion(): Promise<string | undefined> {
  const roots = [...(process.env.PATH || process.env.Path || '').split(path.delimiter).map(p=>p.replace(/^"(.*)"$/,'')).filter(path.isAbsolute), path.join(homedir(), '.local', 'bin')];
  for (const root of [...new Set(roots)]) {
    try {
      const native = path.join(root, process.platform === 'win32' ? 'claude.exe' : 'claude');
      const npm = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      const direct = await stat(native).then(s=>s.isFile(),()=>false);
      if (!direct && !await stat(npm).then(s=>s.isFile(),()=>false)) continue;
      const {stdout} = await exec(direct ? native : process.execPath, direct ? ['--version'] : [npm,'--version'], {windowsHide:true, timeout:4000, maxBuffer:4096});
      return stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    } catch { /* Try another installed native CLI. */ }
  }
  return undefined;
}

async function digest(file: string) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');
}

/** Keep the tiny integration independent of the app's installation/ZIP lifetime.
 * The already-bundled Node is cached once by digest, not downloaded or installed on PATH. */
async function durableRuntime(configDir: string, node: string) {
  const directory=path.join(configDir,'mongle-terminal-runtime');
  await mkdir(directory,{recursive:true});
  if((await lstat(directory)).isSymbolicLink())throw new Error('linked runtime');
  const hash=await digest(node), destination=path.join(directory,`node-${hash}${process.platform==='win32'?'.exe':''}`);
  // Packaged runtimes carry their own matching license; keep it with the durable copy.
  for(const name of ['NODE-LICENSE.txt','LICENSE']) {
    let license:string;
    try {license=await readFile(path.join(path.dirname(node),name),'utf8');}
    catch(e:any){if(e.code==='ENOENT')continue;throw e;}
    const licensePath=path.join(directory,`node-${hash}-LICENSE.txt`);
    try {await writeFile(licensePath,license,{flag:'wx',mode:0o600});}
    catch(e:any){if(e.code!=='EEXIST')throw e;}
    break;
  }
  try {
    const info=await lstat(destination);
    if(!info.isFile() || info.isSymbolicLink() || await digest(destination)!==hash)throw new Error('invalid cached runtime');
    return destination;
  } catch(e:any) {if(e.code!=='ENOENT')throw e;}
  const temp=destination+'.'+randomUUID()+'.tmp';
  try {await copyFile(node,temp);if(await digest(temp)!==hash)throw new Error('runtime changed');await rename(temp,destination);}
  finally {await unlink(temp).catch(()=>{});}
  return destination;
}

export function supportsClaudeHooks(version: string | undefined) {
  const parts = version?.split('.').map(Number);
  return Boolean(parts && parts.length === 3 && parts.every(Number.isInteger)
    && (parts[0] > 2 || parts[0] === 2 && (parts[1] > 1 || parts[1] === 1 && parts[2] >= 292)));
}

/** Merge only our identified entries; malformed/disabled settings are never repaired or enabled. */
export function mergeClaudeHooks(config: unknown, node: string, script: string): Record<string, unknown> {
  if (!plain(config) || config.disableAllHooks === true || config.allowManagedHooksOnly === true) throw new Error('disabled');
  if (config.hooks !== undefined && !plain(config.hooks)) throw new Error('invalid hooks');
  const hooks = {...config.hooks};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const old = hooks[event];
    if (old !== undefined && !Array.isArray(old)) throw new Error('invalid event');
    const kept = (old || []).flatMap((definition: unknown) => {
      if (!plain(definition) || !Array.isArray(definition.hooks)) throw new Error('invalid definition');
      const entries = definition.hooks.filter((entry: any) => !(plain(entry) && entry.type === 'command'
        && Array.isArray(entry.args) && entry.args[1] === marker
        && typeof entry.args[0] === 'string' && path.basename(entry.args[0]) === 'mongle-terminal-hook.cjs'));
      return entries.length ? [{...definition, hooks:entries}] : [];
    });
    hooks[event] = [...kept, {hooks:[{type:'command', command:node, args:[script, marker], timeout:2}]}];
  }
  return {...config, hooks};
}

export async function installClaudeIntegration(options: {configDir: string; node?: string; version?: string}): Promise<ClaudeIntegration> {
  if (!supportsClaudeHooks(options.version)) return unavailable('Claude Code 2.1.292 이상을 설치한 뒤 실행부를 다시 시작하면 자동으로 연결됩니다.');
  if (!path.isAbsolute(options.configDir)) return unavailable('Claude 설정 폴더는 절대 경로여야 자동으로 연결할 수 있습니다.');
  const configDir = path.resolve(options.configDir);
  const settings = path.join(configDir, 'settings.json');
  const script = path.join(configDir, 'mongle-terminal-hook.cjs');
  const lockPath = path.join(configDir, 'mongle-terminal-hook.lock');
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const temp = `${settings}.mongle-${randomUUID()}.tmp`;
  const scriptTemp = `${script}.${randomUUID()}.tmp`;
  try {
    await mkdir(configDir, {recursive:true});
    if ((await lstat(configDir)).isSymbolicLink()) throw new Error('linked directory');
    lock = await installationLock(lockPath);
    await lock.writeFile(JSON.stringify({pid:process.pid}));
    let original: string | undefined;
    try {
      const info = await lstat(settings);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('invalid settings');
      original = await readFile(settings, 'utf8');
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const config = original === undefined ? {} : JSON.parse(original.replace(/^\uFEFF/, ''));
    // Validate the user's structure/opt-out before preparing any managed executable.
    mergeClaudeHooks(config, options.node || process.execPath, script);
    let oldScript: string | undefined;
    try {
      const info = await lstat(script);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('invalid script');
      oldScript = await readFile(script, 'utf8');
      if (!oldScript.startsWith('// Mongle Terminal managed Claude hook v1\n')) throw new Error('unowned script');
    } catch (e: any) { if(e.code !== 'ENOENT') throw e; }
    const runtime = await durableRuntime(configDir, options.node || process.execPath);
    const next = mergeClaudeHooks(config, runtime, script);
    // Each host writes the same generic helper; it contains no boot/terminal secret.
    if(oldScript !== CLAUDE_HOOK_SOURCE) {
      await writeFile(scriptTemp, CLAUDE_HOOK_SOURCE, {flag:'wx', mode:0o600});
      await rename(scriptTemp, script);
    }
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      if (original !== undefined) await writeFile(`${settings}.mongle-backup-${randomUUID()}`, original, {flag:'wx', mode:0o600});
      await writeFile(temp, JSON.stringify(next, null, 2) + '\n', {flag:'wx', mode:0o600});
      // Fail closed on a concurrent user edit; no lost settings updates.
      const latest = await readFile(settings, 'utf8').catch((e: any) => { if(e.code === 'ENOENT') return undefined; throw e; });
      if (latest !== original) throw new Error('concurrent edit');
      await rename(temp, settings);
    }
    return {status:'ready'};
  } catch {
    return unavailable('Claude 자동 연동을 준비하지 못했습니다. 설정 파일의 접근 권한이나 훅 비활성화 설정을 확인해 주세요.');
  } finally {
    await unlink(temp).catch(()=>{});
    await unlink(scriptTemp).catch(()=>{});
    if(lock) { await lock.close(); await unlink(lockPath).catch(()=>{}); }
  }
}
