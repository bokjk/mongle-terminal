import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostCore } from '../../packages/host/core.js';
import { HostStore } from '../../packages/storage/index.js';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol/index.js';

const owner=():ConnectionContext=>({id:randomUUID(),deviceId:randomUUID(),deviceName:'종료 검증 PC',owner:true});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(operation:()=>Promise<boolean>,timeout=15_000){const until=Date.now()+timeout;while(Date.now()<until){if(await operation())return;await delay(50);}throw new Error('Timed out waiting for shutdown test.');}
function ref(core:HostCore,info:TerminalInfo){const state=core.getState();return {id:info.id,hostId:state.hostId,bootId:state.bootId,generation:info.generation};}
async function harness(t:test.TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-shutdown-test-'));
  const core=new HostCore({dataDir});await core.init();const ctx=owner();core.connect(ctx,()=>{});
  t.after(async()=>{await core.close();await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,core,ctx,request:(method:string,params:unknown={})=>core.handle(method,params,ctx)};
}
async function output(core:HostCore,ctx:ConnectionContext,info:TerminalInfo,marker:string){
  const target=ref(core,info),request=(method:string,params:unknown)=>core.handle(method,params,ctx);
  const control=await request('control.acquire',{...target,cols:100,rows:30});
  await request('terminal.ack',{...target,seq:control.frame.seq,epoch:control.epoch});
  // Concatenation ensures the awaited marker is actual output, not echoed input.
  await request('terminal.input',{...target,epoch:control.epoch,inputId:randomUUID(),clientInputSeq:0,data:`Write-Output ('${marker.slice(0,12)}' + '${marker.slice(12)}')\r`});
  await waitFor(async()=>(await request('terminals.attach',target)).snapshot.data.includes(marker));
}

test('owner shutdown checkpoints queued metadata, layout and actual output before stopping, then restores with fresh shells',async t=>{
  const {core,ctx,dataDir,request}=await harness(t);
  const cwd=join(dataDir,'working folder');await mkdir(cwd);
  const profile=core.getState().profiles.find(p=>p.kind==='powershell');assert.ok(profile);
  const group=await request('groups.create',{name:'복원할 그룹',cwd,profileId:profile.id});
  const first:TerminalInfo=await request('terminals.create',{groupId:group.id});
  const second:TerminalInfo=await request('terminals.create',{groupId:group.id,splitTarget:first.id,axis:'vertical',profileId:'cmd'});
  const marker=`SAVED_OUTPUT_${randomUUID().replaceAll('-','')}`;await output(core,ctx,first,marker);
  const layout={type:'split',axis:'horizontal',ratio:0.37,first:{type:'leaf',terminalId:second.id},second:{type:'leaf',terminalId:first.id}};
  const revision=core.getState().groups.find(item=>item.id===group.id)!.revision;
  await request('groups.layout',{id:group.id,layout,revision});
  const observer={...owner(),owner:false};core.connect(observer,()=>{});
  await assert.rejects(core.handle('host.shutdown',{},observer),{code:'OWNER_REQUIRED'});
  const pendingRename=request('terminals.rename',{id:first.id,title:'마지막으로 저장한 이름'});
  const pendingShutdown=request('host.shutdown');
  const rejectedLater=request('terminals.rename',{id:first.id,title:'저장 뒤 쓰기'});
  await pendingRename;assert.deepEqual(await pendingShutdown,{ok:true});
  await assert.rejects(rejectedLater,{code:'HOST_UNAVAILABLE'});
  assert.doesNotThrow(()=>process.kill(first.pid!,0),'preflight must not kill shells');
  const store=(core as any).store as HostStore;
  assert.ok(store.getSnapshot(first.id,first.generation)!.data.includes(marker));
  assert.equal(store.load()!.terminals.find(info=>info.id===first.id)!.title,'마지막으로 저장한 이름');
  const expected=core.getState();await core.close();
  await waitFor(async()=>{try{process.kill(first.pid!,0);return false;}catch{return true;}},5000);
  const restored=new HostCore({dataDir});await restored.init();
  try{
    const state=restored.getState();assert.equal(state.hostId,expected.hostId);assert.notEqual(state.bootId,expected.bootId);
    assert.deepEqual(state.groups,expected.groups);
    assert.deepEqual(state.terminals.map(({id,title,profileId,cwd,cols,rows})=>({id,title,profileId,cwd,cols,rows})),expected.terminals.map(({id,title,profileId,cwd,cols,rows})=>({id,title,profileId,cwd,cols,rows})));
    assert.ok(state.terminals.every(info=>info.status==='running' && info.pid!==undefined));
    for(const info of state.terminals){const prior=expected.terminals.find(value=>value.id===info.id)!;assert.notEqual(info.generation,prior.generation);assert.notEqual(info.pid,prior.pid);}
    assert.equal(state.terminals.find(info=>info.id===first.id)!.historyAvailable,true);
    const reader=owner();restored.connect(reader,()=>{});
    const frame=await restored.handle('terminals.attach',ref(restored,state.terminals.find(info=>info.id===first.id)!),reader);
    assert.ok(frame.snapshot.data.includes(marker));
  }finally{await restored.close();}
});

test('shutdown honors disabled history and restores metadata without persisting terminal output',async t=>{
  const {core,ctx,dataDir,request}=await harness(t);
  await request('settings.update',{recordHistory:false});
  const profile=core.getState().profiles.find(p=>p.kind==='powershell');assert.ok(profile);
  const info:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:profile.id});
  const marker=`PRIVATE_OUTPUT_${randomUUID().replaceAll('-','')}`;await output(core,ctx,info,marker);
  assert.deepEqual(await request('host.shutdown'),{ok:true});
  assert.equal(((core as any).store as HostStore).getSnapshot(info.id,info.generation),undefined);
  await core.close();
  const restored=new HostCore({dataDir});await restored.init();
  try{
    const state=restored.getState();assert.equal(state.settings.recordHistory,false);assert.equal(state.terminals[0].historyAvailable,false);
    const reader=owner();restored.connect(reader,()=>{});
    const frame=await restored.handle('terminals.attach',ref(restored,state.terminals[0]),reader);
    assert.equal(frame.snapshot.data.includes(marker),false);
    assert.equal(((restored as any).store as any).db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count,0);
  }finally{await restored.close();}
});

