import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const root = fileURLToPath(new URL('../../', import.meta.url));
// A real P-256 point is not needed: the page only passes the key bytes to the browser.
const KEY = 'B' + 'A'.repeat(86);

// Browser APIs a phone would provide. Real push services are not reachable from a test.
const browserStubs = String.raw`
  window.__pushCalls = [];
  const keyBytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  let current = null;
  const subscription = key => ({
    endpoint: 'https://push.example.net/push/phone',
    options: { applicationServerKey: key.buffer.slice(0) },
    toJSON: () => ({ endpoint: 'https://push.example.net/push/phone', keys: { p256dh: 'BPpublic', auth: 'AUsecret' } }),
    unsubscribe: async () => { window.__pushCalls.push('local-unsubscribe'); current = null; return true; },
  });
  const registration = {
    pushManager: {
      getSubscription: async () => current,
      subscribe: async options => { window.__pushCalls.push(['subscribe', options.userVisibleOnly, Array.from(new Uint8Array(options.applicationServerKey)).join(',')]); current = subscription(new Uint8Array(options.applicationServerKey)); return current; },
    },
    getNotifications: async () => [],
  };
  window.__permission = 'default';
  window.__answer = 'granted';
  class FakeNotification { static get permission() { return window.__permission; } static async requestPermission() { window.__pushCalls.push('permission'); window.__permission = window.__answer; return window.__answer; } }
  window.Notification = FakeNotification;
  window.PushManager = function PushManager() {};
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    register: async () => { window.__pushCalls.push('register'); return registration; },
    ready: Promise.resolve(registration),
    getRegistration: async () => registration,
    addEventListener() {}, removeEventListener() {},
  } });
  window.__expectedKey = Array.from(keyBytes('${KEY}')).join(',');
`;

