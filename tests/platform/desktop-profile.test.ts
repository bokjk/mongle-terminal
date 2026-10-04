import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);

// Execute the real entrypoint synchronously with inert Electron/native edges.
// No test directory, authentication files, helper process or host is created.
function loadSource(file: string, overrides: Record<string, unknown>, environment: Record<string, unknown> = {}) {
  const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24', sourcefile: file }).code;
  const module = { exports: {} as any };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : require(name),
    process: { platform: 'win32', env: {}, ...environment },
  }, { filename: file });
  return module.exports;
}

test('desktop data preparation uses the explicit native helper synchronously with bounded execution', () => {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const runtime = loadSource('apps/desktop/runtime.ts', {
    'node:child_process': { ...require('node:child_process'), execFileSync(file: string, args: string[], options: Record<string, unknown>) {
      calls.push({ file, args, options });
      return '{"kind":"prepared"}\r\n';
    } },
  }, { env: { MONGLE_OWNER_HELPER: 'untrusted-helper.exe' } });
  assert.equal(runtime.prepareDesktopDataDirectory('application-root', 'isolated-profile'), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, path.resolve('application-root', 'platform/windows/OwnerPipe.exe'));
  assert.deepEqual(Array.from(calls[0].args), ['prepare', path.resolve('isolated-profile')]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(calls[0].options.maxBuffer, 32_768);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.deepEqual(Array.from(calls[0].options.stdio as string[]), ['ignore', 'pipe', 'pipe']);
});

test('desktop data preparation fails closed on helper errors or an unconfirmed response', () => {
  for (const result of [new Error('OWNER_IPC_ERROR:AUTH_FAILED:wrong owner'), '', 'null', '{"kind":"ready"}', '{"kind":"prepared"}\n{"kind":"prepared"}']) {
    let executions = 0;
    const runtime = loadSource('apps/desktop/runtime.ts', {
      'node:child_process': { ...require('node:child_process'), execFileSync() {
        executions++;
        if (result instanceof Error) throw result;
        return result;
      } },
    });
    assert.throws(() => runtime.prepareDesktopDataDirectory('application-root', 'isolated-profile'), /데이터 폴더를 안전하게 준비하지 못했습니다/);
    assert.equal(executions, 1, 'preparation must not retry through a weaker fallback');
  }
});

function desktopStartup(options: { packaged?: boolean; prepareError?: Error; primary?: boolean } = {}) {
  const calls: string[] = [];
  const appRoot = path.resolve('application-root');
  const resourcesPath = path.resolve('resources');
  const dataDir = path.resolve('isolated-profile');
  const expectedRoot = options.packaged ? path.join(resourcesPath, 'hostbundle') : appRoot;
  const app = {
    isPackaged: Boolean(options.packaged),
    setName() {}, setAppUserModelId() {}, on() {},
    getAppPath: () => appRoot,
    getPath() { throw new Error('explicit test profile must not fall back to a default profile'); },
    setPath(name: string, value: string) {
      calls.push('profile'); assert.equal(name, 'userData'); assert.equal(value, path.join(dataDir, 'desktop-profile'));
    },
    requestSingleInstanceLock() { calls.push('lock'); return options.primary !== false; },
    quit() { calls.push('quit'); },
    exit(code: number) { calls.push('exit'); assert.equal(code, 1); },
    whenReady() { calls.push('ready'); return new Promise<void>(() => {}); },
  };
  loadSource('apps/desktop/main.ts', {
    electron: { app, dialog: { showErrorBox(title: string, message: string) {
      calls.push('error'); assert.equal(title, '몽글터미널을 열지 못했습니다'); assert.ok(message.includes('prepare failed'));
    } } },
    zod: { z: {} },
    '../../packages/local-ipc/index': {},
    '../../packages/protocol/index': {},
    './host-registry': { HostRegistry: class {} },
    './runtime': {
      prepareDesktopDataDirectory(root: string, directory: string) {
        calls.push('prepare'); assert.equal(root, expectedRoot); assert.equal(directory, dataDir);
        if (options.prepareError) throw options.prepareError;
      },
      launchHost() { throw new Error('startup test must not launch a host'); },
    },
    './remote-transport': {},
    './full-exit': { FullExitController: class {} },
    './resume-manifest': {}, './updater': {}, './updater-driver': {},
    './clipboard': { createVerifiedClipboardWriter: () => () => {} },
  }, { resourcesPath, env: { MONGLE_DATA_DIR: dataDir } });
  return calls;
}

test('development and packaged startup prepare before any Electron profile or instance-lock work', () => {
  for (const packaged of [false, true]) assert.deepEqual(desktopStartup({ packaged }), ['prepare', 'profile', 'lock', 'ready']);
});

test('failed directory preparation exits without profile, instance lock or ready startup', () => {
  assert.deepEqual(desktopStartup({ prepareError: new Error('prepare failed') }), ['prepare', 'error', 'exit']);
});

test('a secondary desktop instance exits only after protected preparation and does not start a host', () => {
  assert.deepEqual(desktopStartup({ primary: false }), ['prepare', 'profile', 'lock', 'quit']);
});
