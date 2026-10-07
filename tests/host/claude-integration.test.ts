import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installClaudeIntegration, mergeClaudeHooks, supportsClaudeHooks } from '../../packages/host/claude-integration.js';
import { CLAUDE_HOOK_EVENTS } from '../../packages/host/claude-hook-source.js';

async function directory(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(),'mongle-claude-hooks-'));
  t.after(async()=>{assert.equal(path.dirname(dir),tmpdir());assert.ok(path.basename(dir).startsWith('mongle-claude-hooks-'));await rm(dir,{recursive:true,force:true});});
  return dir;
}
function invoke(script: string, value: unknown, token?: string, runtime = process.execPath) {
  return new Promise<{out:string;err:string;code:number|null}>((resolve,reject)=>{
    const env={...process.env};delete env.MONGLE_AGENT_TOKEN;
    if(token)env.MONGLE_AGENT_TOKEN=token;
    const child=spawn(runtime,[script],{env,windowsHide:true});
    let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);
    child.on('error',reject);child.on('exit',code=>resolve({out,err,code}));
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(value));
  });
}

test('automatic installer preserves all other settings/hooks, backs up, and is idempotent',async t=>{
  const configDir=await directory(t), file=path.join(configDir,'settings.json');
  const original={model:'user-model',permissions:{deny:['example']},statusLine:{type:'command',command:'user-status'},hooks:{Stop:[{matcher:'',hooks:[{type:'command',command:'user-stop'}]}],SessionStart:[{hooks:[{type:'command',command:'user-start'}]}]}};
  const raw=JSON.stringify(original,null,4);await writeFile(file,raw);
  assert.deepEqual(await installClaudeIntegration({configDir,version:'2.1.292'}),{status:'ready'});
  const current=JSON.parse(await readFile(file,'utf8'));
  assert.equal(current.model,original.model);assert.deepEqual(current.permissions,original.permissions);assert.deepEqual(current.statusLine,original.statusLine);
  assert.deepEqual(current.hooks.Stop[0],original.hooks.Stop[0]);
  for(const event of CLAUDE_HOOK_EVENTS)assert.ok(current.hooks[event].some((d:any)=>d.hooks.some((h:any)=>h.args?.[1]==='--mongle-claude-hook-v1')));
  const files=await readdir(configDir),backup=files.find(n=>n.includes('.mongle-backup-'))!;
  assert.equal(await readFile(path.join(configDir,backup),'utf8'),raw);
  await installClaudeIntegration({configDir,version:'2.1.292'});
  assert.deepEqual(await readdir(configDir),files,'repeat does not make backup clutter or duplicate hooks');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),current);
});

test('disabled/malformed/locked settings and unsupported versions are left untouched',async t=>{
  const configDir=await directory(t),file=path.join(configDir,'settings.json');
  for(const text of ['{bad',JSON.stringify({disableAllHooks:true}),JSON.stringify({hooks:{Stop:'wrong'}})]){
    await writeFile(file,text);
    assert.equal((await installClaudeIntegration({configDir,version:'2.1.292'})).status,'unavailable');
    assert.equal(await readFile(file,'utf8'),text);
  }
  await writeFile(file,'{}');await writeFile(path.join(configDir,'mongle-terminal-hook.lock'),'held');
  assert.equal((await installClaudeIntegration({configDir,version:'2.1.292'})).status,'unavailable');
  assert.equal(await readFile(file,'utf8'),'{}');
  assert.equal((await installClaudeIntegration({configDir,version:'2.1.10'})).status,'unavailable');
  assert.equal(supportsClaudeHooks(undefined),false);
  assert.throws(()=>mergeClaudeHooks({allowManagedHooksOnly:true},'node','script'));
});

test('installed helper is inert outside Mongle, filters child events and keeps private input out of output',async t=>{
  const configDir=await directory(t);await installClaudeIntegration({configDir,version:'2.1.292'});
  const script=path.join(configDir,'mongle-terminal-hook.cjs'),token='a'.repeat(64);
  const registered=JSON.parse(await readFile(path.join(configDir,'settings.json'),'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  assert.ok(registered.command.startsWith(path.join(configDir,'mongle-terminal-runtime')+path.sep));
  assert.notEqual(registered.command,process.execPath,'hook does not depend on an app/ZIP executable surviving uninstall');
  const value={hook_event_name:'UserPromptSubmit',session_id:'private-session',prompt:'PRIVATE_PROMPT_한글',cwd:'PRIVATE_CWD',transcript_path:'PRIVATE_PATH'};
  assert.deepEqual(await invoke(script,value),{out:'',err:'',code:0});
  assert.deepEqual(await invoke(script,{...value,agent_id:'child'},token),{out:'',err:'',code:0});
  const result=await invoke(script,value,token,registered.command);
  assert.equal(result.code,0);assert.equal(result.err,'');
  const parsed=JSON.parse(result.out);
  assert.deepEqual(Object.keys(parsed),['terminalSequence']);
  const body=parsed.terminalSequence.split(';')[3].slice(0,-1);
  const event=JSON.parse(Buffer.from(body,'base64').toString('utf8'));
  assert.deepEqual(Object.keys(event),['event','session']);
  assert.equal(event.event,'UserPromptSubmit');assert.match(event.session,/^[a-f0-9]{64}$/);
  assert.ok(!result.out.includes('PRIVATE_'));
  const toolEvent=async(hook_event_name:string,tool_input:unknown)=>{
    const result=await invoke(script,{...value,hook_event_name,tool_name:'Bash',tool_input},token,registered.command);
    const terminal=JSON.parse(result.out).terminalSequence;
    assert.ok(!terminal.includes('PRIVATE_'));
    return JSON.parse(Buffer.from(terminal.split(';')[3].slice(0,-1),'base64').toString('utf8'));
  };
  const waiting=await toolEvent('PermissionRequest',{command:'PRIVATE_COMMAND',timeout:1000});
  const finished=await toolEvent('PostToolUse',{timeout:1000,command:'PRIVATE_COMMAND'});
  assert.match(waiting.tool,/^[a-f0-9]{64}$/);
  assert.equal(waiting.tool,finished.tool,'tool matching ignores object key order');
  assert.notEqual(waiting.tool,(await toolEvent('PostToolUse',{command:'OTHER_COMMAND',timeout:1000})).tool);
});
