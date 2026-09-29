import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostCore } from '../../packages/host/core.js';
import { HostStore } from '../../packages/storage/index.js';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol/index.js';

const owner=():ConnectionContext=>({id:randomUUID(),deviceId:randomUUID(),deviceName:'작업 공간 복원 검증',owner:true});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(operation:()=>Promise<boolean>,timeout=15_000){const until=Date.now()+timeout;while(Date.now()<until){if(await operation())return;await delay(80);}throw new Error('Timed out waiting for workspace restore.');}
function ref(core:HostCore,info:TerminalInfo){const state=core.getState();return {id:info.id,hostId:state.hostId,bootId:state.bootId,generation:info.generation};}
function client(core:HostCore){const ctx=owner();core.connect(ctx,()=>{});return (method:string,params:unknown={})=>core.handle(method,params,ctx);}
async function input(core:HostCore,request:ReturnType<typeof client>,info:TerminalInfo,data:string){const target=ref(core,info),control=await request('control.acquire',{...target,cols:88,rows:18});await request('terminal.ack',{...target,seq:control.frame.seq,epoch:control.epoch});await request('terminal.input',{...target,epoch:control.epoch,inputId:randomUUID(),clientInputSeq:0,data});}
async function frame(core:HostCore,request:ReturnType<typeof client>,info:TerminalInfo){return (await request('terminals.attach',ref(core,info))).snapshot;}

test('full shutdown and repeated boot restore IDs, layout and prior output into fresh shells without replaying commands',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-workspace-restore-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();let request=client(core);
  const cwd=join(dataDir,'working folder');await mkdir(cwd);
  const profile=core.getState().profiles.find(value=>value.kind==='powershell');assert.ok(profile);
  const group=await request('groups.create',{name:'보존되는 그룹',profileId:profile.id,cwd});
  const first:TerminalInfo=await request('terminals.create',{groupId:group.id});
  const second:TerminalInfo=await request('terminals.create',{groupId:group.id,splitTarget:first.id,axis:'vertical',profileId:'cmd'});
  const marker=`WORKSPACE_${randomUUID().replaceAll('-','')}`;
  await input(core,request,first,`$mongleRestoreValue=42; Add-Content -LiteralPath './side-effect.txt' -Value 'once'; Write-Output ('${marker.slice(0,10)}' + '${marker.slice(10)}')\r`);
  await waitFor(async()=>(await frame(core!,request,first)).data.includes(marker));
  await request('terminals.rename',{id:first.id,title:'이어지는 화면'});
  const currentGroup=core.getState().groups.find(value=>value.id===group.id)!;
  await request('groups.layout',{id:group.id,revision:currentGroup.revision,layout:{type:'split',axis:'horizontal',ratio:0.36,first:{type:'leaf',terminalId:second.id},second:{type:'leaf',terminalId:first.id}}});
  let expected=core.getState();
  for(let boot=0;boot<2;boot++){
    await request('host.shutdown');await core.close();
    const stored=new HostStore(dataDir);const saved=stored.load()!;
    assert.ok(saved.terminals.every(info=>info.resumeOnBoot===true));stored.close();
    core=new HostCore({dataDir});await Promise.all([core.init(),core.init()]);request=client(core);
    const restored=core.getState();assert.equal(restored.hostId,expected.hostId);assert.notEqual(restored.bootId,expected.bootId);assert.deepEqual(restored.groups,expected.groups);
    for(const info of restored.terminals){const previous=expected.terminals.find(value=>value.id===info.id)!;assert.equal(info.status,'running');assert.ok(info.pid);assert.notEqual(info.pid,previous.pid);assert.notEqual(info.generation,previous.generation);assert.deepEqual([info.id,info.title,info.groupId,info.profileId,info.cwd,info.cols,info.rows],[previous.id,previous.title,previous.groupId,previous.profileId,previous.cwd,previous.cols,previous.rows]);}
    const restoredFirst=restored.terminals.find(info=>info.id===first.id)!;
    assert.ok((await frame(core,request,restoredFirst)).data.includes(marker));
    await delay(350);assert.ok((await frame(core,request,restoredFirst)).data.includes(marker),'new shell startup must not erase old history');
    const pid=restoredFirst.pid;await core.init();assert.equal(core.getState().terminals.find(info=>info.id===first.id)!.pid,pid,'init/reconnect cannot spawn duplicate shells');
    assert.equal((await readFile(join(cwd,'side-effect.txt'),'utf8')).trim(),'once','prior commands must never execute again');
    const freshMarker=`FRESH_${boot}_${randomUUID().replaceAll('-','')}`;
    await input(core,request,restoredFirst,`Write-Output ('${freshMarker.slice(0,10)}' + '${freshMarker.slice(10)}' + ':' + ($null -eq $mongleRestoreValue))\r`);
    await waitFor(async()=>(await frame(core!,request,restoredFirst)).data.includes(freshMarker+':True'));
    expected=core.getState();
  }
});

