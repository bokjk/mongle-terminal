import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, session, Tray, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { connectOwnerPipe } from '../../packages/local-ipc/index';
import { AppError, PROTOCOL_VERSION, type HostEvent, type Transport } from '../../packages/protocol/index';
import { HostRegistry } from './host-registry';
import { launchHost, prepareDesktopDataDirectory } from './runtime';
import { RemoteTransport } from './remote-transport';
import type { ConnectionInfo } from './contracts';
import { FullExitController, isProcessAlive, readHostReadiness } from './full-exit';
import { writeResumeManifest } from './resume-manifest';
import { UpdateController } from './updater';
import { GuardedNsisUpdater } from './updater-driver';
import { createVerifiedClipboardWriter } from './clipboard';

app.setName('몽글터미널');
// Match installer and shortcut identity for Windows taskbar grouping.
if (process.platform === 'win32') app.setAppUserModelId('dev.mongle.terminal');
const root = path.resolve(app.isPackaged ? path.join(process.resourcesPath, 'hostbundle') : app.getAppPath());
process.env.MONGLE_NATIVE_HELPER = path.join(root, 'platform/windows/OwnerPipe.exe');
process.env.MONGLE_OWNER_HELPER = process.env.MONGLE_NATIVE_HELPER;
const dataDir = path.resolve(process.env.MONGLE_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'MongleTerminal'));
const singleInstance = (() => {
  try {
    // Do not yield before preparation: Chromium can create profile directories
    // with the token's default owner before the native owner check runs.
    prepareDesktopDataDirectory(root, dataDir);
    app.setPath('userData', path.join(dataDir, 'desktop-profile'));
    const acquired = app.requestSingleInstanceLock();
    if (!acquired) app.quit();
    return acquired;
  } catch (error) {
    dialog.showErrorBox('몽글터미널을 열지 못했습니다', error instanceof Error ? error.message : String(error));
    app.exit(1);
    return false;
  }
})();
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
let unsavedFiles = 0;
let unsavedNoticeOpen = false;
function protectUnsavedFiles() {
  if (!unsavedFiles) return false;
  openWindow();
  if (!unsavedNoticeOpen) {
    unsavedNoticeOpen = true;
    const options = { type: 'warning' as const, title: '저장하지 않은 파일', message: '파일 편집을 마친 뒤 종료해 주세요.', detail: '파일 편집기에서 변경 내용을 저장하거나 해당 파일 탭을 닫아 변경을 버릴 수 있습니다. 실행 중인 터미널은 유지됩니다.', buttons: ['편집기로 돌아가기'] };
    void (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).finally(() => { unsavedNoticeOpen = false; });
  }
  return true;
}
let connecting = false;
let hostStoppedByUser = false;
let fullExitCommitted = false;
let choosingDirectory = false;
let updater: UpdateController | undefined;
const connectionAttempts = new Set<Promise<ConnectionInfo>>();
const pendingHostStarts = new Set<number>();
const writeClipboard = createVerifiedClipboardWriter(clipboard);

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
  ipcMain.handle('mongle:unsaved-files', (event, count) => { trusted(event); unsavedFiles = z.number().int().min(0).max(48).parse(count); });
  ipcMain.handle('mongle:window-theme', (event, value) => {
    trusted(event);
    const theme = z.enum(['dark', 'light']).parse(value);
    if (process.platform === 'win32') window!.setTitleBarOverlay({ color: theme === 'dark' ? '#171819' : '#f7f8f5', symbolColor: theme === 'dark' ? '#eceeec' : '#242b25' });
  });
  const allowConnectionChanges = () => { if (fullExitCommitted) throw new AppError('SHUTTING_DOWN', '현재 컴퓨터의 완전 종료가 진행 중입니다.'); };
  ipcMain.handle('mongle:connection-info', event => { trusted(event); return connection; });
  ipcMain.handle('mongle:hosts', event => { trusted(event); return registry.list(); });
  ipcMain.handle('mongle:update-state', event => { trusted(event); return updater!.getState(); });
  ipcMain.handle('mongle:update-check', event => { trusted(event); return updater!.check(); });
  ipcMain.handle('mongle:update-install', event => { trusted(event); return updater!.install(); });
  ipcMain.handle('mongle:clipboard-read', async event => { trusted(event); return z.string().max(16 * 1024 * 1024).parse(await clipboard.readText()); });
  ipcMain.handle('mongle:clipboard-write', async (event, text) => { trusted(event); await writeClipboard(z.string().max(16 * 1024 * 1024).parse(text)); });
  ipcMain.handle('mongle:select-directory', async (event, currentPath) => {
    trusted(event); allowConnectionChanges();
    const canChoose = () => !quitting && !fullExitCommitted && connection.status === 'connected' && connection.owner && registry.get(registry.selectedId).local;
    if (!canChoose()) throw new Error('폴더 찾아보기는 이 PC에 연결했을 때 사용할 수 있습니다. 원격 컴퓨터의 폴더는 경로를 입력하세요.');
    const value = z.string().max(4096).refine(value => !value.includes('\0')).optional().parse(currentPath)?.trim();
    if (value && !path.isAbsolute(value)) throw new Error('시작 폴더는 전체 경로로 입력하세요.');
    if (choosingDirectory || !window || window.isDestroyed()) throw new Error('폴더 선택창을 이미 열었거나 앱 창을 사용할 수 없습니다.');
    const generation = selectionGeneration;
    choosingDirectory = true;
    try {
      const result = await dialog.showOpenDialog(window, { title: '터미널 시작 폴더 선택', buttonLabel: '폴더 선택', properties: ['openDirectory'], ...(value ? { defaultPath: value } : {}) });
      if (generation !== selectionGeneration || !canChoose()) throw new Error('연결이 바뀌었습니다. 시작 폴더를 다시 선택하세요.');
      return result.canceled ? null : result.filePaths[0] ?? null;
    } finally { choosingDirectory = false; }
  });
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
    if (name === 'host.shutdown' && protectUnsavedFiles()) throw new AppError('UNSAVED_FILES', '편집 중인 파일을 저장하거나 닫은 뒤 종료해 주세요.');
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
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#171819', symbolColor: '#eceeec', height: 35 } } : {}),
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
function recoverDesktopAfterShutdown(error: string) {
  fullExitCommitted = false; connecting = false;
  transport?.close(); transport = undefined;
  setConnection({ status: 'offline', owner: registry.get(registry.selectedId).local, error });
}
const fullExit = new FullExitController({
  connectLocal: onClose => connectOwnerPipe({ dataDir, onClose }),
  readReadiness: () => readHostReadiness(dataDir),
  isProcessAlive,
  async confirm({ runningTerminals, recordHistory }) {
    if (protectUnsavedFiles()) return false;
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
    if (protectUnsavedFiles()) throw new AppError('UNSAVED_FILES', '편집 중인 파일을 먼저 저장해 주세요.');
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
    recoverDesktopAfterShutdown('완전 종료를 완료하지 못했습니다. 상태를 확인한 뒤 다시 연결하세요.');
  },
  writeResumeManifest: state => writeResumeManifest(dataDir, state),
  quitDesktop: () => { fullExitCommitted = false; app.quit(); },
  showError: message => dialog.showErrorBox('완전 종료를 완료하지 못했습니다', message),
});
function requestFullExit() { void fullExit.run(); }

