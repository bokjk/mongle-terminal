import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import { HostCore } from '../../packages/host/core.js';
import { leafIds, type ConnectionContext, type HostState, type LayoutNode, type SnapshotEvent, type TerminalInfo } from '../../packages/protocol/index.js';

type Position = 'left' | 'right' | 'top' | 'bottom' | 'center';
type Box = { x: number; y: number; width: number; height: number };
const diagnostic = process.env.MONGLE_DRAG_COLLECT === '1';
const output = path.resolve('test-results/ui/pane-drag', ...(diagnostic ? ['diagnostic'] : []));
// Focus reports share the input queue and may be coalesced with typed bytes.
// Remove only complete focus-in/out reports, retaining every other byte.
const withoutFocusReports = (data: string) => data.replace(/\x1b\[[IO]/g, '');
const shellInput = (call: {method: string; params?: {data?: string}}) => call.method === 'terminal.input' && withoutFocusReports(call.params?.data || '') !== '';
const mutation = (method: string) => /^(groups\.(layout|create|update|delete|reorder)|terminals\.(create|remove|restart|terminate|move))$/.test(method);
async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, label: string, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout; let error: unknown;
  do { try { const value = await read(); if (check(value)) return value; } catch (caught) { error = caught; } await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error(`${label}: timed out${error ? ` (${String(error)})` : ''}`);
}
function assertPlacement(source: Box, target: Box, position: Exclude<Position, 'center'>) {
  const gap = position === 'left' ? target.x - source.x - source.width : position === 'right' ? source.x - target.x - target.width : position === 'top' ? target.y - source.y - source.height : source.y - target.y - target.height;
  assert.ok(gap >= 6 && gap <= 12, `${position} drop should show the source beside the target with a 9px divider, got ${gap}`);
  if (position === 'left' || position === 'right') { assert.ok(Math.abs(source.y - target.y) < 2); assert.ok(Math.abs(source.height - target.height) < 2); }
  else { assert.ok(Math.abs(source.x - target.x) < 2); assert.ok(Math.abs(source.width - target.width) < 2); }
}
function assertSameBox(actual: Box, expected: Box) { for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 2, `${key}: ${actual[key]} vs ${expected[key]}`); }

// Real Chrome HTML5 drag: the browser constructs the DataTransfer and dispatches
// native drag lifecycle events. Only external/untrusted payload cases are synthetic.
async function beginDrag(page: Page, source: Locator, target: Locator, position: Position) {
  const from = await source.boundingBox(); const to = await target.boundingBox(); assert.ok(from && to);
  const x = to.x + to.width * (position === 'left' ? .1 : position === 'right' ? .9 : .5);
  const y = to.y + to.height * (position === 'top' ? .1 : position === 'bottom' ? .9 : .5);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x + 1, y + 1);
}