test('explicit termination and natural exit remain stopped across a host boot',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-stopped-restore-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();let request=client(core);
  const profile=core.getState().profiles.find(value=>value.kind==='powershell');assert.ok(profile);
  const first:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:profile.id});
  const second:TerminalInfo=await request('terminals.create',{groupId:first.groupId,profileId:profile.id});
  await input(core,request,first,"Write-Output ('NATURAL_' + 'EXIT'); exit 7\r");
  await waitFor(async()=>core!.getState().terminals.find(info=>info.id===first.id)!.status==='exited');
  await request('terminals.terminate',ref(core,second));
  await core.close();core=new HostCore({dataDir});await core.init();request=client(core);
  const restored=core.getState().terminals;assert.ok(restored.every(info=>info.status==='exited' && info.pid===undefined && !info.resumeOnBoot));
  assert.equal(restored[0].generation,first.generation);assert.equal(restored[1].generation,second.generation);
  assert.ok((await frame(core,request,restored[0])).data.includes('NATURAL_EXIT'));
});

for(const failure of ['missing-cwd','missing-profile','spawn-failure'] as const){
  test(`${failure} keeps the old generation, history and pane and does not prevent other shells from restoring`,async t=>{
    const dataDir=await mkdtemp(join(tmpdir(),'mongle-failed-restore-'));let core:HostCore|undefined;
    t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
    core=new HostCore({dataDir});await core.init();let request=client(core);
    const profile=core.getState().profiles.find(value=>value.kind==='powershell');assert.ok(profile);
    const first:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:profile.id});
    const second:TerminalInfo=await request('terminals.create',{groupId:first.groupId,profileId:'cmd'});
    await input(core,request,first,"Write-Output ('FAILED_' + 'RESTORE_HISTORY')\r");
    await waitFor(async()=>(await frame(core!,request,first)).data.includes('FAILED_RESTORE_HISTORY'));
    const groups=core.getState().groups;await core.close();
    const store=new HostStore(dataDir),saved=store.load()!;
    if(failure==='missing-cwd')saved.terminals[0].cwd=join(dataDir,'does-not-exist');
    if(failure==='missing-profile')saved.terminals[0].profileId='uninstalled-shell-profile';
    store.save(saved);store.close();
    core=new HostCore({dataDir});
    if(failure==='spawn-failure'){
      const start=(core as any).startTerminal.bind(core);
      (core as any).startTerminal=async(info:TerminalInfo,...args:unknown[])=>{if(info.id===first.id)throw new Error('Injected native spawn failure');return start(info,...args);};
    }
    await core.init();request=client(core);
    const restored=core.getState();assert.deepEqual(restored.groups,groups);
    const failed=restored.terminals.find(info=>info.id===first.id)!;
    assert.equal(failed.status,'interrupted');assert.equal(failed.pid,undefined);assert.equal(failed.generation,first.generation);assert.equal(failed.resumeOnBoot,true);assert.ok(failed.restoreError);assert.equal(failed.historyAvailable,true);
    assert.ok((await frame(core,request,failed)).data.includes('FAILED_RESTORE_HISTORY'));
    const healthy=restored.terminals.find(info=>info.id===second.id)!;assert.equal(healthy.status,'running');assert.notEqual(healthy.generation,second.generation);
    assert.ok(((core as any).store as HostStore).getSnapshot(first.id,first.generation)!.data.includes('FAILED_RESTORE_HISTORY'));
  });
}

test('history disabled reopens the workspace but never restores an old persisted snapshot',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-private-restore-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();let request=client(core);
  const info:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:'cmd'});
  await input(core,request,info,'echo PRIVATE_OLD_FRAME\r');await waitFor(async()=>(await frame(core!,request,info)).data.includes('PRIVATE_OLD_FRAME'));
  await core.close();const store=new HostStore(dataDir),saved=store.load()!;assert.ok(store.getSnapshot(info.id,info.generation));saved.settings.recordHistory=false;store.save(saved);store.close();
  core=new HostCore({dataDir});await core.init();request=client(core);const restored=core.getState().terminals[0];
  assert.equal(restored.status,'running');assert.equal(restored.historyAvailable,false);assert.equal((await frame(core,request,restored)).data.includes('PRIVATE_OLD_FRAME'),false);
});

