import { app, BrowserWindow, dialog, ipcMain, Menu, session, Tray, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { connectOwnerPipe } from '../../packages/local-ipc/index';
import { AppError, PROTOCOL_VERSION, type HostEvent, type Transport } from '../../packages/protocol/index';
import { HostRegistry } from './host-registry';
import { launchHost } from './runtime';
import { RemoteTransport } from './remote-transport';
import type { ConnectionInfo } from './contracts';
import { FullExitController, isProcessAlive, readHostReadiness } from './full-exit';
import { writeResumeManifest } from './resume-manifest';

app.setName('몽글터미널');
// Match installer and shortcut identity for Windows taskbar grouping.
if (process.platform === 'win32') app.setAppUserModelId('dev.mongle.terminal');
const dataDir = path.resolve(process.env.MONGLE_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'MongleTerminal'));
app.setPath('userData', path.join(dataDir, 'desktop-profile'));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
const root = app.isPackaged ? path.join(process.resourcesPath, 'hostbundle') : app.getAppPath();
process.env.MONGLE_NATIVE_HELPER = path.join(root, 'platform/windows/OwnerPipe.exe');
process.env.MONGLE_OWNER_HELPER = process.env.MONGLE_NATIVE_HELPER;
const registry = new HostRegistry(dataDir);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let openingWindow: Promise<void> | undefined;
let desktopReady = false;
let transport: Transport | undefined;
let connection: ConnectionInfo = { status: 'connecting', owner: true };
let selectionGeneration = 0;
let retryTimer: NodeJS.Timeout | undefined;
let retryDelay = 500;
let quitting = false;
let connecting = false;
let hostStoppedByUser = false;
let fullExitCommitted = false;
const connectionAttempts = new Set<Promise<ConnectionInfo>>();
const pendingHostStarts = new Set<number>();

