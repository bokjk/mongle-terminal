import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron, expect } from '@playwright/test';

test('desktop clipboard: selection copy, interrupt, native paste, context menu and confirmation',
  { skip: process.platform !== 'win32' || process.env.MONGLE_E2E_CLIPBOARD !== '1', timeout: 90000 }, async () => {
    const root = process.cwd();
    const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-clipboard-'));
    const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_DATA_DIR: dataDir }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.env.MONGLE_E2E_EXE;
    const app = await _electron.launch({ executablePath: executable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: executable ? [] : [root], cwd: root, env: env as Record<string, string>, timeout: 30000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let passed = false;
    let hostPid: number | undefined;
    let shellPids: number[] = [];
    const output = path.join(root, 'test-results/e2e/clipboard'); await mkdir(output, { recursive: true });
    try {
      // Preserve all existing clipboard formats, without returning their contents.
      await app.evaluate(async ({ clipboard }) => {
        (globalThis as any).__previousClipboard = await clipboard.read();
      });
      await expect(page.getByRole('button', { name: '새 터미널', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '새 터미널', exact: true }).click();
      await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
      await page.getByText('여기서 제어 중', { exact: true }).waitFor();
      hostPid = JSON.parse(await readFile(path.join(dataDir, 'host-info.json'), 'utf8')).pid;
      const state = await page.evaluate(() => window.mongle!.request('state.get'));
      shellPids = state.terminals.map((terminal: any) => terminal.pid).filter(Boolean);
      // A raw-mode child reports received bytes, so copying must never send ETX
      // and pasting must arrive exactly once without running shell commands.
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('node -e "process.stdin.setRawMode(true); console.log(\'MONGLE_CLIP_COPY\'); process.stdin.on(\'data\',b=>console.log(\'RX:\'+b.toString(\'hex\')));"');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.xterm-rows > div')).some(row => row.textContent?.trim() === 'MONGLE_CLIP_COPY'));
      const selectMarker = async () => {
        const box = await page.locator('.xterm-rows > div').filter({ hasText: /^MONGLE_CLIP_COPY\s*$/ }).last().boundingBox();
        assert.ok(box);
        await page.mouse.dblclick(box.x + 35, box.y + box.height / 2);
      };
      await selectMarker();
      await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'MONGLE_CLIP_COPY')).toBe(true);
      await page.keyboard.press('Control+c');
      await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'MONGLE_CLIP_COPY')).toBe(true);
      await expect(page.getByRole('status').filter({ hasText: '선택한 내용을 복사했습니다.' })).toBeVisible();
      assert.ok(!(await page.locator('.xterm-rows').innerText()).includes('RX:03'));
      await page.keyboard.press('Control+Shift+c');
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'MONGLE_CLIP_COPY');
      await page.locator('.xterm-helper-textarea').click({ force: true });
      await page.keyboard.press('Control+c');
      await expect(page.locator('.xterm-rows')).toContainText('RX:03');
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_PASTE'));
      await page.keyboard.press('Control+v');
      const hex = Buffer.from('MONGLE_CLIP_PASTE').toString('hex');
      await expect(page.locator('.xterm-rows')).toContainText('RX:' + hex);
      assert.equal((await page.locator('.xterm-rows').innerText()).split('RX:' + hex).length - 1, 1);
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_SHIFT'));
      await page.keyboard.press('Control+Shift+v');
      await expect(page.locator('.xterm-rows')).toContainText('RX:' + Buffer.from('MONGLE_CLIP_SHIFT').toString('hex'));
      await selectMarker();
      await page.locator('.terminal-canvas').click({ button: 'right', modifiers: ['Shift'], position: { x: 120, y: 100 } });
      const menu = page.getByRole('dialog', { name: '터미널 복사와 붙여넣기' });
      await menu.getByRole('button', { name: '복사', exact: false }).click();
      assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'MONGLE_CLIP_COPY');
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_RIGHT'));
      await page.locator('.terminal-canvas').click({ button: 'right', position: { x: 120, y: 100 } });
      await expect(page.locator('.xterm-rows')).toContainText('RX:' + Buffer.from('MONGLE_CLIP_RIGHT').toString('hex'));
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_LINE1\nMONGLE_CLIP_LINE2'));
      await page.locator('.terminal-canvas').click({ button: 'right', position: { x: 120, y: 100 } });
      await page.getByRole('heading', { name: '여러 줄을 붙여넣을까요?' }).waitFor();
      await page.getByRole('button', { name: '취소', exact: true }).click();
      assert.ok(!(await page.locator('.xterm-rows').innerText()).includes(Buffer.from('MONGLE_CLIP_LINE1').toString('hex')));
      await page.screenshot({ path: path.join(output, 'desktop.png') });
      assert.deepEqual(errors, []); passed = true;
    } finally {
      if (!passed) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      // Do not overwrite clipboard changes made by the user during the test.
      await app.evaluate(async ({ clipboard }) => {
        if (!(await clipboard.readText()).startsWith('MONGLE_CLIP_')) return;
        const previous = (globalThis as any).__previousClipboard;
        if (previous?.length) await clipboard.write(previous); else clipboard.clear();
      }).catch(() => {});
      await page.evaluate(() => window.mongle!.request('host.shutdown')).catch(() => {});
      await app.close();
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 10000;
      while ([hostPid, ...shellPids].some(pid => pid && alive(pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      const cleanedUp = ![hostPid, ...shellPids].some(pid => pid && alive(pid));
      await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed, cleanedUp, errors }, null, 2));
      assert.ok(cleanedUp);
    }
  });
