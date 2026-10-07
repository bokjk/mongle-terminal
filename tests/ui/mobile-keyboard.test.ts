import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome=process.platform==='win32'&&existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('mobile UI preserves resize input within its acknowledged lease and discards unsafe stale input',
  {skip:chrome?false:'Requires installed Windows Chrome.',timeout:30000},async()=>{
    const engine=new TerminalEngine({cols:40,rows:20,onResponse(){}});
    const snapshot=await engine.snapshot();await engine.dispose();
    const source=`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {App} from './apps/web/src/App';
      const listeners=new Set();let seq=0;let epoch=0;
      let info={id:'terminal',groupId:'group',title:'모바일',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:20};
      const state=()=>({hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.1.0',protocolVersion:1,capabilities:['control.acquire-if-free'],groups:[{id:'group',name:'모바일 그룹',cwd:'C:/test',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}}],terminals:[info],profiles:[],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}});
      const frame=()=>{const result={type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}};h.latestSeq=seq;return result;};
      const emitState=()=>listeners.forEach(fn=>fn({type:'state',state:state()}));
      const h=window.mobileTest={calls:[],pendingAcquire:null,pendingResize:null,pendingAck:null,pendingInput:null,holdAck:false,holdInput:false,latestSeq:0,ackedSeq:0,readonlyWrites:[],focusEvents:[],blurCount:0,
        output:()=>listeners.forEach(fn=>fn(frame())),
        revoke:()=>{info={...info,controller:{connectionId:'other',deviceName:'다른 기기',epoch:++epoch,ready:true}};emitState();},
        setHeight:height=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>height});window.visualViewport.dispatchEvent(new Event('resize'));}
      };
      const request=async(method,params)=>{
        h.calls.push({method,params});
        if(method==='state.get')return state();
        if(method==='terminals.attach')return frame();
        if(method==='control.acquire')return new Promise(resolve=>{h.pendingAcquire=()=>{h.pendingAcquire=null;info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'mobile',deviceName:'휴대폰',epoch:++epoch,ready:false}};emitState();resolve({epoch,connectionId:'mobile',frame:frame()});};});
        if(method==='terminal.resize')return new Promise(resolve=>{h.pendingResize=()=>{h.pendingResize=null;info={...info,cols:params.cols,rows:params.rows};emitState();resolve({frame:frame()});};});
        if(method==='terminal.ack'){
          const complete=()=>{h.ackedSeq=params.seq;return {acknowledged:true};};
          if(h.holdAck)return new Promise(resolve=>{h.pendingAck=()=>{h.pendingAck=null;h.holdAck=false;resolve(complete());};});
          return complete();
        }
        if(method==='terminal.input'&&h.holdInput)return new Promise((resolve,reject)=>{h.pendingInput=()=>{h.pendingInput=null;h.holdInput=false;reject(Error('입력 응답 확인 실패'));};});
        return {ok:true};
      };
      window.mongle={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{fn({status:'connected',owner:false});return()=>{};},listHosts:async()=>[],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>{}};
      const descriptor=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'readOnly');
      Object.defineProperty(HTMLTextAreaElement.prototype,'readOnly',{...descriptor,set(value){if(this.classList.contains('xterm-helper-textarea'))h.readonlyWrites.push(value);descriptor.set.call(this,value);}});
      let inClick=false;document.addEventListener('click',()=>inClick=true,true);document.addEventListener('click',()=>inClick=false);
      document.addEventListener('focusin',event=>{if(event.target.classList.contains('xterm-helper-textarea'))h.focusEvents.push({inClick,readonly:event.target.readOnly});});
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
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
    const browser=await chromium.launch({channel:'chrome',headless:true});
    try{
      const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);
      const inputText=()=>page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join(''));
      const waitForInput=async(expected:string)=>{try{await page.waitForFunction(expected=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')===expected,expected);}catch(error){
        const state=await page.evaluate(()=>{const h=(window as any).mobileTest,area=document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');return {pendingResize:Boolean(h.pendingResize),pendingAck:Boolean(h.pendingAck),focused:document.activeElement===area,readOnly:area?.readOnly,input:h.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join(''),lastCalls:h.calls.slice(-5)};});
        throw new Error(`Input did not settle: ${JSON.stringify(state)}`,{cause:error});
      }};
      const waitForAck=()=>page.waitForFunction(()=>{const h=(window as any).mobileTest;return !h.pendingAck&&h.ackedSeq===h.latestSeq;});
      const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript('window.__name=function(fn){return fn;};');
      await page.goto(`http://127.0.0.1:${address.port}`);
      const textarea=page.locator('.xterm-helper-textarea');await textarea.waitFor({state:'attached'});
      await page.waitForFunction(()=>(window as any).mobileTest.calls.some((call:any)=>call.method==='terminal.ack'));
      assert.equal(await textarea.evaluate((element:HTMLTextAreaElement)=>element.readOnly),true,'view-only remains read-only');
      await page.evaluate(()=>(window as any).mobileTest.readonlyWrites=[]);
      await page.locator('.terminal-canvas').tap();
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAcquire));
      assert.equal(await textarea.evaluate(element=>document.activeElement===element),true);
      assert.deepEqual(await page.evaluate(()=>(window as any).mobileTest.focusEvents.at(-1)),{inClick:true,readonly:false},'editable focus is synchronous in the trusted control click');
      await page.keyboard.type('PRE_LEASE');
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.input').length),0);
      await page.evaluate(()=>{const h=(window as any).mobileTest;h.holdAck=true;h.pendingAcquire();});
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAck));
      await page.keyboard.type('PRE_ACK');
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.input').length),0);
      await page.evaluate(()=>(window as any).mobileTest.pendingAck());
      await page.getByText('여기서 제어 중',{exact:true}).waitFor();
      await page.keyboard.type('a');
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')),'a');
      await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='control.acquire').length),1,'controlled keyboard button focuses without replacing the lease');

      await page.evaluate(()=>(window as any).mobileTest.setHeight(500));
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingResize));
      assert.equal(Math.round((await page.locator('.app-shell').boundingBox())!.height),500,'mobile layout uses the visual viewport height');
      await page.evaluate(()=>(window as any).mobileTest.output());
      await page.waitForFunction(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.ack').length>=3);
      await page.keyboard.type('MID_RESIZE');
      await page.keyboard.insertText('한글🙂');
      await page.getByRole('button',{name:'왼쪽',exact:true}).tap();
      assert.equal(await inputText(),'a','unrelated stream ACK cannot reopen the resize transport fence');
      await page.evaluate(()=>{const h=(window as any).mobileTest;h.holdAck=true;h.pendingResize();});
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAck));
      await page.keyboard.type('RESIZE_PRE_ACK');
      assert.equal(await inputText(),'a','fresh resize input remains queued until its snapshot ACK');
      await page.evaluate(()=>(window as any).mobileTest.pendingAck());
      await page.waitForFunction(()=>!(window as any).mobileTest.pendingAck);
      await page.keyboard.type('b');
      await page.getByRole('button',{name:'Ctrl',exact:true}).tap();
      await page.getByRole('button',{name:'Ctrl',exact:true}).tap();
      await page.getByRole('button',{name:'왼쪽',exact:true}).tap();
      await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();
      assert.equal(await textarea.evaluate(element=>document.activeElement===element),true);
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.blurCount),0,'auxiliary keys never blur the focused input');
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.readonlyWrites.includes(true)),false,'acquire, frames and resize must not toggle read-only');
      const delivered='aMID_RESIZE한글🙂\x1b[DRESIZE_PRE_ACKb\x1b[D';
      await waitForInput(delivered);
      assert.equal(await inputText(),delivered,'fresh ASCII, Unicode and auxiliary keys flush once in order after the matching resize ACK; acquire input never replays');

      // Resize waits for the earlier in-flight input before changing the host
      // input gate. Failure discards newer input and prevents that resize RPC.
      await page.evaluate(()=>(window as any).mobileTest.holdInput=true);await page.keyboard.type('x');
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingInput));
      const resizeCalls=await page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.resize').length);
      await page.evaluate(()=>(window as any).mobileTest.setHeight(560));
      await page.waitForFunction(()=>Math.round(document.querySelector('.app-shell')!.getBoundingClientRect().height)===560);
      await page.keyboard.type('DROP_ON_FAILURE');
      assert.equal(await inputText(),delivered+'x');
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.calls.filter((call:any)=>call.method==='terminal.resize').length),resizeCalls,'resize does not overtake the pending input acceptance');
      await page.evaluate(()=>(window as any).mobileTest.pendingInput());
      await page.getByText('마지막 입력의 전달 여부를 확인해 주세요. 확인 후 제어권을 다시 가져올 수 있습니다.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>(window as any).mobileTest.pendingResize),null,'failed input cancels the paused resize before it is sent');
      await page.evaluate(()=>(window as any).mobileTest.output());await waitForAck();
      await page.keyboard.type('UNCERTAIN');
      assert.equal(await inputText(),delivered+'x','failed input discards resize-buffered text and stream frames do not release the uncertain-input latch');
      await page.locator('button.control-chip').tap();await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAcquire));
      await page.evaluate(()=>{const h=(window as any).mobileTest;h.holdAck=true;h.pendingAcquire();});
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAck));await page.keyboard.type('UNCERTAIN_PRE_ACK');
      assert.equal(await inputText(),delivered+'x','explicit recovery still waits for the new screen ACK');
      await page.evaluate(()=>(window as any).mobileTest.pendingAck());await page.getByText('여기서 제어 중',{exact:true}).waitFor();
      // Removing the uncertainty banner restores terminal height and requires
      // its own resize ACK before newly typed input may leave the client.
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingResize));
      await page.evaluate(()=>(window as any).mobileTest.pendingResize());
      await waitForAck();
      await page.keyboard.type('c');
      await waitForInput(delivered+'xc');
      assert.equal(await inputText(),delivered+'xc','explicit recovery never replays failed-lease buffered text or uncertain input');

      await page.evaluate(()=>(window as any).mobileTest.setHeight(650));
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingResize));
      await page.keyboard.type('DROP_ON_REVOKE');
      assert.equal(await inputText(),delivered+'xc');
      await page.evaluate(()=>(window as any).mobileTest.revoke());
      await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.readOnly);
      await page.evaluate(()=>(window as any).mobileTest.pendingResize());
      await page.evaluate(()=>(window as any).mobileTest.output());
      await page.keyboard.type('REVOKED');
      assert.equal(await textarea.evaluate((element:HTMLTextAreaElement)=>element.readOnly),true,'late resize response cannot restore a revoked lease');
      assert.equal(await inputText(),delivered+'xc','lease revocation discards the resize queue before the late resize response');
      await page.locator('button.control-chip').tap();await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAcquire));
      await page.keyboard.type('NEW_ACQUIRE_BLOCKED');
      await page.evaluate(()=>{const h=(window as any).mobileTest;h.holdAck=true;h.pendingAcquire();});
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingAck));
      await page.keyboard.type('NEW_ACQUIRE_PRE_ACK');
      assert.equal(await inputText(),delivered+'xc');
      await page.evaluate(()=>(window as any).mobileTest.pendingAck());await page.getByText('여기서 제어 중',{exact:true}).waitFor();
      // As above, clearing the takeover warning restores the viewport height.
      // The fake host must answer that resize too; a real host does so normally.
      await page.waitForFunction(()=>Boolean((window as any).mobileTest.pendingResize));
      await page.keyboard.type('d');assert.equal(await inputText(),delivered+'xc');
      await page.evaluate(()=>(window as any).mobileTest.pendingResize());await waitForAck();
      await waitForInput(delivered+'xcd');
      assert.equal(await inputText(),delivered+'xcd','a replacement lease only sends new input; revoked and acquire-stage input never replay');
      assert.deepEqual(errors,[]);
    }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
