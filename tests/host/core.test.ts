import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostCore } from '../../packages/host/core.js';
import { HostStore } from '../../packages/storage/index.js';
import type { ConnectionContext, SnapshotEvent, TerminalInfo } from '../../packages/protocol/index.js';

const owner = ():ConnectionContext => ({id:randomUUID(),deviceId:randomUUID(),deviceName:'테스트 PC',owner:true});
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(operation:()=>Promise<boolean>,timeout=15_000){const until=Date.now()+timeout;while(Date.now()<until){if(await operation())return;await delay(80);}throw new Error('Timed out waiting for real terminal output.');}
function ref(core:HostCore,info:TerminalInfo){const s=core.getState();return {id:info.id,hostId:s.hostId,bootId:s.bootId,generation:info.generation};}
async function harness(t:test.TestContext){const dataDir=await mkdtemp(join(tmpdir(),'mongle-core-test-'));const core=new HostCore({dataDir,name:'테스트'});await core.init();const ctx=owner();core.connect(ctx,()=>{});t.after(async()=>{await core.close();await rm(dataDir,{recursive:true,force:true});});return {core,ctx,dataDir,request:(method:string,params:unknown={})=>core.handle(method,params,ctx)};}

test('group layout CAS validates membership, split, reorder and removal',async t=>{
  const {core,request}=await harness(t),state=core.getState(),profile=state.profiles.find(p=>p.id==='cmd') || state.profiles[0];assert.ok(profile);
  const group=await request('groups.create',{name:'분할 테스트',profileId:profile.id});
  const first=await request('terminals.create',{groupId:group.id});
  const second=await request('terminals.create',{groupId:group.id,splitTarget:first.id,axis:'vertical'});
  const current=core.getState().groups.find(g=>g.id===group.id)!;
  assert.equal(current.layout?.type,'split');
  await assert.rejects(request('groups.layout',{id:group.id,revision:0,layout:current.layout}),{code:'REVISION_CONFLICT'});
  await assert.rejects(request('groups.layout',{id:group.id,revision:current.revision,layout:{type:'leaf',terminalId:first.id}}),{code:'INVALID_LAYOUT'});
  const tree=current.layout!;assert.equal(tree.type,'split');if(tree.type==='split'){tree.ratio=0.35;[tree.first,tree.second]=[tree.second,tree.first];}
  const changed=await request('groups.layout',{id:group.id,revision:current.revision,layout:tree});assert.equal(changed.revision,current.revision+1);
  await assert.rejects(request('terminals.remove',{...ref(core,second),terminate:false}),{code:'CONFIRM_REQUIRED'});
  await request('terminals.remove',{...ref(core,second),terminate:true});
  assert.deepEqual(core.getState().groups.find(g=>g.id===group.id)!.layout,{type:'leaf',terminalId:first.id});
  const ordered=core.getState().groups.map(g=>g.id).reverse();await request('groups.reorder',{ids:ordered});assert.deepEqual(core.getState().groups.map(g=>g.id),ordered);
  await assert.rejects(request('groups.delete',{id:group.id,revision:0,terminate:true}),{code:'REVISION_CONFLICT'});
  const destination=await request('groups.create',{name:'옮긴 그룹',profileId:profile.id});
  const moved=await request('terminals.move',{...ref(core,first),groupId:destination.id});
  assert.equal(moved.pid,first.pid);assert.equal(moved.generation,first.generation);
  assert.equal(core.getState().groups.find(g=>g.id===group.id)!.layout,null);
  assert.deepEqual(core.getState().groups.find(g=>g.id===destination.id)!.layout,{type:'leaf',terminalId:first.id});
});

test('revoked connection cannot run its queued mutation',async t=>{
  const {core,ctx,request}=await harness(t),count=core.getState().groups.length;
  const pending=request('groups.create',{name:'취소된 연결의 요청'});
  core.disconnect(ctx.id);
  await assert.rejects(pending,{code:'NOT_CONNECTED'});
  assert.equal(core.getState().groups.length,count);
});

test('failed metadata save rolls back the rejected operation without poisoning a later save',async t=>{
  const {core,request}=await harness(t),before=core.getState();
  const store=(core as any).store as HostStore,save=store.save.bind(store);
  store.save=()=>{throw new Error('Simulated disk-full fault');};
  try{await assert.rejects(request('groups.create',{name:'저장에 실패한 그룹'}),{code:'STORAGE_ERROR'});}finally{store.save=save;}
  assert.deepEqual(core.getState().groups,before.groups);
  await request('groups.create',{name:'저장된 그룹'});
  assert.equal(store.load()!.groups.some(g=>g.name==='저장에 실패한 그룹'),false);
});

