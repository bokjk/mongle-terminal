import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('a paired phone creates codes and approves or rejects requests without PC-only management', { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000 }, async () => {
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Settings} from './apps/web/src/Settings';
    const base={hostId:'host',bootId:'boot',name:'회사 PC',version:'0.3.18',protocolVersion:1,groups:[],terminals:[],profiles:[],settings:{name:'회사 PC',recordHistory:true,scrollback:5000}};
    window.calls=[];window.errors=[];window.codeLifetime=180000;
    window.requests=[
      {requestId:'11111111-1111-4111-8111-111111111111',name:'집 PC',status:'pending',createdAt:Date.now(),expiresAt:Date.now()+150000},
      {requestId:'22222222-2222-4222-8222-222222222222',name:'모르는 기기',status:'pending',createdAt:Date.now(),expiresAt:Date.now()+150000},
    ];
    const client={request:async(method,params)=>{
      window.calls.push({method,params});
      if(method==='pairing.list')return {requests:window.requests};
      if(method==='pairing.create')return {code:'ABCD234567',expiresAt:Date.now()+window.codeLifetime};
      if(method==='pairing.approve'||method==='pairing.reject'){window.requests=window.requests.filter(item=>item.requestId!==params.requestId);return {ok:true};}
      if(method==='remote.status')return {enabled:true,origin:'https://office.example-tailnet.ts.net'};
      if(method==='devices.list')return {devices:[{deviceId:'33333333-3333-4333-8333-333333333333',name:'집 PC',createdAt:Date.now(),revoked:false,approvedBy:'내 휴대폰'}]};
      throw Error('Unexpected RPC: '+method);
    }};
    const root=createRoot(document.getElementById('root'));
    window.render=(owner,capabilities,theme='dark')=>{document.documentElement.dataset.theme=theme;root.render(<Settings client={client} state={{...base,capabilities}} owner={owner} theme={theme} fontSize={14} scrollSpeed={0.5} onScrollSpeed={()=>{}} onTheme={()=>{}} onFontSize={()=>{}} onClose={()=>{}} onError={message=>window.errors.push(message)} />);};
    window.render(false,['pairing.remote-approve']);
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8').replace("@import '@xterm/xterm/css/xterm.css';", '');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const screenshotDir = fileURLToPath(new URL('../../test-results/remote-approval/', import.meta.url));
    mkdirSync(screenshotDir, { recursive: true });
    const overflow = () => page.locator('.settings-content').evaluate(element => element.scrollWidth - element.clientWidth);

    await page.getByRole('tab', { name: '원격 연결', exact: true }).click();
    await expect(page.getByRole('heading', { name: '새 기기 연결', exact: true })).toBeVisible();
    await expect(page.getByText('승인한 기기는 회사 PC의 터미널에서 명령을 실행할 수 있습니다.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '집 PC 연결 승인', exact: true }).waitFor();
    await page.getByRole('button', { name: '연결 코드 만들기', exact: true }).click();
    await page.getByText('ABCD234567', { exact: true }).waitFor();
    await expect(page.getByText(/^[0-3]:[0-5]\d 남음 · 한 번만 쓸 수 있습니다\.$/)).toBeVisible();
    assert.ok(await overflow() <= 1, '390px paired-device settings must not overflow horizontally');
    await page.screenshot({ path: `${screenshotDir}/phone-dark-390.png` });

    await page.getByRole('button', { name: '집 PC 연결 승인', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '집 PC의 연결을 승인했습니다.' }).waitFor();
    await page.getByRole('button', { name: '모르는 기기 연결 거절', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '모르는 기기의 연결 요청을 거절했습니다.' }).waitFor();
    assert.deepEqual(await page.evaluate('window.calls.filter(call => call.method === "pairing.approve" || call.method === "pairing.reject")'), [
      { method: 'pairing.approve', params: { requestId: '11111111-1111-4111-8111-111111111111' } },
      { method: 'pairing.reject', params: { requestId: '22222222-2222-4222-8222-222222222222' } },
    ]);
    await expect(page.getByText('승인 대기 중인 기기가 없습니다.', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate('window.calls.some(call => /^(remote|devices)\\./.test(call.method))'), false, 'A paired device never asks for PC-only remote settings or the device list');

    await page.setViewportSize({ width: 320, height: 740 });
    assert.ok(await overflow() <= 1, '320px paired-device settings must not overflow horizontally');
    await page.evaluate('window.render(false,["pairing.remote-approve"],"light")');
    await page.screenshot({ path: `${screenshotDir}/phone-light-320.png` });

    await page.evaluate('window.codeLifetime=1200');
    await page.getByRole('button', { name: '새 코드 만들기', exact: true }).click();
    await expect(page.getByText('코드가 만료되었습니다. 새 코드를 만들어 주세요.', { exact: true })).toBeVisible();
    assert.equal(await page.getByText('ABCD234567', { exact: true }).count(), 0, 'An expired code is no longer shown');

    await page.evaluate('window.calls=[]; window.render(false,[],"dark")');
    await expect(page.getByRole('heading', { name: '원격 연결 관리', exact: true })).toBeVisible();
    assert.equal(await page.getByRole('button', { name: /코드 만들기/ }).count(), 0, 'An older host does not offer remote approval');
    await page.waitForTimeout(3300);
    assert.equal(await page.evaluate('window.calls.length'), 0, 'An older host is not polled for approval requests');

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.evaluate('window.render(true,["pairing.remote-approve"])');
    const approvedBy = page.getByText('· 내 휴대폰에서 승인', { exact: false });
    await expect(approvedBy).toBeVisible();
    await approvedBy.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshotDir}/pc-dark-devices.png` });
    assert.deepEqual(await page.evaluate('window.errors'), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
