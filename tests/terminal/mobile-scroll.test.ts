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
async function swipe(page: Page, touch: CDPSession, direction: 'history' | 'latest', coast = false) {
  const rect = await page.locator('.xterm-screen').boundingBox();
  assert.ok(rect && rect.height > 60);
  const x = rect.x + rect.width / 2;
  const start = rect.y + rect.height * (direction === 'history' ? 0.2 : 0.8);
  const end = rect.y + rect.height * (direction === 'history' ? 0.8 : 0.2);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start, id: 1 }] });
  for (let step = 1; step <= 8; step += 1) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 8, id: 1 }] });
  }
  // Hold before release in distance/encoding checks; inertia has separate tests.
  if (!coast) await page.waitForTimeout(100);
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

test('real Chrome Android emulation: fullscreen mouse applications receive touch wheels through xterm encodings', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    for (const encoding of ['SGR', 'DEFAULT', 'SGR_PIXELS']) {
      await engine.write('\x1bc\x1b[?1049h\x1b[?1003h' +
        (encoding === 'DEFAULT' ? '' : encoding === 'SGR' ? '\x1b[?1006h' : '\x1b[?1016h') + 'touch application');
      await page.evaluate(async frame => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(frame); h.adapter.setInputEnabled(true); h.inputs.length = 0; h.inputSources.length = 0;
      }, await engine.snapshot());
      await swipe(page, touch, 'history');
      const up = (await position(page)).inputs as Array<[string, string]>;
      assert.ok(up.length > 1, `${encoding}: a pan spans multiple wheel steps`);
      assert.ok(await page.evaluate(() => (window as any).mongleTerminalTest.inputSources.every((source: string) => source === 'touch-scroll')),
        'Pane must distinguish touch wheel bytes from keyboard Alt/Ctrl input');
      assert.ok(up.every(([data, kind]) => encoding === 'DEFAULT'
        ? kind === 'binary' && data.startsWith('\x1b[M`')
        : kind === 'utf8' && /^\x1b\[<64;\d+;\d+M$/.test(data)), `${encoding}: use xterm wheel-up encoding, never arrows`);
      await page.evaluate(() => { (window as any).mongleTerminalTest.inputs.length = 0; });
      await swipe(page, touch, 'latest');
      const down = (await position(page)).inputs as Array<[string, string]>;
      assert.ok(down.length > 1);
      assert.ok(down.every(([data, kind]) => encoding === 'DEFAULT'
        ? kind === 'binary' && data.startsWith('\x1b[Ma')
        : kind === 'utf8' && /^\x1b\[<65;\d+;\d+M$/.test(data)));
      recordEvidence(`application-${encoding}`, { up, down });

      await page.evaluate(() => {
        const h = (window as any).mongleTerminalTest;
        h.inputs.length = 0; h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      });
      await swipe(page, touch, 'history');
      assert.deepEqual((await position(page)).inputs, [], 'a writable editor is not an open transport gate');
      await page.evaluate(() => { (window as any).mongleTerminalTest.adapter.setInputEnabled(true); });
      assert.deepEqual((await position(page)).inputs, [], 'closed-gate movements are never replayed');
    }
  }));

test('real Chrome Android emulation: touch speed reduces actual xterm wheel reports in both directions', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.resize(40, 30);
    await engine.write('\x1bc\x1b[?1049h\x1b[?1003h\x1b[?1006h' + 'scroll speed');
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame); h.adapter.setInputEnabled(true);
    }, await engine.snapshot());
    const counts: Record<string, number> = {};
    for (const speed of [0.25, 0.5, 1, 1.5, 2]) {
      await page.evaluate(value => { const h = (window as any).mongleTerminalTest; h.setTouchScrollSpeed(value); }, speed);
      for (const direction of ['history', 'latest'] as const) {
        await page.evaluate(() => { (window as any).mongleTerminalTest.inputs.length = 0; });
        await swipe(page, touch, direction);
        const reports = (await position(page)).inputs as Array<[string, string]>;
        const rect = await page.locator('.xterm-screen').boundingBox();
        const expected = Math.floor(rect!.height * 0.6 * speed / 24);
        assert.ok(Math.abs(reports.length - expected) <= 1, `speed=${speed}: ${reports.length} reports, expected about ${expected}`);
        assert.ok(reports.length > 0);
        const encoding = direction === 'history' ? /^\x1b\[<64;\d+;\d+M$/ : /^\x1b\[<65;\d+;\d+M$/;
        assert.ok(reports.every(([data, kind]) => kind === 'utf8' && encoding.test(data)));
        counts[`${speed}:${direction}`] = reports.length;
      }
    }
    for (const direction of ['history', 'latest']) {
      assert.ok(counts[`0.25:${direction}`] < counts[`0.5:${direction}`]);
      assert.ok(counts[`0.5:${direction}`] < counts[`1:${direction}`]);
      assert.ok(counts[`1:${direction}`] < counts[`2:${direction}`]);
    }
    recordEvidence('touch-speed', counts);
  }));

