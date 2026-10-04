import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect, type Page } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('app ignores obsolete state replies and completed editors after newer user intent', { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000 }, async t => {
  // Bundle the actual App in memory so these ordering regressions do not depend
  // on a previously built dist tree or disturb another UI test using that tree.
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {App} from './apps/web/src/App';
    import {PRESENTATION_VERSION} from './packages/terminal/types';
    const listeners=new Set(),connections=new Set();
    const state={hostId:'host',bootId:'boot',name:'검증 PC',version:'0.3.8',protocolVersion:1,capabilities:[],groups:[
      {id:'a',name:'첫 작업',cwd:'C:\\\\Test',profileId:'pwsh',revision:0,layout:null},
      {id:'b',name:'다른 작업',cwd:'C:\\\\Test',profileId:'pwsh',revision:0,layout:null}
    ],terminals:[],profiles:[{id:'pwsh',name:'PowerShell',kind:'powershell'}],settings:{name:'검증 PC',recordHistory:true,scrollback:5000}};
    const terminal=(id,groupId)=>({id,groupId,title:id,profileId:'pwsh',cwd:'C:\\\\Test',generation:id+'-generation',status:'exited',cols:80,rows:24});
    if(new URLSearchParams(location.search).has('drag')){state.terminals.push(terminal('left','a'),terminal('right','a'));state.groups[0].layout={type:'split',axis:'horizontal',ratio:.5,first:{type:'leaf',terminalId:'left'},second:{type:'leaf',terminalId:'right'}};}
    const reads=[],creates=[],terminalCreates=[],adds=[],selections=[];
    const fixture=window.fixture={state,reads,creates,terminalCreates,adds,selections,holdReads:new URLSearchParams(location.search).has('hold'),
      emit(){const event={type:'state',state:structuredClone(state)};for(const listener of listeners)listener(event);},
      connect(){for(const listener of connections)listener({status:'connected',owner:true,connectionId:'connection'});},
      releaseRead(index){reads[index].resolve(reads[index].state);},
      releaseCreate(index){const item=creates[index],group={id:'created-'+index,name:item.params.name,cwd:'C:\\\\Test',profileId:'pwsh',revision:0,layout:null};state.groups.push(group);fixture.emit();item.resolve(group);},
      releaseTerminal(index){const item=terminalCreates[index],created=terminal('created-terminal-'+index,item.params.groupId),group=state.groups.find(group=>group.id===created.groupId);state.terminals.push(created);group.layout={type:'leaf',terminalId:created.id};group.revision++;fixture.emit();item.resolve(created);},
      releaseAdd(index){adds[index].resolve({id:'remote-'+index,name:adds[index].params.name,local:false,selected:false});}
    };
    window.mongle={
      request(method,params){
        if(method==='state.get')return fixture.holdReads?new Promise(resolve=>reads.push({resolve,state:structuredClone(state)})):Promise.resolve(structuredClone(state));
        if(method==='groups.create')return new Promise(resolve=>creates.push({resolve,params}));
        if(method==='terminals.create')return new Promise(resolve=>terminalCreates.push({resolve,params}));
        if(method==='groups.layout'){const group=state.groups.find(group=>group.id===params.id);group.layout=params.layout;group.revision++;fixture.emit();fixture.holdReads=true;return Promise.resolve(group);}
        if(method==='terminals.attach')return Promise.resolve({terminalId:params.id,bootId:state.bootId,generation:params.generation,seq:0,snapshot:{kind:'presentation-v1',version:PRESENTATION_VERSION,data:'',cols:80,rows:24,modes:{applicationCursorKeysMode:false,applicationKeypadMode:false,bracketedPasteMode:false,insertMode:false,originMode:false,reverseWraparoundMode:false,sendFocusMode:false,wraparoundMode:true,mouseTrackingMode:'none',mouseEncoding:'DEFAULT',cursorHidden:false,cursorStyle:'block',cursorBlink:false}}});
        if(['heartbeat','terminal.ack','terminals.detach'].includes(method))return Promise.resolve({ok:true});
        throw Error('Unexpected request: '+method);
      },
      subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
      onConnection(listener){connections.add(listener);listener({status:'connected',owner:true,connectionId:'connection'});return()=>connections.delete(listener);},
      listHosts:async()=>[{id:'local',name:'검증 PC',local:true,selected:true}],
      addHost:params=>new Promise(resolve=>adds.push({resolve,params})),
      selectHost:async id=>{selections.push(id);return {status:'connected',owner:false,connectionId:'remote'};}
    };
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const css = readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8') + readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const pages: Page[] = [], errors: string[] = [];
  const open = async (query = '') => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); pages.push(page);
    page.setDefaultTimeout(4000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}/${query ? '?' + query : ''}`);
    return page;
  };
  const selected = (page: Page) => page.getByRole('navigation', { name: '작업 공간 전환' }).locator('[aria-current="page"]');
  try {
    await t.test('an older state.get reply cannot replace a state event received while it waited', async () => {
      const page = await open('hold');
      await page.waitForFunction(() => (window as any).fixture.reads.length === 1);
      await page.evaluate(() => { const f = (window as any).fixture; f.state.groups[0].name = '최신 작업'; f.state.groups[0].revision++; f.emit(); });
      await expect(selected(page)).toHaveText('최신 작업');
      await page.evaluate(() => (window as any).fixture.releaseRead(0));
      await expect(selected(page)).toHaveText('최신 작업');
    });
    await t.test('an earlier state.get reply cannot replace the result of a later request', async () => {
      const page = await open('hold');
      await page.waitForFunction(() => (window as any).fixture.reads.length === 1);
      await page.evaluate(() => { const f = (window as any).fixture; f.state.groups[0].name = '나중 조회'; f.connect(); });
      await page.waitForFunction(() => (window as any).fixture.reads.length === 2);
      await page.evaluate(() => (window as any).fixture.releaseRead(1));
      await expect(selected(page)).toHaveText('나중 조회');
      await page.evaluate(() => (window as any).fixture.releaseRead(0));
      await expect(selected(page)).toHaveText('나중 조회');
    });
    await t.test('a cancelled creation can finish without closing the next editor or changing its group', async () => {
      const page = await open();
      await expect(selected(page)).toHaveText('첫 작업');
      await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '새 작업 그룹', exact: true });
      await editor.getByLabel('이름', { exact: true }).fill('늦게 만들어진 그룹');
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await page.waitForFunction(() => (window as any).fixture.creates.length === 1);
      await editor.getByRole('button', { name: '취소', exact: true }).click();
      await page.getByRole('navigation', { name: '작업 공간 전환' }).getByRole('button', { name: '다른 작업', exact: true }).click();
      await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
      await editor.getByLabel('이름', { exact: true }).fill('계속 작성 중');
      await page.evaluate(() => (window as any).fixture.releaseCreate(0));
      await expect(page.getByRole('navigation', { name: '작업 공간 전환' }).getByRole('button', { name: '늦게 만들어진 그룹', exact: true })).toBeVisible();
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('이름', { exact: true })).toHaveValue('계속 작성 중');
      await expect(selected(page)).toHaveText('다른 작업');
    });
    await t.test('an active editor still closes and selects its newly created group', async () => {
      const page = await open();
      await expect(selected(page)).toHaveText('첫 작업');
      await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '새 작업 그룹', exact: true });
      await editor.getByLabel('이름', { exact: true }).fill('정상 생성');
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await page.waitForFunction(() => (window as any).fixture.creates.length === 1);
      await page.evaluate(() => (window as any).fixture.releaseCreate(0));
      await expect(editor).toHaveCount(0); await expect(selected(page)).toHaveText('정상 생성');
    });
    await t.test('a cancelled terminal creation preserves a replacement editor and the selected group', async () => {
      const page = await open();
      await expect(selected(page)).toHaveText('첫 작업');
      await page.getByRole('button', { name: '새 터미널', exact: true }).click();
      const terminalEditor = page.getByRole('dialog', { name: '새 터미널', exact: true });
      await terminalEditor.getByRole('button', { name: '터미널 열기', exact: true }).click();
      await page.waitForFunction(() => (window as any).fixture.terminalCreates.length === 1);
      await terminalEditor.getByRole('button', { name: '취소', exact: true }).click();
      await page.getByRole('navigation', { name: '작업 공간 전환' }).getByRole('button', { name: '다른 작업', exact: true }).click();
      await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '새 작업 그룹', exact: true });
      await editor.getByLabel('이름', { exact: true }).fill('터미널 응답을 기다리지 않는 새 작업');
      await page.evaluate(() => (window as any).fixture.releaseTerminal(0));
      await expect(page.locator('.status-bar')).toContainText('0개 실행 중');
      await expect(editor).toBeVisible();
      await expect(editor.getByLabel('이름', { exact: true })).toHaveValue('터미널 응답을 기다리지 않는 새 작업');
      await expect(selected(page)).toHaveText('다른 작업');
    });
    await t.test('host registration still selects the new computer when initial workspace loading finishes first', async () => {
      const page = await open('hold');
      await page.waitForFunction(() => (window as any).fixture.reads.length === 1);
      await page.getByRole('button', { name: '컴퓨터 추가', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '컴퓨터 추가', exact: true });
      await editor.getByLabel('컴퓨터 이름', { exact: true }).fill('새 컴퓨터');
      await editor.getByLabel('몽글 접속 주소', { exact: true }).fill('https://test.tailnet.ts.net');
      await editor.getByRole('button', { name: '추가하고 연결', exact: true }).click();
      await page.waitForFunction(() => (window as any).fixture.adds.length === 1);
      await page.evaluate(() => (window as any).fixture.releaseRead(0));
      await expect(selected(page)).toHaveText('첫 작업');
      await page.evaluate(() => (window as any).fixture.releaseAdd(0));
      await expect(editor).toHaveCount(0);
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.selections), ['remote-0']);
    });
    await t.test('a cancelled host editor does not switch computers when registration finishes', async () => {
      const page = await open();
      await expect(selected(page)).toHaveText('첫 작업');
      await page.getByRole('button', { name: '컴퓨터 추가', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '컴퓨터 추가', exact: true });
      await editor.getByLabel('컴퓨터 이름', { exact: true }).fill('늦은 컴퓨터');
      await editor.getByLabel('몽글 접속 주소', { exact: true }).fill('https://test.tailnet.ts.net');
      await editor.getByRole('button', { name: '추가하고 연결', exact: true }).click();
      await page.waitForFunction(() => (window as any).fixture.adds.length === 1);
      await editor.getByRole('button', { name: '취소', exact: true }).click();
      await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
      await page.getByRole('dialog').getByLabel('이름', { exact: true }).fill('새 작업 작성');
      await page.evaluate(() => (window as any).fixture.releaseAdd(0));
      await expect(page.getByRole('dialog', { name: '새 작업 그룹', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog').getByLabel('이름', { exact: true })).toHaveValue('새 작업 작성');
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.selections), []);
    });
    await t.test('the refresh after a pane drag cannot replace a newer state event', async () => {
      const page = await open('drag');
      await expect(page.locator('.pane')).toHaveCount(2);
      const source = await page.locator('[data-terminal-id="left"] .pane-drag-handle').boundingBox();
      const target = await page.locator('[data-terminal-id="right"]').boundingBox(); assert.ok(source && target);
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
      await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2 + 12, { steps: 3 });
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
      await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height / 2 + 1);
      await expect(page.locator('.pane-drop-preview')).toBeVisible(); await page.mouse.up();
      await page.waitForFunction(() => (window as any).fixture.reads.length === 1);
      await page.evaluate(() => { const f = (window as any).fixture; f.state.groups[0].name = '드래그 후 최신 작업'; f.emit(); });
      await expect(selected(page)).toHaveText('드래그 후 최신 작업');
      await page.evaluate(() => (window as any).fixture.releaseRead(0));
      await expect(selected(page)).toHaveText('드래그 후 최신 작업');
    });
    assert.deepEqual(errors, []);
  } finally {
    await Promise.all(pages.map(page => page.close())); await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