function emitEvent(message: HostEvent) { if (window && !window.isDestroyed()) window.webContents.send('mongle:event', message); }
function setConnection(info: ConnectionInfo) { connection = info; if (window && !window.isDestroyed()) window.webContents.send('mongle:connection', info); }
function retry() {
  if (quitting || fullExitCommitted || hostStoppedByUser || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; void connectSelected(); }, retryDelay + Math.random() * 250);
  retryDelay = Math.min(30_000, retryDelay * 2);
}
function connectSelected(): Promise<ConnectionInfo> {
  if (quitting || fullExitCommitted || connecting) return Promise.resolve(connection);
  const attempt = connectSelectedAttempt();
  connectionAttempts.add(attempt);
  void attempt.then(() => connectionAttempts.delete(attempt), () => connectionAttempts.delete(attempt));
  return attempt;
}
async function connectSelectedAttempt(): Promise<ConnectionInfo> {
  connecting = true;
  const generation = ++selectionGeneration;
  const cancelled = () => generation !== selectionGeneration || quitting || fullExitCommitted;
  const host = registry.get(registry.selectedId);
  transport?.close(); transport = undefined;
  setConnection({ status: 'connecting', owner: host.local });
  let attempt: Transport | undefined;
  let launchedPid: number | undefined;
  try {
    let next: Transport;
    let info: ConnectionInfo;
    if (host.local) {
      const attach = () => connectOwnerPipe({ dataDir,
        onEvent: (event: HostEvent) => { if (generation === selectionGeneration) emitEvent(event); },
        onClose: () => { if (generation === selectionGeneration && connection.status === 'connected' && !quitting && !fullExitCommitted && !hostStoppedByUser) { setConnection({ ...connection, status: 'offline', error: '로컬 호스트 연결이 끊어졌습니다.' }); retry(); } },
      });
      try { next = await attach(); }
      catch (error) {
        // Never silently replace an existing host after an authentication error.
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !['ENOENT', 'ECONNREFUSED', 'PIPE_NOT_FOUND', 'HOST_UNAVAILABLE', 'NO_HOST'].includes(code)) throw error;
        if (cancelled()) return connection;
        launchedPid = await launchHost(root, dataDir);
        pendingHostStarts.add(launchedPid);
        const deadline = Date.now() + 15_000;
        // If shutdown commits during launch, finish observing readiness before
        // the shutdown controller rechecks local absence. Do not launch again.
        while (true) { try { next = await attach(); break; } catch (error) { if (Date.now() > deadline) throw error; await new Promise(r => setTimeout(r, 250)); } }
      }
      attempt = next;
      if (cancelled()) { next.close(); return connection; }
      const deadline = Date.now() + 15_000;
      let state: { hostId: string; protocolVersion: number };
      while (true) {
        try { state = await next.request('state.get'); break; }
        catch (error) { if (cancelled() || (error as { code?: string }).code !== 'STARTING' || Date.now() > deadline) throw error; await new Promise(r => setTimeout(r, 150)); }
      }
      if (cancelled()) { next.close(); return connection; }
      if (state.protocolVersion !== PROTOCOL_VERSION) { next.close(); throw new AppError('VERSION_MISMATCH', '실행 중인 호스트와 앱 버전이 다릅니다. 기존 앱으로 작업을 마친 후 업데이트하세요.'); }
      if (launchedPid !== undefined) pendingHostStarts.delete(launchedPid);
      const context = await next.request<{ id: string }>('connection.info');
      info = { status: 'connected', owner: true, hostId: state.hostId, connectionId: context.id };
    } else {
      const remote = new RemoteTransport(host, id => registry.bindIdentity(host.id, id), () => { if (generation === selectionGeneration) { setConnection({ ...connection, status: 'offline', error: '원격 연결이 끊어졌습니다.' }); retry(); } });
      attempt = remote;
      next = remote;
      remote.subscribe(event => { if (generation === selectionGeneration) emitEvent(event); });
      const result = await remote.connect();
      info = { status: result.paired ? 'connected' : 'pairing', owner: false, hostId: result.hostId, connectionId: result.connectionId };
    }
    if (cancelled()) { next.close(); return connection; }
    transport = next; retryDelay = 500; setConnection(info);
  } catch (error) {
    attempt?.close();
    const message = error instanceof Error ? error.message : '컴퓨터에 연결하지 못했습니다.';
    if (generation === selectionGeneration) { setConnection({ status: 'offline', owner: host.local, error: message }); if (!(error instanceof AppError && ['VERSION_MISMATCH', 'AUTH_FAILED', 'HOST_IDENTITY_CHANGED'].includes(error.code))) retry(); }
  } finally { if (generation === selectionGeneration) connecting = false; }
  return connection;
}

