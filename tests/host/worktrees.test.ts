import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, rmdir, writeFile, unlink, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { git, gitFixture } from '../helpers/git';
import { inspectProject, prepareWorktree, addWorktree, removeWorktree } from '../../packages/host/worktrees';
import { HostCore } from '../../packages/host/core';
import { HostStore } from '../../packages/storage';
import type { ConnectionContext, Repository, Worktree, WorktreeOperation, TerminalInfo } from '../../packages/protocol';
import { groupRepositoryIds } from '../../packages/protocol';

async function cleanup(root:string){assert.equal(path.dirname(root),tmpdir());assert.ok(path.basename(root).startsWith('mongle-git-'));await rm(root,{recursive:true,force:true});}
async function fixture(t:test.TestContext,autoClean=true){const f=await gitFixture();if(autoClean)t.after(()=>cleanup(f.root));return f;}
const hostRef=(core:HostCore)=>({hostId:core.getState().hostId,bootId:core.getState().bootId});

test('one workspace retains multiple repositories and allows new tabs outside their source worktree', {timeout:60000},async t=>{
  const a=await fixture(t,false),b=await fixture(t,false),core=new HostCore({dataDir:a.data});await core.init();
  t.after(async()=>{await core.close();await cleanup(a.root);await cleanup(b.root);});
  const ctx:ConnectionContext={id:randomUUID(),deviceId:'context',deviceName:'Test',owner:true};core.connect(ctx,()=>{});
  const call=(method:string,params:object)=>core.handle(method,{...hostRef(core),...params},ctx),groupId=core.getState().groups[0].id;
  const attach=(directory:string)=>call('projects.attach',{path:directory,groupId,revision:core.getState().groups[0].revision});
  const first=await attach(a.repository),second=await attach(b.repository);
  assert.deepEqual(groupRepositoryIds(core.getState().groups[0]),[first.repository.id,second.repository.id]);
  await assert.rejects(call('worktrees.create',{requestId:randomUUID(),groupId,name:'ambiguous',baseRef:'main',openTerminal:false}),{code:'PROJECT_NOT_FOUND'});
  const op=await call('worktrees.create',{requestId:randomUUID(),groupId,repositoryId:second.repository.id,name:'B only',baseRef:'main',openTerminal:false});
  assert.equal((await finish(core,op.id)).status,'succeeded');
  const linked=core.getState().worktrees!.find(w=>w.id===op.worktreeId)!;assert.equal(linked.repositoryId,second.repository.id);
  const terminal:TerminalInfo=await call('worktrees.open',{groupId,worktreeId:linked.id});
  // A real directory report is fed through the same parser as shell OSC output.
  const alias=path.join(a.root,'repository-alias');await symlink(a.repository,alias,process.platform==='win32'?'junction':'dir');
  await (core as any).runtimes.get(terminal.id).engine.write(`\x1b]9;9;${path.join(alias,'src')}\x07`);
  const extra:TerminalInfo=await core.handle('terminals.create',{groupId,tabTarget:terminal.id,profileId:'cmd'},ctx);
  assert.equal(await realpath(extra.cwd),await realpath(path.join(a.repository,'src')));assert.equal(extra.worktreeId,first.worktreeId);
  const plain:TerminalInfo=await core.handle('terminals.create',{groupId,tabTarget:terminal.id,profileId:'cmd',cwd:a.root},ctx);
  assert.equal(await realpath(plain.cwd),await realpath(a.root));assert.equal(plain.worktreeId,undefined);
  await core.handle('groups.update',{id:groupId,revision:core.getState().groups[0].revision,cwd:a.root},ctx);
  assert.equal(await realpath(core.getState().groups[0].cwd),await realpath(a.root));
  const other=await core.handle('groups.create',{name:'Shared repository',cwd:a.root,profileId:'cmd'},ctx);
  await call('projects.attach',{path:b.repository,groupId:other.id,revision:other.revision});
  assert.deepEqual(groupRepositoryIds(core.getState().groups.find(g=>g.id===other.id)!),[second.repository.id]);
  for(const item of core.getState().terminals)await core.handle('terminals.remove',{...hostRef(core),id:item.id,generation:item.generation,terminate:true},ctx);
  await core.close();const restored=new HostCore({dataDir:a.data});await restored.init();
  try{assert.deepEqual(groupRepositoryIds(restored.getState().groups[0]),[first.repository.id,second.repository.id]);assert.ok(restored.getState().worktrees?.some(w=>w.id===linked.id));}finally{await restored.close();}
});
async function finish(core:HostCore,id:string){const until=Date.now()+20000;while(Date.now()<until){const op=core.getState().worktreeOperations!.find(op=>op.id===id)!;if(!['pending','running'].includes(op.status))return op;await new Promise(resolve=>setTimeout(resolve,35));}throw new Error('worktree operation did not finish');}

