import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';

test('host picker supports themed options, deliberate selection, keyboard dismissal and narrow screens', { skip: process.platform !== 'win32' || !existsSync('dist/web/index.html'), timeout: 45000 }, async () => {
  const server = createServer(async (req, res) => {
    try { const pathname = new URL(req.url!, 'http://localhost').pathname; const file = path.resolve('dist/web', pathname === '/' ? 'index.html' : pathname.slice(1)); if (!file.startsWith(path.resolve('dist/web') + path.sep)) throw new Error(); res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('window.__name = function(fn) { return fn; };');
  await page.addInitScript(() => {
    let selected = 'local';
    const hosts = [{ id: 'local', name: '현재 컴퓨터', local: true }, { id: 'work', name: '작업용 데스크톱', local: false }, { id: 'lab', name: '개발 실험용 컴퓨터 · 이름이 길어도 자연스럽게', local: false }];
    const query = new URLSearchParams(location.search);
    if (query.has('single')) hosts.splice(1);
    if (query.has('many')) hosts.push(...Array.from({ length: 30 }, (_, index) => ({ id: `extra-${index}`, name: `테스트 컴퓨터 ${index + 1}`, local: false })));
    const calls: string[] = []; (window as any).hostPickerCalls = calls;
    (window as any).mongle = {
      request: async () => ({ hostId: selected, bootId: 'test', version: '0.3.2', name: hosts.find(h => h.id === selected)!.name, groups: [], terminals: [], profiles: [], settings: { name: '테스트', recordHistory: true, scrollback: 5000 } }),
      subscribe: () => () => {}, onConnection: (fn: any) => { fn({ status: 'connected', owner: true, connectionId: 'test' }); return () => {}; },
      listHosts: async () => hosts.map(host => ({ ...host, selected: host.id === selected })),
      selectHost: async (id: string) => { calls.push(id); selected = id; return { status: 'connected', owner: id === 'local', connectionId: 'test' }; },
    };
  });
  try {
    await page.goto(`http://127.0.0.1:${address.port}`);
    const trigger = page.getByRole('button', { name: '접속할 컴퓨터', exact: true });
    const list = page.getByRole('listbox', { name: '접속할 컴퓨터 목록' });
    await expect(trigger).toContainText('현재 컴퓨터'); await trigger.click();
    await expect(list).toBeFocused(); await expect(page.getByRole('option')).toHaveCount(3);
    await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    const box = await page.locator('.host-popover').boundingBox(); assert.ok(box && box.width >= 280);
    const row = await page.getByRole('option').first().boundingBox(); assert.ok(row && row.height >= 56);
    await mkdir('test-results/host-picker', { recursive: true });
    await page.screenshot({ path: 'test-results/host-picker/dark.png', animations: 'disabled', clip: { x: 0, y: 50, width: 340, height: 340 } });
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await page.evaluate(() => (window as any).hostPickerCalls), []);
    await page.keyboard.press('Escape'); await expect(list).toHaveCount(0); await expect(trigger).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(trigger).toContainText('작업용 데스크톱');
    assert.deepEqual(await page.evaluate(() => (window as any).hostPickerCalls), ['work']);
    await trigger.click(); await page.getByRole('option', { selected: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).hostPickerCalls), ['work']);
    await trigger.click(); await page.keyboard.press('Tab'); await expect(list).toHaveCount(0); await expect(page.getByRole('button', { name: '컴퓨터 추가', exact: true })).toBeFocused();
    await trigger.click(); await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await expect(trigger).toContainText('현재 컴퓨터');
    await trigger.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await expect(trigger).toContainText('개발 실험용');
    await trigger.click(); await page.getByRole('heading', { name: '나의 작업 공간' }).click(); await expect(list).toHaveCount(0);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await trigger.click(); await page.screenshot({ path: 'test-results/host-picker/light.png', animations: 'disabled', clip: { x: 0, y: 50, width: 340, height: 340 } });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole('button', { name: '그룹 메뉴 열기' }).click(); await trigger.click();
    const mobile = await page.locator('.host-popover').boundingBox(); assert.ok(mobile && mobile.x >= 0 && mobile.x + mobile.width <= 320);
    await page.screenshot({ path: 'test-results/host-picker/mobile.png' });
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.goto(`http://127.0.0.1:${address.port}/?single`); await trigger.click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown'); await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: 'test-results/host-picker/single.png', animations: 'disabled', clip: { x: 0, y: 50, width: 340, height: 250 } });
    await page.keyboard.press('Enter'); assert.deepEqual(await page.evaluate(() => (window as any).hostPickerCalls), []);
    await page.goto(`http://127.0.0.1:${address.port}/?many`); await trigger.click(); await page.keyboard.press('End');
    await expect(page.getByRole('option').last()).toBeInViewport();
    assert.ok(await list.evaluate(element => element.scrollTop > 0));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
