import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { UpdateController, type UpdateDependencies, type UpdateDriver } from '../../apps/desktop/updater';
import type { UpdateState } from '../../apps/desktop/contracts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeDriver extends EventEmitter implements UpdateDriver {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  disableWebInstaller = false;
  checks = 0;
  installs: Array<[boolean | undefined, boolean | undefined]> = [];
  checkResult: () => ReturnType<UpdateDriver['checkForUpdates']> = async () => ({});
  installAction: () => void = () => {};
  checkForUpdates() { this.checks++; return this.checkResult(); }
  quitAndInstall(silent?: boolean, forceRun?: boolean) { this.installs.push([silent, forceRun]); this.installAction(); }
}

function fixture(t: test.TestContext, overrides: Partial<UpdateDependencies> = {}) {
  const driver = new FakeDriver();
  const states: UpdateState[] = [];
  const calls: string[] = [];
  const d: UpdateDependencies = {
    currentVersion: '0.1.0', driver,
    publish: state => states.push(state),
    prepareInstall: async () => { calls.push('prepare'); return true; },
    allowInstallerQuit: () => { calls.push('allow-quit'); },
    installFailed: () => { calls.push('failed'); },
    ...overrides,
  };
  const controller = new UpdateController(d);
  t.after(() => controller.dispose());
  return { driver, controller, states, calls, d };
}

test('update configuration downloads stable releases but never installs on ordinary app quit', t => {
  const { driver, controller } = fixture(t);
  assert.equal(driver.autoDownload, true);
  assert.equal(driver.autoInstallOnAppQuit, false);
  assert.equal(driver.allowPrerelease, false);
  assert.equal(driver.allowDowngrade, false);
  assert.equal(driver.disableWebInstaller, true);
  assert.equal(controller.getState().status, 'idle');
  assert.deepEqual(driver.installs, []);
});

test('unsupported builds do not check, schedule, prepare, or install updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { controller, driver, states, calls } = fixture(t, { unsupportedReason: '설치본에서 사용할 수 있습니다.' });
  controller.start();
  t.mock.timers.tick(7 * 60 * 60 * 1000);
  await controller.check();
  driver.emit('update-downloaded', { version: '0.2.0' });
  await assert.rejects(controller.install(), /준비되지/);
  assert.equal(controller.getState().status, 'unsupported');
  assert.equal(driver.checks, 0);
  assert.deepEqual(driver.installs, []);
  assert.deepEqual(states, []);
  assert.deepEqual(calls, []);
});

test('concurrent checks share one request and can check again after completion', async t => {
  const { controller, driver } = fixture(t);
  const result = deferred<{}>();
  driver.checkResult = () => result.promise;
  const first = controller.check();
  assert.equal(controller.check(), first);
  assert.equal(driver.checks, 1);
  assert.equal(controller.getState().status, 'checking');
  result.resolve({});
  await first;
  assert.equal(controller.getState().status, 'idle');
  await controller.check();
  assert.equal(driver.checks, 2);
});

test('automatic download reaches readiness without preparing shutdown or launching an installer', async t => {
  const { controller, driver, calls } = fixture(t);
  const downloaded = deferred<void>();
  driver.checkResult = async () => {
    driver.emit('update-available', { version: '0.2.0' });
    return { downloadPromise: downloaded.promise };
  };
  await controller.check();
  assert.equal(controller.getState().status, 'downloading');
  await controller.check();
  assert.equal(driver.checks, 1, 'do not start another check during download');
  driver.emit('update-downloaded', { version: '0.2.0' });
  downloaded.resolve();
  await flush();
  assert.equal(controller.getState().status, 'ready');
  assert.equal(controller.getState().availableVersion, '0.2.0');
  assert.equal(controller.getState().progress, 100);
  await controller.check();
  assert.equal(driver.checks, 1, 'keep the downloaded version ready');
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.installs, []);
});

test('download progress is finite, clamped and accepted only during downloading', t => {
  const { controller, driver } = fixture(t);
  driver.emit('download-progress', { percent: 50 });
  assert.equal(controller.getState().progress, undefined);
  driver.emit('update-available', { version: '0.2.0' });
  for (const [input, expected] of [[-10, 0], [42.6, 43], [1000, 100]] as const) {
    driver.emit('download-progress', { percent: input });
    assert.equal(controller.getState().progress, expected);
  }
  for (const percent of [NaN, Infinity, '25', undefined]) {
    driver.emit('download-progress', { percent });
    assert.equal(controller.getState().progress, 100);
  }
  driver.emit('update-downloaded', { version: '0.2.0' });
  driver.emit('download-progress', { percent: 2 });
  assert.equal(controller.getState().progress, 100);
});

test('a cancelled install keeps the download ready and never allows quit', async t => {
  const { controller, driver, calls } = fixture(t, { prepareInstall: async () => false });
  driver.emit('update-downloaded', { version: '0.2.0' });
  await controller.install();
  assert.equal(controller.getState().status, 'ready');
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.installs, []);
});

test('failed local shutdown never starts installation and can be checked again', async t => {
  const { controller, driver, calls } = fixture(t, { prepareInstall: async () => { throw new Error('private host error'); } });
  driver.emit('update-downloaded', { version: '0.2.0' });
  await controller.install();
  assert.equal(controller.getState().status, 'error');
  assert.deepEqual(calls, ['failed']);
  assert.deepEqual(driver.installs, []);
  await controller.check();
  assert.equal(driver.checks, 1);
});

