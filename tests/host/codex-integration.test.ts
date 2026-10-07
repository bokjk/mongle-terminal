import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installCodexIntegration, mergeCodexHooks, supportsCodexHooks, isManagedCodexHook, codexHookCommand, CODEX_HOOK_MARKER } from '../../packages/host/codex-integration.js';
import { CODEX_HOOK_SOURCE } from '../../packages/host/codex-hook-source.js';
import { startAgentPipe } from '../../packages/host/agent-pipe.js';
import { shellIntegration } from '../../packages/shell-profiles/integration.js';
import type { AgentSessionIdentity } from '../../packages/terminal/agent-status.js';

const run = promisify(execFile);
const TOKEN = 'ab'.repeat(32), RUN = 'cd'.repeat(16), ID = '01a1168a-fd50-7563-b070-9ee8d4a2dc42';

async function directory(t: test.TestContext, prefix = 'mongle-codex-hooks-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async()=>{assert.equal(path.dirname(dir),tmpdir());await rm(dir,{recursive:true,force:true});});
  return dir;
}
const pipeName = () => `\\\\.\\pipe\\mongle-agent-${randomBytes(16).toString('hex')}`;

function recorder() {
  const calls: {kind:'start'|'end'; token:string; session:AgentSessionIdentity}[] = [];
  return {calls, target:{start:(token:string,session:AgentSessionIdentity)=>{calls.push({kind:'start',token,session});return true;}, end:(token:string,session:AgentSessionIdentity)=>{calls.push({kind:'end',token,session});return true;}}};
}
function send(name: string, line: string) {
  return new Promise<void>(resolve=>{const s=net.connect(name);s.on('error',()=>resolve());s.on('close',()=>resolve());s.end(line);});
}
async function settle(){await new Promise(r=>setTimeout(r,50));}

test('installer keeps user hooks (even ones naming our script), writes an unquoted marked command, and is idempotent', async t => {
  const home = await directory(t), file = path.join(home, 'hooks.json');
  const script = path.join(home, 'mongle-terminal-codex-hook.cjs');
  const userEcho = {type:'command', command:`echo ${script}`};
  const original = {hooks:{SessionStart:[{matcher:'startup', hooks:[{type:'command', command:'user-start'}, userEcho]}], Stop:[{hooks:[{type:'command', command:'user-stop'}]}]}};
  const raw = JSON.stringify(original, null, 4); await writeFile(file, raw);
  await writeFile(path.join(home, 'config.toml'), 'notify = ["user-notify"]\n');
  const result = await installCodexIntegration({codexHome:home, version:'0.160.0'});
  assert.equal(result.status, 'installed');
  assert.match(result.message, /\/hooks/);
  const current = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(current.hooks.SessionStart[0], original.hooks.SessionStart[0], 'user group kept verbatim');
  assert.deepEqual(current.hooks.Stop, original.hooks.Stop);
  for (const event of ['SessionStart', 'SessionEnd']) {
    const managed = current.hooks[event].flatMap((g:any)=>g.hooks).filter((h:any)=>isManagedCodexHook(h, script));
    assert.equal(managed.length, 1);
    assert.equal(managed[0].timeout, 3);
    assert.ok(!managed[0].command.includes('"'), 'Windows hook runner gets an unquoted command');
    assert.ok(managed[0].command.endsWith(` ${script} ${CODEX_HOOK_MARKER}`));
  }
  assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), 'notify = ["user-notify"]\n', 'config.toml (notify, trust) untouched');
  assert.equal(await readFile(script, 'utf8'), CODEX_HOOK_SOURCE);
  const files = await readdir(home);
  assert.equal(await readFile(path.join(home, files.find(n=>n.includes('.mongle-backup-'))!), 'utf8'), raw);
  await installCodexIntegration({codexHome:home, version:'0.160.1'});
  assert.deepEqual(await readdir(home), files, 'no duplicate hooks or backup clutter');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), current, 'command text is stable so Codex trust is kept');
});

