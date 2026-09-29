import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { HostCore } from '../../packages/host/core.js';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol/index.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const root = fileURLToPath(new URL('../../', import.meta.url));

async function serve(source: string) {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else if (request.url === '/' || request.url?.startsWith('/?')) { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test('restored split panes keep their own background lease when acquire replies overtake the host state events', {
  skip: chrome ? false : 'Requires Windows and installed Chrome.', timeout: 120_000,
}, async t => {
  const isolatedRoot = path.resolve('.test-data/restore-control');
  await mkdir(isolatedRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(isolatedRoot, 'host-'));
  let host = new HostCore({ dataDir, name: '복원 제어 검증 PC' });
  let browser: Browser | undefined, site: Awaited<ReturnType<typeof serve>> | undefined;
  const desktop: ConnectionContext = { id: randomUUID(), deviceId: 'local-owner', deviceName: '현재 컴퓨터', owner: true };
  t.after(async () => {
    host.disconnect(desktop.id);
    await browser?.close(); await host.close(); await site?.close();
    assert.ok(path.resolve(dataDir).startsWith(isolatedRoot + path.sep), 'Only this test data directory may be removed');
    await rm(dataDir, { recursive: true, force: true });
  });
  await host.init();
  const setup: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: '검증 준비', owner: true };
  host.connect(setup, () => {});
  const profile = host.getState().profiles.find(item => item.kind === 'powershell');
  assert.ok(profile, 'This regression requires actual PowerShell');
  const groupId = host.getState().groups[0].id;
  const first: TerminalInfo = await host.handle('terminals.create', { groupId, profileId: profile.id, cwd: dataDir }, setup);
  await host.handle('terminals.create', { groupId, splitTarget: first.id, axis: 'horizontal' }, setup);
  // Full exit: durable checkpoint and stopped shells, then a new boot restores both into fresh shells.
  await host.handle('host.shutdown', {}, setup); await host.close();
  host = new HostCore({ dataDir, name: '복원 제어 검증 PC' }); await host.init();
  const restored = host.getState().terminals;
  assert.equal(restored.length, 2); assert.ok(restored.every(info => info.status === 'running' && info.pid));

  site = await serve("import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './apps/web/src/App';createRoot(document.getElementById('root')).render(<App/>);");
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls: Array<{ method: string; params: any }> = [];
  // Electron answers ipcMain.handle requests and pushes webContents.send events on
  // separate channels, so a reply can reach the renderer before state events the
  // host broadcast ahead of it. Reproduce that order for every acquisition.
  let holding = 0, delivery = Promise.resolve();
  const held: unknown[] = [];
  const deliver = (event: unknown) => { delivery = delivery.then(() => page.evaluate(value => { for (const listener of (window as any).__hostListeners || []) listener(value); }, event)).catch(() => {}); };
  await page.exposeBinding('hostRequest', async (_source, method: string, params: any) => {
    calls.push({ method, params });
    if (method !== 'control.acquire') return host.handle(method, params, desktop);
    holding++;
    try { return await host.handle(method, params, desktop); }
    finally { setTimeout(() => { if (--holding === 0) for (const event of held.splice(0)) deliver(event); }, 200); }
  });
  await page.addInitScript('window.__name = function (fn) { return fn; };');
  await page.addInitScript(connectionId => {
    const listeners = new Set<any>();
    (window as any).__hostListeners = listeners;
    (window as any).mongle = {
      request: (method: string, params: unknown) => (window as any).hostRequest(method, params),
      subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
      onConnection: (fn: any) => { fn({ status: 'connected', owner: true, connectionId }); return () => {}; },
      listHosts: async () => [{ id: 'local', name: '이 PC', local: true, selected: true }],
      addHost: async () => {}, removeHost: async () => {},
      selectHost: async () => ({ status: 'connected', owner: true, connectionId }),
    };
  }, desktop.id);
  host.connect(desktop, event => { if (holding) held.push(event); else deliver(event); });
  await page.goto(site.url);
  await expect(page.locator('.pane')).toHaveCount(2);
  const pane = (id: string) => page.locator(`.pane[data-terminal-id="${id}"]`);
  for (const info of restored) await expect(pane(info.id).locator('.control-chip')).toHaveText('여기서 제어 중', { timeout: 15_000 });
  // The late snapshots (the grant, and the one sent before it) must not undo either lease.
  await expect.poll(() => holding === 0 && held.length === 0).toBe(true);
  await delivery; await settle(page);
  for (const info of restored) {
    await expect(pane(info.id).locator('.control-chip')).toHaveText('여기서 제어 중');
    const controller = host.getState().terminals.find(item => item.id === info.id)!.controller;
    assert.equal(controller?.connectionId, desktop.id);
    assert.equal(controller?.ready, true, 'The pane ACKed its acquisition frame, so the host keeps sending it new frames');
  }
  const acquisitions = calls.filter(call => call.method === 'control.acquire');
  assert.equal(acquisitions.length, 2);
  assert.ok(acquisitions.every(call => call.params.takeover === false), 'Restoring only takes free terminals');
  // The second pane is the one the packaged app left blank. New output reaches it.
  const second = restored.find(info => info.id !== first.id)!;
  const rows = pane(second.id).locator('.xterm-rows');
  await pane(second.id).locator('.xterm-screen').click();
  await page.keyboard.insertText("Write-Output ('RESTORED_' + 'PANE_OUTPUT')"); await page.keyboard.press('Enter');
  await expect.poll(() => rows.textContent(), { timeout: 15_000 }).toContain('RESTORED_PANE_OUTPUT');
  assert.equal(calls.filter(call => call.method === 'control.acquire').length, 2, 'The click used the existing lease');
  assert.deepEqual(errors, []);
});

test('a pane acknowledges every host frame and leaves no orphan lease behind', {
  skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 120_000,
}, async t => {
  const engine = new TerminalEngine({ cols: 60, rows: 16, onResponse() {} });
  await engine.write(Array.from({ length: 30 }, (_, index) => `Restored line ${index}\r\n`).join(''));
  const snapshot = await engine.snapshot(); await engine.dispose();
  const site = await serve(`
    import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './apps/web/src/App';
    const listeners=new Set(),scenario=new URLSearchParams(location.search).get('scenario');let seq=0,epoch=0;
    let info={id:'terminal',groupId:'group',title:'복원 셸',profileId:'pwsh',cwd:'C:/restore',generation:'generation',status:'running',cols:60,rows:16};
    if(scenario==='own')info.controller={connectionId:'desk',deviceName:'현재 컴퓨터',epoch:++epoch,ready:false};
    const groups=[{id:'group',name:'복원 그룹',cwd:'C:/restore',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}},{id:'empty',name:'빈 그룹',cwd:'C:/restore',profileId:'pwsh',revision:0,layout:null}];
    const state=()=>({hostId:'host',bootId:'boot',name:'복원 PC',version:'0.3.0',protocolVersion:1,capabilities:['control.acquire-if-free'],groups,terminals:[info],profiles:[],settings:{name:'복원 PC',recordHistory:true,scrollback:5000}});
    const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}});
    const emit=()=>listeners.forEach(fn=>fn({type:'state',state:state()}));
    const phone=()=>{info={...info,controller:{connectionId:'phone',deviceName:'휴대폰',epoch:++epoch,ready:true}};emit();};
    const h=window.restoreTest={calls:[],holdAttachAck:scenario==='unmount',releaseAttachAck:null};
    const request=async(method,params)=>{
      h.calls.push({method,params});
      if(method==='state.get')return state();
      if(method==='terminals.attach')return frame();
      if(method==='terminal.ack'&&h.holdAttachAck&&params.epoch===undefined){h.holdAttachAck=false;return new Promise(resolve=>h.releaseAttachAck=()=>resolve({acknowledged:true}));}
      if(method==='control.acquire'){
        if(params.takeover===false&&info.controller&&info.controller.connectionId!=='desk')throw Object.assign(Error('다른 기기에서 제어 중입니다.'),{code:'CONTROL_BUSY'});
        info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'desk',deviceName:'현재 컴퓨터',epoch:++epoch,ready:false}};
        const result={epoch,connectionId:'desk',frame:frame()};h.acquireFrameSeq=result.frame.seq;
        // The host broadcasts each grant before replying; 'stale' adds a newer phone lease.
        emit();if(scenario==='stale')phone();
        return result;
      }
      if(method==='terminal.resize'){
        const result={frame:frame()};h.resizeFrameSeq=result.frame.seq;
        if(scenario==='resize-loss')phone();else{info={...info,cols:params.cols,rows:params.rows};emit();}
        return result;
      }
      return {ok:true};
    };
    window.mongle={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{fn({status:'connected',owner:true,connectionId:'desk'});return()=>{};},listHosts:async()=>[{id:'local',name:'이 PC',local:true,selected:true}],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>({status:'connected',owner:true,connectionId:'desk'})};
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors: string[] = [];
  t.after(async () => { await browser.close(); await site.close(); });
  const open = async (scenario: string) => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = function (fn) { return fn; };');
    await page.goto(`${site.url}?scenario=${scenario}`);
    await page.waitForFunction(() => (window as any).restoreTest.calls.some((call: any) => call.method === 'terminal.ack'));
    return page;
  };
  const calls = (page: Page, method: string) => page.evaluate(name => (window as any).restoreTest.calls.filter((call: any) => call.method === name).map((call: any) => call.params), method);
  const acked = (page: Page, key: 'acquireFrameSeq' | 'resizeFrameSeq') => page.waitForFunction(name => { const h = (window as any).restoreTest; return h[name] !== undefined && h.calls.some((call: any) => call.method === 'terminal.ack' && call.params.seq >= h[name] && call.params.epoch === undefined); }, key);
  const chip = (page: Page) => page.locator('.pane .control-chip');

  await t.test('a grant replaced before its reply arrives is shown and acknowledged as a viewer', async () => {
    const page = await open('stale');
    try {
      await expect(chip(page)).toHaveText('휴대폰에서 제어 · 가져오기');
      await acked(page, 'acquireFrameSeq');
      await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.insertText('DROP'); await settle(page);
      assert.deepEqual(await calls(page, 'terminal.input'), [], 'A replaced grant never sends input');
      assert.deepEqual((await calls(page, 'control.acquire')).map((params: any) => params.takeover), [false]);
    } finally { await page.close(); }
  });
  await t.test('a pane unmounted while its first frame is acknowledged never acquires after its detach', async () => {
    const page = await open('unmount');
    try {
      await page.waitForFunction(() => Boolean((window as any).restoreTest.releaseAttachAck));
      await page.locator('.group-main', { hasText: '빈 그룹' }).click();
      await expect(page.locator('.pane')).toHaveCount(0);
      await page.waitForFunction(() => (window as any).restoreTest.calls.some((call: any) => call.method === 'terminals.detach'));
      await page.evaluate(() => (window as any).restoreTest.releaseAttachAck());
      await page.waitForTimeout(300); await settle(page);
      assert.deepEqual(await calls(page, 'control.acquire'), [], 'A disposed pane would leave this connection an orphan lease');
    } finally { await page.close(); }
  });
  await t.test('a leftover lease of this same window is re-acquired in the background and never shown as another device', async () => {
    const page = await open('own');
    try {
      await expect(chip(page)).toHaveText('여기서 제어 중');
      assert.deepEqual((await calls(page, 'control.acquire')).map((params: any) => params.takeover), [false], 'Only the conditional acquisition is used');
    } finally { await page.close(); }
  });
  await t.test('a resize reply that arrives after the lease moved is still acknowledged', async () => {
    const page = await open('resize-loss');
    try {
      await expect(chip(page)).toHaveText('여기서 제어 중');
      await page.setViewportSize({ width: 900, height: 700 });
      await acked(page, 'resizeFrameSeq');
      await expect(chip(page)).toHaveText('휴대폰에서 제어 · 가져오기');
    } finally { await page.close(); }
  });
  assert.deepEqual(errors, []);
});
