import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('update settings preserve newer events, gate repeated actions, show native failures, and distinguish browser access', { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 30000 }, async () => {
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {UpdateSettings} from './apps/web/src/UpdateSettings';
    window.calls=[]; window.gets=[]; window.checks=[]; window.installs=[];
    const listeners=new Set();
    const bridge={
      getUpdateState:()=>{window.calls.push('get'); return new Promise(resolve=>window.gets.push(resolve));},
      checkForUpdates:()=>{window.calls.push('check'); return new Promise((resolve,reject)=>window.checks.push({resolve,reject}));},
      installUpdate:()=>{window.calls.push('install'); return new Promise((resolve,reject)=>window.installs.push({resolve,reject}));},
      onUpdate:listener=>{window.calls.push('subscribe');listeners.add(listener);return ()=>{window.calls.push('unsubscribe');listeners.delete(listener);};}
    };
    window.emit=value=>listeners.forEach(listener=>listener(value));
    const root=createRoot(document.getElementById('root'));
    window.render=mode=>{window.mongle=mode==='desktop'?bridge:mode==='old'?{}:undefined;root.render(<UpdateSettings key={mode}/>);};
    window.render('desktop');
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction('window.gets.length === 1');
    assert.deepEqual(await page.evaluate('window.calls'), ['subscribe', 'get']);
    await page.getByText('접속한 원격 컴퓨터의 앱은 그 컴퓨터에서 업데이트합니다.', { exact: false }).waitFor();
    await page.evaluate(`window.emit({status:'downloading',currentVersion:'0.1.0',availableVersion:'0.2.0',progress:36}); window.gets.shift()({status:'idle',currentVersion:'0.1.0'});`);
    await page.getByRole('progressbar', { name: '업데이트 다운로드 진행률' }).waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('value'), '36');
    assert.equal(await page.getByRole('button', { name: '업데이트 확인', exact: true }).isDisabled(), true);
    await page.evaluate(`window.emit({status:'ready',currentVersion:'0.1.0',availableVersion:'0.2.0'});`);
    const install = page.getByRole('button', { name: '업데이트 설치 후 다시 시작', exact: true });
    await install.waitFor();
    await page.getByText('실행 중인 프로그램과 저장하지 않은 작업은 복원되지 않습니다.', { exact: false }).waitFor();
    await install.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    assert.equal(await page.evaluate('window.calls.filter(value=>value==="install").length'), 1);
    assert.equal(await install.isDisabled(), true);
    await page.evaluate(`window.installs.shift().reject(new Error('설치 준비에 실패했습니다.'));`);
    await page.getByRole('alert').filter({ hasText: '설치 준비에 실패했습니다.' }).waitFor();
    assert.equal(await install.isEnabled(), true);

    await install.click();
    await page.evaluate('window.installs.shift().resolve()');
    await page.waitForFunction('window.gets.length === 1');
    await page.evaluate(`window.gets.shift()({status:'ready',currentVersion:'0.1.0',availableVersion:'0.2.0'});`);
    await page.waitForFunction(`!document.querySelector('button').disabled`);
    assert.equal(await install.isEnabled(), true, 'Cancelling native confirmation keeps update installable');

    await page.evaluate(`window.emit({status:'idle',currentVersion:'0.1.0'});`);
    const check = page.getByRole('button', { name: '업데이트 확인', exact: true });
    await check.click();
    await page.evaluate(`window.emit({status:'downloading',currentVersion:'0.1.0',availableVersion:'0.2.0',progress:75}); window.checks.shift().resolve({status:'checking',currentVersion:'0.1.0'});`);
    await page.getByRole('progressbar').waitFor();
    assert.equal(await page.getByRole('progressbar').getAttribute('value'), '75', 'Late check response must not rewind download progress');
    await page.evaluate(`window.emit({status:'error',currentVersion:'0.1.0',message:'인터넷 연결을 확인해 주세요.'});`);
    await page.getByRole('alert').filter({ hasText: '인터넷 연결을 확인해 주세요.' }).waitFor();
    await check.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    assert.equal(await page.evaluate('window.calls.filter(value=>value==="check").length'), 2);
    await page.evaluate(`window.checks.shift().reject(new Error('업데이트 서버에 연결하지 못했습니다.'));`);
    await page.getByRole('alert').filter({ hasText: '업데이트 서버에 연결하지 못했습니다.' }).waitFor();
    assert.equal(await check.isEnabled(), true);

    await page.evaluate(`window.emit({status:'unsupported',currentVersion:'0.1.0',message:'설치 버전에서 사용할 수 있습니다.'});`);
    await page.getByRole('status').filter({ hasText: '설치 버전에서 사용할 수 있습니다.' }).waitFor();
    assert.equal(await check.isDisabled(), true);
    await page.evaluate('window.render("browser")');
    await page.getByText('컴퓨터 앱의 업데이트는 해당 컴퓨터에서 진행합니다.').waitFor();
    assert.equal(await page.getByRole('button').count(), 0, 'Browser must not offer local native update controls');
    assert.equal(await page.evaluate('window.calls.filter(value=>value==="unsubscribe").length'), 1);
    await page.evaluate('window.render("old")');
    await page.getByText('이 버전에서는 앱 업데이트를 지원하지 않습니다.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
