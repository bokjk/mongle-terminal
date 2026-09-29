import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext } from '../../packages/protocol/index.js';

test('real UI and host: typing, uncertain-input latch, split, resize, reload PID, light theme, mobile switch', {timeout:90000,skip:process.platform!=='win32'||!existsSync('dist/web/index.html')?'Requires Windows and built web UI.':false}, async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'mongle-ui-'));
  const host=new HostCore({dataDir,name:'UI 검증 PC'});await host.init();
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1380,height:900}});
  const context:ConnectionContext={id:randomUUID(),deviceId:'ui-test-owner',deviceName:'UI 검증',owner:true};
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const server=createServer(async(req,res)=>{try{const url=new URL(req.url||'/', 'http://localhost');const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));const file=path.resolve('dist/web',relative);if(!file.startsWith(path.resolve('dist/web')+path.sep)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  let failNextInput=false;const inputs:any[]=[];const acknowledged:number[]=[];
  await page.exposeBinding('hostRequest',async(_source,method:string,params:unknown)=>{if(method==='terminal.input'){inputs.push(params);if(failNextInput){failNextInput=false;throw new Error('입력 응답 대기 시간이 초과되었습니다.');}}const result=await host.handle(method,params,context);if(method==='terminal.ack')acknowledged.push((params as any).seq);return result;});
  host.connect(context,event=>{void page.evaluate(event=>{(window as any).__hostListeners?.forEach((fn:any)=>fn(event));},event).catch(()=>{});});
  await page.addInitScript('window.__name = function (fn) { return fn; };');
  await page.addInitScript(()=>{
    const listeners=new Set();(window as any).__hostListeners=listeners;
    (window as any).mongle={request:(method:string,params:unknown)=>(window as any).hostRequest(method,params),subscribe:(fn:unknown)=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:(fn:any)=>{fn({status:'connected',owner:true});return()=>{};},listHosts:async()=>[{id:'local',name:'이 PC',local:true,selected:true}],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>({status:'connected',owner:true})};
  });
  try{
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('heading',{name:'기본 그룹',exact:true}).waitFor();
    await page.getByRole('button',{name:'새 터미널',exact:true}).click();
    await page.getByRole('button',{name:'터미널 열기',exact:true}).click();
    await page.getByText('여기서 제어 중',{exact:true}).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo MONGLE_UI_LIVE');await page.keyboard.press('Enter');
    await page.keyboard.insertText('echo 몽글테스트');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent?.includes('몽글테스트'));
    const first=host.getState().terminals[0];assert.equal(first.status,'running');const pid=first.pid;
    // A lost input response must keep typing blocked even when fresh output is
    // rendered and ACKed. Only the user's explicit control action releases it.
    failNextInput=true;await page.keyboard.type('x');
    await page.getByText('마지막 입력의 전달 여부를 확인해 주세요. 확인 후 제어권을 다시 가져올 수 있습니다.',{exact:true}).waitFor();
    const countAfterFailure=inputs.length;const current=host.getState();
    const frame=await host.handle('terminals.attach',{id:first.id,hostId:current.hostId,bootId:current.bootId,generation:first.generation},context);
    await page.evaluate(event=>{(window as any).__hostListeners.forEach((fn:any)=>fn(event));},frame);
    const ackDeadline=Date.now()+5000;while(!acknowledged.includes(frame.seq)&&Date.now()<ackDeadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(acknowledged.includes(frame.seq),'fresh stream frame was rendered and ACKed');
    await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('DO_NOT_SEND');assert.equal(inputs.length,countAfterFailure,'output ACK must not unlock uncertain input');
    await page.getByRole('button',{name:'최대화',exact:true}).click();await page.getByText('마지막 입력의 전달 여부를 확인해 주세요. 확인 후 제어권을 다시 가져올 수 있습니다.',{exact:true}).waitFor();await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('STILL_BLOCKED');assert.equal(inputs.length,countAfterFailure,'pane remount must preserve the latch');
    await page.locator('.control-chip').click();await page.getByText('여기서 제어 중',{exact:true}).waitFor();await page.keyboard.press('Control+c');assert.equal(inputs.slice(countAfterFailure).filter(input=>input.data==='\x03').length,1,'explicit acquire and screen ACK restore input (focus reports may also be sent)');assert.equal(inputs.filter(input=>input.data==='x').length,1,'uncertain input is never replayed');
    await page.getByRole('button',{name:'분할로 돌아가기',exact:true}).click();
    await page.getByRole('button',{name:'좌우 분할',exact:true}).click();await page.getByRole('button',{name:'터미널 열기',exact:true}).click();
    await page.locator('.pane').nth(1).waitFor();await page.locator('.pane').nth(1).getByText('여기서 제어 중',{exact:true}).waitFor();
    assert.equal(host.getState().terminals.length,2);
    const separator=page.getByRole('separator',{name:'좌우 분할 크기'});await separator.focus();await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(()=>document.querySelector('.split-divider')?.getAttribute('aria-valuenow')==='45');
    await separator.dblclick();await page.waitForFunction(()=>document.querySelector('.split-divider')?.getAttribute('aria-valuenow')==='50');
    await page.reload();await page.locator('.pane').nth(1).waitFor();assert.equal(host.getState().terminals[0].pid,pid);
    await page.getByRole('button',{name:'설정',exact:true}).first().click();await page.getByRole('button',{name:'밝게',exact:true}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'light');await page.getByRole('button',{name:'설정 닫기'}).click();
    await mkdir('artifacts/ui',{recursive:true});await page.screenshot({path:'artifacts/ui/desktop-light.png'});
    await page.setViewportSize({width:390,height:844});await page.locator('.mobile-panel-switcher').waitFor({state:'visible'});assert.equal(await page.locator('.pane').count(),1);
    await page.locator('.mobile-panel-switcher').click();await page.getByRole('dialog',{name:'터미널 전환'}).waitFor();await page.locator('.panel-list .device-row').nth(1).click();await page.getByRole('button',{name:'Ctrl',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Ctrl',exact:true}).getAttribute('aria-pressed'),'true');
    const bounds=await page.locator('.app-shell').boundingBox();assert.ok(bounds&&bounds.width<=390);await page.screenshot({path:'artifacts/ui/mobile-light.png'});
    assert.deepEqual(errors,[]);
  }catch(error){await mkdir('artifacts/ui',{recursive:true});await page.screenshot({path:'artifacts/ui/failure.png'});console.error('PAGE ERRORS',errors,'PAGE',await page.locator('body').innerText());throw error;}finally{host.disconnect(context.id);await browser.close();await host.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dataDir,{recursive:true,force:true});}
});