const entry = path.join(root, 'dist/web/index.html');
const expectedURL = pathToFileURL(entry).href;
function trusted(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== expectedURL) throw new Error('신뢰할 수 없는 화면의 요청입니다.');
}
function handlers() {
  const allowConnectionChanges = () => { if (fullExitCommitted) throw new AppError('SHUTTING_DOWN', '현재 컴퓨터의 완전 종료가 진행 중입니다.'); };
  ipcMain.handle('mongle:connection-info', event => { trusted(event); return connection; });
  ipcMain.handle('mongle:hosts', event => { trusted(event); return registry.list(); });
  ipcMain.handle('mongle:add-host', (event, host) => { trusted(event); return registry.add(host); });
  ipcMain.handle('mongle:remove-host', async (event, id) => {
    trusted(event); allowConnectionChanges(); z.string().uuid().parse(id);
    const host = registry.get(id); const wasSelected = host.selected;
    const remote = new RemoteTransport(host, async () => undefined, () => undefined); await remote.forget();
    await registry.remove(id); if (wasSelected) { selectionGeneration++; transport?.close(); connecting = false; await connectSelected(); }
  });
  ipcMain.handle('mongle:select-host', async (event, id) => {
    trusted(event); allowConnectionChanges(); z.string().max(80).parse(id);
    if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
    selectionGeneration++; connecting = false; hostStoppedByUser = false; await registry.select(id); return connectSelected();
  });
  ipcMain.handle('mongle:request', async (event, method, params) => {
    try { return { ok: true, result: await handleRequest(event, method, params) }; }
    catch (error) { return { ok: false, error: { code: error instanceof AppError ? error.code : 'REQUEST_FAILED', message: error instanceof Error ? error.message : '요청을 완료하지 못했습니다.' } }; }
  });
  async function handleRequest(event: IpcMainInvokeEvent, method: unknown, params: unknown) {
    trusted(event); allowConnectionChanges(); z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/).parse(method);
    const name = method as string;
    if (JSON.stringify(params ?? null).length > 256 * 1024) throw new Error('요청이 너무 큽니다.');
    if (transport instanceof RemoteTransport && ['pairing.request', 'pairing.status', 'pairing.claim', 'auth.logout'].includes(name)) {
      const result = await transport.pairing(name, params);
      if (name === 'pairing.claim' || name === 'auth.logout') await connectSelected();
      return result;
    }
    if (connection.status !== 'connected' || !transport) throw new Error('먼저 컴퓨터에 연결하세요.');
    try {
      const result = await transport.request(name, params);
      if (name === 'host.shutdown' && connection.owner) { hostStoppedByUser = true; if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined; transport.close(); transport = undefined; setConnection({ status: 'offline', owner: true, error: '호스트를 종료했습니다. 현재 컴퓨터를 다시 선택하면 시작합니다.' }); }
      return result;
    }
    catch (error) { if ((error as { code?: string }).code === 'OFFLINE') { setConnection({ ...connection, status: 'offline' }); retry(); } throw error; }
  }
}
async function createWindow() {
  const created = new BrowserWindow({ width: 1380, height: 900, minWidth: 760, minHeight: 520, title: '몽글터미널', icon: path.join(root, 'platform/windows/icon.ico'), backgroundColor: '#17191b', show: false,
    webPreferences: { preload: path.join(app.getAppPath(), 'dist/desktop/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, webviewTag: false },
  });
  window = created;
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', event => event.preventDefault());
  created.webContents.on('will-attach-webview', event => event.preventDefault());
  created.on('close', event => {
    if (!quitting && tray && !tray.isDestroyed()) { event.preventDefault(); created.hide(); }
  });
  // Leave query-session-end unblocked and unchanged: another app can still
  // cancel shutdown. Only the confirmed session-end starts desktop cleanup.
  created.on('session-end', releaseDesktopResources);
  created.on('closed', () => { if (window === created) window = undefined; });
  try { await created.loadFile(entry); }
  catch (error) { if (!created.isDestroyed()) created.destroy(); throw error; }
}
async function showWindow() {
  if (quitting) return;
  if (!openingWindow && (!window || window.isDestroyed())) {
    openingWindow = createWindow().finally(() => { openingWindow = undefined; });
  }
  if (openingWindow) await openingWindow;
  if (!quitting && window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }
}
function openWindow() {
  void showWindow().catch(error => { dialog.showErrorBox('몽글터미널을 열지 못했습니다', error instanceof Error ? error.message : String(error)); });
}
const fullExit = new FullExitController({
  connectLocal: onClose => connectOwnerPipe({ dataDir, onClose }),
  readReadiness: () => readHostReadiness(dataDir),
  isProcessAlive,
  async confirm({ runningTerminals, recordHistory }) {
    const options = {
      type: 'warning' as const, title: '몽글터미널 완전 종료',
      message: '현재 컴퓨터의 몽글터미널을 완전히 종료할까요?',
      detail: `현재 컴퓨터에서 실행 중인 터미널 ${runningTerminals}개를 종료합니다. 이 컴퓨터로 들어오는 원격 접속도 끊깁니다. 다른 컴퓨터의 터미널은 종료하지 않습니다.\n\n그룹과 분할 배치는 저장됩니다. ${recordHistory ? '출력 기록 저장이 켜져 있어 이전 출력도 저장됩니다.' : '출력 기록 저장이 꺼져 있어 이전 출력은 저장되지 않습니다.'}\n다음 실행에서는 배치와 기록을 열고, 저장된 시작 폴더에서 새 셸을 자동으로 시작합니다. 실행 중인 프로그램과 저장하지 않은 상태는 복구되지 않으며 이전 명령은 다시 실행하지 않습니다.`,
      buttons: ['취소', '완전 종료'], defaultId: 0, cancelId: 0, noLink: true,
    };
    const result = window && !window.isDestroyed() && window.isVisible() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  async suspendDesktop() {
    fullExitCommitted = true; hostStoppedByUser = true; selectionGeneration++;
    if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
    await Promise.allSettled([...connectionAttempts]);
    connecting = false;
    // A launcher may return before the host writes readiness. If its attach
    // timed out, absence of the file alone must not be treated as no live host.
    const readiness = await readHostReadiness(dataDir);
    for (const pid of pendingHostStarts) {
      if (isProcessAlive(pid) && readiness?.pid !== pid) throw new AppError('HOST_STARTING', '현재 컴퓨터의 백그라운드 실행이 아직 시작 중입니다. 준비된 뒤 완전 종료를 다시 시도하세요.');
      pendingHostStarts.delete(pid);
    }
  },
  keepDesktop() {
    fullExitCommitted = false; connecting = false;
    transport?.close(); transport = undefined;
    setConnection({ status: 'offline', owner: registry.get(registry.selectedId).local, error: '완전 종료를 완료하지 못했습니다. 상태를 확인한 뒤 다시 연결하세요.' });
  },
  writeResumeManifest: state => writeResumeManifest(dataDir, state),
  quitDesktop: () => { fullExitCommitted = false; app.quit(); },
  showError: message => dialog.showErrorBox('완전 종료를 완료하지 못했습니다', message),
});
function requestFullExit() { void fullExit.run(); }
function createTray() {
  if (process.platform !== 'win32') return;
  tray = new Tray(path.join(root, 'platform/windows/icon.ico'));
  tray.setToolTip('몽글터미널');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '몽글터미널 열기', click: openWindow },
    { type: 'separator' },
    { label: '앱 종료 · 터미널 유지', click: () => app.quit() },
    { label: '완전 종료…', click: requestFullExit },
  ]));
  tray.on('click', openWindow);
  tray.on('double-click', openWindow);
}
function releaseDesktopResources() {
  quitting = true; desktopReady = false; selectionGeneration++;
  if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
  transport?.close(); transport = undefined;
  tray?.destroy(); tray = undefined;
}
app.on('second-instance', () => { if (desktopReady) openWindow(); });
app.on('before-quit', event => {
  // A second quit command must not turn a pending shutdown acknowledgement into
  // apparent completion. Windows session-end still owns its normal cleanup.
  if (fullExitCommitted && !quitting) { event.preventDefault(); return; }
  releaseDesktopResources();
});
app.on('window-all-closed', () => { if (quitting || !tray || tray.isDestroyed()) app.quit(); });
if (singleInstance) void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '몽글터미널', submenu: [{ label: process.platform === 'win32' ? '창 닫기 · 트레이로 숨기기' : '창 닫기 · 터미널 유지', role: 'close' }, { type: 'separator' }, { label: '앱 종료 · 터미널 유지', role: 'quit' }, { label: '완전 종료…', click: requestFullExit }] }, { label: '편집', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }]));
  await registry.load(); handlers(); createTray(); desktopReady = true; await showWindow(); await connectSelected();
  const monitor = setInterval(() => {
    if (connection.status !== 'connected' || !transport || connecting || quitting || fullExitCommitted) return;
    const current = transport;
    void current.request('connection.info').catch(() => { if (transport === current && !quitting && !fullExitCommitted && !hostStoppedByUser) { setConnection({ ...connection, status: 'offline', error: '연결이 끊어졌습니다.' }); retry(); } });
  }, 5_000);
  monitor.unref();
}).catch(error => { dialog.showErrorBox('몽글터미널을 열지 못했습니다', error instanceof Error ? error.message : String(error)); app.quit(); });