test('real Git creates Unicode worktrees outside the source, disables hooks, preserves branches and rejects dirty removal',async t=>{
  const f=await fixture(t),inspection=await inspectProject(f.repository,f.data);
  const repo:Repository={id:randomUUID(),root:inspection.root,commonDir:inspection.commonDir,baseRef:inspection.baseRef,worktreeRoot:path.join(f.root,'worktrees'),checkedAt:Date.now()};
  await writeFile(path.join(f.repository,'.git','hooks','post-checkout'),'#!/bin/sh\necho ran > hook-ran.txt\n');
  const input={name:'로그인 수정',branch:'feat/login',baseRef:'main',path:path.join(f.root,'로그인 수정'),existingBranch:false};
  const prepared=await prepareWorktree(repo,input,f.data),result=await addWorktree(repo,prepared,f.data);
  assert.equal(result.worktrees.length,2);assert.equal(result.worktrees[1].branch,'feat/login');assert.equal(existsSync(path.join(prepared.path,'hook-ran.txt')),false);
  assert.equal((await readFile(path.join(prepared.path,'README.md'),'utf8')).replaceAll('\r\n','\n'),'# Test project\n');
  await assert.rejects(prepareWorktree(repo,{...input,path:path.join(f.root,'duplicate')},f.data),{code:'BRANCH_IN_USE'});
  await assert.rejects(prepareWorktree(repo,{...input,branch:'bad name'},f.data),{code:'INVALID_BRANCH'});
  await assert.rejects(prepareWorktree(repo,{...input,branch:'new',path:path.join(f.repository,'nested')},f.data),{code:'INVALID_WORKTREE_PATH'});
  await assert.rejects(prepareWorktree(repo,{...input,branch:'new',path:f.repository},f.data),{code:'WORKTREE_PATH_EXISTS'});
  const worktree:Worktree={...result.worktrees[1],id:randomUUID(),repositoryId:repo.id,name:input.name,managed:true};
  await mkdir(path.join(worktree.path,'ignored'));await writeFile(path.join(worktree.path,'ignored','secret.env'),'keep');
  await assert.rejects(removeWorktree(repo,worktree,f.data,()=>{}),{code:'WORKTREE_DIRTY'});assert.equal(await readFile(path.join(worktree.path,'ignored','secret.env'),'utf8'),'keep');
  await unlink(path.join(worktree.path,'ignored','secret.env'));await rmdir(path.join(worktree.path,'ignored'));
  await removeWorktree(repo,worktree,f.data,()=>{});assert.equal(existsSync(worktree.path),false);assert.match(await git(f.repository,'branch','--list','feat/login'),/feat\/login/);
});

test('worktree branch choices keep exact local names and commits when tags share their names',async t=>{
  const f=await fixture(t),originalHead=(await git(f.repository,'rev-parse','HEAD')).trim();
  await git(f.repository,'branch','shared');
  await writeFile(path.join(f.repository,'README.md'),'new main commit\n');
  await git(f.repository,'commit','-qam','advance main');
  const mainHead=(await git(f.repository,'rev-parse','HEAD')).trim();
  await git(f.repository,'tag','shared',mainHead);await git(f.repository,'tag','main',originalHead);
  const inspection=await inspectProject(f.repository,f.data);
  assert.deepEqual(inspection.branches,['main','shared']);assert.equal(inspection.baseRef,'main');
  const repo:Repository={id:randomUUID(),root:inspection.root,commonDir:inspection.commonDir,baseRef:inspection.baseRef,worktreeRoot:path.join(f.root,'worktrees'),checkedAt:Date.now()};
  const existing=await prepareWorktree(repo,{name:'shared',branch:'shared',baseRef:'main',path:path.join(f.root,'existing'),existingBranch:true},f.data);
  assert.equal(existing.head,originalHead,'existing branches must resolve through refs/heads');
  const connected=await addWorktree(repo,existing,f.data);
  assert.equal(connected.worktrees.find(item=>item.branch==='shared')?.head,originalHead);
  const created=await prepareWorktree(repo,{name:'from main',branch:'from-main',baseRef:'main',path:path.join(f.root,'from-main'),existingBranch:false},f.data);
  assert.equal(created.head,mainHead,'a selected local base branch must not resolve to a same-name tag');
  const result=await addWorktree(repo,created,f.data);
  assert.equal(result.worktrees.find(item=>item.branch==='from-main')?.head,mainHead);
});

