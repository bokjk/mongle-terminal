import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { HostCore } from '../../packages/host/core.js';
import type { ConnectionContext, TerminalInfo } from '../../packages/protocol/index.js';

test('real desktop/mobile UI and PowerShell: deliberate input transfers control both ways after ACK without restarting the shell', {
  timeout: 90_000,
  skip: process.platform !== 'win32' || !existsSync('dist/web/index.html') ? 'Requires Windows and built web UI.' : false,
}, async t => {
  const isolatedRoot = path.resolve('.test-data/tap-control-integration');
  await mkdir(isolatedRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(isolatedRoot, 'host-'));
  const previousDataDir = process.env.MONGLE_DATA_DIR;
  process.env.MONGLE_DATA_DIR = dataDir;
  const host = new HostCore({ dataDir, name: '터치 통합 검증 PC' });
  const setup: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: '검증 준비', owner: true };
  const contexts: ConnectionContext[] = [setup];
  const errors: string[] = [];
  const calls: Array<{ connectionId: string; method: string; params: any; completed: boolean }> = [];
  let browser: Browser | undefined;
  let acquisitionAckPaused = false;
  let releaseAck!: () => void;
  const acquisitionAckGate = new Promise<void>(resolve => { releaseAck = resolve; });
  const webRoot = path.resolve('dist/web');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const file = path.resolve(webRoot, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
      if (!file.startsWith(webRoot + path.sep)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      res.end(await readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  t.after(async () => {
    releaseAck();
    for (const context of contexts) host.disconnect(context.id);
    await browser?.close();
    await host.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    assert.ok(path.resolve(dataDir).startsWith(isolatedRoot + path.sep), 'Only this test data directory may be removed');
    await rm(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MONGLE_DATA_DIR;
    else process.env.MONGLE_DATA_DIR = previousDataDir;
  });

  await host.init();
  host.connect(setup, () => {});
  const profile = host.getState().profiles.find(item => item.kind === 'powershell');
  assert.ok(profile, 'This integration test requires actual PowerShell');
  const terminal: TerminalInfo = await host.handle('terminals.create', {
    groupId: host.getState().groups[0].id, profileId: profile.id, cwd: dataDir,
  }, setup);
  const originalPid = terminal.pid;
  assert.ok(originalPid);
  const currentTerminal = () => host.getState().terminals.find(item => item.id === terminal.id)!;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  async function openSurface(name: string, { owner, mobile, pauseFirstAck = false }: { owner: boolean; mobile: boolean; pauseFirstAck?: boolean }) {
    const context: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: name, owner };
    contexts.push(context);
    // Separate browser contexts model independent desktop and phone clients,
    // including their own selected terminal and remembered input state.
    const browserContext = await browser!.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile,
    });
    const page = await browserContext.newPage();
    page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
    let delivery = Promise.resolve();
    await page.exposeBinding('hostRequest', async (_source, method: string, params: any) => {
      const call = { connectionId: context.id, method, params, completed: false };
      calls.push(call);
      if (pauseFirstAck && !acquisitionAckPaused && method === 'terminal.ack' && params.epoch !== undefined) {
        acquisitionAckPaused = true;
        await acquisitionAckGate;
      }
      const result = await host.handle(method, params, context);
      // Like the browser WebSocket client, this bridge delivers state events before
      // their response. The Electron desktop bridge can deliver the response first;
      // tests/ui/restore-control.test.ts covers that order.
      await delivery;
      call.completed = true;
      return result;
    });
    await page.addInitScript('window.__name = function (fn) { return fn; };');
    await page.addInitScript(({ owner }) => {
      const listeners = new Set<any>();
      (window as any).__hostListeners = listeners;
      (window as any).mongle = {
        request: (method: string, params: unknown) => (window as any).hostRequest(method, params),
        subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
        onConnection: (fn: any) => { fn({ status: 'connected', owner }); return () => {}; },
        listHosts: async () => [{ id: owner ? 'local' : 'remote-test', name: '검증 PC', local: owner, selected: true }],
        addHost: async () => {}, removeHost: async () => {},
        selectHost: async () => ({ status: 'connected', owner }),
      };
    }, { owner });
    host.connect(context, event => {
      delivery = delivery.then(() => page.evaluate(value => {
        for (const listener of (window as any).__hostListeners || []) listener(value);
      }, event)).catch(() => {});
    });
    await page.goto(url);
    await page.locator('.xterm-screen').waitFor();
    return { page, context };
  }

  const desktop = await openSurface('검증 데스크톱 앱', { owner: true, mobile: false });
  const desktopCalls = (method: string) => calls.filter(call => call.connectionId === desktop.context.id && call.method === method);
  await desktop.page.getByText('여기서 제어 중', { exact: true }).waitFor();
  assert.equal(currentTerminal().controller?.connectionId, desktop.context.id);
  assert.equal(desktopCalls('control.acquire').length, 1);
  assert.equal(desktopCalls('control.acquire')[0].params.takeover, false, 'Initial owner attachment acquires only a free terminal');

  const mobile = await openSurface('검증 휴대폰', { owner: false, mobile: true, pauseFirstAck: true });
  const mobileCalls = (method: string) => calls.filter(call => call.connectionId === mobile.context.id && call.method === method);
  const marker = `T${randomUUID().slice(0, 4)}`;
  async function writeAndObserve(page: Page, prefix: string, initialize = false) {
    await page.keyboard.insertText(`${initialize ? '$mongleTapValue=42; ' : ''}Write-Output ('${prefix}' + $mongleTapValue)`);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.xterm-rows').textContent(), { timeout: 15_000, message: 'Real PowerShell evaluated the command and rendered its result' }).toContain(`${prefix}42`);
  }
  async function settle(page: Page) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  async function assertRevokedInputBlocked(surface: typeof desktop, surfaceCalls: typeof desktopCalls, sentinel: string) {
    const inputCount = surfaceCalls('terminal.input').length;
    const acquisitionCount = surfaceCalls('control.acquire').length;
    const lease = currentTerminal().controller;
    await expect(surface.page.locator('.xterm-helper-textarea')).toHaveJSProperty('readOnly', true);
    // Programmatic/browser focus alone is not a deliberate terminal click.
    await surface.page.locator('.xterm-helper-textarea').focus();
    await surface.page.keyboard.insertText(sentinel);
    await settle(surface.page);
    assert.equal(surfaceCalls('terminal.input').length, inputCount, 'The revoked client discards input before a new deliberate transfer');
    assert.equal(surfaceCalls('control.acquire').length, acquisitionCount, 'Focus alone cannot take control');
    assert.deepEqual(currentTerminal().controller, lease);
  }
  function assertInputsFollowAck(connectionId: string) {
    const inputs = calls.filter(call => call.connectionId === connectionId && call.method === 'terminal.input');
    assert.ok(inputs.length > 0);
    for (const input of inputs) {
      assert.ok(calls.slice(0, calls.indexOf(input)).some(call => call.connectionId === connectionId && call.method === 'terminal.ack' && call.params.epoch === input.params.epoch && call.completed), 'Every lease sends input only after its screen ACK completes');
    }
  }

  await expect.poll(() => mobileCalls('terminals.attach').some(call => call.completed)).toBe(true);
  await settle(mobile.page);
  assert.equal(mobileCalls('control.acquire').length, 0, 'Opening a mobile page leaves the desktop controller alone');
  await desktop.page.locator('.xterm-screen').click();
  await writeAndObserve(desktop.page, `${marker}A_`, true);

  // One genuine phone tap transfers from the desktop; there is no footer click.
  const desktopEpoch = currentTerminal().controller!.epoch;
  await mobile.page.locator('.xterm-screen').tap();
  await expect.poll(() => acquisitionAckPaused).toBe(true);
  assert.equal(mobileCalls('control.acquire').length, 1);
  assert.notEqual(mobileCalls('control.acquire')[0].params.takeover, false, 'A deliberate tap can transfer another device’s lease');
  assert.equal(currentTerminal().controller?.connectionId, mobile.context.id);
  assert.ok(currentTerminal().controller!.epoch > desktopEpoch);
  assert.equal(currentTerminal().controller?.ready, false, 'Host keeps the new lease unready before the rendered screen ACK');
  assert.equal(await mobile.page.locator('.xterm-helper-textarea').evaluate(element => document.activeElement === element), true);
  await expect(mobile.page.locator('.xterm-helper-textarea')).toHaveJSProperty('readOnly', false);
  await mobile.page.keyboard.insertText('MUST_NOT_REACH_SHELL');
  await settle(mobile.page);
  assert.equal(mobileCalls('terminal.input').length, 0, 'Typing before the acquisition ACK is discarded, never buffered for later replay');
  await assertRevokedInputBlocked(desktop, desktopCalls, 'MUST_NOT_USE_OLD_DESKTOP_LEASE');
  releaseAck();
  await mobile.page.getByText('여기서 제어 중', { exact: true }).waitFor();
  assert.equal(currentTerminal().controller?.ready, true);
  await mobile.page.bringToFront();
  await writeAndObserve(mobile.page, `${marker}B_`);
  assert.ok(!mobileCalls('terminal.input').some(call => call.params.data.includes('MUST_NOT_REACH_SHELL')));

  const mobileEpoch = currentTerminal().controller!.epoch;
  const previousAttachCount = desktopCalls('terminals.attach').length;
  await desktop.page.reload();
  await desktop.page.locator('.xterm-screen').waitFor();
  await expect.poll(() => desktopCalls('terminals.attach').filter(call => call.completed).length).toBe(previousAttachCount + 1);
  await settle(desktop.page);
  await desktop.page.bringToFront();
  await settle(desktop.page);
  assert.equal(desktopCalls('control.acquire').length, 1, 'Owner page reload and window focus do not steal the mobile controller');
  assert.equal(currentTerminal().controller?.connectionId, mobile.context.id);
  assert.equal(currentTerminal().controller?.epoch, mobileEpoch);
  await assertRevokedInputBlocked(desktop, desktopCalls, 'MUST_NOT_RECLAIM_ON_FOCUS');

  // Regression: the desktop returns with the same single content click as mobile.
  await desktop.page.locator('.xterm-screen').click();
  await desktop.page.getByText('여기서 제어 중', { exact: true }).waitFor();
  assert.equal(desktopCalls('control.acquire').length, 2);
  assert.notEqual(desktopCalls('control.acquire')[1].params.takeover, false);
  assert.equal(currentTerminal().controller?.connectionId, desktop.context.id);
  await writeAndObserve(desktop.page, `${marker}C_`);
  await assertRevokedInputBlocked(mobile, mobileCalls, 'MUST_NOT_USE_OLD_MOBILE_LEASE');

  // Other input entry points must follow the same deliberate-transfer behavior.
  await mobile.page.getByRole('button', { name: '키보드 열기', exact: true }).tap();
  await mobile.page.getByText('여기서 제어 중', { exact: true }).waitFor();
  assert.equal(mobileCalls('control.acquire').length, 2);
  assert.notEqual(mobileCalls('control.acquire')[1].params.takeover, false);
  await writeAndObserve(mobile.page, `${marker}D_`);
  await desktop.page.getByRole('tab').click();
  assert.equal(desktopCalls('control.acquire').length,2,'Tab selection keeps the phone in control');
  assert.equal(currentTerminal().controller?.connectionId,mobile.context.id);
  await desktop.page.getByRole('button',{name:'검증 휴대폰에서 제어 · 가져오기',exact:true}).click();
  await desktop.page.getByText('여기서 제어 중', { exact: true }).waitFor();
  assert.equal(desktopCalls('control.acquire').length, 3);
  assert.notEqual(desktopCalls('control.acquire')[2].params.takeover, false);
  await writeAndObserve(desktop.page, `${marker}E_`);

  assert.equal(currentTerminal().pid, originalPid, 'All control transfers preserve the original PowerShell process');
  assert.equal(currentTerminal().generation, terminal.generation);
  assert.equal(currentTerminal().controller?.connectionId, desktop.context.id);
  assertInputsFollowAck(desktop.context.id);
  assertInputsFollowAck(mobile.context.id);
  assert.deepEqual(errors, []);
  await mkdir('test-results/tap-control', { recursive: true });
  await desktop.page.screenshot({ path: 'test-results/tap-control/real-desktop-roundtrip-controller.png' });
  await mobile.page.screenshot({ path: 'test-results/tap-control/real-mobile-roundtrip-viewer.png' });
});
