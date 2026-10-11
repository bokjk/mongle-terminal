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
  /** How long installation waits for the release check before asking the user to try again. */
  latestCheckTimeoutMs?: number;
}

const PHASE_MESSAGES: Record<InstallPhase, string> = {
  checking: '설치하기 전에 더 새로운 버전이 나왔는지 확인하고 있습니다.',
  confirming: '설치 확인 창에서 진행 여부를 선택해 주세요.',
  saving: '터미널 구성을 저장하고 이 컴퓨터의 작업을 종료하고 있습니다.',
  launching: '설치 프로그램을 시작합니다. 앱이 닫힌 뒤 설치 창에서 진행 상황을 볼 수 있습니다.',
};
const READY_MESSAGE = '새 버전이 준비됐습니다. 작업을 저장한 뒤 설치해 주세요.';

/**
 * Downloads may be automatic; installation always has a local shutdown barrier.
 * A download that waited for days is never installed blindly: checks continue while
 * it is ready and installation asks once more, so a late install goes straight to
 * the newest release instead of one outdated step at a time.
 */
export class UpdateController {
  private state: UpdateState;
  private checking?: Promise<UpdateState>;
  private installing?: Promise<void>;
  private startup?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private disposed = false;
  private preparing = false;
  private installCleanupDone = false;
  /** The running check began with a download ready. Until a release is offered, its failures keep that download. */
  private quiet = false;
  /** Installation was requested and a newer release started downloading; continue with it once ready. */
  private installAfterDownload = false;
  private pendingDownload?: Promise<unknown>;
  private readonly listeners: Array<[string, (...args: any[]) => void]> = [];

  constructor(private readonly d: UpdateDependencies) {
    d.driver.autoDownload = true;
    d.driver.autoInstallOnAppQuit = false;
    d.driver.allowPrerelease = false;
    d.driver.allowDowngrade = false;
    d.driver.disableWebInstaller = true;
    this.state = { status: d.unsupportedReason ? 'unsupported' : 'idle', currentVersion: d.currentVersion, message: d.unsupportedReason };
    const on = (event: string, listener: (...args: any[]) => void) => { d.driver.on(event, listener); this.listeners.push([event, listener]); };
    on('checking-for-update', () => { if (!this.holdsDownload()) this.set({ status: 'checking', phase: undefined, message: undefined }); });
    on('update-not-available', () => {
      this.quiet = false;
      this.installAfterDownload = false;
      this.set({ status: 'idle', availableVersion: undefined, progress: undefined, phase: undefined, message: '최신 버전입니다.' });
    });
    on('update-available', info => {
      this.quiet = false;
      if (!this.validVersion(info?.version)) { this.fail(); return; }
      // The ready download is still the release on offer: keep it installable.
      if (this.holdsDownload() && info.version === this.state.availableVersion) return;
      const continuing = this.state.status === 'installing';
      this.installAfterDownload = continuing;
      this.set({ status: 'downloading', availableVersion: info.version, progress: 0, phase: undefined,
        message: continuing ? `더 새로운 ${info.version} 버전을 받고 있습니다. 다운로드가 끝나면 이 버전으로 설치를 이어 갑니다.` : undefined });
    });
    on('download-progress', info => {
      if (this.state.status === 'downloading' && Number.isFinite(info?.percent)) this.set({ progress: Math.min(100, Math.max(0, Math.round(info.percent))) });
    });
    on('update-downloaded', info => {
      if (!this.validVersion(info?.version)) { this.fail(); return; }
      // A re-check of the same release while installation already holds this download.
      if (this.state.status === 'installing') return;
      const ready: Partial<UpdateState> = { status: 'ready', availableVersion: info.version, progress: 100, phase: undefined, message: READY_MESSAGE };
      if (this.installAfterDownload && this.state.status === 'downloading') {
        this.installAfterDownload = false;
        // The user already chose to install: go straight to the confirmation for this release.
        this.state = { ...this.state, ...ready };
        void this.startInstall(false);
        return;
      }
      this.set(ready);
    });
    on('update-cancelled', () => {
      this.installAfterDownload = false;
      this.set({ status: 'idle', progress: undefined, phase: undefined, message: '다운로드가 취소됐습니다. 다시 확인할 수 있습니다.' });
    });
    on('error', () => { if (!this.quiet) this.fail(); });
  }