test('host lazily opens one terminal, keeps worktree identity across tabs and move, and restores unopened worktrees', {timeout:60000},async t=>{
  const f=await fixture(t,false),core=new HostCore({dataDir:f.data});await core.init();t.after(async()=>{await core.close();await cleanup(f.root);});
  const ctx:ConnectionContext={id:randomUUID(),deviceId:'worktree-test',deviceName:'Test',owner:true};core.connect(ctx,()=>{});
  const call=(method:string,params:object)=>core.handle(method,{...hostRef(core),...params},ctx);
  const original=core.getState().groups[0];
  await call('projects.attach',{path:f.repository,groupId:original.id,revision:original.revision});
  assert.equal(core.getState().terminals.length,0);
  const request={requestId:randomUUID(),groupId:original.id,name:'로그인 수정',baseRef:'main',openTerminal:false};
  const [a,b]:WorktreeOperation[]=await Promise.all([call('worktrees.create',request),call('worktrees.create',request)]);assert.equal(a.id,b.id);
  assert.equal((await finish(core,a.id)).status,'succeeded');assert.equal(core.getState().terminals.length,0);
  const worktree=core.getState().worktrees!.find(w=>w.id===a.worktreeId)!;assert.ok(worktree.managed);assert.equal(worktree.name,'로그인 수정');
  const [first,again]:TerminalInfo[]=await Promise.all([call('worktrees.open',{groupId:original.id,worktreeId:worktree.id}),call('worktrees.open',{groupId:original.id,worktreeId:worktree.id})]);
  assert.equal(first.id,again.id);assert.equal(first.cwd,await realpath(worktree.path));assert.equal(core.getState().terminals.length,1);
  const extra:TerminalInfo=await core.handle('terminals.create',{groupId:original.id,tabTarget:first.id,profileId:'cmd'},ctx);assert.equal(extra.worktreeId,worktree.id);assert.equal(extra.cwd,first.cwd);
  const selected=await call('worktrees.open',{groupId:original.id,worktreeId:worktree.id,preferredId:extra.id});assert.equal(selected.id,extra.id);
  const other=await core.handle('groups.create',{name:'다른 그룹',profileId:'cmd'},ctx);
  const moved=await core.handle('terminals.move',{...hostRef(core),id:extra.id,generation:extra.generation,groupId:other.id},ctx);assert.equal(moved.worktreeId,worktree.id);assert.equal(moved.pid,extra.pid);
  await assert.rejects(call('worktrees.remove',{requestId:randomUUID(),groupId:original.id,worktreeId:worktree.id,confirmed:true}),{code:'WORKTREE_IN_USE'});
  await assert.rejects(core.handle('worktrees.open',{...hostRef(core),bootId:randomUUID(),groupId:original.id,worktreeId:worktree.id},ctx),{code:'HOST_CHANGED'});
  for(const terminal of core.getState().terminals)await core.handle('terminals.remove',{...hostRef(core),id:terminal.id,generation:terminal.generation,terminate:true},ctx);
  await core.close();const restored=new HostCore({dataDir:f.data});await restored.init();
  try{assert.equal(restored.getState().terminals.length,0);assert.equal(restored.getState().worktrees!.find(w=>w.id===worktree.id)?.name,'로그인 수정');}finally{await restored.close();}
});

test('creation keeps a finished worktree when the requesting client disconnects before terminal opening', {timeout:45000},async t=>{
  const f=await fixture(t,false),core=new HostCore({dataDir:f.data});await core.init();t.after(async()=>{await core.close();await cleanup(f.root);});
  const ctx:ConnectionContext={id:randomUUID(),deviceId:'test',deviceName:'Test',owner:true};core.connect(ctx,()=>{});
  const group=core.getState().groups[0];await core.handle('projects.attach',{...hostRef(core),path:f.repository,groupId:group.id,revision:group.revision},ctx);
  const op:WorktreeOperation=await core.handle('worktrees.create',{...hostRef(core),requestId:randomUUID(),groupId:group.id,name:'나중에 열기',baseRef:'main',openTerminal:true},ctx);
  core.disconnect(ctx.id);
  const done=await finish(core,op.id);assert.equal(done.status,'succeeded');assert.match(done.message!,/터미널을 열지 못/);assert.equal(core.getState().terminals.length,0);assert.ok(core.getState().worktrees!.find(w=>w.id===op.worktreeId));
});