test('installer refuses old CLIs, malformed files and paths it cannot pass unquoted', async t => {
  assert.equal(supportsCodexHooks('0.159.9'), false);
  assert.equal(supportsCodexHooks('0.160.0'), true);
  assert.equal(supportsCodexHooks(undefined), false);
  const home = await directory(t);
  assert.equal((await installCodexIntegration({codexHome:home, version:'0.150.0'})).status, 'unavailable');
  assert.deepEqual(await readdir(home), [], 'old CLI: nothing written');
  await writeFile(path.join(home, 'hooks.json'), '{"hooks":[]}');
  assert.equal((await installCodexIntegration({codexHome:home, version:'0.160.0'})).status, 'unavailable');
  assert.equal(await readFile(path.join(home, 'hooks.json'), 'utf8'), '{"hooks":[]}');
  const spaced = await directory(t, 'mongle codex ');
  assert.equal((await installCodexIntegration({codexHome:spaced, version:'0.160.0'})).status, 'unavailable');
  assert.deepEqual(await readdir(spaced), []);
  assert.throws(()=>codexHookCommand('C:\\Program Files\\node.exe', 'C:\\x\\h.cjs'));
  assert.throws(()=>mergeCodexHooks({hooks:{SessionEnd:{}}}, 'C:\\r\\node-' + 'a'.repeat(64) + '.exe', 'C:\\x\\h.cjs'));
});

function invoke(script: string, value: unknown, env: Record<string,string|undefined>) {
  return new Promise<{out:string;err:string}>((resolve,reject)=>{
    const e={...process.env};for(const k of ['MONGLE_AGENT_TOKEN','MONGLE_AGENT_PIPE','MONGLE_CODEX_RUN'])delete e[k];
    for(const [k,v] of Object.entries(env))if(v!==undefined)e[k]=v;
    const child=spawn(process.execPath,[script],{env:e,windowsHide:true});
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
    child.on('error',reject);child.on('exit',()=>resolve({out,err}));
    child.stdin.on('error',()=>{});child.stdin.end(typeof value==='string'?value:JSON.stringify(value));
  });
}

test('hook forwards only exact wrapped lifecycle events over the pipe and never prints', async t => {
  const dir = await directory(t), script = path.join(dir, 'hook.cjs'); await writeFile(script, CODEX_HOOK_SOURCE);
  const name = pipeName(), lines: any[] = [];
  const server = net.createServer(s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>lines.push(JSON.parse(d)));});
  await new Promise<void>(r=>server.listen(name,r)); t.after(()=>server.close());
  const env = {MONGLE_AGENT_TOKEN:TOKEN, MONGLE_AGENT_PIPE:name, MONGLE_CODEX_RUN:RUN};
  const start = {session_id:ID.toUpperCase(), cwd:'D:\\work', hook_event_name:'SessionStart', source:'startup', transcript_path:'C:\\secret.jsonl', model:'m'};
  for (const [value, e] of [
    [start, {...env, MONGLE_CODEX_RUN:undefined}],            // unwrapped / shared daemon
    [start, {...env, MONGLE_AGENT_TOKEN:'x'}],
    [{...start, agent_id:'sub'}, env],                         // subagent
    [{...start, session_id:'latest'}, env],
    [{...start, hook_event_name:'UserPromptSubmit', prompt:'secret'}, env],
    ['not json', env],
  ] as const) { const r = await invoke(script, value, e as any); assert.equal(r.out+r.err, ''); }
  await settle(); assert.deepEqual(lines, []);
  assert.deepEqual(await invoke(script, start, env), {out:'', err:''});
  assert.deepEqual(await invoke(script, {session_id:ID, hook_event_name:'SessionEnd', reason:'other'}, env), {out:'', err:''});
  await settle();
  assert.deepEqual(lines, [
    {v:1, token:TOKEN, run:RUN, event:'SessionStart', sessionId:ID, cwd:'D:\\work'},
    {v:1, token:TOKEN, run:RUN, event:'SessionEnd', sessionId:ID},
  ], 'no transcript path, model or prompt leaves the hook');
});

