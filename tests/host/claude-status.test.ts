import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, HostState, ServerMessage, TerminalInfo } from '../../packages/protocol/index.js';

async function until(check:()=>boolean) {
  const deadline=Date.now()+7000;
  while(!check()){assert.ok(Date.now()<deadline,'host agent state timeout');await new Promise(r=>setTimeout(r,25));}
}

test('real PTY carries scoped agent state to viewers and notification frames without exposing the token', {timeout:25000},async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'mongle-claude-state-'));
  let core=new HostCore({dataDir,claudeIntegration:{status:'ready'}});
  t.after(async()=>{await core.close();assert.equal(path.dirname(dataDir),tmpdir());assert.ok(path.basename(dataDir).startsWith('mongle-claude-state-'));await rm(dataDir,{recursive:true,force:true});});
  const signal=path.join(dataDir,'signal.json');await writeFile(signal,'{}');
  const program=path.join(dataDir,'fixture.cjs');
  await writeFile(program,`const fs=require('node:fs');let last='';process.stdout.write('AGENT_FIXTURE_READY');setInterval(()=>{try{const s=fs.readFileSync(process.argv[2],'utf8');if(s===last)return;last=s;const v=JSON.parse(s);if(!v.event)return;const encoded=Buffer.from(JSON.stringify({...v,session:'b'.repeat(64)})).toString('base64');process.stdout.write('\\x1b]777;mongle-agent;'+process.env.MONGLE_AGENT_TOKEN+';'+encoded+'\\x07');}catch{}},30);`);
  await core.init();
  const internal=core as any;
  internal.profiles.push({id:'agent-fixture',name:'Synthetic agent',kind:'cmd',executable:process.execPath,args:[program,signal]});
  const ctx:ConnectionContext={id:randomUUID(),deviceId:randomUUID(),deviceName:'fixture',owner:true};
  const events:ServerMessage[]=[];core.connect(ctx,e=>events.push(e));
  const terminal:TerminalInfo=await core.handle('terminals.create',{groupId:core.getState().groups[0].id,profileId:'agent-fixture',cwd:dataDir},ctx);
  const current=()=>core.getState().terminals.find(x=>x.id===terminal.id)!;
  let nonce=0;
  const emit=async(event:string,extra:Record<string,unknown>={})=>{await writeFile(signal,JSON.stringify({event,...extra,nonce:++nonce}));};
  await emit('UserPromptSubmit');await until(()=>current().agentStatus==='working');
  assert.equal(current().notificationCount,0);
  await emit('PermissionRequest');await until(()=>current().agentStatus==='attention');
  assert.equal(current().notificationCount,1);
  assert.equal(current().agentNotificationCount,1,'the alert records the notification number it produced');
  const ref={id:terminal.id,generation:terminal.generation,hostId:core.getState().hostId,bootId:core.getState().bootId};
  const oldFrame=await core.handle('terminals.attach',ref,ctx);
  await emit('PostToolUse');await until(()=>current().agentStatus==='working');
  await emit('Stop');await until(()=>current().agentStatus==='completed');
  assert.equal(current().agentNotificationCount,2);
  const frame=await core.handle('terminals.attach',ref,ctx);
  assert.equal(oldFrame.snapshot.notificationCount,1);assert.equal(frame.snapshot.notificationCount,2);
  assert.ok(frame.snapshot.data.includes('AGENT_FIXTURE_READY'));
  assert.ok(!JSON.stringify(frame).includes('mongle-agent'));
  await until(()=>events.some(e=>'type'in e&&e.type==='state'&&(e.state as HostState).terminals.some(t=>t.agentStatus==='completed')));
  // Claude 2.1.294 sends no hook after "No" in a permission dialog: the delivered Enter ends the shown request.
  await emit('UserPromptSubmit');await until(()=>current().agentStatus==='working');
  await emit('PermissionRequest');await until(()=>current().agentStatus==='attention');
  const lease=await core.handle('control.acquire',{...ref,cols:80,rows:24},ctx);
  await core.handle('terminal.ack',{...ref,seq:lease.frame.seq,epoch:lease.epoch},ctx);
  await core.handle('terminal.input',{...ref,epoch:lease.epoch,inputId:randomUUID(),clientInputSeq:1,data:'\x1b[B\r'},ctx);
  await until(()=>current().agentStatus==='idle');
  assert.equal(current().notificationCount,3);
  assert.equal(current().agentNotificationCount,3,'lowering a request is not a new alert');
  // Enter alone picks Claude's preselected approval; a focus report from the view is not a key.
  const tool='c'.repeat(64);
  await emit('PreToolUse',{tool,call:'d'.repeat(64)});await until(()=>current().agentStatus==='working');
  await emit('PermissionRequest',{tool});await until(()=>current().agentStatus==='attention');
  await core.handle('terminal.input',{...ref,epoch:lease.epoch,inputId:randomUUID(),clientInputSeq:2,data:'\x1b[I'},ctx);
  await core.handle('terminal.input',{...ref,epoch:lease.epoch,inputId:randomUUID(),clientInputSeq:3,data:'\r'},ctx);
  await until(()=>current().agentStatus==='working');
  assert.equal(current().agentNotificationCount,4);
  // Claude also moves a selection with J/K: a letter typed while the request is shown makes Enter provisional.
  await emit('PreToolUse',{tool,call:'e'.repeat(64)});await new Promise(r=>setTimeout(r,150));
  await emit('PermissionRequest',{tool});await until(()=>current().agentStatus==='attention');
  await core.handle('terminal.input',{...ref,epoch:lease.epoch,inputId:randomUUID(),clientInputSeq:4,data:'j'},ctx);
  await core.handle('terminal.input',{...ref,epoch:lease.epoch,inputId:randomUUID(),clientInputSeq:5,data:'\r'},ctx);
  await until(()=>current().agentStatus==='idle');
  await core.handle('terminals.terminate',ref,ctx);
  assert.ok(current().agentStatus !== 'working');
  await core.close();
  core=new HostCore({dataDir});await core.init();
  assert.equal(current().agentStatus,undefined,'cold load never presents a persisted live status');
});