test('a slow checkout filter does not block heartbeat or state commits and does not replace the running shell', {timeout:45000},async t=>{
  const f=await fixture(t,false),core=new HostCore({dataDir:f.data});await core.init();t.after(async()=>{await core.close();await cleanup(f.root);});
  const marker=path.join(f.root,'filter-started'),script=path.join(f.root,'filter.cjs');
  await writeFile(script,`const fs=require('node:fs');let data='';process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>process.stdout.write(data),2500);});`);
  await writeFile(path.join(f.repository,'.gitattributes'),'*.slow filter=slow\n');await writeFile(path.join(f.repository,'test.slow'),'filtered file\n');await git(f.repository,'add','.gitattributes','test.slow');await git(f.repository,'commit','-qm','filter fixture');await git(f.repository,'config','filter.slow.smudge',`node "${script.replaceAll('\\','/')}"`);
  const ctx:ConnectionContext={id:randomUUID(),deviceId:'responsive',deviceName:'Test',owner:true};core.connect(ctx,()=>{});
  const group=core.getState().groups[0];await core.handle('groups.update',{id:group.id,revision:group.revision,profileId:'cmd'},ctx);
  await core.handle('projects.attach',{...hostRef(core),path:f.repository,groupId:group.id,revision:core.getState().groups[0].revision},ctx);
  const terminal:TerminalInfo=await core.handle('terminals.create',{groupId:group.id,profileId:'cmd',cwd:f.repository},ctx);
  const op:WorktreeOperation=await core.handle('worktrees.create',{...hostRef(core),requestId:randomUUID(),groupId:group.id,name:'slow',baseRef:'main',openTerminal:false},ctx);
  const deadline=Date.now()+15000;while(!existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));assert.ok(existsSync(marker));
  const start=Date.now();await core.handle('heartbeat',{},ctx);await core.handle('terminals.rename',{id:terminal.id,title:'still responsive'},ctx);assert.ok(Date.now()-start<1500,'checkout must not hold the terminal mutation queue');
  assert.equal(core.getState().terminals[0].pid,terminal.pid);assert.equal(core.getState().terminals[0].generation,terminal.generation);assert.equal((await finish(core,op.id)).status,'succeeded');
});

test('refresh recovers a checkout after metadata failure without duplicate folders or surprise terminals', {timeout:45000},async t=>{
  const f=await fixture(t,false),core=new HostCore({dataDir:f.data});await core.init();t.after(async()=>{await core.close();await cleanup(f.root);});
  const ctx:ConnectionContext={id:randomUUID(),deviceId:'recovery',deviceName:'Test',owner:true};core.connect(ctx,()=>{});
  const call=(method:string,params:object)=>core.handle(method,{...hostRef(core),...params},ctx),group=core.getState().groups[0];
  await call('projects.attach',{path:f.repository,groupId:group.id,revision:group.revision});
  const store=(core as any).store as HostStore,save=store.save.bind(store);let injected=false;
  store.save=(state,...args)=>{if(!injected&&state.worktrees?.some(w=>w.managed)){injected=true;throw new Error('simulated disk full after checkout');}save(state,...args);};
  const request={requestId:randomUUID(),groupId:group.id,name:'복구 확인',baseRef:'main',openTerminal:true};
  const op:WorktreeOperation=await call('worktrees.create',request),failed=await finish(core,op.id);store.save=save;
  assert.equal(injected,true);assert.equal(failed.status,'attention');assert.ok(existsSync(path.join(failed.path!,'README.md')));assert.equal(core.getState().terminals.length,0);assert.equal(core.getState().worktrees!.filter(w=>w.managed).length,0);
  assert.equal((await call('worktrees.create',request)).id,op.id);
  await call('worktrees.refresh',{repositoryId:op.repositoryId});
  assert.equal(core.getState().worktrees!.filter(w=>w.managed).length,1);assert.equal(path.resolve(core.getState().worktrees!.find(w=>w.id===op.worktreeId)!.path),path.resolve(failed.path!));assert.equal(core.getState().worktreeOperations!.find(item=>item.id===op.id)?.status,'succeeded');
  assert.equal(core.getState().terminals.length,0,'recovery must not open a terminal after the original request has failed');
  assert.equal((await call('worktrees.create',request)).id,op.id);assert.equal((await inspectProject(f.repository,f.data)).worktrees.length,2);
});
