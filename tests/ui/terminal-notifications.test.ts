import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const dot = (page: Page, id: string) => page.locator(`[data-sidebar-terminal-id="${id}"] .terminal-status[data-unread="true"]`);
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
      let hostId='notification-host',bootId='boot',hidden=false,claudeIntegration={status:'ready'};
      const terminals=['first','second','third','fourth'].map((id,i)=>({id,title:id,groupId:i<2?'group-one':'group-two',profileId:'pwsh',cwd:'C:/fixture',generation:'generation',status:'running',cols:80,rows:24,notificationCount:0,...(i>1?{worktreeId:'tree'}:{})}));
      const groups=[{id:'group-one',name:'첫 그룹',cwd:'C:/fixture',profileId:'pwsh',revision:0,layout:{type:'leaf',terminalId:'first',tabs:['second']}},{id:'group-two',name:'다른 그룹',cwd:'C:/fixture',profileId:'pwsh',revision:0,repositoryIds:['repo'],layout:{type:'leaf',terminalId:'third',tabs:['fourth']}}];
      const state=()=>structuredClone({hostId,bootId,claudeIntegration,name:'알림 시험 PC',version:'0.3.14',protocolVersion:1,capabilities:['layout.tabs','worktrees.manage'],groups,terminals,profiles:[],settings:{name:'알림 시험 PC',recordHistory:false,scrollback:5000},repositories:[{id:'repo',root:'C:/fixture',commonDir:'C:/fixture/.git',baseRef:'dev',worktreeRoot:'C:/trees',checkedAt:0}],worktrees:[{id:'tree',repositoryId:'repo',name:'기본 작업',path:'C:/fixture',branch:'dev',head:'123456789',main:true,managed:false,status:'ready'}]});
      const frame=id=>{const info=terminals.find(t=>t.id===id);return {type:'snapshot',terminalId:id,generation:info.generation,bootId,seq:++seq,snapshot:{...${JSON.stringify(snapshot)},notificationCount:counts.get(id)||0}};};
      const publish=event=>listeners.forEach(fn=>fn(event));
      const update=()=>publish({type:'state',state:state()});
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
      const h=window.notificationsTest={
        getState:state,
        calls:[], holdAttach:false, pendingAttaches:[], releaseAttach:()=>{h.holdAttach=false;h.pendingAttaches.splice(0).forEach(fn=>fn());}, notify:(id,present=true)=>{const info=terminals.find(t=>t.id===id);info.notificationCount++;update();if(present){counts.set(id,info.notificationCount);if(attached.has(id))publish(frame(id));}},
        agent:(id,status,present=true)=>{const info=terminals.find(t=>t.id===id);info.agentProvider='claude';info.agentStatus=status;if(['completed','attention','error'].includes(status)){info.agentNotificationCount=info.notificationCount+1;h.notify(id,present);}else update();},
        integration:value=>{claudeIntegration=value;update();},
        present:id=>{counts.set(id,terminals.find(t=>t.id===id).notificationCount);if(attached.has(id))publish(frame(id));},
        visibility:value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));},
        connection:status=>connections.forEach(fn=>fn({status,owner:true})),
        host:()=>{hostId=hostId==='notification-host'?'another-host':'notification-host';update();},
        restart:id=>{const info=terminals.find(t=>t.id===id);info.generation+='-new';info.notificationCount=0;delete info.agentStatus;delete info.agentProvider;counts.delete(id);update();},
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
          await page.locator('.group-row .terminal-status[data-unread="true"]').waitFor();
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
          const stale=page.locator('[data-sidebar-terminal-id="first"] .terminal-status');
          assert.equal(await stale.getAttribute('data-stale'),'true');
          assert.match(await stale.getAttribute('aria-label')||'',/연결이 끊겨 마지막으로 확인한 상태/);
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
          const tree=page.locator('[data-worktree-kind="main"]');await tree.locator('.terminal-status[data-unread="true"]').waitFor();
          assert.equal(await page.getByRole('button',{name:'기본 작업 열기',exact:true}).getAttribute('aria-description'),'확인할 알림');
          await page.getByRole('button',{name:'기본 작업 열기',exact:true}).click();
          await page.locator('#terminal-tab-fourth[aria-selected="true"]').waitFor();
          await tree.locator('.terminal-status[data-unread="true"]').waitFor({state:'detached'});
          assert.equal(await dot(page,'second').count(),1,'viewing another group cannot consume first group');
        } finally {await page.close();}
      });
      await t.test('320px mobile menus expose the notification and clear it only after opening the terminal',async()=>{
        const page=await open(320);
        try {
          await page.getByRole('button',{name:'터미널 전환',exact:true}).click();
          await emit(page,'second');await pause(page);
          const row=page.getByRole('dialog').getByRole('button',{name:/second/});
          await row.locator('.terminal-status[data-unread="true"]').waitFor();
          await row.click();await page.locator('#terminal-panel-second').waitFor();
          // The switcher summarizes the other terminals, so wait for the opened terminal's own read receipt.
          await page.waitForFunction(()=>JSON.parse(localStorage.getItem('mongle.notifications.read.notification-host')||'{}').second?.count===1);
          assert.equal(await page.locator('.mobile-panel-switcher .terminal-status').count(),0);
          await emit(page,'third');await page.locator('[aria-label="그룹 메뉴 열기"] .terminal-status[data-unread="true"]').waitFor();
          await page.getByRole('button',{name:'그룹 메뉴 열기'}).click();
          await page.locator('[data-worktree-kind="main"] .terminal-status[data-unread="true"]').waitFor();
          const geometry=await page.locator('[data-worktree-kind="main"]').evaluate(row=>{
            const dot=row.querySelector('.terminal-status[data-unread="true"]')!.getBoundingClientRect();
            const menu=row.querySelector('.worktree-actions')!.getBoundingClientRect();
            return {right:dot.right,menuLeft:menu.left,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
          });
          assert.ok(geometry.right<geometry.menuLeft);assert.equal(geometry.overflow,false);
          await page.getByRole('button',{name:'기본 작업 열기',exact:true}).click();
          await page.locator('#terminal-panel-third').waitFor();
          await page.locator('[aria-label="그룹 메뉴 열기"] .terminal-status[data-unread="true"]').waitFor({state:'detached'});
        } finally {await page.close();}
      });
      await t.test('Claude completion dot waits for the actual frame and disappears after read without changing backend status',async()=>{
        const page=await open();
        const badge=(id:string)=>page.locator(`[data-sidebar-terminal-id="${id}"] .terminal-status`);
        const set=(status:string,present=true)=>page.evaluate(({status,present})=>(window as any).notificationsTest.agent('second',status,present),{status,present});
        try {
          await selected(page,'first');
          await set('idle');assert.equal(await badge('second').count(),0);
          await set('working');await badge('second').filter({hasText:'작업 중'}).waitFor();
          assert.equal(await badge('second').locator('.terminal-status-label').isVisible(),false,'narrow sidebar preserves the terminal name');
          assert.equal(await badge('second').getAttribute('title'),'작업 중');
          assert.equal(await page.locator('#terminal-tab-second').getAttribute('aria-description'),'작업 중');
          await set('completed',false);await dot(page,'second').waitFor();
          assert.equal(await badge('second').getAttribute('data-status'),'completed');
          assert.equal(await badge('second').locator('.terminal-status-dot').count(),1);
          assert.equal(await page.locator('#terminal-tab-second .terminal-status-dot').count(),1);
          assert.equal(await page.locator('.lucide-bell').count(),0,'no bell remains anywhere');
          await selected(page,'second');await pause(page);
          assert.equal(await badge('second').getAttribute('data-unread'),'true','a status update alone is not a read receipt');
          await page.evaluate(()=>(window as any).notificationsTest.present('second'));
          await dot(page,'second').waitFor({state:'detached'});
          assert.equal(await badge('second').count(),0,'reading removes the entire completion indicator');
          assert.equal(await page.locator('#terminal-tab-second .terminal-status').count(),0);
          assert.equal(await page.locator('#terminal-tab-second').getAttribute('aria-description'),null);
          assert.equal(await page.locator('.workspace-switch .terminal-status').count(),0);
          assert.equal(await page.evaluate(()=>(window as any).notificationsTest.getState().terminals.find((t:any)=>t.id==='second').agentStatus),'completed','presentation read does not mutate backend task state');
          await emit(page,'second',false);await dot(page,'second').waitFor();
          assert.equal(await badge('second').getAttribute('data-status'),'notification','a later plain notification is not shown as Claude completion');
          assert.equal(await badge('second').getAttribute('aria-label'),'확인할 알림');
          await page.evaluate(()=>(window as any).notificationsTest.present('second'));await dot(page,'second').waitFor({state:'detached'});
          await selected(page,'first');await set('attention');await dot(page,'second').waitFor();
          assert.equal(await badge('second').getAttribute('aria-label'),'확인 요청 · 미확인');
          await set('error');assert.equal(await badge('second').getAttribute('data-status'),'error');
          await set('working');assert.equal(await badge('second').getAttribute('data-status'),'working');
          assert.equal(await badge('second').getAttribute('data-unread'),null,'a new turn takes visual precedence');
          assert.equal(await badge('second').getAttribute('data-also-unread'),'true','older unseen alerts stay discoverable beside the spinner');
          assert.equal(await badge('second').getAttribute('aria-label'),'작업 중 · 미확인 알림');
          const receipts=await page.evaluate(()=>JSON.parse(localStorage.getItem('mongle.notifications.read.notification-host')||'{}'));
          assert.equal(receipts.second.count,2,'working must not silently consume the two unseen notifications');
          await emit(page,'first',false);await dot(page,'first').waitFor();
          assert.equal(await badge('first').getAttribute('data-status'),'notification');
          assert.equal(await badge('first').getAttribute('aria-label'),'확인할 알림');
          assert.equal(await badge('first').locator('.terminal-status-dot').count(),1);
        } finally {await page.close();}
      });
      await t.test('worktree and group statuses prioritize attention over work and keep unread completion beside work',async()=>{
        const page=await open();
        const tree=page.locator('[data-worktree-kind="main"] .terminal-status');
        const group=page.locator('.workspace-switch').filter({hasText:'다른 그룹'}).locator('.terminal-status');
        async function state(third:string,fourth:string){await page.evaluate(({third,fourth})=>{const h=(window as any).notificationsTest;h.agent('third',third);h.agent('fourth',fourth);},{third,fourth});}
        try {
          await state('completed','working');await tree.waitFor();
          assert.equal(await tree.getAttribute('data-status'),'working');assert.equal(await group.getAttribute('data-status'),'working');
          assert.equal(await tree.getAttribute('data-also-unread'),'true');assert.equal(await group.getAttribute('data-also-unread'),'true');
          assert.equal(await tree.getAttribute('aria-label'),'작업 중 1개 · 미확인 1개');
          await state('attention','working');assert.equal(await tree.getAttribute('data-status'),'attention');assert.equal(await group.getAttribute('data-status'),'attention');
          await state('attention','error');assert.equal(await tree.getAttribute('data-status'),'error');assert.equal(await group.getAttribute('data-status'),'error');
          await state('completed','completed');assert.equal(await tree.getAttribute('data-status'),'completed');assert.equal(await group.getAttribute('data-unread'),'true');
          assert.equal(await tree.locator('.terminal-status-dot').count(),1);
          await page.getByRole('button',{name:'기본 작업 열기',exact:true}).click();
          await page.locator('#terminal-tab-third[aria-selected="true"]').waitFor();
          await page.locator('#terminal-tab-third .terminal-status').waitFor({state:'detached'});
          assert.equal(await tree.getAttribute('data-status'),'completed','the other unread completion keeps its worktree dot');
          assert.equal(await group.getAttribute('data-unread'),'true');
          await page.locator('#terminal-tab-fourth').click();
          await tree.waitFor({state:'detached'});await group.waitFor({state:'detached'});
          assert.equal(await page.locator('#terminal-tab-third .terminal-status, #terminal-tab-fourth .terminal-status').count(),0,'neither completed terminal leaves a check behind');
        } finally {await page.close();}
      });
      await t.test('320px switcher summarizes other terminals, the spinner respects reduced motion and read completion dots disappear',async()=>{
        const page=await open(320);
        try {
          await page.evaluate(()=>(window as any).notificationsTest.agent('second','working'));
          const switcher=page.locator('.mobile-panel-switcher');
          await switcher.locator('[data-status="working"]').waitFor();
          assert.equal(await switcher.getAttribute('aria-description'),'다른 터미널 · 작업 중');
          assert.equal(await switcher.locator('.terminal-status-label').isVisible(),false);
          const spinner=switcher.locator('.terminal-status-spinner');
          assert.equal(await spinner.locator('circle').count(),1);assert.equal(await spinner.locator('path').count(),1);
          const motion=await spinner.evaluate(icon=>{
            const style=getComputedStyle(icon),animation=icon.getAnimations()[0];
            return {name:style.animationName,duration:style.animationDuration,easing:style.animationTimingFunction,
              frames:(animation?.effect as KeyframeEffect)?.getKeyframes().map(frame=>String(frame.transform))};
          });
          assert.equal(motion.name,'terminal-status-spin');assert.equal(motion.duration,'0.9s');assert.equal(motion.easing,'linear');
          assert.ok(motion.frames?.some(frame=>frame.includes('rotate(360deg)')),JSON.stringify(motion.frames));
          await page.emulateMedia({reducedMotion:'reduce'});
          assert.equal(await spinner.evaluate(icon=>getComputedStyle(icon).animationName),'none');
          assert.ok(await spinner.isVisible(),'the still arc keeps its meaning without motion');
          await page.getByRole('button',{name:'터미널 전환',exact:true}).click();
          const second=page.getByRole('dialog').getByRole('button',{name:/second/});
          assert.equal(await second.locator('.terminal-status-label').innerText(),'작업 중');
          await page.evaluate(()=>(window as any).notificationsTest.agent('second','attention'));
          await second.locator('[data-status="attention"]').waitFor();
          const geometry=await second.evaluate(row=>{
            const badge=row.querySelector('.terminal-status')!.getBoundingClientRect();
            const text=row.querySelector('.device-info')!.getBoundingClientRect(),bounds=row.getBoundingClientRect();
            return {textRight:text.right,badgeLeft:badge.left,badgeRight:badge.right,rowRight:bounds.right,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth};
          });
          assert.ok(geometry.textRight<=geometry.badgeLeft,JSON.stringify(geometry));assert.ok(geometry.badgeRight<=geometry.rowRight,JSON.stringify(geometry));assert.equal(geometry.overflow,false);
          await second.click();await page.locator('#terminal-panel-second').waitFor();
          await switcher.locator('[data-unread="true"]').waitFor({state:'detached'});
          assert.equal(await switcher.locator(':scope > .terminal-status').getAttribute('data-status'),'attention','this terminal keeps its own badge beside its title');
          assert.equal(await switcher.locator('.mobile-panel-others .terminal-status').count(),0,'other terminals are summarized separately');
          assert.equal(await switcher.getAttribute('aria-description'),'이 터미널 · 확인 요청');
          await page.getByRole('button',{name:'터미널 전환',exact:true}).click();
          await page.evaluate(()=>(window as any).notificationsTest.agent('second','completed'));
          const completed=page.getByRole('dialog').getByRole('button',{name:/second/});
          await completed.locator('.terminal-status-dot').waitFor();await pause(page);
          assert.equal(await completed.locator('[data-unread="true"]').count(),1,'an open modal must not consume completion');
          await completed.click();await switcher.locator('.terminal-status').waitFor({state:'detached'});
          assert.equal(await page.locator('[aria-label="그룹 메뉴 열기"] .terminal-status').count(),0);
        } finally {await page.close();}
      });
      await t.test('settings describe automatic integration and safely show unavailable host diagnostics',async()=>{
        const page=await open();
        try {
          await page.getByRole('button',{name:'설정',exact:true}).click();
          await page.getByRole('tab',{name:'도움말',exact:true}).click();
          await page.getByText('Claude 자동 연동 준비됨',{exact:true}).waitFor();
          assert.equal(await page.getByText(/terminal_bell을 따로 설정할 필요가 없습니다/).count(),1);
          await page.evaluate(()=>(window as any).notificationsTest.integration({status:'unavailable',message:'설정에서 훅이 비활성화되어 있습니다. <script>fixture</script>'}));
          await page.getByText('Claude 자동 연동 사용 불가',{exact:true}).waitFor();
          await page.getByText('설정에서 훅이 비활성화되어 있습니다. <script>fixture</script>',{exact:true}).waitFor();
          assert.equal(await page.locator('[role="dialog"] script').count(),0);
        } finally {await page.close();}
      });
      assert.deepEqual(errors,[]);
    } finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
