import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('real TerminalPane: input waits for acceptance without changing leases or replaying stale bytes',
  { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000 }, async t => {
    const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
    const snapshot = await engine.snapshot();
    await engine.dispose();
    // Production React, xterm and presentation adapter run in real Chrome.
    // The host boundary deliberately holds input acceptance and resize ACKs;
    // its 64 outstanding request limit reproduces the desktop transport limit.
    const source = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {Terminal} from '@xterm/xterm';
      import {TerminalPane} from './apps/web/src/TerminalPane';
      const listeners=new Set();let seq=0;let epoch=0;let connected=true;let mounted=true;
      let info={id:'terminal',groupId:'group',title:'Input queue test',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:8};
      const state=()=>({hostId:'host',bootId:'boot',name:'Test host',version:'0.1.0',protocolVersion:1,capabilities:['control.acquire-if-free'],groups:[],terminals:[info],profiles:[],settings:{name:'Test host',recordHistory:true,scrollback:5000}});
      const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}});
      const h=window.inputQueueTest={calls:[],accepted:[],errors:[],violations:[],active:0,maxActive:0,pending:[],autoAccept:false,terminal:null,actions:null,holdAck:false,holdNextAcquireAck:new URLSearchParams(location.search).has('holdFirstAcquireAck'),pendingAck:null,pendingAckReject:null,settledHeldAcks:0,failNextAck:false,failNextResize:false,ackedSeq:0,events:[],
        emitState:()=>listeners.forEach(fn=>fn({type:'state',state:state()})),
        emitFrame:()=>{const next=frame();listeners.forEach(fn=>fn(next));return next.seq;},
        input:chunks=>{for(const chunk of chunks)h.terminal.input(chunk,true);},
        release:()=>{h.autoAccept=true;for(const item of h.pending.splice(0))item.resolve();},
        fail:()=>{const item=h.pending.shift();if(!item)throw Error('No pending input');item.reject(Error('Input acceptance was lost'));},
        revoke:()=>{info={...info,controller:{connectionId:'other',deviceName:'Other test device',epoch:++epoch,ready:true}};h.emitState();},
        disconnect:()=>{connected=false;flushSync(render);},
        reconnect:()=>{connected=true;flushSync(render);},
        unmount:()=>{mounted=false;flushSync(render);},
        remount:()=>{mounted=true;flushSync(render);},
        releaseAck:()=>{const release=h.pendingAck;if(!release)throw Error('No pending frame ACK');h.pendingAck=null;h.pendingAckReject=null;h.holdAck=false;release();},
        rejectAck:()=>{const reject=h.pendingAckReject;if(!reject)throw Error('No pending frame ACK');h.pendingAck=null;h.pendingAckReject=null;h.holdAck=false;reject(Error('Old frame acknowledgement failed'));},
        result:()=>({inputs:h.calls.filter(call=>call.method==='terminal.input').map(call=>call.params),accepted:h.accepted,errors:h.errors,violations:h.violations,active:h.active,maxActive:h.maxActive,events:h.events,acquires:h.calls.filter(call=>call.method==='control.acquire').length,resizes:h.calls.filter(call=>call.method==='terminal.resize').length})};
      const open=Terminal.prototype.open;
      Terminal.prototype.open=function(...args){h.terminal=this;return open.apply(this,args);};
      const request=async(method,params)=>{
        h.calls.push({method,params});
        if(method==='terminals.attach')return frame();
        if(method==='control.acquire'){
          if(h.holdNextAcquireAck){h.holdNextAcquireAck=false;h.holdAck=true;}
          info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'test',deviceName:'Test',epoch:++epoch,ready:false}};
          h.emitState();return {epoch,connectionId:'test',frame:frame()};
        }
        if(method==='terminal.resize'){
          h.events.push('resize');
          if(h.active)h.violations.push('resize before older input accepted');
          if(h.failNextResize){h.failNextResize=false;throw Error('Resize request failed');}
          info={...info,cols:params.cols,rows:params.rows,controller:{...info.controller,ready:false}};
          return {frame:frame()};
        }
        if(method==='terminal.ack'){
          if(h.failNextAck){h.failNextAck=false;throw Error('Frame acknowledgement failed');}
          if(h.holdAck){try{await new Promise((resolve,reject)=>{h.pendingAck=resolve;h.pendingAckReject=reject;});}finally{h.settledHeldAcks++;}}
          if(info.controller?.epoch===params.epoch){info={...info,controller:{...info.controller,ready:true}};h.events.push('ack');}
          h.ackedSeq=params.seq;
          return {acknowledged:true};
        }
        if(method==='terminal.input'){
          if(h.active>=64){h.violations.push('transport pending request limit');throw Error('Too many pending requests');}
          if(!connected||info.controller?.connectionId!=='test'||info.controller?.epoch!==params.epoch||!info.controller.ready){h.violations.push('input outside acknowledged lease');throw Error('Input lease is not ready');}
          h.active++;h.maxActive=Math.max(h.maxActive,h.active);h.events.push('input:'+params.data);
          try{
            if(!h.autoAccept)await new Promise((resolve,reject)=>h.pending.push({resolve,reject}));
            h.accepted.push(params);h.events.push('accepted:'+params.data);return {accepted:true};
          }finally{h.active--;}
        }
        return {ok:true};
      };
      const client={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
      const root=createRoot(document.getElementById('root'));const noop=()=>{};
      function render(){root.render(mounted?<TerminalPane client={client} state={state()} info={info}
        connected={connected} owner={true} connectionId="test" selected={true} maximized={false} fontSize={14} theme="dark" ctrl={false} alt={false}
        onSelect={noop} onSplit={noop} onMaximize={noop} onClose={noop} onRename={noop} onRestart={noop} onMove={noop}
        onClearHistory={noop} onTerminate={noop} onError={message=>h.errors.push(message)} confirmPaste={async()=>true} register={(_id,actions)=>{h.actions=actions;}}/>:null);}
      render();
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
    const fixture = async (run: (page: Page) => Promise<void>, options: { holdFirstAcquireAck?: boolean } = {}) => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(5000);
      await page.addInitScript('window.__name=function(fn){return fn;};');
      try {
        await page.goto(`http://127.0.0.1:${address.port}/${options.holdFirstAcquireAck ? '?holdFirstAcquireAck=1' : ''}`);
        if (options.holdFirstAcquireAck) await page.waitForFunction(() => typeof (window as any).inputQueueTest.pendingAck === 'function');
        else await page.getByText('여기서 제어 중', { exact: true }).waitFor();
        await run(page);
        assert.deepEqual(errors, [], 'no uncaught browser errors');
      } finally { await page.close(); }
    };
    try {
      await t.test('160 rapid chunks wait behind one input and arrive exactly once in the original lease', async () => fixture(async page => {
        const chunks = Array.from({ length: 160 }, (_, i) => i % 10 === 0 ? '한🙂' : String.fromCharCode(33 + i % 80));
        await page.evaluate(values => (window as any).inputQueueTest.input(values), chunks);
        const pending = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.equal(pending.maxActive, 1, 'one acceptance request may be in flight');
        assert.equal(pending.inputs.length, 1, 'later chunks remain local until acceptance');
        assert.deepEqual(pending.errors, []);
        assert.deepEqual(pending.violations, []);
        await page.evaluate(() => (window as any).inputQueueTest.release());
        await page.waitForFunction(expected => (window as any).inputQueueTest.accepted.map((input: any) => input.data).join('') === expected, chunks.join(''));
        const result = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.equal(result.accepted.map((input: any) => input.data).join(''), chunks.join(''));
        assert.equal(result.maxActive, 1);
        assert.equal(result.acquires, 1, 'backpressure must not reacquire control');
        assert.deepEqual([...new Set(result.inputs.map((input: any) => input.epoch))], [pending.inputs[0].epoch]);
        assert.equal(new Set(result.inputs.map((input: any) => input.inputId)).size, result.inputs.length);
        assert.deepEqual(result.inputs.map((input: any) => input.clientInputSeq), result.inputs.map((_input: any, i: number) => i + 1));
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.violations, []);
      }));
      await t.test('a lost acceptance stops input, drops the queue and requires explicit recovery', async () => fixture(async page => {
        await page.evaluate(() => (window as any).inputQueueTest.input(['uncertain-input', 'discard-1', 'discard-2']));
        assert.equal(await page.evaluate(() => (window as any).inputQueueTest.result().inputs.length), 1);
        await page.evaluate(() => (window as any).inputQueueTest.fail());
        const recover = page.getByRole('button', { name: '입력 확인 후 다시 제어', exact: true });
        await recover.waitFor();
        await page.evaluate(() => {
          const h = (window as any).inputQueueTest;
          h.input(['blocked-native-input']);
          h.actions.key('blocked-toolbar-input');
        });
        const blocked = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.equal(blocked.inputs.length, 1, 'uncertain input and buffered bytes are never retried');
        assert.equal(blocked.acquires, 1, 'ordinary input cannot clear uncertainty');
        assert.deepEqual(blocked.errors, ['Input acceptance was lost']);
        await page.evaluate(() => (window as any).inputQueueTest.release());
        await recover.click();
        await page.getByText('여기서 제어 중', { exact: true }).waitFor();
        await page.evaluate(() => (window as any).inputQueueTest.input(['fresh-input']));
        await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 1);
        const recovered = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.deepEqual(recovered.inputs.map((input: any) => input.data), ['uncertain-input', 'fresh-input']);
        assert.deepEqual(recovered.accepted.map((input: any) => input.data), ['fresh-input']);
        assert.equal(recovered.acquires, 2);
        assert.ok(recovered.inputs[1].epoch > recovered.inputs[0].epoch);
        assert.equal(recovered.maxActive, 1);
        assert.deepEqual(recovered.violations, []);
      }));
      for (const invalidation of ['revoke', 'disconnect', 'unmount'] as const) {
        await t.test(`${invalidation} discards queued bytes while the old acceptance is pending`, async () => fixture(async page => {
          await page.evaluate(() => (window as any).inputQueueTest.input(['old-in-flight', 'discard-1', 'discard-2']));
          assert.equal(await page.evaluate(() => (window as any).inputQueueTest.result().inputs.length), 1);
          await page.evaluate(action => {
            const h = (window as any).inputQueueTest;
            h[action]();
            // Keep reattachment in viewer mode, so recovery is an explicit
            // click in every scenario rather than a background acquisition.
            if (action !== 'revoke') h.revoke();
            h.release();
          }, invalidation);
          await page.waitForFunction(() => (window as any).inputQueueTest.active === 0);
          const invalidated = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.deepEqual(invalidated.inputs.map((input: any) => input.data), ['old-in-flight']);
          assert.equal(invalidated.acquires, 1, 'invalidating the queue cannot reacquire control automatically');
          assert.deepEqual(invalidated.errors, []);
          if (invalidation !== 'revoke') {
            await page.evaluate(action => {
              const h = (window as any).inputQueueTest;
              if (action === 'disconnect') h.reconnect();
              else h.remount();
            }, invalidation);
          }
          await page.getByRole('button', { name: '입력 확인 후 다시 제어', exact: true }).click();
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          await page.evaluate(() => (window as any).inputQueueTest.input(['fresh-after-recovery']));
          await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 2);
          const recovered = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.deepEqual(recovered.inputs.map((input: any) => input.data), ['old-in-flight', 'fresh-after-recovery']);
          assert.deepEqual(recovered.accepted.map((input: any) => input.data), ['old-in-flight', 'fresh-after-recovery']);
          assert.ok(recovered.inputs[1].epoch > recovered.inputs[0].epoch);
          assert.equal(recovered.acquires, 2);
          assert.equal(recovered.maxActive, 1);
          assert.deepEqual(recovered.errors, []);
          assert.deepEqual(recovered.violations, []);
        }));
      }
      await t.test('a late rejection from a revoked lease cannot block its explicitly recovered replacement', async () => fixture(async page => {
        await page.evaluate(() => {
          const h = (window as any).inputQueueTest;
          h.input(['old-in-flight', 'discard-old-buffer']);
          h.revoke();
          h.autoAccept = true;
        });
        await page.getByRole('button', { name: '입력 확인 후 다시 제어', exact: true }).click();
        await page.getByText('여기서 제어 중', { exact: true }).waitFor();
        await page.evaluate(() => (window as any).inputQueueTest.input(['fresh-before-old-reply']));
        await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 1);
        await page.evaluate(() => (window as any).inputQueueTest.fail());
        await page.waitForFunction(() => (window as any).inputQueueTest.active === 0);
        await page.getByText('여기서 제어 중', { exact: true }).waitFor();
        await page.evaluate(() => (window as any).inputQueueTest.input(['fresh-after-old-reply']));
        await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 2);
        const result = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.deepEqual(result.inputs.map((input: any) => input.data), ['old-in-flight', 'fresh-before-old-reply', 'fresh-after-old-reply']);
        assert.deepEqual(result.accepted.map((input: any) => input.data), ['fresh-before-old-reply', 'fresh-after-old-reply']);
        assert.ok(result.inputs[1].epoch > result.inputs[0].epoch);
        assert.equal(result.inputs[1].epoch, result.inputs[2].epoch);
        assert.equal(result.acquires, 2);
        assert.deepEqual(result.errors, [], 'obsolete rejections cannot poison the new queue');
        assert.deepEqual(result.violations, []);
      }));
      for (const outcome of ['rejection', 'success'] as const) {
        await t.test(`an old output frame ACK ${outcome} cannot disable the new pane effect after reconnect`, async () => fixture(async page => {
          await page.evaluate(() => {
            const h = (window as any).inputQueueTest;
            h.holdAck = true;
            h.emitFrame();
          });
          await page.waitForFunction(() => typeof (window as any).inputQueueTest.pendingAck === 'function');
          assert.deepEqual(await page.evaluate(() => (window as any).inputQueueTest.result().inputs), [], 'the old queue has no uncertain input');
          await page.evaluate(() => {
            const h = (window as any).inputQueueTest;
            // Preserve the held old ACK while allowing the new effect's
            // attach/acquire frames to complete normally on the same client.
            h.holdAck = false;
            h.disconnect();
            h.reconnect();
            h.autoAccept = true;
          });
          await page.waitForFunction(() => (window as any).inputQueueTest.result().acquires === 2);
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          await page.evaluate(() => (window as any).inputQueueTest.input(['before-old-ack']));
          await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 1);
          await page.evaluate(result => {
            const h = (window as any).inputQueueTest;
            if (result === 'rejection') h.rejectAck();
            else h.releaseAck();
          }, outcome);
          await page.waitForFunction(() => (window as any).inputQueueTest.settledHeldAcks === 1);
          await expect(page.getByText('여기서 제어 중', { exact: true })).toBeVisible();
          assert.equal(await page.evaluate(() => (window as any).inputQueueTest.terminal.options.disableStdin), false);
          await page.evaluate(() => (window as any).inputQueueTest.input(['after-old-ack']));
          await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 2);
          const result = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.deepEqual(result.inputs.map((input: any) => input.data), ['before-old-ack', 'after-old-ack']);
          assert.deepEqual(result.accepted.map((input: any) => input.data), ['before-old-ack', 'after-old-ack']);
          assert.equal(result.inputs[0].epoch, result.inputs[1].epoch, 'the replacement lease remains intact');
          assert.equal(result.acquires, 2, 'a late old ACK must not require another acquisition');
          assert.deepEqual(result.errors, []);
          assert.deepEqual(result.violations, []);
        }));
      }
      for (const outcome of ['rejection', 'success'] as const) {
        await t.test(`an old acquisition frame ACK ${outcome} cannot clear the replacement lease after reconnect`, async () => fixture(async page => {
          const acquiring = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.equal(acquiring.acquires, 1);
          assert.deepEqual(acquiring.inputs, []);
          await expect(page.getByText('여기서 제어 중', { exact: true })).toHaveCount(0);
          await page.evaluate(() => {
            const h = (window as any).inputQueueTest;
            h.holdAck = false;
            h.disconnect();
            h.reconnect();
            h.autoAccept = true;
          });
          await page.waitForFunction(() => (window as any).inputQueueTest.result().acquires === 2);
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          await page.evaluate(() => (window as any).inputQueueTest.input(['before-old-acquisition-ack']));
          await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 1);
          await page.evaluate(result => {
            const h = (window as any).inputQueueTest;
            if (result === 'rejection') h.rejectAck();
            else h.releaseAck();
          }, outcome);
          await page.waitForFunction(() => (window as any).inputQueueTest.settledHeldAcks === 1);
          await expect(page.getByText('여기서 제어 중', { exact: true })).toBeVisible();
          assert.equal(await page.evaluate(() => (window as any).inputQueueTest.terminal.options.disableStdin), false);
          // This catches the old acquireControl continuation, separately from
          // drain's stale ACK handler: resolving its frame waiter must not
          // clear epoch/connection refs belonging to the replacement effect.
          await page.evaluate(() => (window as any).inputQueueTest.input(['after-old-acquisition-ack']));
          await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 2);
          const result = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.deepEqual(result.inputs.map((input: any) => input.data), ['before-old-acquisition-ack', 'after-old-acquisition-ack']);
          assert.deepEqual(result.accepted.map((input: any) => input.data), ['before-old-acquisition-ack', 'after-old-acquisition-ack']);
          assert.equal(result.inputs[0].epoch, result.inputs[1].epoch);
          assert.equal(result.acquires, 2);
          assert.deepEqual(result.errors, []);
          assert.deepEqual(result.violations, []);
        }, { holdFirstAcquireAck: true }));
      }
      for (const failure of ['frame ACK', 'resize'] as const) {
        await t.test(`${failure} failure with an empty queue stays read-only until explicit recovery`, async () => fixture(async page => {
          await page.evaluate(kind => {
            const h = (window as any).inputQueueTest;
            if (kind === 'frame ACK') {
              h.failNextAck = true;
              h.emitFrame();
            } else {
              h.failNextResize = true;
              document.getElementById('root')!.style.width = '650px';
            }
          }, failure);
          const recover = page.getByRole('button', { name: '제어 다시 시도', exact: true });
          await recover.waitFor();
          assert.equal(await page.evaluate(() => (window as any).inputQueueTest.terminal.options.disableStdin), true);
          // A healthy later snapshot may refresh the screen, but cannot
          // resurrect the abandoned lease with no working input queue.
          const seq = await page.evaluate(() => (window as any).inputQueueTest.emitFrame());
          await page.waitForFunction(expected => (window as any).inputQueueTest.ackedSeq >= expected, seq);
          await expect(recover).toBeVisible();
          await expect(page.getByText('여기서 제어 중', { exact: true })).toHaveCount(0);
          assert.equal(await page.evaluate(() => (window as any).inputQueueTest.terminal.options.disableStdin), true);
          await page.evaluate(() => {
            const h = (window as any).inputQueueTest;
            h.input(['blocked-native-input']);
            h.actions.key('blocked-toolbar-input');
          });
          const blocked = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.deepEqual(blocked.inputs, [], 'read-only keystrokes cannot be sent or buffered for replay');
          assert.equal(blocked.acquires, 1, 'ordinary input must not silently recover the failed queue');
          await page.evaluate(() => { (window as any).inputQueueTest.autoAccept = true; });
          await recover.click();
          await page.getByText('여기서 제어 중', { exact: true }).waitFor();
          assert.equal(await page.evaluate(() => (window as any).inputQueueTest.terminal.options.disableStdin), false);
          await page.evaluate(() => (window as any).inputQueueTest.input(['fresh-after-frame-recovery']));
          await page.waitForFunction(() => (window as any).inputQueueTest.accepted.length === 1);
          const result = await page.evaluate(() => (window as any).inputQueueTest.result());
          assert.deepEqual(result.inputs.map((input: any) => input.data), ['fresh-after-frame-recovery']);
          assert.deepEqual(result.accepted.map((input: any) => input.data), ['fresh-after-frame-recovery']);
          assert.equal(result.acquires, 2);
          assert.deepEqual(result.errors, failure === 'resize' ? ['Resize request failed'] : []);
          assert.deepEqual(result.violations, []);
        }));
      }
      await t.test('resize waits for older input and buffers new input until the resized frame ACK', async () => fixture(async page => {
        const expected = 'before-0before-1during-waitduring-ack';
        await page.evaluate(() => {
          const h = (window as any).inputQueueTest;
          h.input(['before-0', 'before-1']);
          h.holdAck = true;
          document.getElementById('root')!.style.width = '650px';
        });
        // Let the real ResizeObserver's 120 ms debounce enter resize while
        // the first acceptance is held. This is the only time-based trigger.
        await page.waitForTimeout(220);
        const waiting = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.equal(waiting.resizes, 0, 'resize cannot invalidate the lease before older inputs are accepted');
        assert.equal(waiting.inputs.length, 1);
        await page.evaluate(() => {
          const h = (window as any).inputQueueTest;
          h.input(['during-wait']);
          h.release();
        });
        await page.waitForFunction(() => typeof (window as any).inputQueueTest.pendingAck === 'function');
        const pendingAck = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.equal(pendingAck.resizes, 1);
        // Only the request already sent must be accepted before resizing.
        // Locally queued input stays paused, preserving FIFO after the ACK.
        assert.equal(pendingAck.accepted.map((input: any) => input.data).join(''), 'before-0');
        assert.deepEqual(pendingAck.violations, []);
        await page.evaluate(() => (window as any).inputQueueTest.input(['during-ack']));
        const afterInput = await page.evaluate(() => (window as any).inputQueueTest.result());
        assert.equal(afterInput.inputs.length, pendingAck.inputs.length, 'input stays local while host is waiting for resize ACK');
        await page.evaluate(() => (window as any).inputQueueTest.releaseAck());
        await page.waitForFunction(value => (window as any).inputQueueTest.accepted.map((input: any) => input.data).join('') === value, expected);
        const result = await page.evaluate(() => (window as any).inputQueueTest.result());
        const resizeIndex = result.events.indexOf('resize');
        const ackIndex = result.events.indexOf('ack', resizeIndex);
        assert.ok(resizeIndex >= 0 && ackIndex > resizeIndex);
        assert.deepEqual(result.events.slice(resizeIndex + 1, ackIndex), [], 'no input request occurs inside the host ACK barrier');
        assert.equal(result.inputs.map((input: any) => input.data).join(''), expected);
        assert.equal(result.accepted.map((input: any) => input.data).join(''), expected);
        assert.equal(result.maxActive, 1);
        assert.equal(result.acquires, 1);
        assert.equal(new Set(result.inputs.map((input: any) => input.epoch)).size, 1);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.violations, []);
      }));
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
