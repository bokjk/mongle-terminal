import assert from 'node:assert/strict';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';
import {chromium,expect,type Page} from '@playwright/test';
import {TerminalEngine} from '../../packages/terminal/engine.js';

const chrome=process.platform==='win32'&&existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
test('input intent transfers control consistently while background events preserve lease fences',{skip:chrome?false:'Requires installed Windows Chrome.',timeout:120000},async t=>{
  const engine=new TerminalEngine({cols:40,rows:20,onResponse(){}});
  await engine.write(Array.from({length:80},(_,i)=>`History line ${i}\r\n`).join(''));
  const snapshot=await engine.snapshot();await engine.dispose();
  const source=`
    import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';import {App} from './apps/web/src/App';import {TerminalPane} from './apps/web/src/TerminalPane';
    const listeners=new Set(),connections=new Set();let seq=0,epoch=0;const query=new URLSearchParams(location.search),legacy=query.has('legacy'),owner=query.has('owner');
    let info={id:'terminal',groupId:'group',title:'모바일',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:20};
    if(query.has('controlled'))info.controller={connectionId:'other',deviceName:'다른 기기',epoch:++epoch,ready:true};
    const state=()=>({hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.2.0',protocolVersion:1,...(legacy?{}:{capabilities:['control.acquire-if-free']}),groups:[{id:'group',name:'모바일 그룹',cwd:'C:/test',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}}],terminals:[info],profiles:[],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}});
    const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}});
    const emit=()=>listeners.forEach(fn=>fn({type:'state',state:state()}));
    const h=window.tapTest={calls:[],holdAcquire:false,holdAck:false,pendingAcquire:null,pendingAck:null,failInput:false,failAcquire:false,busyRace:query.has('busy'),focus:[],clipboard:'pasted',
      revoke:()=>{info={...info,controller:{connectionId:'other',deviceName:'다른 기기',epoch:++epoch,ready:true}};emit();},
      free:()=>{info={...info,controller:undefined};emit();},
      output:()=>listeners.forEach(fn=>fn(frame())),
      connection:status=>connections.forEach(fn=>fn({status,owner}))
    };
    const request=async(method,params)=>{
      h.calls.push({method,params});
      if(method==='state.get')return state();
      if(method==='terminals.attach')return frame();
      if(method==='control.acquire'){
        if(h.busyRace){h.busyRace=false;info={...info,controller:{connectionId:'other',deviceName:'다른 기기',epoch:++epoch,ready:true}};}
        if(params.takeover===false&&info.controller&&info.controller.connectionId!=='mobile')throw Object.assign(Error('다른 기기에서 제어 중입니다.'),{code:'CONTROL_BUSY'});
        if(h.failAcquire){h.failAcquire=false;throw Error('제어 요청 실패');}
        info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'mobile',deviceName:'휴대폰',epoch:++epoch,ready:false}};emit();
        const result={epoch,connectionId:'mobile',frame:frame()};
        if(h.holdAcquire)return new Promise(resolve=>h.pendingAcquire=()=>{h.pendingAcquire=null;h.holdAcquire=false;resolve(result);});
        return result;
      }
      if(method==='terminal.resize'){info={...info,cols:params.cols,rows:params.rows};emit();return {frame:frame()};}
      if(method==='terminal.ack'&&h.holdAck)return new Promise(resolve=>h.pendingAck=()=>{h.pendingAck=null;h.holdAck=false;resolve({acknowledged:true});});
      if(method==='terminal.input'&&h.failInput){h.failInput=false;throw Error('입력 전달을 확인하지 못했습니다.');}
      return {ok:true};
    };
    let inClick=false;document.addEventListener('click',()=>inClick=true,true);document.addEventListener('click',()=>inClick=false);
    document.addEventListener('focusin',event=>{if(event.target.classList.contains('xterm-helper-textarea'))h.focus.push({inClick,readonly:event.target.readOnly});});
    window.mongle={request,readClipboard:async()=>h.clipboard,writeClipboard:async text=>{h.copied=text;},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{connections.add(fn);fn({status:'connected',owner});return()=>connections.delete(fn);},listHosts:async()=>[],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>{}};
    function RegisteredPane(){const [current,setCurrent]=useState(state());useEffect(()=>window.mongle.subscribe(event=>{if(event.type==='state')setCurrent(event.state);}),[]);return <TerminalPane client={window.mongle} state={current} info={current.terminals[0]} connected owner={false} selected maximized={false} fontSize={14} theme="dark" ctrl={false} alt={false} onSelect={()=>{}} onSplit={()=>{}} onMaximize={()=>{}} onClose={()=>{}} onRename={()=>{}} onRestart={()=>{}} onMove={()=>{}} onClearHistory={()=>{}} onTerminate={()=>{}} onError={message=>h.error=message} confirmPaste={async()=>true} register={(_id,actions)=>h.actions=actions}/>;}
    createRoot(document.getElementById('root')).render(query.has('registered')?<RegisteredPane/>:<App/>);
  `;
  const bundle=await build({stdin:{contents:source,loader:'tsx',resolveDir:fileURLToPath(new URL('../../',import.meta.url))},bundle:true,write:false,format:'iife',platform:'browser'});
  const css=readFileSync(new URL('../../apps/web/src/styles.css',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css',import.meta.url),'utf8');
  const server=createServer((request,response)=>{
    if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(bundle.outputFiles[0].contents);}
    else if(request.url==='/style.css'){response.setHeader('Content-Type','text/css');response.end(css);}
    else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const browser=await chromium.launch({channel:'chrome',headless:true});const errors:string[]=[];
  const open=async(mobile=true,query='')=>{
    const page=await browser.newPage({viewport:{width:mobile?390:1200,height:844},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));await page.addInitScript('window.__name=function(fn){return fn;};');
    await page.goto(`http://127.0.0.1:${address.port}/${query}`);await page.waitForFunction(()=>(window as any).tapTest.calls.some((call:any)=>call.method==='terminal.ack'));
    return page;
  };
  const acquisitions=(page:Page)=>page.evaluate(()=>(window as any).tapTest.calls.filter((call:any)=>call.method==='control.acquire').map((call:any)=>call.params));
  const input=(page:Page)=>page.evaluate(()=>(window as any).tapTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join(''));
  const readonly=(page:Page)=>page.locator('.xterm-helper-textarea').evaluate((element:HTMLTextAreaElement)=>element.readOnly);
  const nativePaste=(page:Page,text:string)=>page.locator('.terminal-canvas').evaluate((element,text)=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);element.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));},text);
  const auxiliaryOrPaste=async(page:Page,action:string)=>{
    if(action==='auxiliary')await page.getByRole('button',{name:'Tab',exact:true}).tap();
    else if(action==='native')await nativePaste(page,'pasted');
    else if(action==='rightclick')await page.locator('.terminal-canvas').click({button:'right'});
    else if(action==='shortcut'){await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Control+Shift+V');}
    else if(action==='registered')await page.evaluate(()=>(window as any).tapTest.actions.paste('pasted'));
    else {await page.getByLabel('터미널 메뉴',{exact:true}).click();await page.getByRole('button',{name:/^붙여넣기/}).click();}
  };
  try{
    await t.test('mobile free tap focuses synchronously, waits for ACK, and does not replay early input',async()=>{
      const page=await open();try{
        await page.getByText('화면을 눌러 입력',{exact:true}).waitFor();assert.equal(await page.locator('button.control-chip').count(),0);
        await page.evaluate(()=>(window as any).tapTest.holdAck=true);await page.locator('.terminal-canvas').tap();
        await page.waitForFunction(()=>Boolean((window as any).tapTest.pendingAck));
        assert.deepEqual(await page.evaluate(()=>(window as any).tapTest.focus.at(-1)),{inClick:true,readonly:false});
        assert.equal((await acquisitions(page))[0].takeover,undefined,'a user tap explicitly requests control, also on legacy hosts');
        await page.keyboard.type('DROP');assert.equal(await input(page),'');
        await page.evaluate(()=>(window as any).tapTest.pendingAck());await page.getByText('여기서 제어 중',{exact:true}).waitFor();
        assert.equal(await page.locator('button.control-chip').count(),0,'controlled state is an indicator');
        await page.keyboard.type('ok');assert.equal(await input(page),'ok');
        await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();assert.equal((await acquisitions(page)).length,1);
        mkdirSync(fileURLToPath(new URL('../../test-results/tap-control/',import.meta.url)),{recursive:true});
        await page.screenshot({path:fileURLToPath(new URL('../../test-results/tap-control/mobile-controlled.png',import.meta.url))});
      }finally{await page.close();}
    });
    await t.test('keyboard-open and desktop click safely start a free terminal',async()=>{
      for(const mobile of [true,false]){const page=await open(mobile);try{
        if(mobile)await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();else await page.locator('.terminal-canvas').click();
        await page.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal((await acquisitions(page))[0].takeover,undefined);
        await page.keyboard.type('typed');assert.equal(await input(page),'typed');
      }finally{await page.close();}}
    });
    await t.test('swipe, long press, multitouch, cancelled pointers, and selection do not acquire or enable the keyboard',async()=>{
      const page=await open();try{
        const canvas=page.locator('.terminal-canvas');
        const pointer=async(type:string,id:number,x:number,y:number,primary=true)=>canvas.dispatchEvent(type,{pointerId:id,pointerType:'touch',isPrimary:primary,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y,bubbles:true});
        await pointer('pointerdown',1,150,300);await pointer('pointermove',1,150,294);await pointer('pointerup',1,150,294);await canvas.dispatchEvent('click',{button:0});
        assert.equal((await acquisitions(page)).length,0,'six-pixel swipe');
        await pointer('pointerdown',2,150,300);await page.waitForTimeout(520);await pointer('pointerup',2,150,300);await canvas.dispatchEvent('click',{button:0});
        assert.equal((await acquisitions(page)).length,0,'long press');
        await pointer('pointerdown',3,150,300);await pointer('pointerdown',4,180,300,false);await pointer('pointerup',4,180,300,false);await pointer('pointerup',3,150,300);await canvas.dispatchEvent('click',{button:0});
        assert.equal((await acquisitions(page)).length,0,'multitouch inside pane');
        await pointer('pointerdown',7,150,300);await page.locator('.workspace-header').dispatchEvent('pointerdown',{pointerId:8,pointerType:'touch',isPrimary:false,button:0,clientX:180,clientY:20,bubbles:true});await pointer('pointerup',8,180,20,false);await pointer('pointerup',7,150,300);await canvas.dispatchEvent('click',{button:0});
        assert.equal((await acquisitions(page)).length,0,'second pointer outside pane');
        await pointer('pointerdown',5,150,300);await pointer('pointercancel',5,150,300);await canvas.dispatchEvent('click',{button:0});
        assert.equal((await acquisitions(page)).length,0);assert.equal(await readonly(page),true);
        assert.equal(await page.evaluate(()=>(window as any).tapTest.focus.some((entry:any)=>!entry.readonly)),false);
        await pointer('pointerdown',9,150,300);await canvas.dispatchEvent('contextmenu',{button:2,clientX:150,clientY:300,bubbles:true});await pointer('pointerup',9,150,300);
        await page.getByRole('dialog',{name:'터미널 복사와 붙여넣기',exact:true}).waitFor();assert.equal((await acquisitions(page)).length,0,'touch long-press opens the menu without pasting or acquiring');await page.keyboard.press('Escape');
      }finally{await page.close();}
      const desktop=await open(false);try{
        const row=await desktop.locator('.xterm-screen').boundingBox();assert.ok(row);
        await desktop.mouse.move(row.x+8,row.y+8);await desktop.mouse.down();await desktop.mouse.move(row.x+95,row.y+8,{steps:8});await desktop.mouse.up();
        await desktop.waitForFunction(()=>Boolean((window as any).tapTest.copied?.length));
        assert.equal((await acquisitions(desktop)).length,0,'drag selects without acquiring');
        await desktop.locator('.terminal-canvas').click();assert.equal((await acquisitions(desktop)).length,0,'clicking an existing selection only clears it');
        await desktop.locator('.terminal-canvas').click();await desktop.getByText('여기서 제어 중',{exact:true}).waitFor();
      }finally{await desktop.close();}
    });
    await t.test('content, mobile titles and explicit input transfer control; desktop tabs only select',async()=>{
      for(const mobile of [true,false]){const page=await open(mobile,mobile?'':'?owner&controlled');try{
        for(const action of mobile?['screen','title','keyboard','button']:['screen','tab','button']){
          await page.evaluate(()=>(window as any).tapTest.revoke());await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();
          const before=(await acquisitions(page)).length;
          if(action==='screen')await page.locator('.terminal-canvas')[mobile?'tap':'click']();
          else if(action==='title')await page.locator('.pane-title')[mobile?'tap':'click']();
          else if(action==='tab'){
            await page.getByRole('tab').click();
            assert.equal((await acquisitions(page)).length,before,'Selecting a desktop tab leaves another controller alone');
            await expect(page.locator('.xterm-helper-textarea')).toHaveJSProperty('readOnly',true);
            await expect(page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true})).toBeVisible();
            continue;
          }
          else if(action==='keyboard')await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();
          else await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true})[mobile?'tap':'click']();
          await page.getByText('여기서 제어 중',{exact:true}).waitFor();
          assert.equal((await acquisitions(page)).length,before+1,`${mobile?'mobile':'desktop'} ${action} acquires once`);
          assert.equal((await acquisitions(page)).at(-1).takeover,undefined);
          assert.equal(await readonly(page),false);
        }
        await page.keyboard.type('return');assert.equal(await input(page),'return');
      }finally{await page.close();}}
    });
    await t.test('desktop background attach, reconnect, focus, and output never steal another lease',async()=>{
      const free=await open(false,'?owner');try{
        await free.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal((await acquisitions(free))[0].takeover,false,'only background acquisition is conditional');
      }finally{await free.close();}
      for(const query of ['?owner&controlled','?owner&busy']){const page=await open(false,query);try{
        await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();
        const before=await acquisitions(page);assert.equal(before.length,query.includes('busy')?1:0);
        if(before.length)assert.equal(before[0].takeover,false);
        await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));(window as any).tapTest.output();});
        await page.evaluate(()=>(window as any).tapTest.connection('offline'));await page.waitForFunction(()=>document.querySelector('.xterm-helper-textarea')?.hasAttribute('readonly'));
        await page.evaluate(()=>(window as any).tapTest.connection('connected'));await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();
        assert.deepEqual(await acquisitions(page),before);assert.equal(await readonly(page),true);assert.equal(await page.locator('.toast').count(),0,'normal background contention is not an error banner');
        await page.locator('.terminal-canvas').click();await page.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal((await acquisitions(page)).at(-1).takeover,undefined);
      }finally{await page.close();}}
    });
    await t.test('late acquisition and ACK responses cannot reopen a lease already taken elsewhere',async()=>{
      for(const stage of ['acquire','ack']){const page=await open();try{
        await page.evaluate(stage=>{const h=(window as any).tapTest;h[stage==='acquire'?'holdAcquire':'holdAck']=true;},stage);
        await page.locator('.terminal-canvas').tap();await page.waitForFunction(stage=>Boolean((window as any).tapTest[stage==='acquire'?'pendingAcquire':'pendingAck']),stage);
        await page.evaluate(()=>{(window as any).tapTest.revoke();});
        await page.evaluate(stage=>(window as any).tapTest[stage==='acquire'?'pendingAcquire':'pendingAck'](),stage);
        await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();
        await page.keyboard.type('STALE');assert.equal(await readonly(page),true);assert.equal(await input(page),'');
      }finally{await page.close();}}
    });
    await t.test('auxiliary keys and every paste entry point acquire, wait for ACK, and send once',async()=>{
      for(const action of ['auxiliary','native','rightclick','menu','shortcut','registered']){const page=await open(action==='auxiliary',action==='registered'?'?registered&controlled':'?controlled');try{
        await page.evaluate(()=>(window as any).tapTest.holdAck=true);await auxiliaryOrPaste(page,action);
        await page.waitForFunction(()=>Boolean((window as any).tapTest.pendingAck));
        assert.equal((await acquisitions(page)).length,1,`${action} requests one lease`);assert.equal((await acquisitions(page))[0].takeover,undefined);
        assert.equal(await input(page),'',`${action} must wait for the snapshot ACK`);
        await page.evaluate(()=>(window as any).tapTest.pendingAck());await page.getByText('여기서 제어 중',{exact:true}).waitFor();
        const expected=action==='auxiliary'?'\t':'pasted';await page.waitForFunction(expected=>(window as any).tapTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')===expected,expected);
        assert.equal(await input(page),expected);assert.equal(await page.evaluate(()=>(window as any).tapTest.calls.filter((call:any)=>call.method==='terminal.input').length),1,`${action} sends exactly once`);
      }finally{await page.close();}}
    });
    await t.test('pending paste and auxiliary actions are discarded when the lease changes before ACK',async()=>{
      for(const action of ['auxiliary','native']){const page=await open(action==='auxiliary','?controlled');try{
        await page.evaluate(()=>(window as any).tapTest.holdAck=true);await auxiliaryOrPaste(page,action);await page.waitForFunction(()=>Boolean((window as any).tapTest.pendingAck));
        await page.evaluate(()=>{const h=(window as any).tapTest;h.revoke();h.pendingAck();});await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();
        assert.equal(await readonly(page),true);assert.equal(await input(page),'');
        await page.locator('.terminal-canvas')[action==='auxiliary'?'tap':'click']();await page.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal(await input(page),'','the stale action is never replayed on a subsequent valid lease');
      }finally{await page.close();}}
    });
    await t.test('paste and auxiliary intent join a click acquisition already waiting for ACK',async()=>{
      for(const action of ['auxiliary','native'])for(const revoke of [false,true]){const page=await open(action==='auxiliary','?controlled');try{
        await page.evaluate(()=>(window as any).tapTest.holdAck=true);
        await page.locator('.terminal-canvas')[action==='auxiliary'?'tap':'click']();await page.waitForFunction(()=>Boolean((window as any).tapTest.pendingAck));
        await auxiliaryOrPaste(page,action);assert.equal((await acquisitions(page)).length,1,'the action shares the acquisition initiated by the click');assert.equal(await input(page),'');
        if(revoke)await page.evaluate(()=>(window as any).tapTest.revoke());
        await page.evaluate(()=>(window as any).tapTest.pendingAck());
        if(revoke){
          await page.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();assert.equal(await input(page),'');assert.equal(await readonly(page),true);
          await page.locator('.terminal-canvas')[action==='auxiliary'?'tap':'click']();await page.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal(await input(page),'','joining a lost lease must not replay later');
        }else{
          await page.getByText('여기서 제어 중',{exact:true}).waitFor();const expected=action==='auxiliary'?'\t':'pasted';
          await page.waitForFunction(expected=>(window as any).tapTest.calls.filter((call:any)=>call.method==='terminal.input').map((call:any)=>call.params.data).join('')===expected,expected);
          assert.equal(await page.evaluate(()=>(window as any).tapTest.calls.filter((call:any)=>call.method==='terminal.input').length),1,'the action is sent once after the shared ACK');
        }
      }finally{await page.close();}}
    });
    await t.test('copy, opening a context menu, and cancelling a paste never acquire control',async()=>{
      const page=await open(false,'?controlled');try{
        const row=await page.locator('.xterm-screen').boundingBox();assert.ok(row);
        await page.mouse.move(row.x+8,row.y+8);await page.mouse.down();await page.mouse.move(row.x+95,row.y+8,{steps:8});await page.mouse.up();
        await page.waitForFunction(()=>Boolean((window as any).tapTest.copied?.length));assert.equal((await acquisitions(page)).length,0);
        await page.locator('.terminal-canvas').click({button:'right',modifiers:['Shift']});
        const menu=page.getByRole('dialog',{name:'터미널 복사와 붙여넣기',exact:true});await menu.waitFor();assert.equal((await acquisitions(page)).length,0);
        await menu.getByRole('button',{name:/^복사/}).click();assert.equal((await acquisitions(page)).length,0,'copying through the menu does not take control');
        await page.evaluate(()=>(window as any).tapTest.clipboard='line one\nline two');
        await page.locator('.terminal-canvas').click({button:'right'});const confirmation=page.getByRole('dialog',{name:'여러 줄을 붙여넣을까요?',exact:true});await confirmation.waitFor();assert.equal((await acquisitions(page)).length,0,'confirmation precedes acquisition');
        await confirmation.getByRole('button',{name:'취소',exact:true}).click();assert.equal((await acquisitions(page)).length,0);assert.equal(await input(page),'');
        await page.locator('.terminal-canvas').click({button:'right',modifiers:['Shift']});await menu.waitFor();assert.equal((await acquisitions(page)).length,0);
        await menu.getByRole('button',{name:/^붙여넣기/}).click();await confirmation.waitFor();assert.equal((await acquisitions(page)).length,0);
        await confirmation.getByRole('button',{name:'붙여넣기',exact:true}).click();await page.getByText('여기서 제어 중',{exact:true}).waitFor();
        await page.waitForFunction(()=>(window as any).tapTest.calls.some((call:any)=>call.method==='terminal.input'));
        assert.equal((await acquisitions(page)).length,1);assert.equal(await input(page),'line one\rline two');
      }finally{await page.close();}
    });
    await t.test('uncertain input and failed acquire still require explicit recovery',async()=>{
      const page=await open();try{
        await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();await page.getByText('여기서 제어 중',{exact:true}).waitFor();
        await page.evaluate(()=>(window as any).tapTest.failInput=true);await page.keyboard.type('x');await page.getByRole('button',{name:'입력 확인 후 다시 제어',exact:true}).waitFor();
        await page.getByRole('button',{name:'알림 닫기',exact:true}).tap();
        await page.evaluate(()=>(window as any).tapTest.free());await page.locator('.terminal-canvas').tap();await page.getByRole('button',{name:'키보드 열기',exact:true}).tap();await page.getByRole('button',{name:'Tab',exact:true}).tap();await nativePaste(page,'DROP');assert.equal((await acquisitions(page)).length,1);assert.equal(await input(page),'x');
        await page.getByRole('button',{name:'입력 확인 후 다시 제어',exact:true}).tap();await page.getByText('여기서 제어 중',{exact:true}).waitFor();await page.keyboard.type('y');assert.equal(await input(page),'xy');
        await page.evaluate(()=>{const h=(window as any).tapTest;h.free();h.failAcquire=true;});await page.getByText('화면을 눌러 입력',{exact:true}).waitFor();
        await page.locator('.terminal-canvas').tap();await page.getByRole('button',{name:'제어 다시 시도',exact:true}).waitFor();const count=(await acquisitions(page)).length;
        await page.getByRole('button',{name:'알림 닫기',exact:true}).tap();
        await page.locator('.terminal-canvas').tap();assert.equal((await acquisitions(page)).length,count);
        await page.getByRole('button',{name:'제어 다시 시도',exact:true}).tap();await page.getByText('여기서 제어 중',{exact:true}).waitFor();
      }finally{await page.close();}
    });
    await t.test('legacy hosts accept deliberate clicks and taps while background owner attach stays read-only',async()=>{
      for(const mobile of [true,false]){const legacy=await open(mobile,'?legacy&owner');try{
        assert.equal((await acquisitions(legacy)).length,0);
        await legacy.locator('.terminal-canvas')[mobile?'tap':'click']();await legacy.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal((await acquisitions(legacy))[0].takeover,undefined);
        await legacy.evaluate(()=>(window as any).tapTest.revoke());await legacy.getByRole('button',{name:'다른 기기에서 제어 · 가져오기',exact:true}).waitFor();
        await legacy.locator('.terminal-canvas')[mobile?'tap':'click']();await legacy.getByText('여기서 제어 중',{exact:true}).waitFor();assert.equal((await acquisitions(legacy)).length,2);
      }finally{await legacy.close();}}
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
