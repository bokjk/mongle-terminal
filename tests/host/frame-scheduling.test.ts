import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostCore } from '../../packages/host/core';
import { TerminalEngine } from '../../packages/terminal/engine';
import type { ConnectionContext, ServerMessage, SnapshotEvent, TerminalInfo } from '../../packages/protocol';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function until(predicate:()=>boolean){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out waiting for a scheduled frame.');await delay(15);}}
async function harness(t:test.TestContext){
  const dataDir=await mkdtemp(path.join(tmpdir(),'mongle-frames-')),core=new HostCore({dataDir});await core.init();
  t.after(async()=>{await core.close();assert.equal(path.dirname(dataDir),tmpdir());assert.ok(path.basename(dataDir).startsWith('mongle-frames-'));await rm(dataDir,{recursive:true,force:true});});
  const internal=core as any,state=core.getState(),events:ServerMessage[]=[];
  const ctx:ConnectionContext={id:randomUUID(),deviceId:randomUUID(),deviceName:'Frame test',owner:true};core.connect(ctx,event=>events.push(event));
  // A real VT engine with synthetic output keeps scheduling deterministic and
  // never starts a shell or depends on its prompt/startup timing.
  const info:TerminalInfo={id:randomUUID(),groupId:state.groups[0].id,title:'Frames',profileId:state.profiles[0].id,cwd:dataDir,generation:randomUUID(),status:'running',cols:80,rows:24};
  const engine=new TerminalEngine({cols:80,rows:24,scrollback:10,onResponse:()=>{}});
  const runtime={info,engine,seq:0,epoch:0,checkpointAt:0,disposed:false,pendingBytes:0} as any;
  internal.terminals.push(info);internal.groups[0].layout={type:'leaf',terminalId:info.id};internal.runtimes.set(info.id,runtime);internal.settings.recordHistory=false;internal.persist(true);
  const ref={id:info.id,hostId:state.hostId,bootId:state.bootId,generation:info.generation};
  const attach=await core.handle('terminals.attach',ref,ctx);await core.handle('terminal.ack',{...ref,seq:attach.seq},ctx);
  const frames=()=>events.filter((event):event is SnapshotEvent=>'type' in event&&event.type==='snapshot');
  return {core,internal,ctx,events,runtime,engine,ref,frames,schedule:()=>internal.scheduleFrame(runtime)};
}

test('scheduled snapshots coalesce while pending and eventually deliver the newest output',async t=>{
  const h=await harness(t),started=deferred(),release=deferred(),original=h.engine.snapshot.bind(h.engine);
  let calls=0,active=0,maxActive=0;
  const mock=t.mock.method(h.engine,'snapshot',async()=>{
    const index=++calls;active++;maxActive=Math.max(maxActive,active);
    try{const snapshot=await original();if(index===1){started.resolve();await release.promise;}return snapshot;}finally{active--;}
  });
  try{
    await h.engine.write('first frame\r\n');h.schedule();await started.promise;
    await h.engine.write('newest frame\r\n');h.schedule();await delay(90);h.schedule();await delay(90);
    assert.equal(calls,1,'output arriving during capture must not start another capture');
    release.resolve();await until(()=>h.frames().length>0);
    await h.core.handle('terminal.ack',{...h.ref,seq:h.frames()[0].seq},h.ctx);
    await until(()=>h.frames().some(frame=>frame.snapshot.data.includes('newest frame')));
    assert.equal(maxActive,1);assert.equal(calls,2,'one follow-up capture covers all pending output');
    await h.core.handle('terminal.ack',{...h.ref,seq:h.frames().at(-1)!.seq},h.ctx);
    h.core.disconnect(h.ctx.id);h.core.connect(h.ctx,event=>h.events.push(event));
    const attached=await h.core.handle('terminals.attach',h.ref,h.ctx);
    assert.ok(attached.snapshot.data.includes('newest frame'));
    await h.core.handle('terminal.ack',{...h.ref,seq:attached.seq},h.ctx);
    await h.engine.write('after reconnect');h.schedule();
    await until(()=>h.frames().some(frame=>frame.snapshot.data.includes('after reconnect')));
  }finally{release.resolve();await until(()=>!h.runtime.framePending);mock.mock.restore();}
});

test('a failed scheduled snapshot releases its slot and retries output received during capture',async t=>{
  const h=await harness(t),started=deferred(),release=deferred(),original=h.engine.snapshot.bind(h.engine);
  let calls=0;
  const mock=t.mock.method(h.engine,'snapshot',async()=>{if(++calls===1){started.resolve();await release.promise;throw new Error('simulated snapshot failure');}return original();});
  try{
    h.schedule();await started.promise;await h.engine.write('recovered output');h.schedule();release.resolve();
    await until(()=>h.frames().some(frame=>frame.snapshot.data.includes('recovered output')));
    assert.equal(calls,2);
    assert.equal(h.events.filter(event=>'type' in event&&event.type==='notice'&&event.code==='SNAPSHOT_FAILED').length,1);
  }finally{release.resolve();await until(()=>!h.runtime.framePending);mock.mock.restore();}
});

test('disconnect and removal during capture discard the stale frame without scheduling another',async t=>{
  const h=await harness(t),started=deferred(),release=deferred(),original=h.engine.snapshot.bind(h.engine);
  let calls=0;
  const mock=t.mock.method(h.engine,'snapshot',async()=>{calls++;const snapshot=await original();started.resolve();await release.promise;return snapshot;});
  try{
    h.schedule();await started.promise;await h.engine.write('pending output');h.schedule();h.core.disconnect(h.ctx.id);
    const replacement={...h.ctx,id:randomUUID()};h.core.connect(replacement,event=>h.events.push(event));
    await h.core.handle('terminals.remove',{...h.ref,terminate:true},replacement);
    release.resolve();await until(()=>!h.runtime.framePending);await delay(90);
    assert.equal(h.runtime.disposed,true);assert.equal(h.runtime.timer,undefined);assert.equal(calls,1);assert.equal(h.frames().length,0);
    assert.ok(!h.events.some(event=>'type' in event&&event.type==='notice'&&event.code==='SNAPSHOT_FAILED'));
  }finally{release.resolve();await until(()=>!h.runtime.framePending);mock.mock.restore();}
});
