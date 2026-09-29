import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

const browserOptions = { skip: chrome ? false : 'Requires installed Windows Chrome for the real DOM check.', timeout: 30000 };

async function withTerminalBrowser(check: (page: Page, engine: TerminalEngine) => Promise<void>, mobile = false) {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('./browser-harness.ts', import.meta.url))], bundle: true, write: false, format: 'iife', platform: 'browser' });
    const css = readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url));
    const server = createServer((req, res) => {
      if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
      else if (req.url === '/xterm.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/xterm.css"></head><body><div id="terminal" style="width:600px;height:300px"></div><script src="/app.js"></script></body></html>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage(mobile ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : {});
      await page.goto(`http://127.0.0.1:${address.port}`);
      await check(page, engine);
    } finally {
      await browser.close();
      await engine.dispose();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test('real Chrome: repeated frames preserve typing, application cursor, selection and IME commit',
  browserOptions, async () => withTerminalBrowser(async (page, engine) => {
      await engine.write('select me\r\n몽글 terminal\x1b[?1h\x1b[?2004h');
      const frame = await engine.snapshot();
      await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(snapshot);
        h.adapter.setInputEnabled(true);
        h.terminal.focus();
      }, frame);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Control+c');
      await page.evaluate(snapshot => {
        const h = (window as any).mongleTerminalTest;
        h.frames = setInterval(() => { void h.adapter.applySnapshot(snapshot); }, 5);
      }, frame);
      await page.keyboard.type('keep-all-letters', { delay: 8 });
      await page.keyboard.insertText('몽글');
      await page.evaluate(() => clearInterval((window as any).mongleTerminalTest.frames));
      await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(snapshot);
        h.terminal.select(0, 0, 9);
        await h.adapter.applySnapshot(snapshot);
      }, frame);
      const result = await page.evaluate(() => {
        const h = (window as any).mongleTerminalTest;
        return { inputs: h.inputs, selected: h.terminal.getSelection() };
      });
      assert.equal(result.inputs.map((item: [string, string]) => item[0]).join(''), '\x1bOA\x03keep-all-letters몽글');
      assert.ok(result.inputs.every((item: [string, string]) => item[1] === 'utf8'));
      assert.equal(result.selected, 'select me');
      const composition = await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        h.terminal.clearSelection();
        const textarea = h.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart'));
        const applied = h.adapter.applySnapshot(snapshot);
        textarea.value = '한';
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '한' }));
        textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
        await applied;
        return h.inputs[h.inputs.length - 1];
      }, frame);
      assert.deepEqual(composition, ['한', 'utf8'], 'the deferred xterm IME commit runs before snapshot reset');
  }));

test('real Chrome mobile emulation: resize fences preserve the writable focused editor without replaying blocked input',
  browserOptions, async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('mobile resize');
    const frame = await engine.snapshot();
    const initial = await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(snapshot);
      // A trusted acquire gesture must be able to open the keyboard before the
      // lease request/ACK returns, while transmission is still closed.
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      h.terminal.focus();
      h.textarea = h.terminal.textarea;
      h.blurs = 0;
      h.readonlyMutations = 0;
      h.textarea.addEventListener('blur', () => { h.blurs += 1; });
      h.observer = new MutationObserver((records: MutationRecord[]) => {
        h.readonlyMutations += records.filter(record => record.attributeName === 'readonly').length;
      });
      h.observer.observe(h.textarea, { attributes: true });
      h.terminal.input('before acquire ACK', true);
      return { readonly: h.textarea.readOnly, focused: document.activeElement === h.textarea, inputs: h.inputs };
    }, frame);
    assert.deepEqual(initial, { readonly: false, focused: true, inputs: [] });
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.setInputEnabled(true));
    await page.keyboard.insertText('before');
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.setInputEnabled(false, { preserveKeyboard: true }));
    await page.setViewportSize({ width: 390, height: 460 });
    await page.keyboard.insertText('blocked');
    const gated = await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      for (let index = 0; index < 12; index += 1) {
        h.adapter.setInputEnabled(false, { preserveKeyboard: true });
        await h.adapter.applySnapshot({ ...snapshot, rows: index % 2 ? 8 : 6 });
        h.terminal.input('blocked native', true);
        h.terminal._core.coreService.triggerBinaryEvent('blocked binary');
        h.adapter.sendInput('\x03');
        h.adapter.sendKey('ArrowUp');
        h.adapter.paste('blocked paste');
      }
      return { readonly: h.textarea.readOnly, focused: document.activeElement === h.textarea,
        sameEditor: h.terminal.textarea === h.textarea, blurs: h.blurs,
        readonlyMutations: h.readonlyMutations, inputs: h.inputs };
    }, frame);
    assert.deepEqual(gated, { readonly: false, focused: true, sameEditor: true, blurs: 0,
      readonlyMutations: 0, inputs: [['before', 'utf8']] });
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.setInputEnabled(true));
    await page.keyboard.insertText('after');
    assert.deepEqual(await page.evaluate(() => (window as any).mongleTerminalTest.inputs),
      [['before', 'utf8'], ['after', 'utf8']], 'normal input resumes after the resize ACK');

    const composition = await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      const textarea = h.textarea;
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '한';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '한' }));
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      let rendered = false;
      const pending = h.adapter.applySnapshot(snapshot).then(() => { rendered = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      const during = { rendered, value: textarea.value, readonly: textarea.readOnly,
        focused: document.activeElement === textarea };
      h.adapter.setInputEnabled(true);
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
      await pending;
      // A fresh, fully authorized composition must still work.
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '새';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '새' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '새' }));
      await h.adapter.applySnapshot(snapshot);
      return { during, inputs: h.inputs, blurs: h.blurs, readonlyMutations: h.readonlyMutations };
    }, frame);
    assert.deepEqual(composition, {
      during: { rendered: false, value: '한', readonly: false, focused: true },
      inputs: [['before', 'utf8'], ['after', 'utf8'], ['새', 'utf8']], blurs: 0, readonlyMutations: 0,
    }, 'a gate does not reset a live IME; its stale commit is dropped and a fresh composition works');

    const lateInput = await page.evaluate(async () => {
      const h = (window as any).mongleTerminalTest;
      const textarea = h.textarea;
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      textarea.value = '';
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
      textarea.value = '!';
      h.adapter.setInputEnabled(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '닫';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '닫' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '닫' }));
      h.adapter.setInputEnabled(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      // Also quarantine an already scheduled composition commit across a hard
      // lease/uncertainty fence, even if a new ACK reopens it immediately.
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '늦';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '늦' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '늦' }));
      h.adapter.setInputEnabled(false);
      const hardReadonly = textarea.readOnly;
      h.adapter.setInputEnabled(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      h.terminal.input('fresh', true);
      h.adapter.setInputEnabled(false);
      h.terminal.input('hard blocked', true);
      h.adapter.sendInput('hard blocked control');
      h.adapter.dispose();
      h.adapter.setInputEnabled(true, { preserveKeyboard: true });
      return { inputs: h.inputs, hardReadonly, disposedReadonly: textarea.readOnly };
    });
    assert.deepEqual(lateInput, { inputs: [['before', 'utf8'], ['after', 'utf8'], ['새', 'utf8'], ['fresh', 'utf8']],
      hardReadonly: true, disposedReadonly: true });
  }, true));
