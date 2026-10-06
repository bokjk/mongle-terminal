import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('real TerminalPane: deferred selection copies once and respects a newer gesture or typing',
  { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 45000 }, async t => {
    const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
    await engine.write('abcdefghijklmnopqrstuvwxyz\r\noutput');
    const snapshot = await engine.snapshot();
    await engine.dispose();
    // Use the production React pane and its actual window mouseup handler.
    // Only the host transport and clipboard boundary are test doubles.
    const source = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Terminal} from '@xterm/xterm';
      import {TerminalPane} from './apps/web/src/TerminalPane';
      const listeners=new Set();let seq=0;let epoch=0;
      let info={id:'terminal',groupId:'group',title:'Selection test',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:8};
      const state=()=>({hostId:'host',bootId:'boot',name:'Test host',version:'0.1.0',protocolVersion:1,capabilities:['control.acquire-if-free'],groups:[],terminals:[info],profiles:[],settings:{name:'Test host',recordHistory:true,scrollback:5000}});
      const initial=${JSON.stringify(snapshot)};
      const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...initial,cols:info.cols,rows:info.rows,modes:{...initial.modes,mouseTrackingMode:h.mouseMode||'none'}}});
      const h=window.selectionCopyTest={copies:[],calls:[],errors:[],failCopy:false,holdCopy:false,copyReleases:[],holdWrite:false,release:null,ackedSeq:0,terminal:null,
        emit:()=>{const next=frame();listeners.forEach(fn=>fn(next));return next.seq;}};
      const open=Terminal.prototype.open;
      Terminal.prototype.open=function(...args){h.terminal=this;return open.apply(this,args);};
      const write=Terminal.prototype.write;
      Terminal.prototype.write=function(data,done){
        if(!h.holdWrite)return write.call(this,data,done);
        h.holdWrite=false;
        return write.call(this,data,()=>{h.release=()=>{h.release=null;done();};});
      };
      const request=async(method,params)=>{
        h.calls.push({method,params});
        if(method==='terminals.attach')return frame();
        if(method==='control.acquire'){
          info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'test',deviceName:'Test',epoch:++epoch,ready:false}};
          listeners.forEach(fn=>fn({type:'state',state:state()}));
          return {epoch,connectionId:'test',frame:frame()};
        }
        if(method==='terminal.resize'){info={...info,cols:params.cols,rows:params.rows};return {frame:frame()};}
        if(method==='terminal.ack'){h.ackedSeq=params.seq;return {acknowledged:true};}
        return {ok:true};
      };
      window.mongle={writeClipboard:async text=>{h.copies.push(text);const fails=h.failCopy;if(h.holdCopy)await new Promise(resolve=>h.copyReleases.push(resolve));if(fails)throw Error('Clipboard write failed');}};
      const client={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
      const noop=()=>{};
      createRoot(document.getElementById('root')).render(<TerminalPane client={client} state={state()} info={info}
        connected={true} owner={true} connectionId="test" selected={true} maximized={false} fontSize={14} theme="dark" ctrl={false} alt={false}
        onSelect={noop} onSplit={noop} onMaximize={noop} onClose={noop} onRename={noop} onRestart={noop} onMove={noop}
        onClearHistory={noop} onTerminate={noop} onError={message=>h.errors.push(message)} confirmPaste={async()=>true} register={noop}/>);
    `;
    const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
      bundle: true, write: false, format: 'iife', platform: 'browser' });
    const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8').replace(/@import[^;]+;/g, '') +
      '\n' + readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
    const server = createServer((request, response) => {
      if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
      else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
      else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"><style>#root{width:750px;height:450px}.pane{height:450px}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      await t.test('Shift selection in a mouse-reporting CLI copies once after a frame', async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        try {
          await page.addInitScript('window.__name=function(fn){return fn;};');
          await page.goto(`http://127.0.0.1:${address.port}`);
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          const cell = await page.evaluate(() => {
            const terminal=(window as any).selectionCopyTest.terminal;
            const rect=terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
            return {x:rect.x,y:rect.y+rect.height/terminal.rows/2,width:rect.width/terminal.cols};
          });
          // Place the pointer before enabling ANY: its normal pre-drag hover
          // report is unrelated to the Shift selection under test.
          await page.mouse.move(cell.x+2.1*cell.width,cell.y);
          const seq = await page.evaluate(() => { const h=(window as any).selectionCopyTest; h.mouseMode='any'; return h.emit(); });
          await page.waitForFunction(expected => (window as any).selectionCopyTest.ackedSeq >= expected, seq);
          await page.keyboard.down('Shift');
          await page.mouse.down();
          await page.mouse.move(cell.x+5.1*cell.width,cell.y);
          const next=await page.evaluate(() => (window as any).selectionCopyTest.emit());
          await page.waitForFunction(expected => (window as any).selectionCopyTest.ackedSeq >= expected,next);
          await page.mouse.move(cell.x+12.1*cell.width,cell.y);
          await page.mouse.up();
          await page.keyboard.up('Shift');
          await page.waitForFunction(() => (window as any).selectionCopyTest.copies.length===1);
          assert.deepEqual(await page.evaluate(() => {
            const h=(window as any).selectionCopyTest;
            return {copies:h.copies,inputs:h.calls.filter((c:any)=>c.method==='terminal.input')};
          }),{copies:['cdefghijkl'],inputs:[]});
        } finally {await page.close();}
      });
      for (const action of ['release', 'new selection', 'typing'] as const) {
        await t.test(action, async () => {
          const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
          const errors: string[] = [];
          page.on('pageerror', error => errors.push(error.message));
          page.setDefaultTimeout(5000);
          await page.addInitScript('window.__name=function(fn){return fn;};');
          try {
            await page.goto(`http://127.0.0.1:${address.port}`);
            await page.getByText('여기서 제어 중', { exact: true }).waitFor();
            const cell = await page.evaluate(() => {
              const terminal = (window as any).selectionCopyTest.terminal;
              const rect = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
              return { x: rect.x, y: rect.y + rect.height / terminal.rows / 2, width: rect.width / terminal.cols };
            });
            await page.mouse.move(cell.x + 2.1 * cell.width, cell.y);
            await page.mouse.down();
            await page.mouse.move(cell.x + 5.1 * cell.width, cell.y);
            const seq = await page.evaluate(() => {
              const h = (window as any).selectionCopyTest;
              h.holdWrite = true;
              return h.emit();
            });
            await page.waitForFunction(() => typeof (window as any).selectionCopyTest.release === 'function');
            await page.mouse.move(cell.x + 12.1 * cell.width, cell.y);
            await page.mouse.up();
            assert.deepEqual(await page.evaluate(() => (window as any).selectionCopyTest.copies), [], 'copy waits for the complete selection');
            if (action === 'new selection') {
              await page.mouse.move(cell.x + 15.1 * cell.width, cell.y);
              await page.mouse.down();
              await page.mouse.move(cell.x + 20.1 * cell.width, cell.y);
              await page.mouse.up();
            } else if (action === 'typing') await page.keyboard.press('x');
            await page.evaluate(() => (window as any).selectionCopyTest.release());
            await page.waitForFunction(expected => (window as any).selectionCopyTest.ackedSeq >= expected, seq);
            assert.deepEqual(await page.evaluate(() => {
              const h = (window as any).selectionCopyTest;
              return { copies: h.copies, inputs: h.calls.filter((call: any) => call.method === 'terminal.input').map((call: any) => call.params.data), errors: h.errors };
            }), { copies: action === 'typing' ? [] : [action === 'release' ? 'cdefghijkl' : 'pqrst'],
              inputs: action === 'typing' ? ['x'] : [], errors: [] });
            assert.deepEqual(errors, []);
          } finally { await page.close(); }
        });
      }
      await t.test('a failed copy clears recent success feedback and never sends terminal input', async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(5000);
        await page.addInitScript('window.__name=function(fn){return fn;};');
        try {
          await page.goto(`http://127.0.0.1:${address.port}`);
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          await page.evaluate(() => {
            const terminal = (window as any).selectionCopyTest.terminal;
            terminal.focus(); terminal.select(0, 0, 5);
          });
          await page.keyboard.press('Control+c');
          const success = page.getByRole('status').filter({ hasText: '선택한 내용을 복사했습니다.' });
          await expect(success).toBeVisible();
          await page.evaluate(() => { (window as any).selectionCopyTest.failCopy = true; });
          await page.keyboard.press('Control+c');
          await page.waitForFunction(() => (window as any).selectionCopyTest.errors.length === 1);
          // The previous success expires after two seconds. A long retry here
          // would incorrectly pass when the failed attempt leaves it visible.
          await expect(success).toHaveCount(0, { timeout: 250 });
          assert.deepEqual(await page.evaluate(() => {
            const h = (window as any).selectionCopyTest;
            return { copies: h.copies, inputs: h.calls.filter((call: any) => call.method === 'terminal.input'), errors: h.errors };
          }), { copies: ['abcde', 'abcde'], inputs: [], errors: ['복사하지 못했습니다. 내용을 선택한 뒤 Ctrl+C를 사용해 주세요.'] });
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
      await t.test('an older copy completion cannot show success while the newest copy is pending or failed', async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(5000);
        await page.addInitScript('window.__name=function(fn){return fn;};');
        try {
          await page.goto(`http://127.0.0.1:${address.port}`);
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          await page.evaluate(() => {
            const h = (window as any).selectionCopyTest;
            h.terminal.focus(); h.terminal.select(0, 0, 5); h.holdCopy = true;
          });
          await page.keyboard.press('Control+c');
          await page.waitForFunction(() => (window as any).selectionCopyTest.copyReleases.length === 1);
          await page.evaluate(() => { (window as any).selectionCopyTest.failCopy = true; });
          await page.keyboard.press('Control+c');
          await page.waitForFunction(() => (window as any).selectionCopyTest.copyReleases.length === 2);
          await page.evaluate(() => (window as any).selectionCopyTest.copyReleases[0]());
          const success = page.getByRole('status').filter({ hasText: '선택한 내용을 복사했습니다.' });
          await expect(success).toHaveCount(0, { timeout: 250 });
          await page.evaluate(() => (window as any).selectionCopyTest.copyReleases[1]());
          await page.waitForFunction(() => (window as any).selectionCopyTest.errors.length === 1);
          await expect(success).toHaveCount(0, { timeout: 250 });
          assert.deepEqual(await page.evaluate(() => {
            const h = (window as any).selectionCopyTest;
            return { copies: h.copies, inputs: h.calls.filter((call: any) => call.method === 'terminal.input'), errors: h.errors };
          }), { copies: ['abcde', 'abcde'], inputs: [], errors: ['복사하지 못했습니다. 내용을 선택한 뒤 Ctrl+C를 사용해 주세요.'] });
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