test('native pane drag: dock, swap, create once, cancel, lease/input continuity and persistence', { timeout: 240000, skip: process.platform !== 'win32' || !existsSync('dist/web/index.html') ? 'Requires Windows, Chrome and built web UI.' : false }, async (testContext) => {
  await mkdir(output, { recursive: true });
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'mongle-pane-drag-'));
  const dataDirs = [path.join(dataRoot, 'primary'), path.join(dataRoot, 'alternate')];
  const hosts = dataDirs.map((dataDir, index) => new HostCore({ dataDir, name: index ? '다른 QA 컴퓨터' : '드래그 QA 컴퓨터' }));
  const ui: ConnectionContext = { id: randomUUID(), deviceId: 'drag-ui', deviceName: '드래그 UI', owner: true };
  const observer: ConnectionContext = { id: randomUUID(), deviceId: 'drag-observer', deviceName: '읽기 검증', owner: true };
  const remote: ConnectionContext = { id: randomUUID(), deviceId: 'drag-remote', deviceName: '다른 기기 QA', owner: false };
  let selected = 0;
  const calls: Array<{ method: string; params: any; hostId: string; outcome?: string }> = [];
  const errors: string[] = []; const inputFailures: Array<{id:string;prefix:string;expected:string;actual:string}> = []; const steps: string[] = []; const evidence: Record<string, unknown> = {};
  let result: Record<string, unknown> = { startedAt: new Date().toISOString(), dataRoot, passed: false };
  let layoutGate: { entered: () => void; release: Promise<void> } | undefined;
  let releasePendingLayout: (() => void) | undefined;
  testContext.after(async () => { releasePendingLayout?.(); await Promise.all(hosts.map(host => host.close().catch(() => {}))); });
  await Promise.all(hosts.map(host => host.init()));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  testContext.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  const server = createServer(async (req, res) => { try { const url = new URL(req.url || '/', 'http://localhost'); const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); const file = path.resolve('dist/web', relative); if (!file.startsWith(path.resolve('dist/web') + path.sep)) { res.writeHead(404).end(); return; } res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(await readFile(file)); } catch { res.writeHead(404).end(); } });
  testContext.after(() => new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (index: number) => (event: unknown) => { if (selected === index) void page.evaluate(event => (window as any).__dragListeners?.forEach((fn: any) => fn(event)), event).catch(() => {}); };
  hosts[0].connect(ui, send(0));
  hosts.forEach(host => host.connect(observer, () => {}));
  hosts[0].connect(remote, () => {});
  await page.exposeBinding('dragHostRequest', async (_source, method: string, params: unknown) => {
    const host = hosts[selected]; const record = { method, params, hostId: host.getState().hostId, outcome: 'pending' }; calls.push(record);
    if (method === 'groups.layout' && layoutGate) { const gate = layoutGate; layoutGate = undefined; gate.entered(); await gate.release; }
    try { const response = await host.handle(method, params, ui); record.outcome = 'accepted'; return response; } catch (error) { record.outcome = 'rejected'; throw error; }
  });
  await page.exposeBinding('dragHostList', () => hosts.map((host, index) => ({ id: String(index), name: host.getState().name, local: true, selected: selected === index })));
  await page.exposeBinding('dragHostSelect', async (_source, id: string) => { hosts[selected].disconnect(ui.id); selected = Number(id); assert.ok(hosts[selected]); hosts[selected].connect(ui, send(selected)); return { status: 'connected', owner: true, hostId: hosts[selected].getState().hostId, connectionId: ui.id }; });
  await page.addInitScript('window.__name = function (fn) { return fn; };');
  await page.addInitScript(({ hostId, connectionId }) => {
    const listeners = new Set<any>(); const connections = new Set<any>();
    (window as any).__dragListeners = listeners; (window as any).__dragConnections = connections;
    (window as any).mongle = { request: (method: string, params: unknown) => (window as any).dragHostRequest(method, params), subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, onConnection: (fn: any) => { connections.add(fn); fn({ status: 'connected', owner: true, hostId, connectionId }); return () => connections.delete(fn); }, listHosts: () => (window as any).dragHostList(), selectHost: (id: string) => (window as any).dragHostSelect(id), addHost: async () => {}, removeHost: async () => {} };
  }, { hostId: hosts[0].getState().hostId, connectionId: ui.id });
  const host = hosts[0];
  const pane = (id: string) => page.locator(`.pane[data-terminal-id="${id}"]`);
  const handle = (id: string) => pane(id).locator('.pane-drag-handle');
  const frame = async (id: string): Promise<string> => { const state = host.getState(); const info = state.terminals.find(item => item.id === id)!; const ref = { id, hostId: state.hostId, bootId: state.bootId, generation: info.generation }; const snapshot = await host.handle('terminals.attach', ref, observer) as SnapshotEvent; await host.handle('terminal.ack', { ...ref, seq: snapshot.seq }, observer); return snapshot.snapshot.data; };
  const proveVariable = async (id: string, marker: string, prefix: string, assign = false) => {
    await until(() => host.getState().terminals.find(item => item.id === id)?.controller, controller => controller?.connectionId === ui.id && controller.ready, 'self controller remains ready without reacquire');
    await pane(id).locator('.xterm-helper-textarea').focus();
    const inputStart = calls.length;
    const command = `${assign ? `$dragProof='${marker}'; ` : ''}Write-Output ('${prefix}:'+$dragProof)`;
    await page.keyboard.type(command, { delay: 2 }); await page.keyboard.press('Enter');
    const sentInput = () => withoutFocusReports(calls.slice(inputStart).filter(item => item.method === 'terminal.input' && item.params.id === id).map(item => item.params.data).join(''));
    try {
      await expect.poll(sentInput, { message: 'Every typed byte reaches the host exactly once after the asynchronous input queue drains' }).toBe(command+'\r');
    } catch (error) {
      if (!diagnostic) throw error;
      inputFailures.push({ id, prefix, expected: command+'\r', actual: sentInput() }); await page.keyboard.press('Control+c'); return;
    }
    await settle();
    const sent = sentInput();
    if (diagnostic && sent !== command+'\r') { inputFailures.push({ id, prefix, expected: command+'\r', actual: sent }); await page.keyboard.press('Control+c'); return; }
    assert.equal(sent, command+'\r', 'Every typed byte must reach the host exactly once, including during drag-triggered resize');
    await until(() => frame(id), text => text.includes(`${prefix}:${marker}`), `live variable ${prefix}`);
    await settle();
    assert.equal(sentInput(), command+'\r', 'No typed byte may be duplicated after the command has executed');
  };
  const settle = async () => { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); await hosts[selected].handle('state.get', undefined, observer); await until(() => calls.every(call => call.outcome !== 'pending'), Boolean, 'bridge requests settled'); };
  const observeMutation = () => calls.filter(item => mutation(item.method));
  const identity = () => host.getState().terminals.map(({ id, pid, generation, status, groupId }) => ({ id, pid, generation, status, groupId }));
  const group = (id: string) => host.getState().groups.find(item => item.id === id)!;
  const selectGroup = async (name: string) => { await page.locator('.group-main').filter({ hasText: name }).click(); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(); };
  const assertNoOverlap = async (ids: string[]) => { const boxes = await Promise.all(ids.map(id => pane(id).boundingBox())); for (const box of boxes) assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1601 && box.y + box.height <= 1001); for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) { const x = boxes[a]!, y = boxes[b]!; assert.ok(Math.min(x.x+x.width,y.x+y.width)-Math.max(x.x,y.x) <= 1 || Math.min(x.y+x.height,y.y+y.height)-Math.max(x.y,y.y) <= 1, 'pane rectangles must not overlap'); } };
  let ownedPids: number[] = [];
  try {
    result.webIndexSha256 = createHash('sha256').update(await readFile('dist/web/index.html')).digest('hex');
    const mainGroup = host.getState().groups[0]; const profile = host.getState().profiles.find(item => item.kind === 'powershell'); assert.ok(profile);
    await host.handle('groups.update', { id: mainGroup.id, name: '드래그 작업', profileId: profile.id, cwd: path.resolve('.'), revision: mainGroup.revision }, observer);
    const terminals: TerminalInfo[] = [];
    for (const title of ['A', 'B', 'C']) { const terminal = await host.handle('terminals.create', { groupId: mainGroup.id }, observer); await host.handle('terminals.rename', { id: terminal.id, title: `검증 ${title}` }, observer); terminals.push(terminal); }
    const [a, b, c] = terminals.map(item => item.id);
    const baseline: LayoutNode = { type: 'split', axis: 'horizontal', ratio: .42, first: { type: 'leaf', terminalId: a }, second: { type: 'split', axis: 'vertical', ratio: .37, first: { type: 'leaf', terminalId: b }, second: { type: 'leaf', terminalId: c } } };
    const resetLayout = async () => { await host.handle('groups.layout', { id: mainGroup.id, revision: group(mainGroup.id).revision, layout: baseline }, observer); await settle(); await until(async () => { const aa = await pane(a).boundingBox(), bb = await pane(b).boundingBox(), cc = await pane(c).boundingBox(); return Boolean(aa && bb && cc && aa.x < cc.x && bb.y < cc.y); }, Boolean, 'baseline rectangle rendered'); };
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.locator('.pane')).toHaveCount(3);
    await resetLayout();
    const markers = new Map(terminals.map(item => [item.id, `DRAG_${item.id.slice(0,8)}`]));
    for (const terminal of terminals) await proveVariable(terminal.id, markers.get(terminal.id)!, 'INITIAL', true);
    const beforeIdentity = identity(); evidence.initial = { identity: beforeIdentity, bootId: host.getState().bootId };
    for (const position of ['left', 'right', 'top', 'bottom', 'center'] as Position[]) {
      await resetLayout(); const beforeSource = (await pane(a).boundingBox())!, beforeTarget = (await pane(c).boundingBox())!;
      const start = calls.length; const revision = group(mainGroup.id).revision;
      await beginDrag(page, position === 'center' ? pane(a).locator('.pane-title') : handle(a), pane(c), position);
      const preview = pane(c).locator(`.pane-drop-preview[data-drop-position="${position}"]`);
      await expect(preview).toBeVisible(); await expect(preview).toHaveText({ left: '왼쪽에 분할', right: '오른쪽에 분할', top: '위쪽에 분할', bottom: '아래쪽에 분할', center: '위치 바꾸기' }[position]);
      if (position === 'left' || position === 'center') await page.screenshot({ path: path.join(output, `preview-${position}.png`) });
      await page.mouse.up();
      await until(() => group(mainGroup.id).revision, value => value === revision + 1, `${position} layout committed once`); await settle();
      await expect(page.locator('.pane-drop-preview')).toHaveCount(0);
      assert.deepEqual(identity(), beforeIdentity); assert.deepEqual(leafIds(group(mainGroup.id).layout).sort(), [a,b,c].sort());
      assert.equal(calls.slice(start).filter(item => item.method === 'groups.layout').length, 1);
      assert.equal(calls.slice(start).filter(item => ['terminals.create', 'terminals.attach', 'terminals.detach', 'control.acquire'].includes(item.method)).length, 0, 'moving a pane must not recreate a shell, remount it or reacquire its control lease');
      if (position === 'center') { assertSameBox((await pane(a).boundingBox())!, beforeTarget); assertSameBox((await pane(c).boundingBox())!, beforeSource); }
      else assertPlacement((await pane(a).boundingBox())!, (await pane(c).boundingBox())!, position);
      await assertNoOverlap([a,b,c]);
      for (const id of [a,b,c]) await proveVariable(id, markers.get(id)!, `AFTER_${position}`);
      steps.push(`native ${position} drag commits once, preserves all shell identities and immediate self-controlled input without detach/acquire`);
    }

    // An independently controlled pane must stay controlled by that other device.
    await resetLayout();
    const current = host.getState(); const remoteRef = { id: a, hostId: current.hostId, bootId: current.bootId, generation: current.terminals.find(item => item.id === a)!.generation };
    const lease = await host.handle('control.acquire', { ...remoteRef, cols: 90, rows: 24 }, remote);
    await host.handle('terminal.ack', { ...remoteRef, seq: lease.frame.seq, epoch: lease.epoch }, remote);
    await expect(pane(a).locator('.control-chip')).toContainText('다른 기기 QA');
    const remoteStart = calls.length; const remoteRevision = group(mainGroup.id).revision;
    await beginDrag(page, handle(a), pane(c), 'top'); await expect(pane(c).locator('.pane-drop-preview')).toBeVisible(); await page.mouse.up(); await settle();
    await until(() => group(mainGroup.id).revision, value => value === remoteRevision + 1, 'remote pane move applied');
    assert.equal(host.getState().terminals.find(item => item.id === a)?.controller?.connectionId, remote.id);
    assert.equal(host.getState().terminals.find(item => item.id === a)?.controller?.epoch, lease.epoch);
    assert.equal(calls.slice(remoteStart).filter(item => ['control.acquire', 'terminals.attach', 'terminals.detach'].includes(item.method)).length, 0);
    await host.handle('terminal.input', { ...remoteRef, epoch: lease.epoch, inputId: randomUUID(), clientInputSeq: 1, data: "Write-Output ('REMOTE:'+$dragProof)\r" }, remote);
    await until(() => frame(a), text => text.includes(`REMOTE:${markers.get(a)}`), 'remote controller remains usable');
    steps.push('moving an externally controlled pane neither steals nor replaces the remote lease; remote input still reaches the same shell');
    await pane(a).locator('.control-chip').click(); // Explicit user takeover only after the remote-lease scenario finishes.
    await proveVariable(a, markers.get(a)!, 'TAKEBACK');

    // Cancel native drag through every state boundary before it reaches an RPC.
    const cancelCase = async (name: string, cancel: () => Promise<void>, source?: Locator) => {
      await resetLayout(); const before = observeMutation().length; const inputBefore = calls.filter(shellInput).length;
      await beginDrag(page, source || handle(a), pane(c), 'right'); await expect(pane(c).locator('.pane-drop-preview')).toBeVisible();
      await cancel(); await page.mouse.up(); await settle();
      await expect(page.locator('.pane-drop-preview')).toHaveCount(0);
      assert.equal(observeMutation().length, before, `${name} must send zero state-changing RPCs`);
      assert.equal(calls.filter(shellInput).length, inputBefore, `${name} must not type into the shell`);
      assert.deepEqual(identity(), beforeIdentity); steps.push(`${name}: canceled with no mutation or terminal input`);
    };
    await cancelCase('native Escape', async () => { await page.keyboard.press('Escape'); });
    await cancelCase('new terminal Escape', async () => { await page.keyboard.press('Escape'); }, page.locator('.new-terminal-drag'));
    await cancelCase('outside release', async () => { await page.mouse.move(20, 20, { steps: 8 }); });
    await cancelCase('stale group revision', async () => { const g = group(mainGroup.id); await host.handle('groups.update', { id: g.id, revision: g.revision, name: g.name }, observer); await expect(page.locator('.pane-drop-preview')).toHaveCount(0); });
    await cancelCase('offline mid-drag', async () => { await page.evaluate(() => (window as any).__dragConnections.forEach((fn: any) => fn({ status: 'offline', owner: true, error: 'QA disconnected' }))); await expect(page.locator('.pane-drop-preview')).toHaveCount(0); });
    assert.notEqual(await pane(a).locator('.pane-header').getAttribute('draggable'), 'true');
    assert.notEqual(await page.locator('.new-terminal-drag').getAttribute('draggable'), 'true');
    const offlineStart = calls.length; await beginDrag(page, pane(a).locator('.pane-title'), pane(c), 'left'); await page.mouse.up(); await settle();
    await expect(page.locator('.pane-drop-preview')).toHaveCount(0); assert.equal(calls.slice(offlineStart).filter(item => mutation(item.method) || shellInput(item)).length, 0);
    await page.evaluate(({ hostId, connectionId }) => (window as any).__dragConnections.forEach((fn: any) => fn({ status: 'connected', owner: true, hostId, connectionId })), { hostId: host.getState().hostId, connectionId: ui.id });
    await expect(page.locator('.connection-status')).toContainText('연결됨');
    const spare = await host.handle('groups.create', { name: '취소 대상', profileId: profile.id }, observer);
    await cancelCase('group switch mid-drag', async () => { await page.locator('.group-main').filter({ hasText: '취소 대상' }).evaluate(element => (element as HTMLButtonElement).click()); await expect(page.getByRole('heading', { name: '취소 대상', exact: true })).toBeVisible(); });
    await selectGroup('드래그 작업');
    // Native HTML drag suppresses physical clicks/keys. Activate the UI like the group-switch boundary above.
    await cancelCase('new terminal host switch mid-drag', async () => { await page.getByRole('button', { name: '접속할 컴퓨터', exact: true }).evaluate(element => (element as HTMLElement).click()); await page.getByRole('option').nth(1).evaluate(element => (element as HTMLElement).click()); await expect(page.getByRole('heading', { name: '기본 그룹', exact: true })).toBeVisible(); }, page.locator('.new-terminal-drag'));
    assert.equal(hosts[1].getState().terminals.length, 0, 'stale source intent cannot create on the new computer');
    await page.getByRole('button', { name: '접속할 컴퓨터', exact: true }).click(); await page.getByRole('option').nth(0).click(); await selectGroup('드래그 작업');

    // If another writer wins after drop, a rejected CAS must not replay stale intent.
    await resetLayout();
    let gateEntered = false, release!: () => void;
    const releasePromise = new Promise<void>(resolve => { release = resolve; }); releasePendingLayout = release;
    layoutGate = { entered: () => { gateEntered = true; }, release: releasePromise }; const conflictStart = calls.length;
    await beginDrag(page, handle(a), pane(c), 'bottom'); await page.mouse.up(); await until(() => gateEntered, Boolean, 'drag reaches revision-conflict gate');
    // Queue a separator edit behind the blocked drop. Its old tree path must
    // not be interpreted against the unrelated winner tree after the conflict.
    await page.getByRole('separator', { name: '좌우 분할 크기', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    const g = group(mainGroup.id); const winner: LayoutNode = { type: 'split', axis: 'vertical', ratio: .6, first: { type: 'leaf', terminalId: c }, second: { type: 'split', axis: 'horizontal', ratio: .45, first: { type: 'leaf', terminalId: a }, second: { type: 'leaf', terminalId: b } } };
    await host.handle('groups.layout', { id: g.id, revision: g.revision, layout: winner }, observer); release();
    await until(() => calls.slice(conflictStart).find(item => item.method === 'groups.layout')?.outcome, value => value === 'rejected', 'stale layout rejected'); await settle();
    assert.deepEqual(group(mainGroup.id).layout, winner); assert.equal(calls.slice(conflictStart).filter(item => item.method === 'groups.layout').length, 1); steps.push('late revision conflict preserves the other writer layout; neither stale drag intent nor a queued separator path is replayed');

    // A native drag source is disabled for maximized/mobile/offline views; click remains available.
    await resetLayout();
    await pane(a).getByRole('button', { name: '최대화', exact: true }).click(); await expect(page.locator('.pane:visible')).toHaveCount(1);
    assert.notEqual(await pane(a).locator('.pane-header').getAttribute('draggable'), 'true'); assert.notEqual(await page.locator('.new-terminal-drag').getAttribute('draggable'), 'true');
    const blockedStart = observeMutation().length;
    await beginDrag(page, pane(a).locator('.pane-title'), pane(a), 'left'); await page.mouse.up(); await settle(); await expect(page.locator('.pane-drop-preview')).toHaveCount(0); assert.equal(observeMutation().length, blockedStart);
    await page.getByRole('button', { name: '분할로 돌아가기', exact: true }).click(); await expect(page.locator('.pane:visible')).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.pane:visible')).toHaveCount(1);
    assert.notEqual(await page.locator('.new-terminal-drag').getAttribute('draggable'), 'true');
    for (const source of await page.locator('.pane:visible .pane-header').all()) assert.notEqual(await source.getAttribute('draggable'), 'true');
    const mobileStart = observeMutation().length; const mobilePane = page.locator('.pane:visible').first(); await beginDrag(page, mobilePane.locator('.pane-title'), mobilePane, 'left'); await page.mouse.up(); await settle(); await expect(page.locator('.pane-drop-preview')).toHaveCount(0); assert.equal(observeMutation().length, mobileStart);
    await expect(page.locator('.mobile-keys')).toBeVisible(); await page.locator('.mobile-panel-switcher').click(); await expect(page.getByRole('dialog', { name: '터미널 전환' }).locator('.device-row')).toHaveCount(3); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1600, height: 1000 }); await expect(page.locator('.pane:visible')).toHaveCount(3);
    steps.push('maximized drag is inert and mobile single-pane controls remain available without drag sources');

    // Existing separator gestures still affect only geometry, not terminal lifetimes.
    await resetLayout(); const separator = page.getByRole('separator', { name: '좌우 분할 크기', exact: true });
    // Host state can lead the renderer: each gesture must see the acknowledged revision before the next CAS.
    await expect(separator).toHaveAttribute('aria-valuenow', '42');
    await separator.focus(); await page.keyboard.press('ArrowRight'); await until(() => group(mainGroup.id).layout, value => value?.type === 'split' && value.ratio > .42, 'keyboard resize');
    await expect(separator).toHaveAttribute('aria-valuenow', '47');
    await page.keyboard.press('Home'); await until(() => group(mainGroup.id).layout, value => value?.type === 'split' && value.ratio === .5, 'Home equalize');
    await expect(separator).toHaveAttribute('aria-valuenow', '50');
    const separatorBox = (await separator.boundingBox())!; await page.mouse.move(separatorBox.x + separatorBox.width/2, separatorBox.y + separatorBox.height/2); await page.mouse.down(); await page.mouse.move(separatorBox.x+70,separatorBox.y+separatorBox.height/2,{steps:8}); await page.mouse.up();
    await until(() => group(mainGroup.id).layout, value => value?.type === 'split' && value.ratio > .5, 'pointer resize'); await expect.poll(async () => Number(await separator.getAttribute('aria-valuenow'))).toBeGreaterThan(50); await separator.dblclick(); await until(() => group(mainGroup.id).layout, value => value?.type === 'split' && value.ratio === .5, 'double-click equalize');
    await assertNoOverlap([a,b,c]); await proveVariable(a, markers.get(a)!, 'RESIZED'); steps.push('keyboard, Home, pointer resize and double-click equalize retain usable nonoverlapping panes');

    // New-terminal source drag creates one default shell at the requested side.
    for (const position of ['left', 'top'] as const) {
      const singleGroup = await host.handle('groups.create', { name: `새 셸 ${position}`, profileId: profile.id, cwd: path.resolve('.') }, observer);
      const first = await host.handle('terminals.create', { groupId: singleGroup.id }, observer) as TerminalInfo;
      await selectGroup(singleGroup.name); await expect(page.locator('.pane:visible')).toHaveCount(1);
      await proveVariable(first.id, `SINGLE_${position}`, 'ONE', true);
      const beforeIds = host.getState().terminals.map(item => item.id); const createStart = calls.length;
      await beginDrag(page, page.locator('.new-terminal-drag'), pane(first.id), position);
      await expect(pane(first.id).locator(`.pane-drop-preview[data-drop-position="${position}"]`)).toBeVisible(); await page.mouse.up();
      await until(() => host.getState().terminals.length, count => count === beforeIds.length+1, 'exactly one default shell created');
      await expect(page.locator('.pane:visible')).toHaveCount(2); await settle();
      const created = host.getState().terminals.find(item => !beforeIds.includes(item.id))!;
      assert.equal(calls.slice(createStart).filter(item => item.method === 'terminals.create').length, 1); assert.equal(created.profileId, profile.id); assert.equal(created.cwd, singleGroup.cwd);
      assertPlacement((await pane(created.id).boundingBox())!, (await pane(first.id).boundingBox())!, position);
      assert.equal(await page.getByRole('dialog').count(), 0, 'drag must not accidentally trigger toolbar click dialog');
      await proveVariable(first.id, `SINGLE_${position}`, 'NEW_NEIGHBOR');
      steps.push(`toolbar ${position} native drop creates exactly one default shell and preserves the original live session`);
    }
    await page.locator('.new-terminal-drag').click(); await expect(page.getByRole('dialog', { name: '새 터미널', exact: true })).toBeVisible(); await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();

    // Browser-origin text/files/unrecognized internal-looking tokens are untrusted.
    await selectGroup('드래그 작업'); await resetLayout(); const externalStart = calls.length;
    for (const kind of ['text', 'file', 'forged']) await pane(a).locator('.terminal-canvas').evaluate((element, kind) => { const dataTransfer = new DataTransfer(); if (kind === 'text') dataTransfer.setData('text/plain', 'MONGLE_EXTERNAL_DROP_DO_NOT_RUN'); else if (kind === 'file') dataTransfer.items.add(new File(['harmless'], 'qa-file.txt', { type: 'text/plain' })); else dataTransfer.setData('application/x-mongle-pane-drag', 'forged-token'); for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX: 500, clientY: 300 })); }, kind);
    await settle(); assert.equal(calls.slice(externalStart).filter(item => mutation(item.method) || shellInput(item)).length, 0); steps.push('external text/file/forged drag payloads neither mutate layout nor reach terminal input');
    const savedLayout = structuredClone(group(mainGroup.id).layout); const savedRevision = group(mainGroup.id).revision;
    const database = new DatabaseSync(path.join(dataDirs[0], 'sessions.sqlite'), { readOnly: true });
    try { const row = database.prepare('SELECT value FROM metadata WHERE key=?').get('host') as { value: string }; const saved = JSON.parse(row.value) as HostState; const savedGroup = saved.groups.find(item => item.id === mainGroup.id)!; assert.deepEqual(savedGroup.layout, savedLayout); assert.equal(savedGroup.revision, savedRevision); } finally { database.close(); }
    // A fresh browser transport closes its former lease; emulate that connection lifecycle explicitly.
    await page.goto('about:blank'); host.disconnect(ui.id); host.connect(ui, send(0));
    await page.goto(`http://127.0.0.1:${address.port}`); await expect(page.locator('.pane:visible')).toHaveCount(3); assert.deepEqual(group(mainGroup.id).layout, savedLayout);
    for (const id of [a,b,c]) await proveVariable(id, markers.get(id)!, 'RELOADED');
    assert.deepEqual(identity().filter(item => [a,b,c].includes(item.id)), beforeIdentity);
    await page.screenshot({ path: path.join(output, 'desktop-final.png') });
    evidence.final = { identity: identity(), layout: savedLayout, revision: savedRevision, bootId: host.getState().bootId };
    steps.push('SQLite stores the exact committed layout/revision and renderer reload restores it with original PIDs, generations and live variables');
    assert.deepEqual(errors, []); assert.deepEqual(inputFailures, [], 'Collected input losses are real failures, never a passing diagnostic run'); result.passed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    await page.keyboard.press('Escape').catch(() => {}); await page.mouse.up().catch(() => {});
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => 'page unavailable'));
    throw error;
  } finally {
    releasePendingLayout?.();
    ownedPids = hosts.flatMap(item => item.getState().terminals.map(terminal => terminal.pid).filter((pid): pid is number => pid !== undefined));
    await browser.close(); for (const host of hosts) { host.disconnect(ui.id); host.disconnect(observer.id); host.disconnect(remote.id); await host.close(); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    await until(() => ownedPids.every(pid => { try { process.kill(pid,0); return false; } catch { return true; } }), Boolean, 'owned test shells stop', 10000).catch(error => { result.cleanupError = String(error); });
    result = { ...result, diagnostic, inputFailures, steps, evidence, errors, ownedPids, cleanedUp: !result.cleanupError, finishedAt: new Date().toISOString(), limitations: ['Actual Chrome mouse drags with real HostCore/ConPTY; the desktop bridge and connection transitions are a test fixture, not Electron/Tailscale transport.', 'External untrusted payloads are synthetic DragEvents. Physical mobile touch/IME is not exercised.'] };
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(path.join(output, 'rpc.json'), JSON.stringify(calls, null, 2));
    assert.equal(result.cleanedUp, true);
  }
});