test('pipe ends only the identical run+conversation and never sends a generic clear', async t => {
  const {calls, target} = recorder();
  const pipe = await startAgentPipe(target, {name:pipeName()}); t.after(()=>pipe.close());
  const msg = (o: object) => JSON.stringify({v:1, token:TOKEN, run:RUN, ...o}) + '\n';
  const OTHER = '01a1168a-fd50-7563-b070-000000000000';
  await send(pipe.name, msg({event:'SessionStart', sessionId:ID, cwd:'D:\\work'}));
  await send(pipe.name, msg({event:'SessionEnd', sessionId:OTHER}));              // stale/other conversation
  await send(pipe.name, msg({event:'SessionEnd', sessionId:ID, run:'ef'.repeat(16)})); // other run
  await send(pipe.name, msg({event:'SessionStart', sessionId:'not-a-uuid'}));
  await send(pipe.name, JSON.stringify({v:1, token:'zz', run:RUN, event:'SessionStart', sessionId:ID}) + '\n');
  await send(pipe.name, 'x'.repeat(5000) + '\n');
  await settle();
  assert.deepEqual(calls, [{kind:'start', token:TOKEN, session:{provider:'codex', sessionId:ID, cwd:'D:\\work'}}]);
  await send(pipe.name, msg({event:'SessionEnd', sessionId:ID}));
  await send(pipe.name, msg({event:'SessionEnd', sessionId:ID}));
  await settle();
  assert.deepEqual(calls.slice(1), [{kind:'end', token:TOKEN, session:{provider:'codex', sessionId:ID}}], 'one identity-bound end');
});

test('pipe handles chunked lines once, drops forgotten or rejected shells, caps tracking, and closes open sockets', async t => {
  const {calls, target} = recorder();
  const pipe = await startAgentPipe(target, {name:pipeName()}); t.after(()=>pipe.close());
  const line = JSON.stringify({v:1, token:TOKEN, run:RUN, event:'SessionStart', sessionId:ID}) + '\n';
  await new Promise<void>(resolve=>{const s=net.connect(pipe.name,()=>{s.write(line.slice(0,10));setTimeout(()=>{s.write(line.slice(10)+line);s.end();},20);});s.on('close',()=>resolve());s.on('error',()=>resolve());});
  await settle();
  assert.equal(calls.length, 1, 'chunked line handled once; a second line on the same socket is ignored');
  pipe.forget(TOKEN);
  await send(pipe.name, JSON.stringify({v:1, token:TOKEN, run:RUN, event:'SessionEnd', sessionId:ID}) + '\n');
  await settle();
  assert.equal(calls.length, 1, 'forgotten shell: late end is ignored');
  const rejecting = await startAgentPipe({start:()=>false, end:()=>{throw new Error('no end');}}, {name:pipeName()}); t.after(()=>rejecting.close());
  await send(rejecting.name, line); await settle();
  assert.equal(rejecting.tracked, 0, 'a token the host rejects is not tracked');
  for (let i = 0; i < 300; i++) await send(pipe.name, JSON.stringify({v:1, token:i.toString(16).padStart(64,'0'), run:RUN, event:'SessionStart', sessionId:ID}) + '\n');
  assert.ok(pipe.tracked <= 256);
  const idle = net.connect(pipe.name); idle.on('error',()=>{});
  await new Promise(r=>idle.once('connect',r));
  const closedAt = Date.now(); await pipe.close();
  assert.ok(Date.now() - closedAt < 1000, 'close does not wait for idle sockets');
});

test('only PowerShell shells with a token get the pipe and the codex wrapper', () => {
  const name = pipeName(), env = {MONGLE_AGENT_TOKEN:TOKEN, MONGLE_CODEX_RUN:RUN, MONGLE_AGENT_PIPE:'stale'};
  const ps = shellIntegration({kind:'powershell'} as any, [], env, {agentPipe:name});
  assert.equal(ps.env.MONGLE_AGENT_PIPE, name); assert.equal(ps.env.MONGLE_CODEX_RUN, undefined);
  assert.match(Buffer.from(ps.args.at(-1)!, 'base64').toString('utf16le'), /function global:codex/);
  for (const kind of ['cmd', 'bash'] as const) {
    const other = shellIntegration({kind} as any, [], env, {agentPipe:name});
    assert.equal(other.env.MONGLE_AGENT_PIPE, undefined); assert.equal(other.env.MONGLE_CODEX_RUN, undefined);
  }
  const noToken = shellIntegration({kind:'powershell'} as any, [], {}, {agentPipe:name});
  assert.equal(noToken.env.MONGLE_AGENT_PIPE, undefined);
  assert.doesNotMatch(Buffer.from(noToken.args.at(-1)!, 'base64').toString('utf16le'), /function global:codex/);
});

