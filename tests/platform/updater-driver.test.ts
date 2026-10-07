import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';
import { GuardedNsisUpdater } from '../../apps/desktop/updater-driver';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

class FixtureUpdater extends GuardedNsisUpdater {
  readonly spawned: Array<{ file: string; args: string[] }> = [];
  launch: () => Promise<boolean> = async () => true;
  beforeQuit: () => void = () => {};

  async ready(): Promise<void> {
    const helper = new DownloadedUpdateHelper(path.join(os.tmpdir(), 'mongle-updater-no-io-fixture'));
    const file = { url: 'never-executed.exe', sha512: 'fixture' };
    // false avoids all filesystem writes; spawnLog below never executes a file.
    await helper.setDownloadedFile('never-executed.exe', null,
      { version: '0.3.0', files: [file], path: file.url, sha512: file.sha512, releaseDate: '2026-09-29T00:00:00Z' },
      { url: new URL('https://example.invalid/never-executed.exe'), info: file }, file.url, false);
    this.downloadedUpdateHelper = helper;
  }

  protected override spawnLog(file: string, args: string[] = []): Promise<boolean> {
    this.spawned.push({ file, args });
    return this.launch();
  }
  protected override beforeQuitForUpdate(): void { this.beforeQuit(); }
}

async function fixture() {
  const events: string[] = [];
  let installing = true;
  const app: AppAdapter = {
    version: '0.2.0', name: 'Mongle fixture', isPackaged: true,
    appUpdateConfigPath: '', userDataPath: '', baseCachePath: '',
    whenReady: async () => {}, relaunch: () => {}, onQuit: () => {},
    quit: () => { events.push('quit'); },
  };
  const driver = new FixtureUpdater(() => installing, app);
  driver.logger = null;
  driver.autoInstallOnAppQuit = false;
  driver.beforeQuit = () => { events.push('before-quit'); };
  driver.on('error', () => { installing = false; events.push('error'); });
  await driver.ready();
  return { driver, events, setInstalling: (value: boolean) => { installing = value; } };
}

test('real NSIS driver launch rejection does not quit the app', async () => {
  const { driver, events } = await fixture();
  driver.launch = async () => { throw Object.assign(new Error('Fixture launch rejection'), { code: 'EIO' }); };
  driver.quitAndInstall(false, true);
  await flush();
  assert.deepEqual(events, ['error']);
  assert.equal(driver.spawned.length, 1);
  assert.deepEqual(driver.spawned[0].args, ['--updated', '--force-run']);
});

test('real NSIS driver retries after launch failure and quits only the new attempt', async () => {
  const { driver, events, setInstalling } = await fixture();
  driver.launch = async () => { throw Object.assign(new Error('Fixture launch rejection'), { code: 'EIO' }); };
  driver.on('error', () => {
    // Retry before the failed attempt's setImmediate callback has run.
    driver.launch = async () => true;
    setInstalling(true);
    driver.quitAndInstall(false, true);
  });
  driver.quitAndInstall(false, true);
  await flush(); await flush();
  assert.equal(driver.spawned.length, 2);
  assert.deepEqual(events, ['error', 'before-quit', 'quit']);
});

test('visible update install always requests a restart even when the driver default disables it', async () => {
  const { driver } = await fixture();
  driver.autoRunAppAfterInstall = false;
  driver.quitAndInstall(false, true);
  await flush();
  // installer.nsh restarts the app and skips the finish page only for --updated --force-run.
  assert.deepEqual(driver.spawned[0].args, ['--updated', '--force-run']);
});

test('duplicate install requests do not spawn or quit twice', async () => {
  const { driver, events } = await fixture();
  driver.quitAndInstall(false, true);
  driver.quitAndInstall(false, true);
  await flush();
  assert.equal(driver.spawned.length, 1);
  assert.deepEqual(events, ['before-quit', 'quit']);
});

test('a cancelled update state prevents the scheduled quit', async () => {
  const { driver, events, setInstalling } = await fixture();
  driver.quitAndInstall(false, true);
  setInstalling(false);
  await flush();
  assert.deepEqual(events, []);
});

test('before-quit recovery is checked again before app quit', async () => {
  const { driver, events, setInstalling } = await fixture();
  driver.beforeQuit = () => { events.push('before-quit'); setInstalling(false); };
  driver.quitAndInstall(false, true);
  await flush();
  assert.deepEqual(events, ['before-quit']);
});

test('an attempt without a downloaded installer stays open and can later retry', async () => {
  const events: string[] = [];
  const app: AppAdapter = {
    version: '0.2.0', name: 'Mongle fixture', isPackaged: true,
    appUpdateConfigPath: '', userDataPath: '', baseCachePath: '',
    whenReady: async () => {}, relaunch: () => {}, onQuit: () => {}, quit: () => { events.push('quit'); },
  };
  const driver = new FixtureUpdater(() => true, app);
  driver.logger = null;
  driver.on('error', () => { events.push('error'); });
  driver.quitAndInstall(false, true);
  await flush();
  assert.deepEqual(events, ['error']);
  await driver.ready();
  driver.quitAndInstall(false, true);
  await flush();
  assert.deepEqual(events, ['error', 'quit']);
});
