import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const dot = (page: Page, id: string) => page.locator(`[data-sidebar-terminal-id="${id}"] .notification-dot`);
const emit = (page: Page, id: string, present = true) => page.evaluate(({id,present}) => (window as any).notificationsTest.notify(id,present), {id,present});
const selected = (page: Page, id: string) => page.locator(`[data-sidebar-terminal-id="${id}"] .worktree-main`).click();
const pause = (page: Page) => page.waitForTimeout(1000);

test('terminal notifications follow actual presentations and remain discoverable across navigation',
  {skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 120000}, async t => {
    const engine = new TerminalEngine({cols:80,rows:24,onResponse(){}});
    await engine.write('Notification fixture: no user output.');
    const snapshot = await engine.snapshot(); await engine.dispose();
    const source = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {App} from './apps/web/src/App';
      const listeners=new Set(),connections=new Set(),attached=new Set(),counts=new Map();let seq=0;
      let hostId='notification-host',bootId='boot',hidden=false;
      const terminals=['first','second','third','fourth'].map((id,i)=>({id,title:id,groupId:i<2?'group-one':'group-two',profileId:'pwsh',cwd:'C:/fixture',generation:'generation',status:'running',cols:80,rows:24,notificationCount:0,...(i>1?{worktreeId:'tree'}:{})}));
      const groups=[{id:'group-one',name:'첫 그룹',cwd:'C:/fixture',profileId:'pwsh',revision:0,layout:{type:'leaf',terminalId:'first',tabs:['second']}},{id:'group-two',name:'다른 그룹',cwd:'C:/fixture',profileId:'pwsh',revision:0,repositoryIds:['repo'],layout:{type:'leaf',terminalId:'third',tabs:['fourth']}}];
      const state=()=>structuredClone({hostId,bootId,name:'알림 시험 PC',version:'0.3.14',protocolVersion:1,capabilities:['layout.tabs','worktrees.manage'],groups,terminals,profiles:[],settings:{name:'알림 시험 PC',recordHistory:false,scrollback:5000},repositories:[{id:'repo',root:'C:/fixture',commonDir:'C:/fixture/.git',baseRef:'dev',worktreeRoot:'C:/trees',checkedAt:0}],worktrees:[{id:'tree',repositoryId:'repo',name:'기본 작업',path:'C:/fixture',branch:'dev',head:'123456789',main:true,managed:false,status:'ready'}]});
      const frame=id=>{const info=terminals.find(t=>t.id===id);return {type:'snapshot',terminalId:id,generation:info.generation,bootId,seq:++seq,snapshot:{...${JSON.stringify(snapshot)},notificationCount:counts.get(id)||0}};};
      const publish=event=>listeners.forEach(fn=>fn(event));
      const update=()=>publish({type:'state',state:state()});
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
      const h=window.notificationsTest={
        calls:[], holdAttach:false, pendingAttaches:[], releaseAttach:()=>{h.holdAttach=false;h.pendingAttaches.splice(0).forEach(fn=>fn());}, notify:(id,present=true)=>{const info=terminals.find(t=>t.id===id);info.notificationCount++;update();if(present){counts.set(id,info.notificationCount);if(attached.has(id))publish(frame(id));}},
        present:id=>{counts.set(id,terminals.find(t=>t.id===id).notificationCount);if(attached.has(id))publish(frame(id));},
        visibility:value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));},
        connection:status=>connections.forEach(fn=>fn({status,owner:true})),
        host:()=>{hostId=hostId==='notification-host'?'another-host':'notification-host';update();},
        restart:id=>{const info=terminals.find(t=>t.id===id);info.generation+='-new';info.notificationCount=0;counts.delete(id);update();},
        split:()=>{groups[0].layout={type:'split',axis:'horizontal',ratio:.5,first:{type:'leaf',terminalId:'first'},second:{type:'leaf',terminalId:'second'}};update();}
      };
      window.mongle={request:async(method,params={})=>{h.calls.push({method,params});if(method==='state.get')return state();if(method==='terminals.attach'){attached.add(params.id);if(h.holdAttach)return new Promise(resolve=>h.pendingAttaches.push(()=>resolve(frame(params.id))));return frame(params.id);}if(method==='terminals.detach'){attached.delete(params.id);return {};}if(method==='projects.refresh')return {};if(method==='worktrees.open')return terminals.find(t=>t.id===(params.preferredId||'third'));return {};},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{connections.add(fn);fn({status:'connected',owner:true});return()=>connections.delete(fn);},listHosts:async()=>[],selectHost:async()=>{}};
      createRoot(document.getElementById('root')).render(<App/>);
    `;
    const bundle = await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('../../',import.meta.url))},bundle:true,write:false,format:'iife',platform:'browser'});
    const css = readFileSync(new URL('../../apps/web/src/styles.css',import.meta.url),'utf8') + '\n' + readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css',import.meta.url),'utf8');
    const server = createServer((request,response) => {
      if(request.url === '/app.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles[0].contents);}
      else if(request.url === '/style.css'){response.setHeader('Content-Type','text/css');response.end(css);}
      else {response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const url=`http://127.0.0.1:${address.port}`;
    const browser=await chromium.launch({channel:'chrome',headless:true});
    const errors:string[]=[];
    async function open(width=1200){
      const page=await browser.newPage({viewport:{width,height:800},isMobile:width<=700,hasTouch:width<=700});
      page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript('window.__name=function(fn){return fn;};');
      await page.goto(url);await page.locator('#terminal-panel-first').waitFor();
      await page.bringToFront();return page;
    }
    try {
      await t.test('inactive tab, collapsed group, rendered-count race and durable read receipt', async()=>{
        const page=await open();
        try {
          await selected(page,'first');await emit(page,'second',false);
          await dot(page,'second').waitFor();assert.equal(await page.locator('#terminal-tab-second').getAttribute('aria-description'),'확인할 알림');
          await selected(page,'second');await pause(page);
          assert.equal(await dot(page,'second').count(),1,'old presentation must not consume a newer notification');
          await page.evaluate(()=>(window as any).notificationsTest.present('second'));
          await dot(page,'second').waitFor({state:'detached'});
          const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('mongle.notifications.read.notification-host')||'{}'));
          assert.deepEqual(saved.second,{generation:'generation',count:1});
          await page.reload();await page.locator('#terminal-panel-second').waitFor();
          await emit(page,'second');await pause(page);
          assert.equal(await dot(page,'second').count(),0,'refresh must not replay the same notification');
          await selected(page,'first');await emit(page,'second');await dot(page,'second').waitFor();
          await page.getByRole('button',{name:'첫 그룹 작업 목록 접기',exact:true}).click();
          await page.locator('.group-row .notification-dot').waitFor();
          await page.getByRole('button',{name:'첫 그룹 작업 목록 펼치기',exact:true}).click();
          assert.equal(await dot(page,'second').count(),1);
          await page.evaluate(()=>(window as any).notificationsTest.restart('second'));
          await dot(page,'second').waitFor({state:'detached'});
          await emit(page,'second');await dot(page,'second').waitFor();
        } finally {await page.close();}
      });
      await t.test('background, dialogs, disconnection and host changes cannot consume unseen notifications',async()=>{
        const page=await open();
        try {
          await selected(page,'first');
          await page.evaluate(()=>(window as any).notificationsTest.visibility(true));
          await emit(page,'first');await pause(page);assert.equal(await dot(page,'first').count(),1);
          await page.evaluate(()=>(window as any).notificationsTest.visibility(false));
          await dot(page,'first').waitFor({state:'detached'});
          await page.getByRole('button',{name:'설정',exact:true}).click();
          await emit(page,'first');await pause(page);assert.equal(await dot(page,'first').count(),1);
          await page.getByRole('button',{name:'닫기',exact:true}).click();
          await dot(page,'first').waitFor({state:'detached'});
          await page.evaluate(()=>(window as any).notificationsTest.connection('offline'));
          await emit(page,'first');await pause(page);assert.equal(await dot(page,'first').count(),1);
          await page.evaluate(()=>(window as any).notificationsTest.connection('connected'));
          await dot(page,'first').waitFor({state:'detached'});
          await selected(page,'second');
          await page.evaluate(()=>(window as any).notificationsTest.host());
          await dot(page,'first').waitFor();
          await pause(page);assert.equal(await dot(page,'first').count(),1,'another host cannot inherit read receipts');
        } finally {await page.close();}
      });
      await t.test('reconnecting the same process cannot reuse a retired pane presentation',async()=>{
        const page=await open();
        try {
          await selected(page,'first');
          await page.evaluate(()=>(window as any).notificationsTest.visibility(true));
          await emit(page,'first');await pause(page);assert.equal(await dot(page,'first').count(),1);
          await page.evaluate(()=>{const h=(window as any).notificationsTest;h.holdAttach=true;h.connection('offline');});
          await pause(page);
          await page.evaluate(()=>{const h=(window as any).notificationsTest;h.visibility(false);h.connection('connected');});
          await page.waitForFunction(()=>(window as any).notificationsTest.pendingAttaches.length>0);
          await pause(page);assert.equal(await dot(page,'first').count(),1,'a blank replacement renderer must not inherit the retired presentation');
          await page.evaluate(()=>(window as any).notificationsTest.releaseAttach());
          await dot(page,'first').waitFor({state:'detached'});
        } finally {await page.close();}
      });
      await t.test('split peers stay unread, worktree badges open the unread terminal and aggregate per group',async()=>{
        const page=await open();
        try {
          await selected(page,'first');await page.evaluate(()=>(window as any).notificationsTest.split());
          await emit(page,'second');await pause(page);assert.equal(await dot(page,'second').count(),1);
          await emit(page,'fourth');
          const tree=page.locator('[data-worktree-kind="main"]');await tree.locator('.notification-dot').waitFor();
          assert.equal(await page.getByRole('button',{name:'기본 작업 열기',exact:true}).getAttribute('aria-description'),'확인할 알림');
          await page.getByRole('button',{name:'기본 작업 열기',exact:true}).click();
          await page.locator('#terminal-tab-fourth[aria-selected="true"]').waitFor();
          await tree.locator('.notification-dot').waitFor({state:'detached'});
          assert.equal(await dot(page,'second').count(),1,'viewing another group cannot consume first group');
        } finally {await page.close();}
      });
      await t.test('320px mobile menus expose the dot and clear it only after opening the terminal',async()=>{
        const page=await open(320);
        try {
          await page.getByRole('button',{name:'터미널 전환',exact:true}).click();
          await emit(page,'second');await pause(page);
          const row=page.getByRole('dialog').getByRole('button',{name:/second/});
          await row.locator('.notification-dot').waitFor();
          await row.click();await page.locator('#terminal-panel-second').waitFor();
          await page.locator('.mobile-panel-switcher .notification-dot').waitFor({state:'detached'});
          await emit(page,'third');await page.locator('[aria-label="그룹 메뉴 열기"] .notification-dot').waitFor();
          await page.getByRole('button',{name:'그룹 메뉴 열기'}).click();
          await page.locator('[data-worktree-kind="main"] .notification-dot').waitFor();
          const geometry=await page.locator('[data-worktree-kind="main"]').evaluate(row=>{
            const dot=row.querySelector('.notification-dot')!.getBoundingClientRect();
            const menu=row.querySelector('.worktree-actions')!.getBoundingClientRect();
            return {right:dot.right,menuLeft:menu.left,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
          });
          assert.ok(geometry.right<geometry.menuLeft);assert.equal(geometry.overflow,false);
          await page.getByRole('button',{name:'기본 작업 열기',exact:true}).click();
          await page.locator('#terminal-panel-third').waitFor();
          await page.locator('[aria-label="그룹 메뉴 열기"] .notification-dot').waitFor({state:'detached'});
        } finally {await page.close();}
      });
      assert.deepEqual(errors,[]);
    } finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
