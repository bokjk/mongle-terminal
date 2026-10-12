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

async function appSource(capabilities: string[]) {
  const engine = new TerminalEngine({ cols: 80, rows: 20, onResponse() {} });
  const snapshot = await engine.snapshot(); await engine.dispose();
  return `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {App} from './apps/web/src/App';
    const listeners=new Set();let seq=0;let epoch=0;
    let info={id:'terminal',groupId:'group',title:'작업',profileId:'pwsh',cwd:'C:\\\\test',generation:'generation',status:'running',cols:80,rows:20};
    const state=()=>({hostId:'host',bootId:'boot',name:'테스트 PC',version:'0.1.0',protocolVersion:1,capabilities:${JSON.stringify(capabilities)},groups:[{id:'group',name:'그룹',cwd:'C:\\\\test',profileId:'pwsh',revision:1,layout:{type:'leaf',terminalId:'terminal'}}],terminals:[info],profiles:[{id:'pwsh',name:'PowerShell',executable:'pwsh.exe',args:[],kind:'powershell'}],settings:{name:'테스트 PC',recordHistory:true,scrollback:5000}});
    const frame=()=>({type:'snapshot',terminalId:info.id,generation:info.generation,bootId:'boot',seq:++seq,snapshot:{...${JSON.stringify(snapshot)},cols:info.cols,rows:info.rows}});
    const emitState=()=>listeners.forEach(fn=>fn({type:'state',state:state()}));
    const h=window.uploadTest={calls:[],files:{},holdChunk:false,pendingChunk:null};
    const request=async(method,params)=>{
      h.calls.push({method,params});
      if(method==='state.get')return state();
      if(method==='terminals.attach')return frame();
      if(method==='control.acquire'){info={...info,cols:params.cols,rows:params.rows,controller:{connectionId:'me',deviceName:'이 기기',epoch:++epoch,ready:true}};emitState();return {epoch,connectionId:'me',frame:frame()};}
      if(method==='terminal.resize'){info={...info,cols:params.cols,rows:params.rows};emitState();return {frame:frame()};}
      if(method==='terminal.ack')return {acknowledged:true};
      if(method==='files.upload.begin'){const id='00000000-0000-4000-8000-00000000000'+Object.keys(h.files).length;h.files[id]={name:params.name,size:params.size,data:''};return {uploadId:id,chunkBytes:4096,name:params.name};}
      if(method==='files.upload.chunk'){if(h.holdChunk)await new Promise(resolve=>{h.pendingChunk=resolve;});h.files[params.uploadId].data+=atob(params.dataBase64);return {received:h.files[params.uploadId].data.length};}
      if(method==='files.upload.finish'){const file=h.files[params.uploadId];return {path:'C:\\\\test\\\\.mongle-attachments\\\\20261012-153000-abcd1234-'+file.name,name:file.name};}
      return {ok:true};
    };
    window.mongle={request,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onConnection:fn=>{fn({status:'connected',owner:true});return()=>{};},listHosts:async()=>[],addHost:async()=>{},removeHost:async()=>{},selectHost:async()=>{}};
    createRoot(document.getElementById('root')).render(<App/>);
  `;
}

async function withApp(capabilities: string[], run: (page: Page, errors: string[]) => Promise<void>) {
  const bundle = await build({ stdin: { contents: await appSource(capabilities), loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'error' });
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name=function(fn){return fn;};');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator('.terminal-canvas').waitFor();
    await run(page, errors);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const typed = (page: Page) => page.evaluate(() => (window as any).uploadTest.calls.filter((call: any) => call.method === 'terminal.input').map((call: any) => call.params.data).join(''));
const calls = (page: Page, method: string) => page.evaluate(method => (window as any).uploadTest.calls.filter((call: any) => call.method === method).length, method);
const openMenu = async (page: Page) => { await page.locator('summary[aria-label="터미널 메뉴"]').click(); await page.locator('details.command-menu[open]').waitFor(); };

test('a chosen file is saved on the PC in chunks and its path is typed without Enter', options, async () => {
  await withApp(['control.acquire-if-free', 'files.upload'], async (page, errors) => {
    const content = 'x'.repeat(10000);
    await openMenu(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '파일 첨부…' }).click();
    await (await chooser).setFiles({ name: '화면.png', mimeType: 'image/png', buffer: Buffer.from(content) });
    const path = 'C:\\test\\.mongle-attachments\\20261012-153000-abcd1234-화면.png';
    await page.waitForFunction(expected => (window as any).uploadTest.calls.filter((call: any) => call.method === 'terminal.input').map((call: any) => call.params.data).join('') === expected, path + ' ');
    const stored = await page.evaluate(() => Object.values((window as any).uploadTest.files) as Array<{ name: string; data: string }>);
    assert.deepEqual(stored, [{ name: '화면.png', size: 10000, data: content }]);
    assert.equal(await calls(page, 'files.upload.chunk'), 3, '10000 bytes in 4096-byte chunks');
    assert.ok(!(await typed(page)).includes('\r'), 'nothing is sent with Enter');
    await page.getByText('파일을 PC에 저장하고 경로를 입력 줄에 넣었습니다.').waitFor();
    assert.deepEqual(errors, []);
  });
});

test('a pasted screenshot uploads like a chosen file, and cancelling leaves nothing typed', options, async () => {
  await withApp(['control.acquire-if-free', 'files.upload'], async (page, errors) => {
    const paste = (name: string) => page.locator('.terminal-canvas').evaluate((canvas, name) => {
      const data = new DataTransfer(); data.items.add(new File(['PNGDATA'], name, { type: 'image/png' }));
      canvas.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, name);
    await paste('clip.png');
    await page.waitForFunction(() => (window as any).uploadTest.calls.some((call: any) => call.method === 'terminal.input'));
    assert.equal(await typed(page), 'C:\\test\\.mongle-attachments\\20261012-153000-abcd1234-clip.png ');
    await page.evaluate(() => { (window as any).uploadTest.holdChunk = true; });
    await paste('second.png');
    await page.getByText('second.png 보내는 중 0%').waitFor();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.evaluate(() => (window as any).uploadTest.pendingChunk?.());
    await page.waitForFunction(() => (window as any).uploadTest.calls.some((call: any) => call.method === 'files.upload.cancel'));
    await page.getByText('second.png 보내는 중', { exact: false }).waitFor({ state: 'detached' });
    assert.equal(await typed(page), 'C:\\test\\.mongle-attachments\\20261012-153000-abcd1234-clip.png ', 'a cancelled file types nothing');
    assert.equal(await calls(page, 'files.upload.finish'), 1);
    assert.deepEqual(errors, []);
  });
});

test('a PC that cannot take files keeps the menu item disabled and a pasted image only explains why', options, async () => {
  await withApp(['control.acquire-if-free'], async page => {
    await openMenu(page);
    assert.equal(await page.getByRole('button', { name: '파일 첨부…' }).isDisabled(), true);
    assert.equal(await calls(page, 'files.upload.begin'), 0);
    await page.keyboard.press('Escape');
    await page.locator('.terminal-canvas').evaluate(canvas => { const data = new DataTransfer(); data.items.add(new File(['PNG'], 'clip.png', { type: 'image/png' })); canvas.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
    await page.getByText('이 컴퓨터의 몽글터미널을 업데이트하면 파일을 보낼 수 있습니다.').waitFor();
    assert.equal(await calls(page, 'files.upload.begin'), 0);
    assert.equal(await typed(page), '', 'no empty paste reaches the terminal either');
  });
});

