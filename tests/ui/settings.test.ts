import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

test('settings UI downloads JSON, validates and confirms empty-group import, and confirms device logout', { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 30000 }, async () => {
  const config = { version: 1, name: '집 컴퓨터', recordHistory: true, groups: [{ name: '몽글', cwd: 'C:\\Projects', profileId: 'powershell' }] };
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Settings} from './apps/web/src/Settings';
    const config=${JSON.stringify(config)};
    const state={hostId:'host',bootId:'boot',name:'현재 컴퓨터',version:'0.1.0',protocolVersion:1,groups:[],terminals:[],profiles:[],settings:{name:'현재 컴퓨터',recordHistory:true,scrollback:5000}};
    window.calls=[];window.errors=[];window.settingsClosed=false;
    const client={request:async(method,params)=>{window.calls.push({method,params}); if(method==='settings.export')return config;if(method==='settings.import')return {importedGroups:params.config.groups.length,warnings:['폴더를 기본값으로 변경했습니다.']};if(method==='auth.logout')return {ok:true};throw Error('Unexpected RPC: '+method);}};
    const root=createRoot(document.getElementById('root'));
    window.render=owner=>root.render(<Settings client={client} state={state} owner={owner} theme='dark' fontSize={14} onTheme={()=>{}} onFontSize={()=>{}} onClose={()=>{window.settingsClosed=true}} onError={message=>window.errors.push(message)} />);
    window.render(true);
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => console.error('Settings browser error:', error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('tab', { name: '컴퓨터', exact: true }).click();
    const downloadPending = page.waitForEvent('download');
    await page.getByRole('button', { name: '설정 내보내기', exact: true }).click();
    const download = await downloadPending;
    assert.match(download.suggestedFilename(), /^mongle-settings-\d{4}-\d{2}-\d{2}\.json$/);
    const saved = await download.path();
    assert.ok(saved);
    assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), config);

    const input = page.getByLabel('가져올 설정 파일');
    await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid json') });
    await page.getByRole('alert').filter({ hasText: '올바른 JSON 설정 파일' }).waitFor();
    assert.equal(await page.evaluate('window.calls.filter(call => call.method === "settings.import").length'), 0);
    await input.setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...config, version: 999 })) });
    await page.getByRole('alert').filter({ hasText: '버전 1' }).waitFor();
    await input.setInputFiles({ name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(96 * 1024 + 1, 32) });
    await page.getByRole('alert').filter({ hasText: '96KiB' }).waitFor();
    await input.setInputFiles({ name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(config)) });
    await page.getByRole('button', { name: '빈 그룹 1개 추가', exact: true }).waitFor();
    assert.equal(await page.evaluate('window.calls.filter(call => call.method === "settings.import").length'), 0, 'File selection must not mutate host settings');
    await page.getByRole('button', { name: '빈 그룹 1개 추가', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '빈 그룹 1개를 추가했습니다.' }).waitFor();
    const imports = await page.evaluate('window.calls.filter(call => call.method === "settings.import")') as { method: string; params: unknown }[];
    assert.deepEqual(imports, [{ method: 'settings.import', params: { config, confirmed: true } }]);
    assert.equal(await page.evaluate('window.calls.some(call => call.method.startsWith("terminal."))'), false);

    await page.evaluate('window.render(false)');
    await page.getByRole('tab', { name: '원격 연결', exact: true }).click();
    await page.getByRole('button', { name: '이 기기 연결 해제', exact: true }).click();
    assert.equal(await page.evaluate('window.calls.some(call => call.method === "auth.logout")'), false);
    await page.getByRole('button', { name: '접속 권한 해제', exact: true }).click();
    await page.waitForFunction('window.settingsClosed === true');
    assert.equal(await page.evaluate('window.calls.filter(call => call.method === "auth.logout").length'), 1);
    assert.equal(await page.evaluate('window.errors.length'), 3, 'Rejected import files must report their error');
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