test('real Chrome Android emulation: unsupported alternate mouse modes do not generate keyboard history navigation', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    for (const mouseMode of ['', '\x1b[?9h']) {
      await engine.write('\x1bc\x1b[?1049h\x1b[?1h' + mouseMode + 'no wheel protocol');
      await page.evaluate(async frame => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(frame); h.adapter.setInputEnabled(true); h.inputs.length = 0;
      }, await engine.snapshot());
      await swipe(page, touch, 'history'); await swipe(page, touch, 'latest');
      assert.deepEqual((await position(page)).inputs, [], 'none/x10 never turns a swipe into CSI or SS3 arrows');
    }
  }));

test('real Chrome touch: the same physical drag sends the same CLI reports at 11, 14 and 20px', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.resize(30, 30);
    await engine.write('\x1bc\x1b[?1049h\x1b[?1003h\x1b[?1006hfont-independent touch');
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame); h.adapter.setInputEnabled(true); h.setTouchScrollSpeed(0.5);
    }, await engine.snapshot());
    const counts: Record<string, number> = {};
    for (const font of [11, 14, 20]) {
      await page.evaluate(value => { const h = (window as any).mongleTerminalTest; h.terminal.options.fontSize = value; h.inputs.length = 0; }, font);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const rect = (await page.locator('.xterm-screen').boundingBox())!;
      const x = rect.x + 50, y = rect.y + 20;
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      for (let step = 1; step <= 6; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 20, id: 1 }] });
      await page.waitForTimeout(100);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const reports = (await position(page)).inputs as Array<[string, string]>;
      assert.equal(reports.length, 2, `font ${font}: 120px at default speed = two detents`);
      counts[font] = reports.length;
    }
    recordEvidence('font-independent', counts);
  }));

test('real Chrome touch: release coasts briefly, new touch stops it and reduced motion stays still', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.resize(30, 30);
    await engine.write(Array.from({ length: 150 }, (_, index) => `momentum-${index}\r\n`).join(''));
    const snapshot = await engine.snapshot();
    const evidence: unknown[] = [];
    for (const action of ['coast', 'retouch', 'reduced']) {
      await page.emulateMedia({ reducedMotion: action === 'reduced' ? 'reduce' : 'no-preference' });
      await page.evaluate(async frame => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(frame); h.terminal.scrollToBottom(); h.setTouchScrollSpeed(0.5);
        h.releaseViewport = undefined;
        h.terminal.element.addEventListener('touchend', () => { h.releaseViewport = h.terminal.buffer.active.viewportY; }, { once: true });
      }, snapshot);
      await swipe(page, touch, 'history', true);
      const released = await page.evaluate(() => (window as any).mongleTerminalTest.releaseViewport as number);
      if (action === 'retouch') {
        const rect = (await page.locator('.xterm-screen').boundingBox())!;
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + 40, y: rect.y + 30, id: 2 }] });
      }
      const afterAction = (await position(page)).viewport;
      await page.waitForTimeout(700);
      const settled = await position(page);
      if (action === 'coast') {
        assert.ok(settled.viewport < released, 'release continues in the same direction');
        assert.ok(released - settled.viewport <= 14, 'continuation is bounded to 200px plus a row remainder');
      } else assert.equal(settled.viewport, action === 'retouch' ? afterAction : released);
      assert.deepEqual(settled.inputs, [], 'history momentum is local only');
      evidence.push({ action, released, afterAction, settled: settled.viewport });
      if (action === 'retouch') await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    recordEvidence('momentum-and-retouch', evidence);
  }));

