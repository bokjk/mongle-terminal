import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';

test('closing a dialog opened from a menu item returns focus to the menu button', { skip: process.platform !== 'win32' || !existsSync('dist/web/index.html'), timeout: 60000 }, async () => {
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
    const group = { id: 'group-1', name: '작업', cwd: 'C:\\', profileId: 'powershell', revision: 1, layout: null };
    (window as any).mongle = {
      request: async () => ({ hostId: 'local', bootId: 'test', version: '0.3.21', name: '현재 컴퓨터', groups: [group], terminals: [], profiles: [], settings: { name: '테스트', recordHistory: true, scrollback: 5000 } }),
      subscribe: () => () => {}, onConnection: (fn: any) => { fn({ status: 'connected', owner: true, connectionId: 'test' }); return () => {}; },
      listHosts: async () => [{ id: 'local', name: '현재 컴퓨터', local: true, selected: true }],
      selectHost: async () => ({ status: 'connected', owner: true, connectionId: 'test' }),
      addHost: async () => { throw new Error('not used'); },
    };
  });
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const menu = page.locator('details.group-actions');
    const opener = menu.locator('summary');
    const item = menu.getByRole('button', { name: '그룹 설정', exact: true });
    const dialog = page.getByRole('dialog', { name: '그룹 설정' });
    // Choosing an item closes the menu, which hides the item that opened the dialog.
    await opener.click();
    await item.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('details.group-actions[open]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    // The keyboard path and the close button return to the same menu button.
    await page.keyboard.press('Enter');
    await expect(page.locator('details.group-actions[open]')).toHaveCount(1);
    await page.keyboard.press('Tab'); await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '닫기' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
