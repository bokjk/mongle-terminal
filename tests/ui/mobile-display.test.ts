import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome=process.platform==='win32'&&existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const smaller='터미널 글자 작게';
const larger='터미널 글자 크게';
const reset=(size:number)=>`글자 크기 ${size}px · 기본 14px로 복원`;

async function openPage(browser:Browser,url:string,errors:string[],width=390,storedFont?:string,storedCompact?:string){
  const page=await browser.newPage({viewport:{width,height:844},isMobile:width<=700,hasTouch:width<=700});
  page.setDefaultTimeout(5000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript('window.__name=function(fn){return fn;};');
  if(storedFont!==undefined||storedCompact!==undefined)await page.addInitScript(({font,compact})=>{
    if(font!==undefined)localStorage.setItem('mongle.fontSize',font);
    if(compact!==undefined)localStorage.setItem('mongle.mobileCompact',compact);
  },{font:storedFont,compact:storedCompact});
  await page.goto(url);
  await page.locator('.xterm-helper-textarea').waitFor({state:'attached'});
  await page.waitForFunction(()=>(window as any).displayTest.calls.some((call:any)=>call.method==='terminal.ack'));
  return page;
}

async function settleFrames(page:Page){
  await page.waitForFunction(()=>{
    const h=(window as any).displayTest;
    return !h.pendingResize&&!h.pendingAck&&h.ackedSeq===h.latestSeq;
  });
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}

async function assertFont(page:Page,size:number){
  await page.getByRole('button',{name:reset(size),exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('mongle.fontSize')),String(size));
}

async function dimensions(page:Page){
  return page.evaluate(()=>(window as any).displayTest.dimensions() as {cols:number;rows:number});
}

async function waitForFontGeometry(page:Page,size:number){
  await page.waitForFunction(size=>{
    const h=(window as any).displayTest;
    const rows=document.querySelector<HTMLElement>('.xterm-rows');
    return rows&&getComputedStyle(rows).fontSize===`${size}px`&&h.lastResizeFont===size&&h.ackedSeq===h.latestSeq&&rows.children.length===h.dimensions().rows;
  },size);
  await settleFrames(page);
}

async function assertNoHorizontalOverflow(page:Page,width:number){
  const geometry=await page.evaluate(()=>{
    const shell=document.querySelector<HTMLElement>('.app-shell')!;
    const bar=document.querySelector<HTMLElement>('.mobile-display-bar')!;
    return {
      viewport:document.documentElement.clientWidth,
      document:document.documentElement.scrollWidth,
      shell:shell.scrollWidth,
      barWidth:bar.clientWidth,
      barScroll:bar.scrollWidth,
      controls:Array.from(bar.querySelectorAll('button')).map(element=>{
        const rect=element.getBoundingClientRect();
        return {label:element.getAttribute('aria-label')||element.textContent,left:rect.left,right:rect.right,width:rect.width,height:rect.height};
      }),
    };
  });
  assert.equal(geometry.viewport,width);
  assert.ok(geometry.document<=width,`page overflows at ${width}px: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.shell<=width,`shell overflows at ${width}px`);
  assert.ok(geometry.barScroll<=geometry.barWidth,`display controls overflow their row at ${width}px`);
  for(const control of geometry.controls){
    assert.ok(control.left>=0&&control.right<=width,`control clipped at ${width}px: ${JSON.stringify(control)}`);
    assert.ok(control.width>0&&control.height>0,`control must remain reachable: ${control.label}`);
  }
}

test('mobile display controls resize the terminal, persist preferences and preserve the input fence',
  {skip:chrome?false:'Requires installed Windows Chrome.',timeout:60000},async t=>{
    const engine=new TerminalEngine({cols:40,rows:20,onResponse(){}});
    const snapshot=await engine.snapshot();await engine.dispose();
    const source=`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {App} from './apps/web/src/App';
      const listeners=new Set();const connectionListeners=new Set();let seq=0;let epoch=0;
      let info={id:'terminal',groupId:'group',title:'아주 긴 모바일 터미널 제목과 작업 내용',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:20};
      const state=()=>({hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.1.0',protocolVersion:1,capabilities:['control.acquire-if-free'],groups:[{id:'group',name:'모바일 그룹',cwd:'C:/test',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}}],terminals:[info],profiles:[],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}});
      const frame=()=>{const result={type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}};h.latestSeq=seq;return result;};
      const emitState=()=>listeners.forEach(fn=>fn({type:'state',state:state()}));
      const h=window.displayTest={calls:[],pendingResize:null,pendingAck:null,holdResize:false,holdAck:false,latestSeq:0,ackedSeq:0,lastResizeFont:0,readonlyWrites:[],blurCount:0,dimensions:()=>({cols:info.cols,rows:info.rows}),setConnection:status=>connectionListeners.forEach(fn=>fn({status,owner:false}))};
      const request=async(method,params)=>{
        h.calls.push({method,params});
        if(method==='state.get')return state();
        if(method==='terminals.attach')return frame();
        if(method==='control.acquire'){
          h.lastResizeFont=parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize);
          info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'mobile',deviceName:'휴대폰',epoch:++epoch,ready:false}};
          emitState();return {epoch,connectionId:'mobile',frame:frame()};
        }
        if(method==='terminal.resize'){
          const requestedFont=parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize);
          const complete=()=>{h.lastResizeFont=requestedFont;info={...info,cols:params.cols,rows:params.rows};emitState();return {frame:frame()};};
          if(h.holdResize)return new Promise(resolve=>{h.pendingResize=()=>{h.pendingResize=null;h.holdResize=false;resolve(complete());};});
          return complete();
        }
        if(method==='terminal.ack'){
          const complete=()=>{h.ackedSeq=params.seq;return {acknowledged:true};};
          if(h.holdAck)return new Promise(resolve=>{h.pendingAck=()=>{h.pendingAck=null;h.holdAck=false;resolve(complete());};});
          return complete();
        }
        return {ok:true};
      };
      window.mongle={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{connectionListeners.add(fn);fn({status:'connected',owner:false});return()=>connectionListeners.delete(fn);},listHosts:async()=>[],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>{}};
      const descriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'readOnly');
      Object.defineProperty(HTMLTextAreaElement.prototype,'readOnly',{...descriptor,set(value){if(this.classList.contains('xterm-helper-textarea'))h.readonlyWrites.push(value);descriptor.set.call(this,value);}});
      document.addEventListener('focusout',event=>{if(event.target.classList.contains('xterm-helper-textarea'))h.blurCount++;});
      createRoot(document.getElementById('root')).render(<App/>);
    `;
    const bundle=await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('../../',import.meta.url))},bundle:true,write:false,format:'iife',platform:'browser'});
    const css=readFileSync(new URL('../../apps/web/src/styles.css',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css',import.meta.url),'utf8');
    const server=createServer((request,response)=>{
      if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles[0].contents);}
      else if(request.url==='/style.css'){response.setHeader('Content-Type','text/css');response.end(css);}
      else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const url=`http://127.0.0.1:${address.port}`;
    const browser=await chromium.launch({channel:'chrome',headless:true});
    const errors:string[]=[];
    try{
      await t.test('font controls preserve editable focus during resize and ACK, fit more cells, and respect both bounds',async()=>{
        const page=await openPage(browser,url,errors);
        try{
          await assertFont(page,14);
          await page.locator('.terminal-canvas').tap();
          await page.getByText('여기서 제어 중',{exact:true}).waitFor();await settleFrames(page);
          const original=await dimensions(page);
          const textarea=page.locator('.xterm-helper-textarea');
          await page.keyboard.type('a');
          await page.waitForFunction(()=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')==='a');
          const beforeResize='BEFORE_RESIZE한글😀';
          const beforeAck='BEFORE_ACKé🦊';
          const queuedInput=`${beforeResize}\x1b[D\x1b${beforeAck}\x1b[C\r`;
          await page.evaluate(()=>{const h=(window as any).displayTest;h.readonlyWrites=[];h.blurCount=0;h.holdResize=true;});
          await page.getByRole('button',{name:smaller,exact:true}).tap();
          await assertFont(page,13);
          await page.waitForFunction(()=>Boolean((window as any).displayTest.pendingResize));
          assert.equal(await textarea.evaluate(element=>element===document.activeElement),true,'font tap must retain the keyboard focus');
          assert.equal(await textarea.evaluate((element:HTMLTextAreaElement)=>element.readOnly),false);
          await page.keyboard.insertText(beforeResize);
          await page.keyboard.press('ArrowLeft');
          await page.keyboard.press('Escape');
          assert.equal(await page.evaluate(()=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').length),1,'fresh input under the existing lease stays queued until resize completes');
          await page.evaluate(()=>{const h=(window as any).displayTest;h.holdAck=true;h.pendingResize();});
          await page.waitForFunction(()=>Boolean((window as any).displayTest.pendingAck));
          await page.keyboard.insertText(beforeAck);
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('Enter');
          assert.equal(await page.evaluate(()=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').length),1,'font resizing must wait for the new screen ACK');
          await page.evaluate(()=>(window as any).displayTest.pendingAck());await settleFrames(page);
          await page.waitForFunction(expected=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')===expected,`a${queuedInput}`);
          await page.keyboard.type('b');
          await page.waitForFunction(expected=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')===expected,`a${queuedInput}b`);
          assert.equal(await page.evaluate(()=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')),`a${queuedInput}b`,'ACK flushes fresh Unicode input and escape keys once, in their original order before later input');
          for(const size of [12,11,10]){await page.getByRole('button',{name:smaller,exact:true}).tap();await assertFont(page,size);}
          await waitForFontGeometry(page,10);
          const small=await dimensions(page);
          assert.ok(small.cols>original.cols&&small.rows>original.rows,`10px must fit more columns and rows: ${JSON.stringify({original,small})}`);
          assert.equal(await page.getByRole('button',{name:smaller,exact:true}).isDisabled(),true);
          await page.getByRole('button',{name:smaller,exact:true}).dispatchEvent('click');await assertFont(page,10);
          for(let size=11;size<=24;size++){await page.getByRole('button',{name:larger,exact:true}).tap();await assertFont(page,size);}
          assert.equal(await page.getByRole('button',{name:larger,exact:true}).isDisabled(),true);
          await page.getByRole('button',{name:larger,exact:true}).dispatchEvent('click');await assertFont(page,24);
          await page.getByRole('button',{name:reset(24),exact:true}).tap();await assertFont(page,14);await settleFrames(page);
          assert.equal(await textarea.evaluate(element=>element===document.activeElement),true);
          assert.equal(await page.evaluate(()=>(window as any).displayTest.blurCount),0,'all display font controls preserve input focus');
          assert.equal(await page.evaluate(()=>(window as any).displayTest.readonlyWrites.includes(true)),false,'font resizes must not toggle read-only');
          assert.equal(await page.evaluate(()=>(window as any).displayTest.calls.filter((call:any)=>call.method==='control.acquire').length),1,'display controls never reacquire a lease');
          t.diagnostic(`390px terminal cells: 14px ${original.cols}x${original.rows}; 10px ${small.cols}x${small.rows}`);
        }finally{await page.close();}
      });

      await t.test('font preferences survive reload, settings include every integer, and invalid values restore 14px',async()=>{
        const page=await openPage(browser,url,errors);
        try{
          await page.getByRole('button',{name:smaller,exact:true}).tap();await assertFont(page,13);
          await page.reload();await assertFont(page,13);
          await page.locator('.workspace-header').getByRole('button',{name:'설정',exact:true}).tap();
          const select=page.getByRole('combobox',{name:'터미널 글자 크기',exact:true});
          assert.deepEqual(await select.locator('option').evaluateAll(options=>options.map(option=>Number((option as HTMLOptionElement).value))),Array.from({length:15},(_,index)=>10+index));
          assert.equal(await select.inputValue(),'13');
          await select.selectOption('17');
          await page.getByRole('button',{name:'설정 닫기',exact:true}).tap();await assertFont(page,17);
          await page.reload();await assertFont(page,17);
          for(const invalid of ['9','25','13.5','"16"','null','true','{}','not-json']){
            await page.evaluate(value=>localStorage.setItem('mongle.fontSize',value),invalid);
            await page.reload();await assertFont(page,14);
          }
        }finally{await page.close();}
      });

      await t.test('compact mode adds terminal height, stays reversible at 320px and 390px, and leaves desktop headers visible',async()=>{
        for(const width of [390,320]){
          const page=await openPage(browser,url,errors,width);
          try{
            await assertNoHorizontalOverflow(page,width);
            await page.locator('.terminal-canvas').tap();await page.getByText('여기서 제어 중',{exact:true}).waitFor();await settleFrames(page);
            const normalHeight=(await page.locator('.terminal-canvas').boundingBox())!.height;
            const headerHeight=(await page.locator('.workspace-header').boundingBox())!.height;
            const normal=await dimensions(page);
            const compact=page.locator('.mobile-compact-toggle');
            assert.equal(await compact.getAttribute('aria-pressed'),'false');
            await page.evaluate(()=>{const h=(window as any).displayTest;h.readonlyWrites=[];h.blurCount=0;});
            await compact.tap();
            await page.getByRole('button',{name:'기본 화면',exact:true}).waitFor();
            assert.equal(await compact.getAttribute('aria-pressed'),'true');
            assert.equal(await page.locator('.workspace-header').isVisible(),false);
            const compactHeight=(await page.locator('.terminal-canvas').boundingBox())!.height;
            assert.ok(compactHeight-normalHeight>=50,`compact mode must recover header height at ${width}px`);
            assert.ok(Math.abs(compactHeight-normalHeight-headerHeight)<2,`height gain should match the hidden header at ${width}px`);
            await page.waitForFunction(rows=>(window as any).displayTest.dimensions().rows>rows,normal.rows);await settleFrames(page);
            await assertNoHorizontalOverflow(page,width);
            assert.equal(await page.locator('.xterm-helper-textarea').evaluate(element=>element===document.activeElement),true);
            assert.equal(await page.evaluate(()=>(window as any).displayTest.blurCount),0,'compact toggle keeps the keyboard open');
            assert.equal(await page.evaluate(()=>(window as any).displayTest.readonlyWrites.includes(true)),false);
            assert.equal(await page.evaluate(()=>localStorage.getItem('mongle.mobileCompact')),'true');
            for(const size of [13,12,11,10]){await page.getByRole('button',{name:smaller,exact:true}).tap();await assertFont(page,size);}
            await waitForFontGeometry(page,10);
            const compactSmall=await dimensions(page);
            await assertNoHorizontalOverflow(page,width);
            const screenshot=fileURLToPath(new URL(`../../artifacts/ui/mobile-display-${width}.png`,import.meta.url));
            mkdirSync(fileURLToPath(new URL('../../artifacts/ui/',import.meta.url)),{recursive:true});
            await page.screenshot({path:screenshot});
            t.diagnostic(`${width}px cells: 14px normal ${normal.cols}x${normal.rows}; 10px compact ${compactSmall.cols}x${compactSmall.rows}; screenshot ${screenshot}`);
            await page.getByRole('button',{name:reset(10),exact:true}).tap();await assertFont(page,14);await waitForFontGeometry(page,14);
            await page.getByRole('button',{name:'기본 화면',exact:true}).tap();
            await page.waitForFunction(rows=>(window as any).displayTest.dimensions().rows===rows,normal.rows);await settleFrames(page);
            await page.keyboard.type('restored');
            assert.equal(await page.evaluate(()=>(window as any).displayTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')),'restored','exiting compact mode restores live terminal rows and input after ACK');
            await page.getByRole('button',{name:'화면 넓게',exact:true}).tap();
            await page.getByRole('button',{name:'기본 화면',exact:true}).waitFor();
            await page.reload();await page.getByRole('button',{name:'기본 화면',exact:true}).waitFor();
            assert.equal(await page.locator('.workspace-header').isVisible(),false,'compact preference survives reload');
            await assertNoHorizontalOverflow(page,width);
            await page.getByRole('button',{name:'기본 화면',exact:true}).tap();
            await page.getByRole('button',{name:'화면 넓게',exact:true}).waitFor();
            assert.equal(await page.locator('.workspace-header').isVisible(),true);
            assert.equal(await compact.getAttribute('aria-pressed'),'false');
            assert.ok(Math.abs((await page.locator('.terminal-canvas').boundingBox())!.height-normalHeight)<2,'normal mode restores the original terminal height');
            assert.equal(await page.evaluate(()=>localStorage.getItem('mongle.mobileCompact')),'false');
            t.diagnostic(`${width}px terminal height: normal ${normalHeight}px; compact ${compactHeight}px; gain ${compactHeight-normalHeight}px`);
          }finally{await page.close();}
        }
        const desktop=await openPage(browser,url,errors,1280,'14','true');
        try{
          assert.equal(await desktop.locator('.workspace-header').isVisible(),true,'stored mobile compact mode must not hide the desktop header');
          assert.equal(await desktop.locator('.mobile-display-bar').count(),0);
          assert.equal(await desktop.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
        }finally{await desktop.close();}
        const pairing=await openPage(browser,url,errors,390,'14','true');
        try{
          await pairing.getByRole('button',{name:'기본 화면',exact:true}).waitFor();
          await pairing.evaluate(()=>(window as any).displayTest.setConnection('pairing'));
          await pairing.getByRole('heading',{name:'이 기기를 연결하세요',exact:true}).waitFor();
          assert.equal(await pairing.locator('.workspace-header').isVisible(),true,'pairing must restore the header even when compact mode is stored');
        }finally{await pairing.close();}
      });
      assert.deepEqual(errors,[],'all browser scenarios must finish without uncaught exceptions');
    }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