function setupUpdater() {
  const installed = process.platform === 'win32' && app.isPackaged && existsSync(path.join(process.resourcesPath, 'mongle-installed.json')) && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  const driver = new GuardedNsisUpdater(() => updater?.getState().status === 'installing');
  let lastStatus = '';
  updater = new UpdateController({
    currentVersion: app.getVersion(), driver,
    unsupportedReason: installed ? undefined : '자동 업데이트는 Windows 설치 프로그램으로 설치한 앱에서 사용할 수 있습니다. ZIP 실행본과 개발 모드는 수동으로 교체하세요.',
    publish(state) {
      if (window && !window.isDestroyed()) window.webContents.send('mongle:update', state);
      if (state.status !== lastStatus) {
        configureApplicationMenu(); updateTrayMenu();
        if (state.status === 'ready' && Notification.isSupported()) {
          const notification = new Notification({ title: '몽글터미널 업데이트 준비 완료', body: `${state.availableVersion} 버전을 설치할 수 있습니다. 작업을 저장한 뒤 사이드바 아래의 업데이트 버튼이나 트레이 메뉴에서 설치해 주세요.` });
          notification.on('click', openWindow); notification.show();
        }
        lastStatus = state.status;
      }
    },
    async prepareInstall(report) {
      if (protectUnsavedFiles()) return false;
      let prepared = false;
      await fullExit.run({
        async confirm({ runningTerminals, recordHistory }) {
          const options = { type: 'warning' as const, title: '몽글터미널 업데이트',
            message: '작업을 저장하고 업데이트를 설치할까요?',
            detail: `현재 컴퓨터의 터미널 ${runningTerminals}개와 원격 접속을 종료하고 새 버전으로 다시 시작합니다. 다른 컴퓨터의 터미널은 종료하지 않습니다.\n\n그룹과 분할 배치${recordHistory ? ', 보관 중인 출력 기록' : ''}는 저장되며 새 셸로 복원됩니다. 실행 중인 Claude 등의 프로그램과 저장하지 않은 작업은 이어서 실행되지 않습니다.\n\n앱이 닫히면 설치 창에 진행 상황이 표시되고, 설치가 끝나면 몽글터미널이 다시 열립니다.`,
            buttons: ['취소', '설치 후 다시 시작'], defaultId: 0, cancelId: 0, noLink: true };
          const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
          const accepted = result.response === 1;
          if (accepted) report('saving');
          return accepted;
        },
        quitDesktop: () => { prepared = true; },
        showError: message => dialog.showErrorBox('업데이트를 설치하지 못했습니다', message),
      });
      return prepared;
    },
    allowInstallerQuit() { fullExitCommitted = false; },
    installFailed() { recoverDesktopAfterShutdown('업데이트 설치를 완료하지 못했습니다. 다시 연결하면 작업 공간을 열 수 있습니다.'); },
  });
}
async function checkUpdatesFromMenu() {
  const state = await updater?.check();
  if (!state || quitting) return;
  const message = state.message || (state.status === 'downloading' ? '새 버전을 다운로드하고 있습니다. 완료되면 알려드립니다.' : '업데이트를 확인하고 있습니다.');
  const options = { type: 'info' as const, title: '몽글터미널 업데이트', message, buttons: ['확인'] };
  if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options); else await dialog.showMessageBox(options);
}
function installUpdateFromMenu() { void updater?.install().catch(error => dialog.showErrorBox('업데이트', error.message)); }
function updateMenuItems() {
  return [{ label: '업데이트 확인', click: () => { void checkUpdatesFromMenu(); } },
    { label: '업데이트 설치 후 다시 시작…', enabled: updater?.getState().status === 'ready', click: installUpdateFromMenu }];
}
function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(updater?.getState().status === 'ready' ? '몽글터미널 · 업데이트 준비 완료' : '몽글터미널');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '몽글터미널 열기', click: openWindow },
    ...updateMenuItems(),
    { type: 'separator' },
    { label: '앱 종료 · 터미널 유지', click: () => app.quit() },
    { label: '완전 종료…', click: requestFullExit },
  ]));
}
function createTray() {
  if (process.platform !== 'win32') return;
  tray = new Tray(path.join(root, 'platform/windows/icon.ico'));
  updateTrayMenu();
  tray.on('click', openWindow);
  tray.on('double-click', openWindow);
}
function releaseDesktopResources() {
  updater?.dispose();
  quitting = true; desktopReady = false; selectionGeneration++;
  if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
  transport?.close(); transport = undefined;
  tray?.destroy(); tray = undefined;
}
app.on('second-instance', () => { if (desktopReady) openWindow(); });
app.on('before-quit', event => {
  if (protectUnsavedFiles()) { event.preventDefault(); return; }
  // A second quit command must not turn a pending shutdown acknowledgement into
  // apparent completion. Windows session-end still owns its normal cleanup.
  if (fullExitCommitted && !quitting) { event.preventDefault(); return; }
  releaseDesktopResources();
});
app.on('window-all-closed', () => { if (quitting || !tray || tray.isDestroyed()) app.quit(); });
function configureApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '몽글터미널', submenu: [{ label: process.platform === 'win32' ? '창 닫기 · 트레이로 숨기기' : '창 닫기 · 터미널 유지', role: 'close' }, { type: 'separator' }, { label: '앱 종료 · 터미널 유지', role: 'quit' }, { label: '완전 종료…', click: requestFullExit }, { type: 'separator' }, ...updateMenuItems()] }, { label: '편집', submenu: [{ role: 'copy', accelerator: 'CommandOrControl+Shift+C' }, { role: 'paste' }, { role: 'selectAll', accelerator: 'CommandOrControl+Shift+A' }] }, { label: '보기', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }]));
}
if (singleInstance) void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  setupUpdater(); configureApplicationMenu();
  await registry.load(); handlers(); createTray(); desktopReady = true; await showWindow(); await connectSelected(); updater?.start();
  const monitor = setInterval(() => {
    if (connection.status !== 'connected' || !transport || connecting || quitting || fullExitCommitted) return;
    const current = transport;
    void current.request('connection.info').catch(() => { if (transport === current && !quitting && !fullExitCommitted && !hostStoppedByUser) { setConnection({ ...connection, status: 'offline', error: '연결이 끊어졌습니다.' }); retry(); } });
  }, 5_000);
  monitor.unref();
}).catch(error => { dialog.showErrorBox('몽글터미널을 열지 못했습니다', error instanceof Error ? error.message : String(error)); app.quit(); });