for(const failure of ['metadata','snapshot'] as const){
  test(`${failure} SQLite failure rejects shutdown before terminating the shell and allows retry`,async t=>{
    const {core,ctx,request}=await harness(t);
    const profile=core.getState().profiles.find(p=>p.kind==='powershell');assert.ok(profile);
    const info:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:profile.id});
    await output(core,ctx,info,`BEFORE_FAILURE_${randomUUID().replaceAll('-','')}`);
    const store=(core as any).store as HostStore,db=(store as any).db;
    const before=store.load();
    db.exec(failure==='metadata'
      ? "CREATE TRIGGER reject_shutdown_write BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'simulated full disk'); END;"
      : "CREATE TRIGGER reject_shutdown_write BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'simulated full disk'); END;");
    try{
      await assert.rejects(request('host.shutdown'),{code:'STORAGE_ERROR'});
      assert.deepEqual(store.load(),before,'failed checkpoint must roll back metadata along with snapshots');
      assert.doesNotThrow(()=>process.kill(info.pid!,0));
      const state=await request('state.get');assert.equal(state.terminals[0].pid,info.pid);assert.equal(state.terminals[0].status,'running');
      const marker=`AFTER_FAILURE_${randomUUID().replaceAll('-','')}`;await output(core,ctx,info,marker);
    }finally{db.exec('DROP TRIGGER reject_shutdown_write');}
    await request('terminals.rename',{id:info.id,title:'저장 복구 후 작업'});
    assert.deepEqual(await request('host.shutdown'),{ok:true});
    assert.equal(store.load()!.terminals[0].title,'저장 복구 후 작업');
  });
}
