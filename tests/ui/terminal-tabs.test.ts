import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol/index.js';

test('terminal tabs preserve live panes, input and layouts; remember views; confirm close; fit narrow screens', {
  timeout:120000,skip:process.platform!=='win32'||!existsSync('dist/web/index.html')?'Requires Windows, Chrome and built web UI.':false,
},async t=>{
  const dataRoot=await mkdtemp(path.join(tmpdir(),'mongle-tabs-'));
  const output=path.resolve('test-results/ui/terminal-tabs');await mkdir(output,{recursive:true});
  const hosts=[new HostCore({dataDir:path.join(dataRoot,'primary'),name:'탭 검증 PC'}),new HostCore({dataDir:path.join(dataRoot,'alternate'),name:'다른 검증 PC'})];
  t.after(async()=>{await Promise.all(hosts.map(host=>host.close()));await rm(dataRoot,{recursive:true,force:true});});
  await Promise.all(hosts.map(host=>host.init()));
  const context:ConnectionContext={id:randomUUID(),deviceId:'tabs-owner',deviceName:'탭 검증',owner:true};
  const remote:ConnectionContext={id:randomUUID(),deviceId:'tabs-remote',deviceName:'다른 기기',owner:false};
  hosts.forEach(host=>host.connect(context,()=>{}));
  // cmd.exe avoids reading or writing the user's interactive PowerShell history.
  const host=hosts[0],group=host.getState().groups[0],profile=host.getState().profiles.find(item=>item.kind==='cmd');assert.ok(profile);
  await host.handle('groups.update',{id:group.id,revision:group.revision,name:'개발',cwd:'C:\\Windows',profileId:profile.id},context);
  const first=await host.handle('terminals.create',{groupId:group.id,profileId:profile.id},context) as TerminalInfo;
  const second=await host.handle('terminals.create',{groupId:group.id,profileId:profile.id,splitTarget:first.id,axis:'vertical'},context) as TerminalInfo;
  await host.handle('terminals.rename',{id:first.id,title:'API 서버'},context);
  await host.handle('terminals.rename',{id:second.id,title:'빌드 작업'},context);
  const otherGroup=await host.handle('groups.create',{name:'로그',cwd:'C:\\Windows',profileId:profile.id},context);
  await host.handle('terminals.create',{groupId:otherGroup.id,profileId:profile.id},context);
  const alternate=hosts[1],alternateGroup=alternate.getState().groups[0];
  await alternate.handle('groups.update',{id:alternateGroup.id,revision:alternateGroup.revision,cwd:'C:\\Windows',profileId:profile.id},context);
  await alternate.handle('terminals.create',{groupId:alternateGroup.id,profileId:profile.id},context);

  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1380,height:900}});page.setDefaultTimeout(10000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const server=createServer(async(req,res)=>{
    try{const pathname=new URL(req.url||'/','http://localhost').pathname;const file=path.resolve('dist/web',pathname==='/'?'index.html':pathname.slice(1));if(!file.startsWith(path.resolve('dist/web')+path.sep))throw new Error();res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html');res.end(await readFile(file));}
    catch{res.writeHead(404).end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  let selected=0;
  const calls:Array<{method:string;params:any}>=[];
  const send=(index:number)=>(event:unknown)=>{if(selected===index)void page.evaluate(event=>(window as any).__tabsListeners?.forEach((fn:any)=>fn(event)),event).catch(()=>{});};
  hosts[0].connect(context,send(0));hosts[0].connect(remote,()=>{});
  await page.exposeBinding('tabsRequest',async(_source,method:string,params:unknown)=>{calls.push({method,params});return hosts[selected].handle(method,params,context);});
  await page.exposeBinding('tabsHosts',()=>hosts.map((host,index)=>({id:String(index),name:host.getState().name,local:index===0,selected:index===selected})));
  await page.exposeBinding('tabsSelect',(_source,id:string)=>{hosts[selected].disconnect(context.id);selected=Number(id);hosts[selected].connect(context,send(selected));return {status:'connected',owner:true,hostId:hosts[selected].getState().hostId,connectionId:context.id};});
  await page.addInitScript('window.__name=function(fn){return fn;};');
  await page.addInitScript(({hostId,connectionId})=>{
    const listeners=new Set();(window as any).__tabsListeners=listeners;
    (window as any).mongle={request:(method:string,params:unknown)=>(window as any).tabsRequest(method,params),subscribe:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:(fn:any)=>{fn({status:'connected',owner:true,hostId,connectionId});return()=>{};},listHosts:()=>(window as any).tabsHosts(),selectHost:(id:string)=>(window as any).tabsSelect(id)};
  },{hostId:host.getState().hostId,connectionId:context.id});
  const pane=(id:string)=>page.locator(`.pane[data-terminal-id="${id}"]`);
  const identity=()=>host.getState().terminals.map(({id,pid,generation,status})=>({id,pid,generation,status}));
  const input=(start:number)=>calls.slice(start).filter(call=>call.method==='terminal.input').map(call=>call.params.data).join('').replace(/\x1b\[[IO]/g,'');
  const assertStablePanes=async()=>assert.equal(await page.evaluate(()=>Array.from((window as any).__tabNodes as Map<string,Element>).every(([id,node])=>document.querySelector(`.pane[data-terminal-id="${id}"] .xterm`)===node)),true,'tabs, split and maximize retain the exact xterm DOM nodes');
  try{
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(pane(first.id)).toBeVisible();await expect(pane(second.id)).toBeVisible();
    await expect.poll(()=>host.getState().terminals.filter(item=>item.groupId===group.id&&item.controller?.ready).length).toBe(2);
    const originalLayout=structuredClone(host.getState().groups.find(item=>item.id===group.id)!.layout),originalIdentity=identity();
    await page.evaluate(()=>{(window as any).__tabNodes=new Map(Array.from(document.querySelectorAll('.pane')).map(pane=>[pane.getAttribute('data-terminal-id'),pane.querySelector('.xterm')]));});
    const lifecycle=calls.filter(call=>['terminals.attach','terminals.detach','control.acquire'].includes(call.method)).length;
    const header=await page.locator('.workspace-header').boundingBox();assert.equal(header?.height,44);
    await page.getByRole('button',{name:'탭 보기',exact:true}).click();
    await expect(page.getByRole('tablist',{name:'터미널 탭'})).toBeVisible();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);await expect(pane(second.id)).toBeHidden();
    const wide=await pane(first.id).boundingBox();assert.ok(wide&&wide.width>1100);
    const inputStart=calls.length;
    await pane(first.id).locator('.xterm-helper-textarea').focus();await page.keyboard.type('set TAB_PROOF=SESSION_OK');await page.keyboard.press('Enter');
    await expect.poll(()=>input(inputStart)).toBe('set TAB_PROOF=SESSION_OK\r');
    await page.keyboard.press('Control+Tab');await expect(page.getByRole('tab',{name:'빌드 작업',exact:true})).toHaveAttribute('aria-selected','true');
    await page.keyboard.press('Control+Shift+Tab');await expect(page.getByRole('tab',{name:'API 서버',exact:true})).toHaveAttribute('aria-selected','true');
    assert.equal(input(inputStart),'set TAB_PROOF=SESSION_OK\r','tab shortcuts never leak bytes to a shell');
    await page.getByRole('tab',{name:'API 서버',exact:true}).focus();await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab',{name:'빌드 작업',exact:true})).toBeFocused();
    await page.keyboard.press('Home');await expect(page.getByRole('tab',{name:'API 서버',exact:true})).toBeFocused();
    await page.keyboard.press('End');await expect(page.getByRole('tab',{name:'빌드 작업',exact:true})).toBeFocused();
    await page.getByRole('tab',{name:'API 서버',exact:true}).click();
    const resumeStart=calls.length;await pane(first.id).locator('.xterm-helper-textarea').focus();await page.keyboard.type('echo %TAB_PROOF%');await page.keyboard.press('Enter');
    await expect.poll(()=>input(resumeStart)).toBe('echo %TAB_PROOF%\r');
    await expect.poll(async()=>(await pane(first.id).locator('.xterm-rows').innerText()).split('\n').map(line=>line.trim())).toContain('SESSION_OK');
    await assertStablePanes();assert.deepEqual(identity(),originalIdentity);
    assert.deepEqual(host.getState().groups.find(item=>item.id===group.id)!.layout,originalLayout);
    assert.equal(calls.filter(call=>['terminals.attach','terminals.detach','control.acquire'].includes(call.method)).length,lifecycle,'view changes do not reconnect panes or replace leases');
    await page.screenshot({path:path.join(output,'desktop-tabs-dark.png')});
    await page.screenshot({path:path.join(output,'compact-header.png'),clip:{x:0,y:0,width:1380,height:84}});

    await page.getByRole('button',{name:'분할 보기',exact:true}).click();
    await expect(pane(second.id)).toBeVisible();await expect(page.getByRole('separator',{name:'상하 분할 크기'})).toBeVisible();
    await pane(first.id).getByRole('button',{name:'최대화',exact:true}).click();await expect(pane(second.id)).toBeHidden();await assertStablePanes();
    await page.locator('.terminal-tab-select').filter({hasText:'빌드 작업'}).click();await expect(pane(second.id)).toBeVisible();await expect(pane(first.id)).toBeHidden();
    await pane(second.id).getByRole('button',{name:'분할로 돌아가기',exact:true}).click();await expect(pane(first.id)).toBeVisible();await assertStablePanes();
    await page.screenshot({path:path.join(output,'desktop-split-dark.png')});
    await page.getByRole('button',{name:'탭 보기',exact:true}).click();
    await page.locator('.group-main').filter({hasText:'로그'}).click();await expect(page.getByRole('button',{name:'분할 보기',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.locator('.group-main').filter({hasText:'개발'}).click();await expect(page.getByRole('button',{name:'탭 보기',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.reload();await expect(page.getByRole('tab',{name:'빌드 작업',exact:true})).toHaveAttribute('aria-selected','true');assert.deepEqual(identity(),originalIdentity);
    await page.getByRole('button',{name:'접속할 컴퓨터',exact:true}).click();await page.getByRole('option').nth(1).click();
    await expect(page.getByRole('button',{name:'분할 보기',exact:true})).toHaveAttribute('aria-pressed','true');
    await page.getByRole('button',{name:'접속할 컴퓨터',exact:true}).click();await page.getByRole('option').first().click();
    await expect(page.getByRole('button',{name:'탭 보기',exact:true})).toHaveAttribute('aria-pressed','true');assert.deepEqual(identity(),originalIdentity);
    await expect(pane(second.id).getByText('여기서 제어 중',{exact:true})).toBeVisible();

    // Merely selecting a tab must not take control away from another device.
    const fresh=host.getState();const secondInfo=fresh.terminals.find(item=>item.id===second.id)!;
    await host.handle('control.acquire',{id:second.id,hostId:fresh.hostId,bootId:fresh.bootId,generation:secondInfo.generation,cols:80,rows:24},remote);
    const acquires=calls.filter(call=>call.method==='control.acquire').length;
    await page.getByRole('tab',{name:'API 서버',exact:true}).click();await page.getByRole('tab',{name:'빌드 작업',exact:true}).click();
    await expect(pane(second.id).getByRole('button',{name:'다른 기기에서 제어 · 가져오기'})).toBeVisible();
    assert.equal(host.getState().terminals.find(item=>item.id===second.id)?.controller?.connectionId,remote.id);
    assert.equal(calls.filter(call=>call.method==='control.acquire').length,acquires);

    await page.getByRole('button',{name:'터미널 추가',exact:true}).click();await page.getByRole('button',{name:'터미널 열기',exact:true}).click();
    await expect(page.getByRole('tab')).toHaveCount(3);const added=host.getState().terminals.find(item=>item.groupId===group.id&&item.id!==first.id&&item.id!==second.id)!;
    assert.equal(calls.filter(call=>call.method==='terminals.create').length,1,'plus creates exactly one session');
    await page.locator('.terminal-tab.active .terminal-tab-close').click();await page.getByRole('dialog').getByRole('button',{name:'취소',exact:true}).click();
    assert.ok(host.getState().terminals.some(item=>item.id===added.id));
    await page.locator('.terminal-tab.active .terminal-tab-close').click();await page.getByRole('dialog').getByRole('button',{name:'종료하고 닫기',exact:true}).click();
    await expect(page.getByRole('tab')).toHaveCount(2);assert.equal(host.getState().terminals.some(item=>item.id===added.id),false);
    await page.getByRole('tab',{name:'API 서버',exact:true}).click();
    await pane(first.id).getByRole('button',{name:'좌우 분할',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'취소',exact:true}).click();
    await expect(page.getByRole('button',{name:'탭 보기',exact:true})).toHaveAttribute('aria-pressed','true');
    await pane(first.id).getByRole('button',{name:'좌우 분할',exact:true}).click();await page.getByRole('button',{name:'터미널 열기',exact:true}).click();
    await expect(page.getByRole('button',{name:'분할 보기',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.locator('.pane:visible')).toHaveCount(3);
    await page.getByRole('button',{name:'탭 보기',exact:true}).click();

    await host.handle('terminals.rename',{id:first.id,title:'API 서버 · 아주 긴 터미널 이름으로 넘침과 가로 스크롤 확인'},context);
    await page.setViewportSize({width:701,height:760});
    await page.getByRole('tab').first().focus();await page.keyboard.press('End');await expect(page.getByRole('tab').last()).toBeInViewport();
    assert.ok(await page.locator('.terminal-tabs').evaluate(element=>element.scrollWidth>element.clientWidth));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),701);
    await page.getByRole('button',{name:'파일 탐색기',exact:true}).click();await expect(page.locator('.file-explorer')).toBeVisible();
    await page.getByRole('button',{name:'파일 탐색기',exact:true}).click();
    await page.setViewportSize({width:1380,height:900});await page.getByRole('tab').first().click();
    await page.getByRole('button',{name:'설정',exact:true}).first().click();await page.getByRole('button',{name:'밝게',exact:true}).click();await page.getByRole('button',{name:'설정 닫기'}).click();
    await page.screenshot({path:path.join(output,'desktop-tabs-light.png')});
    await page.setViewportSize({width:390,height:844});await expect(page.locator('.terminal-tabs')).toHaveCount(0);await expect(page.locator('.pane')).toHaveCount(1);await expect(page.locator('.mobile-panel-switcher')).toBeVisible();
    const mobilePlus=await page.getByRole('button',{name:'터미널 추가',exact:true}).boundingBox();assert.ok(mobilePlus&&mobilePlus.width>=44&&mobilePlus.height>=44);
    await page.setViewportSize({width:1380,height:900});await expect(page.getByRole('tablist')).toBeVisible();
    assert.deepEqual(errors,[]);
    await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,headerHeight:header?.height,originalHeaderHeight:78,stablePanes:true,sessionVariablesPreserved:true,shortcutsDoNotSendInput:true,viewPreferencePerHostAndGroup:true,closeConfirmation:true,remoteControlPreserved:true,narrowDesktopWidth:701,mobileWidth:390,errors},null,2));
  }catch(error){await page.screenshot({path:path.join(output,'failure.png')});throw error;}
});
