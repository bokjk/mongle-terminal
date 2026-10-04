import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect, type Page } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test('actual App explorer cancels obsolete queued reads while preserving the two-read budget and current UI', {
  skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 90_000,
}, async t => {
  // Exercise the current App and its real React/xterm components. Only the host
  // bridge is synthetic: delayed replies are released explicitly, never by timing.
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {App} from './apps/web/src/App';
    const listeners=new Set();
    const terminals=['a','b'].map(id=>({id,groupId:'group',title:'터미널 '+id.toUpperCase(),profileId:'cmd',cwd:'C:\\\\Fixture\\\\'+id,generation:'generation-'+id,status:'running',cols:80,rows:24}));
    const state={hostId:'host',bootId:'boot',name:'읽기 대기열 검증 PC',version:'0.3.8',protocolVersion:1,capabilities:['files.read','git.read','layout.tabs'],groups:[{id:'group',name:'검증 작업',cwd:terminals[0].cwd,profileId:'cmd',revision:0,layout:{type:'leaf',terminalId:'a',tabs:['b']}}],terminals,profiles:[{id:'cmd',name:'CMD',kind:'cmd',executable:'cmd.exe',args:[]}],settings:{name:'읽기 대기열 검증 PC',recordHistory:false,scrollback:1000}};
    const entries=[...['first','second','obsolete'].map(name=>({name,path:name,kind:'directory'})),...['first.txt','second.txt','obsolete.txt','latest.txt'].map(name=>({name,path:name,kind:'file'}))];
    const calls=[],held=[];
    const fixture=window.fixture={state,calls,held,active:0,maximum:0,
      emit(){for(const listener of listeners)listener({type:'state',state:structuredClone(state)});},
      release(path,id){const item=held.find(item=>!item.released&&item.params.path===path&&(!id||item.params.id===id));if(!item)throw Error('No pending read: '+id+':'+path);item.released=true;item.resolve(item.result);},
      read(method,params){
        const call={method,params:structuredClone(params)};calls.push(call);fixture.maximum=Math.max(fixture.maximum,++fixture.active);
        let result;
        if(method==='git.status')result={state:'repository',root:params.root,repositoryRoot:params.root,branch:'fixture',detached:false,changes:[],truncated:false};
        else if(method==='files.list')result={root:params.root,path:params.path,absolutePath:params.root,entries:params.path?[{name:params.path+'-child.txt',path:params.path+'/child.txt',kind:'file'}]:entries,truncated:false};
        else result={path:params.path,absolutePath:params.root+'/'+params.path,text:params.id+' | '+params.root+' | '+params.path,truncated:false,encoding:'UTF-8'};
        const pending=method==='files.preview'||method==='files.list'&&params.path?new Promise(resolve=>held.push({...call,resolve,result,released:false})):Promise.resolve(result);
        return pending.finally(()=>fixture.active--);
      }
    };
    window.mongle={request(method,params){
      if(method==='state.get')return Promise.resolve(structuredClone(state));
      if(['files.list','files.preview','git.status'].includes(method))return fixture.read(method,params);
      if(method==='terminals.attach')return Promise.resolve({type:'snapshot',terminalId:params.id,generation:'generation-'+params.id,bootId:'boot',seq:0,snapshot:{kind:'presentation-v1',data:'Synthetic terminal '+params.id,cols:80,rows:24,modes:{},version:'6.0.0'}});
      if(['terminal.ack','terminals.detach','heartbeat'].includes(method))return Promise.resolve({ok:true});
      throw Error('Unexpected request: '+method);
    },subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},onConnection(listener){listener({status:'connected',owner:false,connectionId:'fixture'});return()=>{};},listHosts:async()=>[{id:'fixture',name:state.name,local:false,selected:true}]};
    localStorage.setItem('mongle.files.open','true');
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const pages: Page[] = [], errors: string[] = [];
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); pages.push(page);
    page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.getByRole('complementary', { name: '파일 탐색기' }).getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
    return page;
  };
  const explorer = (page: Page) => page.getByRole('complementary', { name: '파일 탐색기' });
  const editor = (page: Page) => page.getByRole('region', { name: '파일 편집기', exact: true });
  const content = (page: Page) => editor(page).locator('.document-body:not([hidden]) .cm-content');
  const click = (page: Page, name: string) => explorer(page).getByRole('button', { name, exact: true }).click();
  const release = async (page: Page, path: string, id?: string) => { await page.evaluate(({ path, id }) => (window as any).fixture.release(path, id), { path, id }); await settle(page); };
  const calls = (page: Page) => page.evaluate(() => (window as any).fixture.calls) as Promise<Array<{ method: string; params: { id: string; path?: string; root: string } }>>;
  const blockBoth = async (page: Page) => {
    await click(page, 'first'); await click(page, 'second');
    await page.waitForFunction(() => (window as any).fixture.active === 2);
  };
  const verifyBudget = async (page: Page) => {
    await settle(page);
    assert.equal(await page.evaluate(() => (window as any).fixture.maximum), 2, 'Old in-flight reads retain their slots across navigation');
    assert.equal(await page.evaluate(() => (window as any).fixture.active), 0, 'All fixture reads completed');
    await expect(explorer(page).getByRole('alert')).toHaveCount(0);
  };
  try {
    await t.test('collapsing a queued folder prevents its read from reaching the host', async () => {
      const page = await open(); await blockBoth(page);
      await click(page, 'obsolete'); await click(page, 'obsolete');
      await release(page, 'first');
      await expect(explorer(page).getByRole('button', { name: 'first-child.txt', exact: true })).toBeVisible();
      await release(page, 'second');
      assert.ok(!(await calls(page)).some(call => call.params.path === 'obsolete'));
      await click(page, 'latest.txt'); await release(page, 'latest.txt');
      await expect(content(page)).toContainText('latest.txt');
      await verifyBudget(page);
    });
    await t.test('independent file tabs share the read budget and late replies never replace the selected tab', async () => {
      const page = await open();
      await click(page, 'first.txt'); await click(page, 'second.txt');
      await page.waitForFunction(() => (window as any).fixture.active === 2);
      await click(page, 'obsolete.txt'); await click(page, 'latest.txt');
      await release(page, 'first.txt');
      await release(page, 'obsolete.txt');
      await page.waitForFunction(() => (window as any).fixture.held.some((item: any) => item.params.path === 'latest.txt'));
      await release(page, 'latest.txt');
      await expect(content(page)).toContainText('latest.txt');
      await release(page, 'second.txt');
      await expect(content(page)).toContainText('latest.txt');
      for (const name of ['first.txt', 'second.txt', 'obsolete.txt']) {
        await editor(page).getByRole('tab', { name, exact: true }).click();
        await expect(content(page)).toContainText(name);
      }
      assert.equal((await calls(page)).filter(call => call.method === 'files.preview').length, 4, 'Switching tabs reuses their loaded documents');
      await verifyBudget(page);
    });
    await t.test('hiding the editor preserves its queued document without reopening the panel on completion', async () => {
      const page = await open(); await blockBoth(page);
      await click(page, 'obsolete.txt');
      await editor(page).getByRole('button', { name: '편집기 숨기기', exact: true }).click();
      await release(page, 'first'); await release(page, 'obsolete.txt'); await release(page, 'second');
      await expect(editor(page)).toHaveCount(0);
      await click(page, 'obsolete.txt');
      await expect(content(page)).toContainText('obsolete.txt');
      await editor(page).getByRole('button', { name: 'obsolete.txt 닫기', exact: true }).click();
      await expect(editor(page)).toHaveCount(0);
      assert.equal((await calls(page)).filter(call => call.params.path === 'obsolete.txt').length, 1);
      await verifyBudget(page);
    });
    await t.test('a briefly selected terminal cancels both its queued root listing and Git status', async () => {
      const page = await open(); await blockBoth(page);
      await page.getByRole('tab', { name: '터미널 B', exact: true }).click();
      await expect(explorer(page).locator('.file-terminal-name')).toHaveText('터미널 B');
      await page.getByRole('tab', { name: '터미널 A', exact: true }).click();
      await expect(explorer(page).locator('.file-terminal-name')).toHaveText('터미널 A');
      await release(page, 'first', 'a'); await release(page, 'second', 'a');
      await expect(explorer(page).getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
      assert.ok(!(await calls(page)).some(call => call.params.id === 'b'), 'Neither obsolete root nor Git status may use a newly freed slot');
      await verifyBudget(page);
    });
    await t.test('closing and reopening the explorer keeps in-flight reads within the same shared budget', async () => {
      const page = await open(); await blockBoth(page);
      await click(page, 'obsolete'); await click(page, 'obsolete.txt');
      await click(page, '파일 탐색기 닫기');
      await expect(explorer(page)).toHaveCount(0);
      await page.getByRole('button', { name: '파일 탐색기', exact: true }).click();
      await expect(explorer(page)).toBeVisible();
      await settle(page);
      assert.equal(await page.evaluate(() => (window as any).fixture.active), 2);
      assert.equal(await explorer(page).getByRole('button', { name: 'latest.txt', exact: true }).count(), 0, 'Reopened reads must wait for a real slot');
      await release(page, 'first', 'a');
      await release(page, 'obsolete.txt', 'a');
      await expect(explorer(page).getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
      await click(page, 'latest.txt'); await release(page, 'latest.txt', 'a');
      await release(page, 'second', 'a');
      await expect(content(page)).toContainText('latest.txt');
      assert.ok(!(await calls(page)).some(call => call.params.path === 'obsolete'));
      await editor(page).getByRole('tab', { name: 'obsolete.txt', exact: true }).click();
      await expect(content(page)).toContainText('obsolete.txt');
      await verifyBudget(page);
    });
    for (const transition of ['terminal', 'cwd'] as const) await t.test(`${transition} change cancels the old tree queue while preserving independent document tabs`, async () => {
      const page = await open(); await blockBoth(page);
      await click(page, 'obsolete'); await click(page, 'obsolete.txt');
      const oldRoot = await explorer(page).locator('.file-root').innerText();
      if (transition === 'terminal') await page.getByRole('tab', { name: '터미널 B', exact: true }).click();
      else await page.evaluate(() => { const fixture = (window as any).fixture; fixture.state.terminals[0].currentCwd = fixture.state.terminals[0].cwd + '\\nested'; fixture.emit(); });
      await expect(explorer(page).locator('.file-root')).not.toHaveText(oldRoot);
      assert.equal(await page.evaluate(() => (window as any).fixture.active), 2);
      await release(page, 'first', 'a');
      await release(page, 'obsolete.txt', 'a');
      await expect(explorer(page).getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
      await click(page, 'latest.txt');
      await release(page, 'latest.txt', transition === 'terminal' ? 'b' : 'a');
      await expect(content(page)).toContainText('latest.txt');
      const latest = await content(page).innerText();
      assert.ok(latest.includes(await explorer(page).locator('.file-root').innerText()));
      await release(page, 'second', 'a');
      await expect(content(page)).toHaveText(latest);
      assert.ok(!(await calls(page)).some(call => call.params.path === 'obsolete'));
      await editor(page).getByRole('tab', { name: 'obsolete.txt', exact: true }).click();
      await expect(content(page)).toContainText(oldRoot);
      await expect(explorer(page).getByRole('button', { name: 'first-child.txt', exact: true })).toHaveCount(0);
      await expect(explorer(page).getByRole('button', { name: 'second-child.txt', exact: true })).toHaveCount(0);
      await verifyBudget(page);
    });
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(pages.map(page => page.close())); await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
