import electron from 'electron';
import { NsisUpdater } from 'electron-updater';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';

/** Keep an NSIS launch failure from triggering the updater's deferred app quit. */
export class GuardedNsisUpdater extends NsisUpdater {
  private installGeneration = 0;

  // Supplying an adapter disables the upstream HTTP executor, so this optional
  // argument is only for isolated tests. Production retains Electron's executor.
  constructor(private readonly shouldQuit: () => boolean, testApp?: AppAdapter) {
    super(undefined, testApp);
    this.on('error', () => {
      this.installGeneration++;
      this.quitAndInstallCalled = false;
    });
  }

  override quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    if (this.quitAndInstallCalled) return;
    const generation = ++this.installGeneration;
    // Pass --force-run explicitly: the assisted installer relaunches only for
    // --updated --force-run (see platform/windows/installer.nsh).
    const installed = this.install(isSilent, isForceRunAfter);
    if (!installed) { this.quitAndInstallCalled = false; return; }
    setImmediate(() => {
      const current = () => generation === this.installGeneration && this.quitAndInstallCalled && this.shouldQuit();
      if (!current()) return;
      this.beforeQuitForUpdate();
      // A before-quit subscriber can cancel this attempt or trigger recovery.
      if (current()) this.app.quit();
    });
  }

  protected beforeQuitForUpdate(): void {
    electron.autoUpdater.emit('before-quit-for-update');
  }
}
