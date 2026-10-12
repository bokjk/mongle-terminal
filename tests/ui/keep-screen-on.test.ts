import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { holdScreenAwake } from '../../apps/web/src/use-screen-wake-lock';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const options = { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000 };

test('a screen lock that arrives after it was given up is released at once', async () => {
  const events: string[] = [];
  let grant!: () => void;
  const source = { request: () => new Promise<{ release(): Promise<void> }>(resolve => { grant = () => resolve({ release: async () => { events.push('release'); } }); }) };
  const stop = holdScreenAwake(source);
  stop();
  grant();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, ['release']);
  const refused = holdScreenAwake({ request: () => Promise.reject(new Error('NotAllowedError')) });
  await new Promise(resolve => setTimeout(resolve, 0));
  refused();
});

// Records the page's wake lock requests instead of asking a headless browser for a real screen lock.
const fakeWakeLock = `
  window.wakeEvents=[];
  Object.defineProperty(navigator,'wakeLock',{configurable:true,value:{request:async type=>{window.wakeEvents.push('request:'+type);return {release:async()=>{window.wakeEvents.push('release');}};}}});
  let hidden=false;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
  window.setHidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'));};
`;

async function withPage(source: string, init: string, run: (page: Page, errors: string[]) => Promise<void>) {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'error' });
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0]!.contents); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name=function(fn){return fn;};' + init);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await run(page, errors);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function appSource() {
  const engine = new TerminalEngine({ cols: 40, rows: 20, onResponse() {} });
  const snapshot = await engine.snapshot(); await engine.dispose();
  return `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {App} from './apps/web/src/App';
    const listeners=new Set();let seq=0;
    const info={id:'terminal',groupId:'group',title:'모바일',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:20};
    const state=()=>({hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.1.0',protocolVersion:1,capabilities:[],groups:[{id:'group',name:'모바일 그룹',cwd:'C:/test',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}}],terminals:[info],profiles:[],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}});
    const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}});
    const request=async(method)=>{if(method==='state.get')return state();if(method==='terminals.attach')return frame();if(method==='terminal.ack')return {acknowledged:true};return {ok:true};};
    window.mongle={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{fn({status:'connected',owner:false});return()=>{};},listHosts:async()=>[],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>{}};
    createRoot(document.getElementById('root')).render(<App/>);
  `;
}

const events = (page: Page) => page.evaluate(() => [...(window as any).wakeEvents]);

test('keep screen on is off until chosen, then holds the screen only while the app is visible', options, async () => {
  const source = await appSource();
  await withPage(source, fakeWakeLock, async (page, errors) => {
    await page.locator('.mobile-keys').waitFor();
    await page.waitForTimeout(200);
    assert.deepEqual(await events(page), [], 'nothing is held by default');
    assert.deepEqual(errors, []);
  });
  await withPage(source, fakeWakeLock + "localStorage.setItem('mongle.keepScreenOn','true');", async (page, errors) => {
    await page.locator('.mobile-keys').waitFor();
    await page.waitForFunction(() => (window as any).wakeEvents.length === 1);
    assert.deepEqual(await events(page), ['request:screen']);
    await page.evaluate(() => (window as any).setHidden(true));
    await page.waitForFunction(() => (window as any).wakeEvents.length === 2);
    await page.evaluate(() => (window as any).setHidden(false));
    await page.waitForFunction(() => (window as any).wakeEvents.length === 3);
    assert.deepEqual(await events(page), ['request:screen', 'release', 'request:screen'], 'hidden releases, visible asks again');
    assert.deepEqual(errors, []);
  });
});

test('the keep screen on setting can be turned on only where the browser can hold the screen', options, async () => {
  const source = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Settings} from './apps/web/src/Settings';
    const state={hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.1.0',protocolVersion:1,capabilities:[],groups:[],terminals:[],profiles:[],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}};
    const client={request:async()=>({}),subscribe:()=>()=>{}};
    function Harness(){const [on,setOn]=useState(false);window.keepOn=on;return <Settings client={client} state={state} owner={true} theme='dark' fontSize={14} scrollSpeed={0.5} onScrollSpeed={()=>{}} keepScreenOn={on} onKeepScreenOn={setOn} onTheme={()=>{}} onFontSize={()=>{}} onClose={()=>{}} onError={()=>{}}/>;}
    createRoot(document.getElementById('root')).render(<Harness/>);
  `;
  await withPage(source, fakeWakeLock, async (page, errors) => {
    const box = page.getByLabel('몽글터미널을 보는 동안 화면 켜 두기', { exact: false });
    assert.equal(await box.isDisabled(), false);
    await box.check();
    assert.equal(await page.evaluate(() => (window as any).keepOn), true);
    assert.deepEqual(errors, []);
  });
  await withPage(source, "Object.defineProperty(Navigator.prototype,'wakeLock',{configurable:true,get:()=>undefined});delete Navigator.prototype.wakeLock;", async page => {
    const box = page.getByLabel('몽글터미널을 보는 동안 화면 켜 두기', { exact: false });
    assert.equal(await box.isDisabled(), true);
    await page.getByText('이 브라우저에서는 사용할 수 없습니다.', { exact: false }).waitFor();
  });
});

