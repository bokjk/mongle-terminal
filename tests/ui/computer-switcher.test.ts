import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { addSavedComputer, computerOrigin, computerRows, loadSavedComputers, MAX_SAVED_COMPUTERS, SAVED_COMPUTERS_KEY } from '../../apps/web/src/computer-list.ts';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('saved computer addresses accept only Mongle Tailscale origins and merge with found PCs', () => {
  assert.equal(computerOrigin(' office-pc.tail1234.ts.net '), 'https://office-pc.tail1234.ts.net');
  assert.equal(computerOrigin('https://Office-PC.tail1234.ts.net:8443/'), 'https://office-pc.tail1234.ts.net:8443');
  for (const bad of ['http://office-pc.tail1234.ts.net', 'https://example.com', 'javascript:alert(1)', 'https://office-pc.tail1234.ts.net/settings', 'https://user:pw@office-pc.tail1234.ts.net', 'https://office-pc.tail1234.ts.net/?next=1', ''])
    assert.throws(() => computerOrigin(bad), /ts\.net/, bad);
  const storage = (value: string) => ({getItem: () => value});
  assert.deepEqual(loadSavedComputers(storage(JSON.stringify([
    {name: ' 회사 PC ', origin: 'https://office-pc.tail1234.ts.net'}, {name: '중복', origin: 'https://office-pc.tail1234.ts.net/'},
    {name: '나쁜 주소', origin: 'javascript:alert(1)'}, {name: '', origin: 'https://lab.tail1234.ts.net'}, 'text', null,
  ]))), [{name: '회사 PC', origin: 'https://office-pc.tail1234.ts.net'}]);
  assert.deepEqual(loadSavedComputers(storage('{not json')), []);
  assert.deepEqual(loadSavedComputers(storage(JSON.stringify(Array.from({length: 30}, (_, index) => ({name: `PC ${index}`, origin: `https://pc-${index}.tail1234.ts.net`}))))).length, MAX_SAVED_COMPUTERS);
  const current = 'https://home-pc.tail1234.ts.net';
  assert.throws(() => addSavedComputer([], '', 'home-pc.tail1234.ts.net', current), /지금 보고 있는/);
  let saved = addSavedComputer([], '  ', 'https://lab-pc.tail1234.ts.net', current);
  assert.deepEqual(saved, [{name: 'lab-pc', origin: 'https://lab-pc.tail1234.ts.net'}], 'An empty name uses the machine name');
  saved = addSavedComputer(saved, '실험실\u0007', 'lab-pc.tail1234.ts.net', current);
  assert.deepEqual(saved, [{name: '실험실', origin: 'https://lab-pc.tail1234.ts.net'}], 'Adding a saved address again renames it');
  const full = Array.from({length: MAX_SAVED_COMPUTERS}, (_, index) => ({name: `PC ${index}`, origin: `https://pc-${index}.tail1234.ts.net`}));
  assert.throws(() => addSavedComputer(full, '', 'new-pc.tail1234.ts.net', current), /20개/);
  assert.deepEqual(computerRows(
    [{name: 'office-pc', origin: 'https://office-pc.tail1234.ts.net'}, {name: 'home-pc', origin: current}, {name: 'laptop', origin: 'https://laptop.tail1234.ts.net'}],
    [{name: '회사 PC', origin: 'https://office-pc.tail1234.ts.net'}, {name: '실험실', origin: 'https://lab-pc.tail1234.ts.net'}], current,
  ), [
    {name: '회사 PC', origin: 'https://office-pc.tail1234.ts.net', saved: true},
    {name: 'laptop', origin: 'https://laptop.tail1234.ts.net', saved: false},
    {name: '실험실', origin: 'https://lab-pc.tail1234.ts.net', saved: true},
  ]);
  assert.equal(SAVED_COMPUTERS_KEY, 'mongle.savedComputers');
});

