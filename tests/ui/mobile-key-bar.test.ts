import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const options = { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000 };

async function withPage(source: string, run: (page: Page, errors: string[]) => Promise<void>, viewport = { width: 390, height: 844 }) {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0]!.contents); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true }); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name=function(fn){return fn;};');
    (page as any).appUrl = `http://127.0.0.1:${address.port}`;
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
    const listeners=new Set();let seq=0;let epoch=0;
    let info={id:'terminal',groupId:'group',title:'모바일',profileId:'pwsh',cwd:'C:/test',generation:'generation',status:'running',cols:40,rows:20};
    const state=()=>({hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.1.0',protocolVersion:1,capabilities:['control.acquire-if-free'],groups:[{id:'group',name:'모바일 그룹',cwd:'C:/test',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}}],terminals:[info],profiles:[],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}});
    const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}});
    const emitState=()=>listeners.forEach(fn=>fn({type:'state',state:state()}));
    const h=window.keyBarTest={calls:[]};
    const request=async(method,params)=>{
      h.calls.push({method,params});
      if(method==='state.get')return state();
      if(method==='terminals.attach')return frame();
      if(method==='control.acquire'){info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'mobile',deviceName:'휴대폰',epoch:++epoch,ready:true}};emitState();return {epoch,connectionId:'mobile',frame:frame()};}
      if(method==='terminal.resize'){info={...info,cols:params.cols,rows:params.rows};emitState();return {frame:frame()};}
      if(method==='terminal.ack')return {acknowledged:true};
      return {ok:true};
    };
    window.mongle={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{fn({status:'connected',owner:false});return()=>{};},listHosts:async()=>[],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>{}};
    createRoot(document.getElementById('root')).render(<App/>);
  `;
}

const barNames = (page: Page) => page.locator('.mobile-keys button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') ?? button.textContent));
const overflow = (page: Page) => page.locator('.mobile-keys-list').evaluate(list => list.scrollWidth - list.clientWidth);
const sent = (page: Page) => page.evaluate(() => (window as any).keyBarTest.calls.filter((call: any) => call.method === 'terminal.input').map((call: any) => call.params.data).join(''));

test('the phone key bar keeps its default keys and fits narrow phones until someone edits it', options, async () => {
  const source = await appSource();
  for (const width of [390, 320]) await withPage(source, async (page, errors) => {
    await page.goto((page as any).appUrl);
    await page.locator('.mobile-keys').waitFor();
    assert.deepEqual(await barNames(page), ['Esc', 'Tab', 'Ctrl', 'Alt', 'Ctrl+C', '왼쪽', '아래', '위', '오른쪽', '키보드 열기']);
    assert.ok(await overflow(page) <= 0, `the default bar fits at ${width}px without scrolling`);
    assert.deepEqual(errors, []);
  }, { width, height: 760 });
});

test('a saved key bar is shown in its order, sends each key, and scrolls sideways when long', options, async () => {
  const source = await appSource();
  await withPage(source, async (page, errors) => {
    await page.addInitScript(() => localStorage.setItem('mongle.keyBar', JSON.stringify(['home', 'pipe', 'esc', 'end', 'page-up', 'enter', 'removed-key'])));
    await page.goto((page as any).appUrl);
    await page.locator('.mobile-keys').waitFor();
    assert.deepEqual(await barNames(page), ['Home', '세로 막대', 'Esc', 'End', 'PgUp', 'Enter', '키보드 열기'], 'unknown saved keys are dropped');
    await page.getByRole('button', { name: '키보드 열기', exact: true }).tap();
    await page.getByText('여기서 제어 중', { exact: true }).waitFor();
    for (const name of ['Home', '세로 막대', 'End', 'PgUp', 'Enter']) await page.getByRole('button', { name, exact: true }).tap();
    await page.waitForFunction(() => (window as any).keyBarTest.calls.filter((call: any) => call.method === 'terminal.input').length >= 5);
    assert.equal(await sent(page), '\x1b[H|\x1b[F\x1b[5~\r');
    assert.deepEqual(errors, []);
  });
  await withPage(source, async page => {
    await page.addInitScript(() => localStorage.setItem('mongle.keyBar', JSON.stringify(['esc', 'tab', 'shift-tab', 'ctrl', 'alt', 'ctrl-c', 'ctrl-d', 'ctrl-z', 'ctrl-l', 'ctrl-r', 'left', 'down', 'up', 'right', 'home', 'end'])));
    await page.goto((page as any).appUrl);
    await page.locator('.mobile-keys').waitFor();
    assert.ok(await overflow(page) > 0, 'sixteen keys scroll sideways');
    const keyboard = await page.getByRole('button', { name: '키보드 열기', exact: true }).boundingBox();
    assert.ok(keyboard && keyboard.x + keyboard.width <= 390 && keyboard.width >= 30, 'the keyboard button stays on screen at its full size');
  }, { width: 390, height: 760 });
});

test('removing a latched Ctrl from the bar also turns it off, so later typing is plain', options, async () => {
  const source = await appSource();
  await withPage(source, async (page, errors) => {
    await page.goto((page as any).appUrl);
    await page.getByRole('button', { name: '키보드 열기', exact: true }).tap();
    await page.getByText('여기서 제어 중', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Ctrl', exact: true }).tap();
    assert.equal(await page.getByRole('button', { name: 'Ctrl', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.locator('button.icon-button[aria-label="설정"]').click();
    await page.getByRole('button', { name: 'Ctrl (다음 키와 함께) 빼기', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ctrl (다음 키와 함께) 빼기', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Ctrl', exact: true }).count(), 0);
    await page.getByRole('button', { name: '키보드 열기', exact: true }).tap();
    await page.keyboard.type('c');
    await page.waitForFunction(() => (window as any).keyBarTest.calls.some((call: any) => call.method === 'terminal.input'));
    assert.equal(await sent(page), 'c', 'no hidden Ctrl turns c into Ctrl+C');
    assert.deepEqual(errors, []);
  });
});


test('the key bar editor adds, removes, reorders and resets keys and keeps focus on the edited row', options, async () => {
  const source = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {KeyBarSettings} from './apps/web/src/KeyBarSettings';
    function Harness(){const [ids,setIds]=useState(['esc','tab','ctrl']);window.keyBarIds=ids;return <KeyBarSettings ids={ids} onChange={setIds}/>;}
    createRoot(document.getElementById('root')).render(<Harness/>);
  `;
  await withPage(source, async (page, errors) => {
    await page.goto((page as any).appUrl);
    const ids = () => page.evaluate(() => (window as any).keyBarIds);
    const focused = async (label: string) => { try { await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, label, { timeout: 2000 }); return label; } catch { return page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName); } };
    await page.getByRole('button', { name: 'Tab 빼기', exact: true }).click();
    assert.deepEqual(await ids(), ['esc', 'ctrl']);
    assert.equal(await focused('Ctrl (다음 키와 함께) 빼기'), 'Ctrl (다음 키와 함께) 빼기', 'focus moves to the row that took its place');
    await page.getByRole('button', { name: 'Home 추가', exact: true }).click();
    assert.deepEqual(await ids(), ['esc', 'ctrl', 'home']);
    assert.equal(await focused('Home 빼기'), 'Home 빼기', 'focus follows the added key into the list');
    await page.getByRole('button', { name: 'Home 앞으로', exact: true }).click();
    await page.getByRole('button', { name: 'Home 앞으로', exact: true }).click();
    assert.deepEqual(await ids(), ['home', 'esc', 'ctrl']);
    assert.equal(await focused('Home 뒤로'), 'Home 뒤로', 'at the front the other move button takes focus');
    assert.deepEqual(await page.locator('.key-bar-preview .key-button').allTextContents(), ['Home', 'Esc', 'Ctrl']);
    await page.getByRole('button', { name: 'Ctrl (다음 키와 함께) 빼기', exact: true }).click();
    await page.getByRole('button', { name: 'Esc 빼기', exact: true }).click();
    await page.getByRole('button', { name: 'Home 빼기', exact: true }).click();
    assert.deepEqual(await ids(), []);
    assert.equal(await focused('Home 추가'), 'Home 추가', 'removing the last key focuses its add button');
    await page.getByRole('button', { name: '기본값으로 되돌리기', exact: true }).click();
    assert.deepEqual(await ids(), ['esc', 'tab', 'ctrl', 'alt', 'ctrl-c', 'left', 'down', 'up', 'right']);
    assert.equal(await page.getByRole('button', { name: '기본값으로 되돌리기', exact: true }).isDisabled(), true);
    for (const name of ['Shift+Tab', 'Ctrl+D', 'Ctrl+Z', 'Ctrl+L', 'Ctrl+R', 'Home', 'End']) await page.getByRole('button', { name: `${name} 추가`, exact: true }).click();
    assert.equal((await ids()).length, 16);
    assert.equal(await page.getByRole('button', { name: 'Page Up 추가', exact: true }).isDisabled(), true, 'a full bar disables adding');
    await page.getByText('최대 16개까지 넣을 수 있습니다.', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  });
});
