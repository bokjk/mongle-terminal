import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const browserOptions = { skip: chrome ? false : 'Requires installed Windows Chrome for trusted mobile touch events.', timeout: 30000 };

function recordEvidence(name: string, evidence: unknown) {
  const directory = process.env.MONGLE_TOUCH_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function withMobileTerminal(check: (page: Page, touch: CDPSession, engine: TerminalEngine) => Promise<void>) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./browser-harness.ts', import.meta.url))], bundle: true, write: false, format: 'iife', platform: 'browser' });
  const xtermCss = readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
  const appCss = readFileSync(new URL('../../apps/web/src/styles.css', import.meta.url), 'utf8').replace(/@import[^;]+;/g, '');
  const server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(`${xtermCss}\n${appCss}`); }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="terminal" style="width:370px;height:300px;margin:20px 10px"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' });
    const touch = await page.context().newCDPSession(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await check(page, touch, engine);
  } finally {
    await browser.close();
    await engine.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function position(page: Page) {
  return page.evaluate(() => {
    const h = (window as any).mongleTerminalTest;
    const buffer = h.terminal.buffer.active;
    return { viewport: buffer.viewportY, base: buffer.baseY, type: buffer.type,
      topLine: buffer.getLine(buffer.viewportY)?.translateToString(true), inputs: h.inputs,
      readonly: h.terminal.textarea.readOnly, focused: document.activeElement === h.terminal.textarea };
  });
}

// This goes through Chrome's trusted touch pipeline rather than dispatchEvent,
// mouse-wheel simulation, or directly setting the terminal scroll position.
async function swipe(page: Page, touch: CDPSession, direction: 'history' | 'latest') {
  const rect = await page.locator('.xterm-screen').boundingBox();
  assert.ok(rect && rect.height > 60);
  const x = rect.x + rect.width / 2;
  const start = rect.y + rect.height * (direction === 'history' ? 0.2 : 0.8);
  const end = rect.y + rect.height * (direction === 'history' ? 0.8 : 0.2);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start, id: 1 }] });
  for (let step = 1; step <= 8; step += 1) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 8, id: 1 }] });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('real Chrome Android emulation: readonly history swipes scroll both directions and survive snapshots', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.write(Array.from({ length: 100 }, (_, index) => `history-${String(index).padStart(3, '0')}\r\n`).join(''));
    const snapshot = await engine.snapshot();
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame);
      h.adapter.setInputEnabled(false);
      h.trustedMoves = 0;
      h.terminal.element.addEventListener('touchmove', (event: TouchEvent) => {
        if (event.isTrusted) h.trustedMoves += 1;
      }, { passive: true, capture: true });
    }, snapshot);
    const initial = await position(page);
    assert.ok(initial.base > 50);
    assert.equal(initial.viewport, initial.base);
    assert.equal(initial.readonly, true);
    await swipe(page, touch, 'history');
    const earlier = await position(page);
    assert.ok(await page.evaluate(() => (window as any).mongleTerminalTest.trustedMoves > 0),
      'Chrome delivered trusted finger movement to the terminal');
    assert.ok(earlier.viewport < initial.viewport, `finger drag must reveal history: ${JSON.stringify({ initial, earlier })}`);
    assert.notEqual(earlier.topLine, initial.topLine);
    assert.deepEqual(earlier.inputs, []);

    await engine.write('new-host-output\r\n');
    const updated = await engine.snapshot();
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      for (let index = 0; index < 8; index += 1) await h.adapter.applySnapshot(frame);
    }, updated);
    const refreshed = await position(page);
    assert.equal(refreshed.topLine, earlier.topLine, 'new output and repeated snapshots keep the history line being read');
    assert.equal(refreshed.viewport, earlier.viewport, 'unchanged history retains its viewport position');
    await swipe(page, touch, 'latest');
    const later = await position(page);
    assert.ok(later.viewport > refreshed.viewport, 'the reverse finger drag returns toward latest output');
    assert.deepEqual(later.inputs, []);
    recordEvidence('readonly-history', { initial, earlier, afterAppendAndSnapshots: refreshed, later });
  }));