test('settings export contains no host/session identifiers and import creates only empty groups',async t=>{
  const {core,request}=await harness(t),before=core.getState();
  const config=await request('settings.export');
  assert.deepEqual(Object.keys(config).sort(),['groups','name','recordHistory','version']);
  assert.deepEqual(Object.keys(config.groups[0]).sort(),['cwd','name','profileId']);
  assert.equal(JSON.stringify(config).includes(before.hostId),false);assert.equal(JSON.stringify(config).includes(before.bootId),false);assert.equal(JSON.stringify(config).includes(before.groups[0].id),false);
  config.name='다른 컴퓨터';config.recordHistory=false;config.groups[0].profileId='not-installed';config.groups[0].cwd=join(tmpdir(),randomUUID());
  const imported=await request('settings.import',{config,confirmed:true});assert.equal(imported.importedGroups,1);assert.ok(imported.warnings.length>=3);
  const after=core.getState();assert.deepEqual(after.settings,before.settings);assert.equal(after.terminals.length,0);assert.equal(after.groups.length,before.groups.length+1);assert.equal(after.groups.at(-1)!.layout,null);
  await assert.rejects(request('settings.import',{config:{...config,run:'echo should-never-run'},confirmed:true}));
});

test('actual PowerShell stays alive after disconnect and preserves variable with input deduplication',async t=>{
  const {core,ctx,request}=await harness(t),group=core.getState().groups[0];
  const profile=core.getState().profiles.find(p=>p.kind==='powershell');assert.ok(profile,'Windows test requires PowerShell');
  const terminal:TerminalInfo=await request('terminals.create',{groupId:group.id,profileId:profile.id});
  const originalPid=terminal.pid,r=ref(core,terminal);
  const controlled=await request('control.acquire',{...r,cols:100,rows:30});
  await assert.rejects(request('terminal.input',{...r,epoch:controlled.epoch,inputId:'early',clientInputSeq:0,data:'x'}),{code:'CONTROL_SYNCING'});
  await request('terminal.ack',{...r,seq:controlled.frame.seq,epoch:controlled.epoch});
  const marker=`MONGLE_${randomUUID().replaceAll('-','')}_`;
  const command=`$mongleSessionValue=40; $mongleSessionValue+=2; Write-Output ('${marker}' + $mongleSessionValue)\r`;
  const input={...r,epoch:controlled.epoch,inputId:'initial',clientInputSeq:0,data:command};
  assert.equal((await request('terminal.input',input)).duplicate,false);
  assert.equal((await request('terminal.input',input)).duplicate,true);
  await assert.rejects(request('terminal.input',{...input,data:'Different'}),{code:'INPUT_ID_REUSED'});
  await waitFor(async()=>{const frame=await request('terminals.attach',r);return frame.snapshot.data.includes(marker+'42');});
  core.disconnect(ctx.id);await delay(100);
  assert.equal(core.getState().terminals.find(s=>s.id===terminal.id)!.pid,originalPid);
  const reconnect=owner();core.connect(reconnect,()=>{});
  const re=await core.handle('control.acquire',{...r,cols:100,rows:30},reconnect);
  await core.handle('terminal.ack',{...r,seq:re.frame.seq,epoch:re.epoch},reconnect);
  const newMarker=`REATTACH_${randomUUID().replaceAll('-','')}_`;
  await core.handle('terminal.input',{...r,epoch:re.epoch,inputId:'after-reconnect',clientInputSeq:0,data:`Write-Output ('${newMarker}' + $mongleSessionValue)\r`},reconnect);
  await waitFor(async()=>{const frame=await core.handle('terminals.attach',r,reconnect);return frame.snapshot.data.includes(newMarker+'42');});
  assert.equal(core.getState().terminals.find(s=>s.id===terminal.id)!.pid,originalPid);
});

test('controller transfer fences screen, revokes old input, and rejects stale host/generation/ACK',async t=>{
  const {core,ctx,request}=await harness(t);const observer=owner();observer.owner=false;observer.deviceName='휴대폰';core.connect(observer,()=>{});
  const info:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:core.getState().profiles.find(p=>p.id==='cmd')?.id});const r=ref(core,info);
  const first=await request('control.acquire',{...r,cols:100,rows:30});await request('terminal.ack',{...r,seq:first.frame.seq,epoch:first.epoch});
  await assert.rejects(core.handle('terminal.resize',{...r,epoch:first.epoch,cols:40,rows:20},observer),{code:'NOT_CONTROLLER'});
  const second=await core.handle('control.acquire',{...r,cols:40,rows:20},observer);
  assert.equal(second.frame.snapshot.cols,40);assert.equal(second.frame.snapshot.rows,20);assert.ok(second.epoch>first.epoch);
  await assert.rejects(request('terminal.input',{...r,epoch:first.epoch,inputId:'old',clientInputSeq:1,data:'x'}),{code:'NOT_CONTROLLER'});
  await assert.rejects(core.handle('terminal.input',{...r,epoch:second.epoch,inputId:'unsynced',clientInputSeq:0,data:'x'},observer),{code:'CONTROL_SYNCING'});
  await assert.rejects(core.handle('terminal.ack',{...r,seq:second.frame.seq+100,epoch:second.epoch},observer),{code:'INVALID_ACK'});
  await core.handle('terminal.ack',{...r,seq:second.frame.seq,epoch:second.epoch},observer);
  assert.equal(core.getState().terminals[0].controller?.ready,true);
  await assert.rejects(core.handle('terminals.attach',{...r,bootId:randomUUID()},observer),{code:'HOST_CHANGED'});
  await assert.rejects(core.handle('terminals.attach',{...r,generation:randomUUID()},observer),{code:'SESSION_CHANGED'});
  await assert.rejects(core.handle('settings.update',{name:'Remote changed'},observer),{code:'OWNER_REQUIRED'});
  core.disconnect(observer.id);assert.equal(core.getState().terminals[0].controller,undefined);assert.equal((await core.handle('connection.info',{},ctx)).id,ctx.id);
});

