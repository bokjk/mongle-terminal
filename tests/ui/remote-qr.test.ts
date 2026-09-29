import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('remote access QR decodes committed HTTPS origins, retains approval, and fits dark/light/mobile settings', { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 45000 }, async () => {
  const initialOrigin = 'https://mongle-test.tail1234.ts.net:8443';
  const changedOrigin = 'https://another-computer.tail1234.ts.net';
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import jsQR from 'jsqr';
    import {Settings} from './apps/web/src/Settings';
    import {RemoteAccessQr} from './apps/web/src/RemoteAccessQr';
    const state={hostId:'host',bootId:'boot',name:'현재 컴퓨터',version:'0.2.0',protocolVersion:1,groups:[],terminals:[],profiles:[],settings:{name:'현재 컴퓨터',recordHistory:true,scrollback:5000}};
    window.calls=[]; window.errors=[]; window.remote={enabled:true,origin:${JSON.stringify(initialOrigin)}};
    const client={request:async(method,params)=>{
      window.calls.push({method,params});
      if(method==='remote.status')return {...window.remote};
      if(method==='devices.list')return {devices:[]};
      if(method==='pairing.list')return {requests:[]};
      if(method==='remote.configure'){window.remote={enabled:!!params.origin,origin:params.origin};return {ok:true};}
      if(method==='remote.disable'){window.remote.enabled=false;return {ok:true};}
      if(method==='remote.enable'){window.remote.enabled=true;return {origin:window.remote.origin};}
      if(method==='pairing.create')return {code:'123456',expiresAt:Date.now()+60000};
      throw Error('Unexpected RPC: '+method);
    }};
    const root=createRoot(document.getElementById('root'));
    window.render=(owner=true,theme='dark')=>{document.documentElement.dataset.theme=theme;root.render(<Settings client={client} state={state} owner={owner} theme={theme} fontSize={14} onTheme={()=>{}} onFontSize={()=>{}} onClose={()=>{}} onError={message=>window.errors.push(message)}/>);};
    window.renderUnsafe=origin=>root.render(<RemoteAccessQr origin={origin}/>);
    window.decodeQr=async()=>{
      const svg=document.querySelector('.remote-access-qr svg');
      if(!svg)return null;
      const image=new Image();
      image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await image.decode();
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(svg.getBoundingClientRect().width);canvas.height=Math.round(svg.getBoundingClientRect().height);
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
      return jsQR(pixels.data,pixels.width,pixels.height)?.data??null;
    };
    window.render();
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
    const page = await browser.newPage({ viewport: { width: 1100, height: 960 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = [], externalRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(`http://127.0.0.1:${address.port}/`)) externalRequests.push(request.url()); });
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}`);
    const qr = page.getByRole('img', { name: '모바일 원격 접속 QR 코드', exact: true });
    assert.equal(await qr.count(), 0);
    await page.getByRole('tab', { name: '원격 연결', exact: true }).click();
    await qr.waitFor();
    assert.equal(await page.evaluate('window.decodeQr()'), initialOrigin);
    assert.equal(await page.evaluate('window.calls.some(call=>call.method === "pairing.create" || call.method === "pairing.approve")'), false, 'Showing the QR must not create credentials or approve a device');
    assert.equal(await page.getByRole('button', { name: '연결 코드 만들기', exact: true }).isEnabled(), true);
    const screenshotDir = fileURLToPath(new URL('../../test-results/remote-qr/', import.meta.url));
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: `${screenshotDir}/desktop-dark.png` });

    await page.evaluate('window.render(true,"light")');
    assert.equal(await page.evaluate('window.decodeQr()'), initialOrigin);
    assert.deepEqual(await qr.evaluate(svg => Array.from(svg.querySelectorAll('path')).map(path => path.getAttribute('fill'))), ['#ffffff', '#000000']);
    await page.screenshot({ path: `${screenshotDir}/desktop-light.png` });

    await page.getByRole('button', { name: '접속 주소 직접 설정', exact: true }).click();
    await page.getByLabel('HTTPS 접속 주소', { exact: true }).fill(changedOrigin);
    assert.equal(await page.evaluate('window.decodeQr()'), initialOrigin, 'Unsaved address edits must not change the QR destination');
    await page.getByRole('button', { name: '주소 저장', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '접속 주소를 저장했습니다.' }).waitFor();
    assert.equal(await page.evaluate('window.decodeQr()'), changedOrigin);
    await page.getByRole('button', { name: '연결 코드 만들기', exact: true }).click();
    await page.getByText('123456', { exact: true }).waitFor();
    assert.equal(await page.evaluate('window.decodeQr()'), changedOrigin, 'Pairing codes must never be embedded in the QR');

    await page.setViewportSize({ width: 320, height: 740 });
    await qr.scrollIntoViewIfNeeded();
    const mobileSize = await qr.boundingBox();
    assert.ok(mobileSize && mobileSize.width >= 220 && mobileSize.width === mobileSize.height);
    const overflow = await page.locator('.settings-content').evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, `320px settings must not overflow horizontally (${overflow}px)`);
    assert.equal(await page.evaluate('window.decodeQr()'), changedOrigin);
    await page.screenshot({ path: `${screenshotDir}/mobile-light-320.png` });
    await page.evaluate('window.render(true,"dark")');
    assert.equal(await page.evaluate('window.decodeQr()'), changedOrigin);
    await page.screenshot({ path: `${screenshotDir}/mobile-dark-320.png` });

    await page.getByRole('button', { name: '원격 접속 끄기', exact: true }).click();
    await qr.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: '새 코드 만들기', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '원격 접속 켜기', exact: true }).click();
    await qr.waitFor();
    assert.equal(await page.evaluate('window.decodeQr()'), changedOrigin);
    await page.evaluate('window.render(false)');
    await qr.waitFor({ state: 'detached' });
    await page.getByText('현재 이 컴퓨터의 터미널에 원격으로 접속해 있습니다.', { exact: true }).waitFor();

    for (const unsafe of ['http://example.test', 'javascript:alert(1)', 'https://user:secret@example.test', 'https://example.test/secret', 'https://example.test/?code=123456', 'https://example.test/#token', 'not an address']) {
      await page.evaluate(value => (window as any).renderUnsafe(value), unsafe);
      await page.waitForFunction('document.querySelector(".settings-layout") === null');
      assert.equal(await qr.count(), 0, `Invalid or credential-bearing QR must not render: ${unsafe}`);
    }
    assert.deepEqual(externalRequests, [], 'Rendering QR must not contact an external image/QR service');
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate('window.errors'), []);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