  private validVersion(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value); }
  /** A downloaded update stays installable while a check runs in these states. */
  private holdsDownload(): boolean { return this.state.status === 'ready' || (this.state.status === 'installing' && this.state.phase === 'checking'); }
  getState(): UpdateState { return { ...this.state }; }
  private set(patch: Partial<UpdateState>): void {
    if (this.disposed || this.d.unsupportedReason) return;
    this.state = { ...this.state, ...patch };
    this.d.publish(this.getState());
  }
  private fail(): void {
    if (this.disposed) return;
    this.installAfterDownload = false;
    // While still checking for a newer release nothing has been shut down yet.
    if (this.state.status === 'installing' && this.state.phase !== 'checking' && !this.preparing) this.recoverInstall();
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
  /** Also runs while an update is ready, so a newer release replaces an outdated download. */
  check(): Promise<UpdateState> {
    if (this.checking) return this.checking;
    if (this.disposed || this.d.unsupportedReason || ['downloading', 'installing'].includes(this.state.status)) return Promise.resolve(this.getState());
    return this.runCheck();
  }
  private runCheck(): Promise<UpdateState> {
    if (!this.checking) this.checking = this.performCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async performCheck(): Promise<UpdateState> {
    this.quiet = this.holdsDownload();
    if (!this.quiet) this.set({ status: 'checking', phase: undefined, message: undefined });
    try {
      const result = await this.d.driver.checkForUpdates();
      if (result?.downloadPromise) {
        const download = this.pendingDownload = result.downloadPromise;
        void download.catch(() => this.fail());
      }
      if (this.state.status === 'checking') this.set({ status: 'idle', message: result ? '최신 버전입니다.' : '업데이트 정보를 확인할 수 없습니다.' });
    } catch { if (!this.quiet) this.fail(); }
    finally { this.quiet = false; }
    return this.getState();
  }
  install(): Promise<void> {
    if (this.installing) return this.installing;
    if (this.disposed || this.state.status !== 'ready') return Promise.reject(new Error('설치할 업데이트가 준비되지 않았습니다.'));
    return this.startInstall(true);
  }
  private startInstall(checkLatest: boolean): Promise<void> {
    if (!this.installing) this.installing = this.performInstall(checkLatest).finally(() => { this.installing = undefined; });
    return this.installing;
  }
  /**
   * Asks for the newest release before installing. True when the ready download is
   * still the one on offer, or when the check failed (offline) and that download stays valid.
   * A newer release downloads first and installation continues with it automatically.
   */
  private async latestIsReady(): Promise<boolean> {
    const version = this.state.availableVersion;
    this.set({ status: 'installing', phase: 'checking', message: PHASE_MESSAGES.checking });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), this.d.latestCheckTimeoutMs ?? 20_000); timer.unref?.(); });
    // The same release offered again: wait until its download is confirmed. A newer one downloads on its own.
    const confirmed = () => this.state.status === 'installing' && this.state.phase === 'checking' ? this.pendingDownload?.catch(() => undefined) : undefined;
    const checked = this.runCheck().then(confirmed).then(() => 'checked' as const);
    const outcome = await Promise.race([checked, slow]).finally(() => clearTimeout(timer));
    if (this.disposed || this.state.status !== 'installing' || this.state.phase !== 'checking') return false;
    if (outcome === 'slow') {
      this.set({ status: 'ready', phase: undefined, message: '새 버전 확인이 늦어지고 있습니다. 잠시 후 다시 설치해 주세요.' });
      return false;
    }
    return this.state.availableVersion === version;
  }
  private async performInstall(checkLatest: boolean): Promise<void> {
    this.installCleanupDone = false;
    if (checkLatest && !(await this.latestIsReady())) return;
    if (this.disposed) return;
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