test('persisted running sessions reopen as fresh shells after a new host boot',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-restore-test-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();const state=core.getState();await core.close();core=undefined;
  const terminal:TerminalInfo={id:randomUUID(),groupId:state.groups[0].id,title:'이전 작업',profileId:state.profiles[0].id,cwd:state.groups[0].cwd,generation:randomUUID(),status:'running',cols:100,rows:30};
  const store=new HostStore(dataDir);const saved=store.load()!;saved.terminals=[terminal];saved.groups[0].layout={type:'leaf',terminalId:terminal.id};store.save(saved);store.close();
  core=new HostCore({dataDir});await core.init();const recovered=core.getState();
  assert.equal(recovered.hostId,state.hostId);assert.notEqual(recovered.bootId,state.bootId);assert.equal(recovered.terminals[0].status,'running');assert.ok(recovered.terminals[0].pid);assert.notEqual(recovered.terminals[0].generation,terminal.generation);
  const ctx=owner();core.connect(ctx,()=>{});const frame:SnapshotEvent=await core.handle('terminals.attach',ref(core,recovered.terminals[0]),ctx);assert.equal(frame.snapshot.kind,'presentation-v1');assert.equal(typeof frame.snapshot.modes.wraparoundMode,'boolean');
  await assert.rejects(core.handle('terminals.restart',ref(core,terminal),ctx),{code:'SESSION_CHANGED'});
});

test('a stale close confirmation cannot terminate the replacement generation',async t=>{
  const {core,request}=await harness(t);
  const original=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:core.getState().profiles.find(p=>p.id==='cmd')?.id});
  const oldRef=ref(core,original);
  const replacement=await request('terminals.restart',{...oldRef,confirmed:true});
  assert.notEqual(replacement.generation,original.generation);
  await assert.rejects(request('terminals.terminate',oldRef),{code:'SESSION_CHANGED'});
  await assert.rejects(request('terminals.remove',{...oldRef,terminate:true}),{code:'SESSION_CHANGED'});
  assert.equal(core.getState().terminals[0].pid,replacement.pid);
  await request('terminals.terminate',ref(core,replacement));
  await waitFor(async()=>{try{process.kill(replacement.pid,0);return false;}catch{return true;}},5000);
});

test('slow observer receives only its next latest complete frame after ACK',async t=>{
  const {core,request}=await harness(t),received:SnapshotEvent[]=[];
  const observer=owner();observer.owner=false;core.connect(observer,event=>{if(event.type==='snapshot')received.push(event);});
  const info=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:core.getState().profiles.find(p=>p.kind==='powershell')!.id});
  const r=ref(core,info),control=await request('control.acquire',{...r,cols:100,rows:30});
  await request('terminal.ack',{...r,epoch:control.epoch,seq:control.frame.seq});
  const initial:SnapshotEvent=await core.handle('terminals.attach',r,observer);
  await request('terminal.input',{...r,epoch:control.epoch,inputId:'stream',clientInputSeq:0,data:"1..8 | ForEach-Object { Write-Output ('FRAME_MARK_' + $_); Start-Sleep -Milliseconds 100 }\r"});
  await waitFor(async()=>{const current=await request('terminals.attach',r);return current.snapshot.data.includes('FRAME_MARK_8');});
  await delay(160);assert.equal(received.length,0,'No subsequent frame may queue while first frame waits for ACK');
  await core.handle('terminal.ack',{...r,seq:initial.seq},observer);
  assert.equal(received.length,1);assert.ok(received[0].snapshot.data.includes('FRAME_MARK_8'));assert.ok(received[0].seq>initial.seq);
});

test('natural shell exit drains final output and closes its ConPTY worker',async t=>{
  const {core,request,dataDir}=await harness(t);
  const info=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:core.getState().profiles.find(p=>p.kind==='powershell')!.id}),r=ref(core,info);
  const control=await request('control.acquire',{...r,cols:100,rows:30});await request('terminal.ack',{...r,epoch:control.epoch,seq:control.frame.seq});
  await request('terminal.input',{...r,epoch:control.epoch,inputId:'final',clientInputSeq:0,data:"Write-Output ('FINAL_' + 'DRAINED'); exit 7\r"});
  await waitFor(async()=>core.getState().terminals[0].status==='exited');
  assert.equal(core.getState().terminals[0].exitCode,7);
  const frame=await request('terminals.attach',r);assert.ok(frame.snapshot.data.includes('FINAL_DRAINED'));
  await core.close();
  const restored=new HostCore({dataDir});await restored.init();
  assert.equal(restored.getState().terminals[0].status,'exited');assert.equal(restored.getState().terminals[0].historyAvailable,true);
  await restored.close();
});