test('another restored shell exiting cannot persist a tentative generation before its history transaction',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-restore-atomic-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();let request=client(core);
  const first:TerminalInfo=await request('terminals.create',{groupId:core.getState().groups[0].id,profileId:'cmd'});
  const second:TerminalInfo=await request('terminals.create',{groupId:first.groupId,profileId:'cmd'});
  await input(core,request,second,'echo ATOMIC_PRIOR_HISTORY\r');await waitFor(async()=>(await frame(core!,request,second)).data.includes('ATOMIC_PRIOR_HISTORY'));
  await core.close();core=new HostCore({dataDir});
  const start=(core as any).startTerminal.bind(core);let observed=false;
  (core as any).startTerminal=async(info:TerminalInfo,...args:unknown[])=>{
    if(info.id!==second.id)return start(info,...args);
    assert.notEqual(info.generation,second.generation,'second restore has a tentative new generation');
    const runtime=(core as any).runtimes.get(first.id);await runtime.stopPty();await delay(30);
    const store=(core as any).store as HostStore;
    assert.equal(store.load()!.terminals.find(value=>value.id===second.id)!.generation,second.generation,'concurrent onExit must not commit a generation whose frame has not been reseeded');
    assert.ok(store.getSnapshot(second.id,second.generation)!.data.includes('ATOMIC_PRIOR_HISTORY'));observed=true;
    throw new Error('Injected second spawn failure after first shell exit');
  };
  await core.init();assert.equal(observed,true);request=client(core);
  const restored=core.getState().terminals.find(info=>info.id===second.id)!;
  assert.equal(restored.status,'interrupted');assert.equal(restored.generation,second.generation);assert.ok((await frame(core,request,restored)).data.includes('ATOMIC_PRIOR_HISTORY'));
});

test('one-time legacy resume manifest reopens only matching records without an explicit resume decision',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-legacy-restore-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();const state=core.getState();await core.close();core=undefined;
  const store=new HostStore(dataDir),saved=store.load()!,profile=state.profiles.find(value=>value.id==='cmd')!;assert.ok(profile);
  const base={groupId:state.groups[0].id,title:'이전 버전 작업',profileId:profile.id,cwd:state.groups[0].cwd,status:'exited' as const,cols:100,rows:30};
  const matching:TerminalInfo={...base,id:randomUUID(),generation:randomUUID()};
  const stopped:TerminalInfo={...base,id:randomUUID(),generation:randomUUID(),resumeOnBoot:false};
  const mismatch:TerminalInfo={...base,id:randomUUID(),generation:randomUUID()};
  saved.terminals=[matching,stopped,mismatch];store.save(saved);store.close();
  await writeFile(join(dataDir,'workspace-resume.json'),JSON.stringify({version:1,hostId:state.hostId,bootId:state.bootId,terminals:[{id:matching.id,generation:matching.generation},{id:stopped.id,generation:stopped.generation},{id:mismatch.id,generation:randomUUID()}]}));
  core=new HostCore({dataDir});await core.init();const terminals=core.getState().terminals;
  assert.equal(terminals[0].status,'running');assert.notEqual(terminals[0].generation,matching.generation);
  assert.equal(terminals[1].status,'exited');assert.equal(terminals[1].resumeOnBoot,false);assert.equal(terminals[1].generation,stopped.generation);
  assert.equal(terminals[2].status,'exited');assert.equal(terminals[2].generation,mismatch.generation);
  await assert.rejects(access(join(dataDir,'workspace-resume.json')),{code:'ENOENT'});
});

test('wrong-host and invalid legacy manifests are ignored without reopening stopped records',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mongle-legacy-mismatch-'));let core:HostCore|undefined;
  t.after(async()=>{await core?.close();await rm(dataDir,{recursive:true,force:true});});
  core=new HostCore({dataDir});await core.init();const state=core.getState();await core.close();core=undefined;
  const store=new HostStore(dataDir),saved=store.load()!;
  const info:TerminalInfo={id:randomUUID(),generation:randomUUID(),groupId:state.groups[0].id,title:'이전 기록',profileId:state.profiles[0].id,cwd:state.groups[0].cwd,status:'exited',cols:100,rows:30};saved.terminals=[info];store.save(saved);store.close();
  for(const manifest of [{version:1,hostId:randomUUID(),bootId:state.bootId,terminals:[{id:info.id,generation:info.generation}]},{version:2,hostId:state.hostId,bootId:state.bootId,terminals:[{id:info.id,generation:info.generation}]}]){
    await writeFile(join(dataDir,'workspace-resume.json'),JSON.stringify(manifest));core=new HostCore({dataDir});await core.init();
    assert.equal(core.getState().terminals[0].status,'exited');assert.equal(core.getState().terminals[0].generation,info.generation);await core.close();core=undefined;
  }
});