test('real Chrome touch: local movement during a pending presentation survives viewport restoration', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.resize(30, 30);
    await engine.write(Array.from({ length: 150 }, (_, index) => `parsing-${index}\r\n`).join(''));
    const snapshot = await engine.snapshot();
    await page.evaluate(async frame => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(frame); h.terminal.scrollToLine(70); h.setTouchScrollSpeed(0.5);
    }, snapshot);
    const rect = (await page.locator('.xterm-screen').boundingBox())!;
    const x = rect.x + 40, y = rect.y + 20;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 32, id: 1 }] });
    const before = (await position(page)).viewport;
    await page.evaluate(frame => {
      const h = (window as any).mongleTerminalTest;
      const write = h.terminal.write.bind(h.terminal);
      h.terminal.write = (data: string, done: () => void) => write(data, () => {
        h.finishWrite = done; h.terminal.write = write;
      });
      h.pendingFrame = h.adapter.applySnapshot(frame);
    }, snapshot);
    await page.waitForFunction(() => !!(window as any).mongleTerminalTest.finishWrite);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 80, id: 1 }] });
    const firstPaint = await page.evaluate(async () => {
      const h = (window as any).mongleTerminalTest; h.finishWrite(); await h.pendingFrame;
      const buffer = h.terminal.buffer.active;
      return { painted: h.terminal.element.querySelector('.xterm-rows').firstElementChild.textContent.trimEnd(),
        expected: buffer.getLine(buffer.viewportY).translateToString(true) };
    });
    assert.equal(firstPaint.painted, firstPaint.expected, 'the first committed paint includes held touch movement, before another RAF');
    const after = (await position(page)).viewport;
    assert.ok(after < before, `touch during parsing must survive restoring the old viewport: ${before} -> ${after}`);
    assert.deepEqual((await position(page)).inputs, []);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    recordEvidence('pending-presentation', { before, after });
  }));

test('real Chrome touch: CLI momentum tolerates a short ACK without queuing delayed reports', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    await engine.resize(30, 30);
    await engine.write('\x1bc\x1b[?1049h\x1b[?1003h\x1b[?1006hACK timing');
    const evidence: unknown[] = [];
    for (const delay of [0, 32, 200]) {
      await page.evaluate(async ({ frame, delay }) => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(frame); h.adapter.setInputEnabled(true);
        h.setTouchScrollSpeed(0.5); h.setTouchAckDelay(delay); h.inputs.length = 0;
        h.terminal.element.addEventListener('touchend', () => { h.releaseCount = h.inputs.length; }, { once: true });
      }, { frame: await engine.snapshot(), delay });
      await swipe(page, touch, 'history', true);
      const released = await page.evaluate(() => (window as any).mongleTerminalTest.releaseCount as number);
      await page.waitForTimeout(700);
      const settled = (await position(page)).inputs as Array<[string, string]>;
      if (delay < 80) assert.ok(settled.length > released, `ACK ${delay}ms: actual xterm wheel dispatch must continue after release`);
      else assert.equal(settled.length, released, 'a slow ACK cancels instead of replaying later');
      assert.ok(settled.length - released <= 4, 'coasting stays bounded, including when the connection recovers');
      assert.ok(settled.every(([data]) => /^\x1b\[<64;\d+;\d+M$/.test(data)));
      evidence.push({ delay, released, settled: settled.length });
    }
    recordEvidence('cli-momentum-ack', evidence);
  }));

test('real Chrome Android emulation: live pans survive presentation frames but stop at real input boundaries', browserOptions,
  async () => withMobileTerminal(async (page, touch, engine) => {
    for (const boundary of ['gate', 'protocol', 'RIS', 'resize']) {
      await engine.resize(40, 8);
      await engine.write('\x1bc\x1b[?1049h\x1b[?1003h\x1b[?1006hpan boundaries');
      const frame = await engine.snapshot();
      await page.evaluate(async value => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(value); h.adapter.setInputEnabled(true); h.inputs.length = 0;
      }, frame);
      const rect = await page.locator('.xterm-screen').boundingBox();
      assert.ok(rect);
      // Start on painted text, not empty background, so replacing row spans
      // during presentation also exercises native touch target continuity.
      const x = rect.x + 20, y = rect.y + 12;
      const moveTo = (offset: number) => touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + offset, id: 1 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await moveTo(30);
      const beforeFrame = (await position(page)).inputs.length;
      assert.ok(beforeFrame > 0);
      await page.evaluate(async value => {
        const h = (window as any).mongleTerminalTest;
        for (let index = 0; index < 3; index++) await h.adapter.applySnapshot(value);
      }, frame);
      await moveTo(60);
      const beforeBoundary = (await position(page)).inputs.length;
      assert.ok(beforeBoundary > beforeFrame, 'ordinary full-frame reconstruction does not cancel a pan');
      if (boundary === 'gate') {
        await page.evaluate(() => {
          const h = (window as any).mongleTerminalTest;
          h.adapter.setInputEnabled(false, { preserveKeyboard: true }); h.adapter.setInputEnabled(true);
        });
      } else {
        if (boundary === 'protocol') await engine.write('\x1b[?1003l');
        if (boundary === 'RIS') await engine.write('\x1bc\x1b[?1049h\x1b[?1003h\x1b[?1006h');
        if (boundary === 'resize') await engine.resize(42, 9);
        await page.evaluate(async value => { await (window as any).mongleTerminalTest.adapter.applySnapshot(value); }, await engine.snapshot());
      }
      await moveTo(100);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal((await position(page)).inputs.length, beforeBoundary, `${boundary} invalidates the old gesture`);
    }
  }));