test('phone notification settings explain the rule, turn on through the browser prompt, send a test and turn off', { skip: chrome ? false : 'Requires installed Windows Chrome.', timeout: 60000 }, async () => {
  const source = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {PushSettings} from './apps/web/src/PushSettings';
    let host = { publicKey: '${KEY}', subscribed: false };
    window.__requests = [];
    const client = { request: async (method, params) => {
      window.__requests.push([method, params]);
      if (method === 'push.status') return { ...host };
      if (method === 'push.subscribe') { host = { ...host, subscribed: true, endpoint: params.endpoint }; return { ok: true }; }
      if (method === 'push.unsubscribe') { host = { publicKey: host.publicKey, subscribed: false }; return { ok: true }; }
      if (method === 'push.test') { if (window.__failTest) throw new Error('알림 서비스에 연결하지 못했습니다. PC의 인터넷 연결을 확인해 주세요.'); return { ok: true }; }
      throw new Error('unexpected ' + method);
    } };
    const state = { hostId: 'h', bootId: 'b', name: 'DESKTOP-EXAMPLE-WITH-A-LONG-NAME', capabilities: ['notifications.push'], terminals: [], groups: [] };
    const root = createRoot(document.getElementById('root'));
    window.render = (capabilities = state.capabilities) => root.render(<div className="settings-content"><PushSettings key={String(Math.random())} client={client} state={{ ...state, capabilities }} /></div>);
    window.render();
  `;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: root }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const css = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url));
  const icon = readFileSync(new URL('../../apps/web/public/icon-192.png', import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else if (request.url === '/icon-192.png') { response.setHeader('Content-Type', 'image/png'); response.end(icon); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const open = async (options: { width?: number; userAgent?: string; stubs?: string } = {}) => {
    const page = await browser.newPage({ viewport: { width: options.width ?? 390, height: 844 }, ...(options.userAgent ? { userAgent: options.userAgent } : {}) });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript('window.__name = function(fn) { return fn; };');
    await page.addInitScript(options.stubs ?? browserStubs);
    await page.goto(url);
    return { page, errors };
  };
  const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  try {
    const { page, errors } = await open();
    await page.getByRole('heading', { name: '이 기기로 알림 받기' }).waitFor();
    await page.getByText('Claude·Codex가 확인이나 답을 기다릴 때').waitFor();
    await page.getByText('새 기기가 이 PC에 연결을 요청할 때').waitFor();
    await page.getByText('5분 넘게 키보드·마우스 입력이 없을 때만', { exact: false }).waitFor();
    await page.getByRole('status').filter({ hasText: '꺼져 있습니다.' }).waitFor();
    assert.equal(await noOverflow(page), true, '390px wide without horizontal scrolling');
    await page.screenshot({ path: 'test-results/ui/push-settings-390.png', fullPage: true });
    await page.getByRole('button', { name: '알림 켜기' }).click();
    await page.getByRole('status').filter({ hasText: '켜져 있습니다.' }).waitFor();
    await page.getByText('알림을 켰습니다.', { exact: false }).waitFor();
    await page.screenshot({ path: 'test-results/ui/push-settings-on-390.png', fullPage: true });
    const calls = await page.evaluate('window.__pushCalls') as unknown[];
    assert.deepEqual(calls.slice(0, 2), ['permission', 'register'], 'the browser asks only after the button');
    const subscribe = calls.find(item => Array.isArray(item) && item[0] === 'subscribe') as unknown[];
    assert.equal(subscribe[1], true, 'userVisibleOnly');
    assert.equal(subscribe[2], await page.evaluate('window.__expectedKey'), 'subscribes with this PC key');
    const requests = await page.evaluate('window.__requests') as Array<[string, any]>;
    assert.deepEqual(requests.find(([method]) => method === 'push.subscribe')![1], { endpoint: 'https://push.example.net/push/phone', keys: { p256dh: 'BPpublic', auth: 'AUsecret' } });
    await page.getByRole('button', { name: '시험 알림 보내기' }).click();
    await page.getByText('시험 알림을 보냈습니다.', { exact: false }).waitFor();
    await page.evaluate('window.__failTest = true');
    await page.getByRole('button', { name: '시험 알림 보내기' }).click();
    await page.getByRole('alert').filter({ hasText: 'PC의 인터넷 연결을 확인해 주세요.' }).waitFor();
    await page.getByRole('button', { name: '알림 끄기' }).click();
    await page.getByRole('status').filter({ hasText: '꺼져 있습니다.' }).waitFor();
    assert.ok((await page.evaluate('window.__requests') as Array<[string]>).some(([method]) => method === 'push.unsubscribe'));
    assert.ok((await page.evaluate('window.__pushCalls') as unknown[]).includes('local-unsubscribe'));
    await page.evaluate("window.__answer = 'denied'");
    await page.getByRole('button', { name: '알림 켜기' }).click();
    await page.getByRole('alert').filter({ hasText: '알림이 차단되어 있습니다' }).waitFor();
    await page.getByRole('status').filter({ hasText: '사이트 설정에서 알림을 허용한 뒤' }).waitFor();
    await page.getByRole('button', { name: '다시 확인' }).waitFor();
    await page.evaluate('window.render([])');
    await page.waitForFunction(() => !document.querySelector('.push-settings'));
    assert.deepEqual(errors, []);

    const narrow = await open({ width: 320 });
    await narrow.page.getByRole('button', { name: '알림 켜기' }).waitFor();
    assert.equal(await noOverflow(narrow.page), true, '320px wide without horizontal scrolling');
    const unsupported = await open({ stubs: 'delete window.PushManager;' });
    await unsupported.page.getByText('이 브라우저는 웹 알림을 지원하지 않습니다.', { exact: false }).waitFor();
    assert.equal(await unsupported.page.getByRole('button', { name: '알림 켜기' }).count(), 0);
    const iphone = await open({ stubs: 'delete window.PushManager;', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await iphone.page.getByText('홈 화면에 추가로 설치한 앱에서', { exact: false }).waitFor();
    const desktop = await open({ stubs: browserStubs + 'window.mongle = {};' });
    await desktop.page.waitForTimeout(300);
    assert.equal(await desktop.page.locator('.push-settings').count(), 0, 'the PC app does not offer phone notifications for itself');
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
