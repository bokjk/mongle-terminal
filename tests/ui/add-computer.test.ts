import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';

test('the PC app adds a Mongle PC found in the tailnet with one choice and keeps the address form', { skip: process.platform !== 'win32' || !existsSync('dist/web/index.html'), timeout: 60000 }, async () => {
  const server = createServer(async (req, res) => {
    try { const pathname = new URL(req.url!, 'http://localhost').pathname; const file = path.resolve('dist/web', pathname === '/' ? 'index.html' : pathname.slice(1)); if (!file.startsWith(path.resolve('dist/web') + path.sep)) throw new Error(); res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('window.__name = function(fn) { return fn; };');
  await page.addInitScript(() => {
    let selected = 'local';
    const hosts: any[] = [{ id: 'local', name: '현재 컴퓨터', local: true }];
    const query = new URLSearchParams(location.search);
    const calls = { find: [] as boolean[], add: [] as unknown[], select: [] as string[] };
    (window as any).addComputerCalls = calls;
    const found = { computers: [{ name: 'duego-notebook', origin: 'https://duego-notebook.tail1234.ts.net' }, { name: 'studio', origin: 'https://studio.tail1234.ts.net:8443' }], available: true, alreadyAdded: 0 };
    (window as any).mongle = {
      request: async () => ({ hostId: selected, bootId: 'test', version: '0.3.21', name: '현재 컴퓨터', groups: [], terminals: [], profiles: [], settings: { name: '테스트', recordHistory: true, scrollback: 5000 } }),
      subscribe: () => () => {}, onConnection: (fn: any) => { fn({ status: 'connected', owner: true, connectionId: 'test' }); return () => {}; },
      listHosts: async () => hosts.map(host => ({ ...host, selected: host.id === selected })),
      selectHost: async (id: string) => { calls.select.push(id); selected = id; return { status: 'pairing', owner: false, connectionId: 'test' }; },
      addHost: async (host: { name: string; url: string }) => {
        calls.add.push(host);
        if (query.has('full')) throw new Error('컴퓨터는 최대 50대까지 등록할 수 있습니다.');
        const added = { id: `host-${hosts.length}`, name: host.name, url: host.url, local: false }; hosts.push(added); return { ...added, selected: false };
      },
      findComputers: (refresh: boolean) => {
        calls.find.push(refresh);
        if (query.has('error')) return Promise.reject(new Error('Tailscale에서 작업을 완료하지 못했습니다.'));
        if (query.has('none')) return Promise.resolve({ computers: [], available: true, alreadyAdded: query.has('added') ? 1 : 0 });
        // Searching takes a while on a real network; the test decides when the answer arrives.
        return new Promise(resolve => { (window as any).releaseFind = () => resolve(found); });
      },
    };
  });
  const dialog = page.getByRole('dialog', { name: '컴퓨터 추가' });
  const status = dialog.getByRole('status');
  const refresh = dialog.locator('.found-computers-header .icon-button');
  const open = async (query = '') => {
    await page.goto(`${base}/${query}`);
    await page.getByRole('button', { name: '컴퓨터 추가', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const calls = () => page.evaluate(() => (window as any).addComputerCalls);
  try {
    await open();
    await expect(status).toHaveText('같은 Tailscale에서 다른 몽글 PC를 찾는 중…');
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByLabel('컴퓨터 이름')).toBeFocused();
    await page.evaluate(() => (window as any).releaseFind());
    const notebook = dialog.getByRole('button', { name: 'duego-notebook 추가하고 연결' });
    await expect(notebook).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'studio 추가하고 연결' })).toContainText('studio.tail1234.ts.net:8443');
    await expect(status).toHaveText('추가할 수 있는 몽글 PC 2대를 찾았습니다.');
    const row = await notebook.boundingBox(); assert.ok(row && row.height >= 44, 'Rows are large enough to click');
    const panel = await dialog.boundingBox(); assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= 1100);
    await mkdir('test-results/add-computer', { recursive: true });
    await page.screenshot({ path: 'test-results/add-computer/dark.png', animations: 'disabled' });
    assert.deepEqual((await calls()).find, [false], 'The dialog searches once when it opens');
    // Searching again keeps focus on the same control so Escape and Tab still work in the dialog.
    await refresh.click();
    await expect(refresh).toBeFocused();
    await expect(status).toHaveText('같은 Tailscale에서 다른 몽글 PC를 찾는 중…');
    await page.keyboard.press('Tab'); await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.evaluate(() => (window as any).releaseFind());
    await expect(notebook).toBeVisible();
    assert.deepEqual((await calls()).find, [false, true]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '컴퓨터 추가', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '컴퓨터 추가', exact: true }).click();
    await page.evaluate(() => (window as any).releaseFind());
    await dialog.getByRole('button', { name: 'duego-notebook 추가하고 연결' }).click();
    await expect(dialog).toHaveCount(0);
    const added = await calls();
    assert.deepEqual(added.add, [{ name: 'duego-notebook', url: 'https://duego-notebook.tail1234.ts.net' }]);
    assert.deepEqual(added.select, ['host-1'], 'Choosing a found PC adds it and connects to it');
    await expect(page.getByRole('heading', { name: '이 기기를 연결하세요' })).toBeVisible();

    await open('?error');
    await expect(status).toHaveText('Tailscale에서 작업을 완료하지 못했습니다.');
    await dialog.getByLabel('컴퓨터 이름').fill('연구실 PC');
    await dialog.getByLabel('몽글 접속 주소').fill('https://lab.tail1234.ts.net');
    await dialog.getByRole('button', { name: '추가하고 연결' }).click();
    await expect(dialog).toHaveCount(0);
    assert.deepEqual((await calls()).add, [{ name: '연구실 PC', url: 'https://lab.tail1234.ts.net' }], 'The address form still works when searching fails');

    await open('?none&added');
    await expect(status).toHaveText('찾은 몽글 PC는 모두 컴퓨터 목록에 있습니다.');
    await open('?none');
    await expect(status).toContainText('추가할 몽글 PC를 찾지 못했습니다.');

    await open('?full');
    await page.evaluate(() => (window as any).releaseFind());
    const fullRow = dialog.getByRole('button', { name: 'duego-notebook 추가하고 연결' });
    await fullRow.click();
    await expect(dialog.getByRole('alert')).toHaveText('컴퓨터는 최대 50대까지 등록할 수 있습니다.');
    await expect(fullRow).toBeFocused();
    await expect(fullRow).toHaveAttribute('aria-disabled', 'false');
    assert.deepEqual((await calls()).select, [], 'A failed add does not switch computers');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: 'test-results/add-computer/light.png', animations: 'disabled' });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