test('real Chrome Android emulation: scrolling keeps the focused editor writable through snapshots and an input fence', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.write(Array.from({ length: 80 }, (_, index) => `editable-${index}\r\n`).join(''));
    const snapshot = await engine.snapshot();
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame);
      h.adapter.setInputEnabled(true);
      h.terminal.focus();
      h.originalTextarea = h.terminal.textarea;
      h.blurs = 0;
      h.readonlyMutations = 0;
      h.originalTextarea.addEventListener('blur', () => { h.blurs += 1; });
      h.observer = new MutationObserver((records: MutationRecord[]) => {
        h.readonlyMutations += records.filter(record => record.attributeName === 'readonly').length;
      });
      h.observer.observe(h.originalTextarea, { attributes: true });
    }, snapshot);
    const initial = await position(page);
    await swipe(page, touch, 'history');
    const earlier = await position(page);
    assert.ok(earlier.viewport < initial.viewport);
    assert.equal(earlier.focused, true);
    assert.equal(earlier.readonly, false);
    assert.deepEqual(earlier.inputs, [], 'a local scroll must not become terminal input');
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      for (let index = 0; index < 6; index += 1) await h.adapter.applySnapshot(frame);
    }, snapshot);
    await swipe(page, touch, 'latest');
    const later = await position(page);
    assert.ok(later.viewport > earlier.viewport);
    assert.equal(later.focused, true);
    assert.equal(later.readonly, false);
    const editor = await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      h.adapter.setInputEnabled(true);
      h.observer.disconnect();
      return { blurs: h.blurs, readonlyMutations: h.readonlyMutations, same: h.terminal.textarea === h.originalTextarea };
    });
    assert.deepEqual(editor, { blurs: 0, readonlyMutations: 0, same: true });
    await page.keyboard.insertText('한');
    const afterTyping = await position(page);
    assert.deepEqual(afterTyping.inputs, [['한', 'utf8']], 'the retained editor accepts new input');
    recordEvidence('focused-editor', { initial, earlier, later, editor, afterTyping });
  }));

test('real Chrome Android emulation: multi-touch remains available to native pinch zoom', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.write(Array.from({ length: 80 }, (_, index) => `pinch-${index}\r\n`).join(''));
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame);
      h.multiMoves = 0;
      h.preventedMulti = 0;
      const originalPreventDefault = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function () {
        if (this instanceof TouchEvent && this.touches.length > 1) h.preventedMulti += 1;
        originalPreventDefault.call(this);
      };
      document.addEventListener('touchmove', (event: TouchEvent) => {
        if (event.touches.length > 1 && event.isTrusted) h.multiMoves += 1;
      }, { passive: true, capture: true });
    }, await engine.snapshot());
    const initial = await position(page);
    const initialScale = await page.evaluate(() => window.visualViewport!.scale);
    const rect = await page.locator('.xterm-screen').boundingBox();
    assert.ok(rect);
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const points = (spread: number, translation: number) => [
      { x: centerX - spread, y: centerY - 20 + translation, id: 1 },
      { x: centerX + spread, y: centerY + 20 + translation, id: 2 },
    ];
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35, -15) });
    for (let step = 1; step <= 8; step += 1) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(35 + step * 10, -15 + step * 3) });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const observed = await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      return { moves: h.multiMoves, prevented: h.preventedMulti,
        touchAction: getComputedStyle(document.querySelector('.xterm-screen')!).touchAction,
        scale: window.visualViewport!.scale };
    });
    assert.ok(observed.moves > 0, 'trusted multi-touch reaches the terminal');
    assert.equal(observed.prevented, 0, 'the terminal must not cancel multi-touch default behavior');
    assert.match(observed.touchAction, /pinch-zoom|auto|manipulation/);
    assert.ok(observed.scale > initialScale, `native pinch increases visual viewport scale: ${initialScale} -> ${observed.scale}`);
    const after = await position(page);
    assert.equal(after.viewport, initial.viewport, 'two-finger movement must not become history scrolling');
    assert.deepEqual(after.inputs, []);
    recordEvidence('pinch', { initialScale, observed, initial, after });
  }));

test('real Chrome Android emulation: alternate screen swipes send no keys and disposal removes scrolling', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.write(Array.from({ length: 80 }, (_, index) => `normal-${index}\r\n`).join(''));
    const normal = await engine.snapshot();
    await engine.write('\x1b[?1049h\x1b[?1halternate application');
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame);
      h.adapter.setInputEnabled(true);
    }, await engine.snapshot());
    assert.equal((await position(page)).type, 'alternate');
    await swipe(page, touch, 'history');
    await swipe(page, touch, 'latest');
    const alternate = await position(page);
    assert.equal(alternate.viewport, 0);
    assert.deepEqual(alternate.inputs, [], 'alternate-screen gestures must not send synthetic arrow keys');

    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame);
    }, normal);
    const live = await position(page);
    await swipe(page, touch, 'history');
    const scrolled = await position(page);
    assert.ok(scrolled.viewport < live.viewport, 'normal scrolling resumes after leaving the alternate screen');
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.dispose());
    await swipe(page, touch, 'history');
    const disposed = await position(page);
    assert.equal(disposed.viewport, scrolled.viewport, 'the adapter removes its gesture listeners on disposal');
    assert.deepEqual(disposed.inputs, []);
    recordEvidence('alternate-and-disposal', { alternate, normalBeforeSwipe: live, scrolled, disposed });
  }));
