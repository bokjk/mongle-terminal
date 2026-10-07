import type { UpdateState } from './contracts';

export type InstallPhase = NonNullable<UpdateState['phase']>;

export interface UpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  disableWebInstaller: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateDependencies {
  currentVersion: string;
  unsupportedReason?: string;
  driver: UpdateDriver;
  publish(state: UpdateState): void;
  /** Must confirm, save state and wait for the authenticated LOCAL host to exit. Reports 'saving' after the user confirms. */
  prepareInstall(report: (phase: InstallPhase) => void): Promise<boolean>;
  allowInstallerQuit(): void;
  installFailed(): void;
}

const PHASE_MESSAGES: Record<InstallPhase, string> = {
  confirming: '설치 확인 창에서 진행 여부를 선택해 주세요.',
  saving: '터미널 구성을 저장하고 이 컴퓨터의 작업을 종료하고 있습니다.',
  launching: '설치 프로그램을 시작합니다. 앱이 닫힌 뒤 설치 창에서 진행 상황을 볼 수 있습니다.',
};

/** Downloads may be automatic; installation always has a local shutdown barrier. */
export class UpdateController {
  private state: UpdateState;
  private checking?: Promise<UpdateState>;
  private installing?: Promise<void>;
  private startup?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private disposed = false;
  private preparing = false;
  private installCleanupDone = false;
  private readonly listeners: Array<[string, (...args: any[]) => void]> = [];

  constructor(private readonly d: UpdateDependencies) {
    d.driver.autoDownload = true;
    d.driver.autoInstallOnAppQuit = false;
    d.driver.allowPrerelease = false;
    d.driver.allowDowngrade = false;
    d.driver.disableWebInstaller = true;
    this.state = { status: d.unsupportedReason ? 'unsupported' : 'idle', currentVersion: d.currentVersion, message: d.unsupportedReason };
    const on = (event: string, listener: (...args: any[]) => void) => { d.driver.on(event, listener); this.listeners.push([event, listener]); };
    on('checking-for-update', () => this.set({ status: 'checking', phase: undefined, message: undefined }));
    on('update-not-available', () => this.set({ status: 'idle', availableVersion: undefined, progress: undefined, phase: undefined, message: '최신 버전입니다.' }));
    on('update-available', info => {
      if (!this.validVersion(info?.version)) { this.fail(); return; }
      this.set({ status: 'downloading', availableVersion: info.version, progress: 0, phase: undefined, message: undefined });
    });
    on('download-progress', info => {
      if (this.state.status === 'downloading' && Number.isFinite(info?.percent)) this.set({ progress: Math.min(100, Math.max(0, Math.round(info.percent))) });
    });
    on('update-downloaded', info => {
      if (!this.validVersion(info?.version)) { this.fail(); return; }
      this.set({ status: 'ready', availableVersion: info.version, progress: 100, phase: undefined, message: '새 버전이 준비됐습니다. 작업을 저장한 뒤 설치해 주세요.' });
    });
    on('update-cancelled', () => this.set({ status: 'idle', progress: undefined, phase: undefined, message: '다운로드가 취소됐습니다. 다시 확인할 수 있습니다.' }));
    on('error', () => this.fail());
  }

  private validVersion(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value); }
  getState(): UpdateState { return { ...this.state }; }
  private set(patch: Partial<UpdateState>): void {
    if (this.disposed || this.d.unsupportedReason) return;
    this.state = { ...this.state, ...patch };
    this.d.publish(this.getState());
  }
  private fail(): void {
    if (this.disposed) return;
    if (this.state.status === 'installing' && !this.preparing) this.recoverInstall();
    this.set({ status: 'error', progress: undefined, phase: undefined,
      message: '업데이트를 완료하지 못했습니다. 인터넷 연결과 공개 릴리스 게시 여부를 확인한 뒤 다시 시도해 주세요.' });
  }
  private recoverInstall(): void {
    if (this.installCleanupDone) return;
    this.installCleanupDone = true;
    this.d.installFailed();
  }
  start(): void {
    if (this.disposed || this.d.unsupportedReason || this.startup || this.interval) return;
    this.startup = setTimeout(() => { this.startup = undefined; void this.check(); }, 30_000);
    this.interval = setInterval(() => { void this.check(); }, 6 * 60 * 60 * 1000);
    this.startup.unref?.(); this.interval.unref?.();
  }
  check(): Promise<UpdateState> {
    if (this.checking) return this.checking;
    if (this.disposed || this.d.unsupportedReason || ['downloading', 'ready', 'installing'].includes(this.state.status)) return Promise.resolve(this.getState());
    this.checking = this.performCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async performCheck(): Promise<UpdateState> {
    this.set({ status: 'checking', phase: undefined, message: undefined });
    try {
      const result = await this.d.driver.checkForUpdates();
      void result?.downloadPromise?.catch(() => this.fail());
      if (this.state.status === 'checking') this.set({ status: 'idle', message: result ? '최신 버전입니다.' : '업데이트 정보를 확인할 수 없습니다.' });
    } catch { this.fail(); }
    return this.getState();
  }
  install(): Promise<void> {
    if (this.installing) return this.installing;
    if (this.disposed || this.state.status !== 'ready') return Promise.reject(new Error('설치할 업데이트가 준비되지 않았습니다.'));
    this.installing = this.performInstall().finally(() => { this.installing = undefined; });
    return this.installing;
  }
  private async performInstall(): Promise<void> {
    this.installCleanupDone = false;
    this.set({ status: 'installing', phase: 'confirming', message: PHASE_MESSAGES.confirming });
    const report = (phase: InstallPhase) => {
      if (this.preparing && this.state.status === 'installing') this.set({ phase, message: PHASE_MESSAGES[phase] });
    };
    try {
      this.preparing = true;
      const prepared = await this.d.prepareInstall(report);
      this.preparing = false;
      if (this.disposed || this.state.status !== 'installing') { if (prepared) this.recoverInstall(); return; }
      if (!prepared) { this.set({ status: 'ready', phase: undefined, message: '설치를 진행하지 않았습니다. 준비되면 다시 시도하세요.' }); return; }
      this.set({ phase: 'launching', message: PHASE_MESSAGES.launching });
      this.d.allowInstallerQuit();
      // The native confirmation already approved installation. The installer
      // shows its own file progress and, only for --updated --force-run, skips
      // the finish page and restarts the app (platform/windows/installer.nsh).
      this.d.driver.quitAndInstall(false, true);
    } catch { this.preparing = false; this.recoverInstall(); this.fail(); }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.startup); clearInterval(this.interval);
    for (const [event, listener] of this.listeners) this.d.driver.removeListener(event, listener);
  }
}