test('PowerShell wrapper adds --no-daemon and a run nonce only to interactive launches', {skip: process.platform !== 'win32'}, async t => {
  const dir = await directory(t), bin = path.join(dir, 'bin'); await mkdir(bin);
  // A .cmd fixture is independent of the PowerShell execution policy of the test machine.
  await writeFile(path.join(bin, 'print.cjs'), "process.stdout.write('ARGS=' + process.argv.slice(2).join('|') + ';RUN=' + (process.env.MONGLE_CODEX_RUN || '') + '\\n')\n");
  await writeFile(path.join(bin, 'codex.cmd'), `@"${process.execPath}" "%~dp0print.cjs" %*\r\n`);
  const integration = shellIntegration({kind:'powershell'} as any, [], {MONGLE_AGENT_TOKEN:TOKEN}, {agentPipe:pipeName()});
  const wrapper = Buffer.from(integration.args.at(-1)!, 'base64').toString('utf16le');
  // This suite may itself run inside a Codex turn; model an ordinary user shell.
  // Exactly one PATH key: Windows env names are case-insensitive, and a leftover
  // 'PATH' next to 'Path' could win and hide the fixture directory.
  const outside: NodeJS.ProcessEnv = {}, searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH' && key !== 'CODEX_THREAD_ID') outside[key] = value;
  const call = async (line: string, prelude = '') => {
    const script = prelude + wrapper + '\n' + line + "\nWrite-Output ('AFTER=' + [string]$env:MONGLE_CODEX_RUN)";
    const env: NodeJS.ProcessEnv = {...outside, ...integration.env};
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.Path = bin + ';relative\\dir;' + searchPath;
    const {stdout, stderr} = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {env, windowsHide:true, timeout:30000});
    const lines = stdout.trim().split(/\r?\n/);
    if (!lines[0]?.startsWith('ARGS=') && !lines[0]?.startsWith('USER')) assert.fail(`wrapper produced no CLI output for ${line}: ${stderr.trim()}`);
    return lines;
  };
  const [interactive, after] = await call('codex -m gpt "fix it"');
  assert.match(interactive, /^ARGS=--no-daemon\|-m\|gpt\|fix it;RUN=[a-f0-9]{32}$/); assert.equal(after, 'AFTER=');
  assert.match((await call(`codex resume ${ID}`))[0], new RegExp(`^ARGS=resume\\|--no-daemon\\|${ID};RUN=[a-f0-9]{32}$`));
  assert.match((await call('codex -m exec'))[0], /^ARGS=--no-daemon\|-m\|exec;RUN=/, 'option values are not subcommands');
  for (const line of ['codex exec hi', 'codex --remote ws://h:1', `codex resume ${ID} --remote ws://h:1`, 'codex -m x --remote=ws://h:1', 'codex login', 'codex --version'])
    assert.equal((await call(line))[0], 'ARGS=' + line.split(' ').slice(1).join('|') + ';RUN=', line);
  assert.match((await call('codex --no-daemon'))[0], /^ARGS=--no-daemon;RUN=[a-f0-9]{32}$/, 'explicit --no-daemon is kept once and still captured');
  assert.equal((await call('codex', '$env:CODEX_THREAD_ID = "t"\n'))[0], 'ARGS=;RUN=', 'Codex launched inside a Codex turn is not captured');
  assert.equal((await call('codex', 'function codex { Write-Output "USER" }\n'))[0], 'USER', 'existing user function is kept');
  assert.match((await call(`__MongleCodex resume ${ID}`, 'function codex { Write-Output "USER" }\n'))[0], new RegExp(`^ARGS=resume\\|--no-daemon\\|${ID};RUN=[a-f0-9]{32}$`), 'host resume entry works even beside a user codex function');
});