test('a phone switches to another computer from the menu, adds addresses and explains failures', {skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000}, async () => {
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ComputerSwitcher} from './apps/web/src/ComputerSwitcher';
    window.calls=[];window.navigations=[];window.delay=400;window.fail='';
    window.reply={available:true,checkedAt:1,computers:[
      {name:'office-pc',origin:'https://office-pc.tail1234.ts.net:8443'},
      {name:'laptop',origin:'https://laptop.tail1234.ts.net'},
      {name:'bad',origin:'javascript:alert(1)'},
    ]};
    const client={request:(method,params)=>{
      window.calls.push({method,params});
      if(method!=='computers.list')return Promise.reject(Error('Unexpected RPC: '+method));
      return new Promise((resolve,reject)=>setTimeout(()=>window.fail?reject(Error(window.fail)):resolve(window.reply),window.delay));
    }};
    const root=createRoot(document.getElementById('root'));
    window.render=(connected=true,theme='dark')=>{document.documentElement.dataset.theme=theme;root.render(<aside className="sidebar open" style={{width:240}}><ComputerSwitcher client={client} name="집 PC" connected={connected} navigate={url=>window.navigations.push(url)}/></aside>);};
    window.render();
  `;
  const bundle = await build({stdin: {contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url))}, bundle: true, write: false, format: 'iife', platform: 'browser'});
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8').replace("@import '@xterm/xterm/css/xterm.css';", '');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
    page.setDefaultTimeout(5000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const screenshots = fileURLToPath(new URL('../../test-results/computer-switcher/', import.meta.url));
    mkdirSync(screenshots, {recursive: true});
    const trigger = page.getByRole('button', {name: '컴퓨터 전환', exact: true});
    const dialog = page.getByRole('dialog', {name: '컴퓨터 전환'});
    const status = dialog.getByRole('status');
    const fits = async (width: number) => {
      const geometry = await page.evaluate(() => ({document: document.documentElement.scrollWidth, modal: document.querySelector('.modal')!.scrollWidth - document.querySelector('.modal')!.clientWidth}));
      assert.ok(geometry.document <= width && geometry.modal <= 1, `The switcher overflows at ${width}px: ${JSON.stringify(geometry)}`);
    };

    await expect(trigger).toContainText('집 PC');
    await expect(trigger).toContainText('접속 중인 컴퓨터');
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(status).toHaveText('같은 Tailscale에서 다른 몽글 PC를 찾는 중…');
    await expect(status).toHaveText('다른 몽글 PC 2대를 찾았습니다.');
    await expect(dialog.getByText(`지금 보는 컴퓨터 · 127.0.0.1:${address.port}`)).toBeVisible();
    await expect(dialog.getByRole('button', {name: 'office-pc 열기'})).toContainText('office-pc.tail1234.ts.net:8443');
    await expect(dialog.getByRole('button', {name: 'laptop 열기'})).toBeVisible();
    assert.equal(await dialog.getByRole('button', {name: 'bad 열기'}).count(), 0, 'Only https Tailscale addresses are offered');
    assert.deepEqual(await page.evaluate('window.calls'), [{method: 'computers.list', params: {}}]);
    for (const row of await dialog.locator('.computer-row > .device-row').all()) assert.ok((await row.boundingBox())!.height >= 44, 'Rows are easy to tap');
    await fits(390);
    await page.screenshot({path: `${screenshots}/phone-dark-390.png`});

    await dialog.getByRole('button', {name: 'office-pc 열기'}).click();
    assert.deepEqual(await page.evaluate('window.navigations'), ['https://office-pc.tail1234.ts.net:8443/']);
    await expect(status).toHaveText('office-pc 여는 중…');
    await expect(dialog.getByRole('button', {name: 'laptop 열기'})).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog.getByRole('button', {name: 'laptop 열기'})).toBeEnabled();
    await dialog.getByRole('button', {name: '주소로 추가'}).click();
    await expect(dialog.getByLabel('이름(선택)')).toBeFocused();
    await dialog.getByLabel('몽글 접속 주소').fill('http://evil.example.com');
    await dialog.getByRole('button', {name: '추가', exact: true}).click();
    await expect(dialog.getByRole('alert')).toHaveText('https://컴퓨터.테일넷.ts.net 형식의 몽글 접속 주소만 추가할 수 있습니다.');
    await dialog.getByLabel('이름(선택)').fill('회사 PC');
    await dialog.getByLabel('몽글 접속 주소').fill('office-pc.tail1234.ts.net:8443');
    await dialog.getByRole('button', {name: '추가', exact: true}).click();
    await expect(dialog.getByRole('button', {name: '회사 PC 열기'})).toContainText('직접 추가 · office-pc.tail1234.ts.net:8443');
    assert.equal(await dialog.getByRole('button', {name: 'office-pc 열기'}).count(), 0, 'The saved name replaces the found name for the same address');
    await dialog.getByRole('button', {name: '주소로 추가'}).click();
    await dialog.getByLabel('몽글 접속 주소').fill('https://lab-pc.tail1234.ts.net/');
    await dialog.getByRole('button', {name: '추가', exact: true}).click();
    await expect(dialog.getByRole('button', {name: 'lab-pc 열기'})).toBeVisible();
    for (const remove of await dialog.getByRole('button', {name: /주소 삭제$/}).all()) {
      const box = (await remove.boundingBox())!;
      assert.ok(box.width >= 44 && box.height >= 44, 'Delete buttons are easy to tap');
    }
    await fits(390);
    await page.screenshot({path: `${screenshots}/phone-saved-390.png`});
    await dialog.getByRole('button', {name: '회사 PC 주소 삭제'}).click();
    await expect(dialog.getByRole('button', {name: 'office-pc 열기'})).toBeVisible();
    assert.deepEqual(JSON.parse(await page.evaluate(`localStorage.getItem('${SAVED_COMPUTERS_KEY}')`) as string), [{name: 'lab-pc', origin: 'https://lab-pc.tail1234.ts.net'}]);

    await dialog.getByRole('button', {name: '다시 찾기'}).click();
    await expect(status).toHaveText('다른 몽글 PC 2대를 찾았습니다.');
    assert.deepEqual((await page.evaluate('window.calls') as any[]).at(-1), {method: 'computers.list', params: {refresh: true}});
    await page.evaluate("window.reply={computers:[],available:false,message:'Tailscale에서 로그인하고 네트워크에 연결해 주세요.',checkedAt:2}");
    await dialog.getByRole('button', {name: '다시 찾기'}).click();
    await expect(status).toHaveText('다른 PC를 찾지 못했습니다. Tailscale에서 로그인하고 네트워크에 연결해 주세요.');
    await expect(dialog.getByRole('button', {name: 'lab-pc 열기'})).toBeVisible();
    await page.evaluate("window.reply={computers:[],available:true,checkedAt:3}");
    await dialog.getByRole('button', {name: '다시 찾기'}).click();
    await expect(status).toContainText('다른 몽글 PC를 찾지 못했습니다. 그 PC와 몽글터미널이 켜져 있고');
    await page.evaluate("window.fail='요청을 완료하지 못했습니다.'");
    await dialog.getByRole('button', {name: '다시 찾기'}).click();
    await expect(status).toHaveText('요청을 완료하지 못했습니다.');

    await page.reload();
    await page.evaluate("window.calls=[]; window.render(false, 'light')");
    await page.setViewportSize({width: 320, height: 700});
    await trigger.click();
    await expect(status).toHaveText('이 컴퓨터에 연결되면 같은 Tailscale의 다른 몽글 PC를 찾습니다. 직접 추가한 주소는 지금도 열 수 있습니다.');
    await expect(dialog.getByRole('button', {name: '다시 찾기'})).toBeDisabled();
    assert.deepEqual(await page.evaluate('window.calls'), [], 'A page that is not connected does not ask the host');
    await fits(320);
    await page.screenshot({path: `${screenshots}/phone-light-320.png`});
    await dialog.getByRole('button', {name: 'lab-pc 열기'}).click();
    assert.deepEqual(await page.evaluate('window.navigations'), ['https://lab-pc.tail1234.ts.net/'], 'A saved address survives reloads and opens even before this PC connects');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