test('installation waits for the lifecycle barrier and coalesces repeated install requests', async t => {
  const prepared = deferred<boolean>();
  const { controller, driver, calls } = fixture(t, { prepareInstall: () => prepared.promise });
  driver.installAction = () => calls.push('installer');
  driver.emit('update-downloaded', { version: '0.2.0' });
  const first = controller.install();
  assert.equal(controller.install(), first);
  await flush();
  assert.equal(controller.getState().status, 'installing');
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.installs, []);
  await controller.check();
  assert.equal(driver.checks, 0);
  prepared.resolve(true);
  await first;
  assert.deepEqual(calls, ['allow-quit', 'installer']);
  assert.deepEqual(driver.installs, [[true, true]]);
  await assert.rejects(controller.install(), /준비되지/);
  assert.equal(driver.installs.length, 1);
});

test('installer launch exceptions report failure after allowing quit without retrying automatically', async t => {
  const { controller, driver, calls } = fixture(t);
  driver.installAction = () => { throw new Error('cannot launch'); };
  driver.emit('update-downloaded', { version: '0.2.0' });
  await controller.install();
  assert.deepEqual(calls, ['prepare', 'allow-quit', 'failed']);
  assert.equal(controller.getState().status, 'error');
  assert.equal(driver.installs.length, 1);
});

for (const accepted of [true, false]) {
  test(`a driver error during preparation blocks installation when preparation returns ${accepted}`, async t => {
    const prepared = deferred<boolean>();
    const { controller, driver, calls } = fixture(t, { prepareInstall: () => prepared.promise });
    driver.emit('update-downloaded', { version: '0.2.0' });
    const pending = controller.install();
    driver.emit('error', new Error('cached update invalid'));
    assert.deepEqual(calls, [], 'do not release the shutdown barrier while preparation is still running');
    prepared.resolve(accepted);
    await pending;
    assert.equal(controller.getState().status, 'error');
    assert.deepEqual(calls, accepted ? ['failed'] : []);
    assert.deepEqual(driver.installs, []);
  });
}

test('update errors never expose server URLs, tokens or local paths in published state', async t => {
  const { controller, driver, states } = fixture(t);
  const secretError = new Error('https://updates.invalid/file?token=SECRET C:\\Users\\private\\update.exe');
  driver.checkResult = async () => { throw secretError; };
  await controller.check();
  assert.equal(controller.getState().status, 'error');
  driver.emit('error', secretError);
  assert.doesNotMatch(JSON.stringify(states), /https:|SECRET|private/);
  assert.ok(controller.getState().message);
});

test('download rejection is handled without an unhandled promise or installer launch', async t => {
  const { controller, driver, calls } = fixture(t);
  const download = deferred<void>();
  driver.checkResult = async () => {
    driver.emit('update-available', { version: '0.2.0' });
    return { downloadPromise: download.promise };
  };
  await controller.check();
  download.reject(new Error('download failed'));
  await flush();
  assert.equal(controller.getState().status, 'error');
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.installs, []);
});

test('invalid version metadata never becomes installable', async t => {
  for (const version of ['0.2.0-beta.1', 'https://invalid', '', 2, undefined]) {
    const { controller, driver } = fixture(t);
    driver.emit('update-downloaded', { version });
    assert.equal(controller.getState().status, 'error');
    await assert.rejects(controller.install(), /준비되지/);
    assert.deepEqual(driver.installs, []);
  }
});

test('start schedules one delayed check and periodic checks; dispose cancels both', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { controller, driver } = fixture(t);
  controller.start(); controller.start();
  t.mock.timers.tick(29_999);
  assert.equal(driver.checks, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(driver.checks, 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 30_000);
  await flush();
  assert.equal(driver.checks, 2);
  controller.dispose();
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  await flush();
  controller.start(); await controller.check();
  assert.equal(driver.checks, 2);
});

test('dispose removes subscriptions and ignores pending check and download callbacks', async t => {
  const { controller, driver, states, calls } = fixture(t);
  const result = deferred<{ downloadPromise: Promise<void> }>();
  const download = deferred<void>();
  driver.checkResult = () => result.promise;
  const checking = controller.check();
  controller.dispose();
  const count = states.length;
  assert.equal(driver.eventNames().length, 0);
  driver.emit('update-downloaded', { version: '0.2.0' });
  result.resolve({ downloadPromise: download.promise });
  await checking;
  download.reject(new Error('late download error'));
  await flush();
  assert.equal(states.length, count);
  assert.deepEqual(calls, []);
  assert.deepEqual(driver.installs, []);
  await assert.rejects(controller.install(), /준비되지/);
});

test('disposing before the initial delay prevents both startup and periodic checks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { controller, driver } = fixture(t);
  controller.start();
  controller.dispose();
  t.mock.timers.tick(7 * 60 * 60 * 1000);
  await flush();
  assert.equal(driver.checks, 0);
});

test('disposing while shutdown is pending prevents installer launch after it completes', async t => {
  const prepared = deferred<boolean>();
  const { controller, driver, states, calls } = fixture(t, { prepareInstall: () => prepared.promise });
  driver.emit('update-downloaded', { version: '0.2.0' });
  const pending = controller.install();
  controller.dispose();
  const count = states.length;
  prepared.resolve(true);
  await pending;
  assert.equal(states.length, count);
  assert.equal(calls.includes('allow-quit'), false);
  assert.deepEqual(driver.installs, []);
});
