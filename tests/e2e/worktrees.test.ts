import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron, chromium, expect, type ElectronApplication, type Browser } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc/index';
import type { HostState } from '../../packages/protocol';
import { git } from '../helpers/git';

const enabled=process.platform==='win32'&&process.env.MONGLE_E2E_WORKTREES==='1';
test('real Electron and approved web client share worktrees and preserve lazy terminals across GUI restart',{skip:!enabled,timeout:150000},async()=>{
  const parent=path.resolve(process.env.MONGLE_E2E_DATA_ROOT||path.join(tmpdir(),'mongle-worktree-e2e'));await mkdir(parent,{recursive:true});
  const isolated=await mkdtemp(path.join(parent,'worktrees-'));assert.equal(path.dirname(isolated),parent);
  const dataDir=path.join(isolated,'host'),repository=path.join(isolated,'project');await mkdir(repository);await git(repository,'init','-q','--initial-branch=dev');await writeFile(path.join(repository,'README.md'),'# Isolated worktree E2E\n');await git(repository,'add','.');await git(repository,'commit','-qm','fixture');
  const output=path.resolve('test-results/e2e/worktrees');await mkdir(output,{recursive:true});
  let app:ElectronApplication|undefined,browser:Browser|undefined,owner:Awaited<ReturnType<typeof connectOwnerPipe>>|undefined;
  const errors:string[]=[],steps:string[]=[];
  const result:{passed:boolean;steps:string[];limitations:string[];error?:string;cleanupError?:string}={passed:false,steps,limitations:['Native directory dialog selection is supplied by the test; the existing desktop directory bridge and real host are used.','Mobile is Chrome touch emulation over the authenticated loopback gateway, not a physical phone or Tailscale network.','Development Electron build, not the installed release.']};
  async function start(){
    const env=Object.fromEntries(Object.entries(process.env).filter((item):item is [string,string]=>item[1]!==undefined));delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:path.resolve('node_modules/electron/dist/electron.exe'),args:[process.cwd()],cwd:process.cwd(),env:{...env,MONGLE_DATA_DIR:dataDir},timeout:30000});
    const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await expect(page.getByRole('button',{name:'프로젝트 열기',exact:true})).toBeEnabled({timeout:30000});return page;
  }
  try{
    let page=await start();owner=await connectOwnerPipe({dataDir});
    const state=()=>owner!.request<HostState>('state.get');
    const initial=await state(),group=initial.groups[0];await owner.request('groups.update',{id:group.id,revision:group.revision,name:'검증 프로젝트',cwd:repository,profileId:'cmd'});
    await owner.request('projects.attach',{hostId:initial.hostId,bootId:initial.bootId,path:repository,groupId:group.id,revision:(await state()).groups[0].revision});
    await app!.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},repository);
    await page.getByRole('button',{name:'프로젝트 열기',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(async()=>(await state()).terminals.length).toBe(1);
    steps.push('Desktop folder bridge opens the existing project and reuses its group.');
    await page.getByRole('button',{name:'워크트리',exact:true}).click();await page.getByLabel('워크트리 이름').fill('로그인 수정');await page.getByLabel('생성 후 터미널 열기').uncheck();await page.getByRole('button',{name:'워크트리 만들기',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    let current=await state();const worktree=current.worktrees!.find(w=>w.name==='로그인 수정')!;assert.ok(worktree);assert.equal(current.terminals.length,1);
    await page.getByRole('button',{name:'로그인 수정 워크트리 열기'}).click();await expect.poll(async()=>(await state()).terminals.filter(t=>t.worktreeId===worktree.id).length).toBe(1);
    current=await state();const terminal=current.terminals.find(t=>t.worktreeId===worktree.id)!;
    const pane=page.locator(`[data-terminal-id="${terminal.id}"]`);await expect(pane).toBeVisible();await pane.locator('.xterm-screen').click({position:{x:30,y:45}});
    await page.keyboard.type('echo WORKTREE_OK>shell-created.txt & git branch --show-current>branch.txt',{delay:5});await page.keyboard.press('Enter');
    await expect.poll(async()=>readFile(path.join(worktree.path,'shell-created.txt'),'utf8').catch(()=>''),{timeout:15000}).toContain('WORKTREE_OK');assert.equal(existsSync(path.join(repository,'shell-created.txt')),false);await expect.poll(async()=>(await readFile(path.join(worktree.path,'branch.txt'),'utf8').catch(()=>'' )).trim(),{timeout:15000}).toBe(worktree.branch);
    steps.push('A real ConPTY shell writes only in the linked worktree and reports the expected branch.');
    await page.getByRole('button',{name:'워크트리',exact:true}).click();await page.getByLabel('워크트리 이름').fill('나중에 시작');await page.getByLabel('생성 후 터미널 열기').uncheck();await page.getByRole('button',{name:'워크트리 만들기',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
    const before=await state(),unopened=before.worktrees!.find(w=>w.name==='나중에 시작')!;
    await page.screenshot({animations:'disabled',path:path.join(output,'desktop.png')});await app!.close();app=undefined;page=await start();await expect(page.getByRole('button',{name:'나중에 시작 워크트리 열기'})).toBeVisible();
    const after=await state();assert.equal(after.bootId,before.bootId);assert.equal(after.terminals.find(t=>t.id===terminal.id)?.pid,terminal.pid);assert.equal(after.terminals.filter(t=>t.worktreeId===unopened.id).length,0);
    steps.push('Closing and reopening Electron retains the live host/PID and keeps an unopened worktree at zero terminals.');
    const hostInfo=JSON.parse(await readFile(path.join(dataDir,'host-info.json'),'utf8'));
    browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mobile=await context.newPage();mobile.setDefaultTimeout(15000);mobile.on('pageerror',error=>errors.push(error.message));
    await mobile.goto(`http://127.0.0.1:${hostInfo.port}`);await expect(mobile.getByRole('heading',{name:'이 기기를 연결하세요'})).toBeVisible();
    const code=await owner.request<{code:string}>('pairing.create');await mobile.getByLabel('이 기기의 이름').fill('워크트리 검증 모바일');await mobile.getByLabel('일회용 연결 코드').fill(code.code);
    const response=mobile.waitForResponse(response=>response.url().endsWith('/v1/pairings/request')&&response.request().method()==='POST');await mobile.getByRole('button',{name:'연결 요청',exact:true}).click();await owner.request('pairing.approve',{requestId:(await (await response).json()).requestId});
    await expect(mobile.locator('.status-bar')).toContainText('세션 연결됨');await mobile.getByRole('button',{name:'그룹 메뉴 열기'}).click();await mobile.getByRole('button',{name:'나중에 시작 워크트리 열기'}).click();await expect.poll(async()=>(await state()).terminals.filter(t=>t.worktreeId===unopened.id).length).toBe(1);await expect(mobile.locator('.pane-title')).toContainText('나중에 시작');await mobile.screenshot({animations:'disabled',path:path.join(output,'mobile.png')});
    steps.push('An approved browser discovers the same worktrees and lazily opens one terminal on the selected host through the real web gateway.');
    assert.deepEqual(errors,[]);result.passed=true;
  }catch(error){result.error=error instanceof Error?error.stack:String(error);const page=app?.windows()[0];await page?.screenshot({animations:'disabled',path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
  finally{
    await browser?.close().catch(()=>{});await app?.close().catch(()=>{});
    if(!owner)owner=await connectOwnerPipe({dataDir}).catch(()=>undefined);
    if(owner){try{await owner.request('host.shutdown');}catch(error){result.cleanupError=String(error);}owner.close();}
    await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));
  }
});
