import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';

const root = process.cwd();
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_UPDATES === '1';
const output = path.join(root, 'test-results/e2e/updates-download');

// This helper bundles the production controller and actual updater transport.
// The injected AppAdapter only redirects identity/cache paths into our tempdir;
// metadata parsing, Electron HTTP, download and checksum verification stay real.
const helper = `
import { app, session } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GuardedNsisUpdater } from './apps/desktop/updater-driver';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import { UpdateController } from './apps/desktop/updater';

app.setPath('userData', process.env.MONGLE_UPDATE_TEST_DATA!);
app.setPath('sessionData', process.env.MONGLE_UPDATE_TEST_DATA!);
app.disableHardwareAcceleration();
globalThis.__updatesDownload = async ({ baseUrl, dataDir }) => {
  await app.whenReady();
  // Keep the production renderer's network restriction while checking the
  // updater's separate Electron session can still reach the fixture server.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
  const rendererBlocked = await session.defaultSession.fetch(baseUrl + '/renderer-blocked')
    .then(() => false, () => true);
  const results = [];
  for (const scenario of ['valid', 'corrupt']) {
    const directory = path.join(dataDir, scenario);
    await mkdir(directory, { recursive: true });
    const config = path.join(directory, 'app-update.yml');
    await writeFile(config, 'updaterCacheDirName: downloads\\n');
    const installCalls = { prepare: 0, quit: 0, relaunch: 0, onQuit: 0 };
    const driver = new GuardedNsisUpdater(() => false, {
      version: '0.1.0', name: 'mongle-update-download-test', isPackaged: true,
      appUpdateConfigPath: config, userDataPath: directory,
      baseCachePath: path.join(directory, 'cache'),
      whenReady: () => app.whenReady(),
      quit: () => { installCalls.quit++; throw new Error('Installer execution is forbidden in this test'); },
      relaunch: () => { installCalls.relaunch++; throw new Error('Relaunch is forbidden in this test'); },
      onQuit: () => { installCalls.onQuit++; throw new Error('Automatic installation must be disabled'); }
    });
    // AppAdapter injection intentionally leaves httpExecutor null in v6.
    // Restore the real Electron transport, not a mock or a Node downloader.
    driver.httpExecutor = new ElectronHttpExecutor(null);
    driver.setFeedURL({ provider: 'generic', url: baseUrl + '/' + scenario + '/' });
    driver.disableDifferentialDownload = true;
    driver.logger = null;
    const states = [];
    const errors = [];
    driver.on('error', error => errors.push({ code: error.code, message: error.message }));
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const controller = new UpdateController({
      currentVersion: '0.1.0', driver,
      publish: state => {
        states.push(state);
        if (state.status === 'ready' || state.status === 'error') resolveDone();
      },
      prepareInstall: async () => { installCalls.prepare++; throw new Error('Installation is forbidden'); },
      allowInstallerQuit: () => { throw new Error('Installation is forbidden'); },
      installFailed: () => { throw new Error('Installation is forbidden'); }
    });
    if (driver.autoInstallOnAppQuit !== false) throw new Error('Unsafe updater configuration');
    let timeout;
    try {
      await controller.check();
      await Promise.race([done, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Download did not finish')), 15000);
      })]);
      // Let the real driver's download completion/cleanup promise settle.
      await new Promise(resolve => setTimeout(resolve, 30));
      results.push({ scenario, state: controller.getState(), states, errors,
        installerPath: driver.installerPath, installCalls,
        autoInstallOnAppQuit: driver.autoInstallOnAppQuit });
    } finally { clearTimeout(timeout); controller.dispose(); }
  }
  return { rendererBlocked, results };
};
`;

test('real Electron updater downloads verified bytes and rejects a corrupt installer without executing either', { skip: !enabled, timeout: 60000 }, async () => {
  await mkdir(output, { recursive: true });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-update-download-'));
  const electronData = path.join(dataDir, 'electron');
  await mkdir(electronData);
  // Deliberately non-executable data. Download tests must never run installers.
  const installer = Buffer.from('Mongle update download fixture only.\n'.repeat(8192));
  const expectedHash = createHash('sha512').update(installer).digest('base64');
  const corrupt = Buffer.from(installer); corrupt[0] ^= 0xff;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://127.0.0.1').pathname;
    requests.push(pathname);
    const scenario = pathname.split('/')[1];
    if (!['valid', 'corrupt'].includes(scenario)) { response.writeHead(404).end(); return; }
    if (pathname.endsWith('/latest.yml')) {
      response.writeHead(200, { 'Content-Type': 'text/yaml' });
      response.end(`version: 0.2.0\nfiles:\n  - url: MongleTerminal-0.2.0-x64-setup.exe\n    sha512: ${expectedHash}\n    size: ${installer.length}\npath: MongleTerminal-0.2.0-x64-setup.exe\nsha512: ${expectedHash}\nreleaseDate: '2026-09-29T00:00:00.000Z'\n`);
    } else if (pathname.endsWith('.exe')) {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': installer.length });
      response.end(scenario === 'valid' ? installer : corrupt);
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let application: ElectronApplication | undefined;
  let electronProcess: ChildProcess | undefined;
  const processLogs: string[] = [];
  const proof: Record<string, unknown> = { passed: false, dataDir };
  try {
    await build({ stdin: { contents: helper, resolveDir: root, sourcefile: 'updates-download-fixture.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(dataDir, 'main.cjs') });
    await writeFile(path.join(dataDir, 'package.json'), JSON.stringify({ name: 'mongle-updater-test', version: '0.1.0', main: 'main.cjs' }));
    const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_UPDATE_TEST_DATA: electronData };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [dataDir], cwd: dataDir, env: env as Record<string, string>, timeout: 20000 });
    electronProcess = application.process();
    electronProcess.stderr?.on('data', data => processLogs.push(String(data)));
    const result = await application.evaluate((_electron, args) => (globalThis as any).__updatesDownload(args), { baseUrl, dataDir });
    proof.result = result;
    assert.equal(result.rendererBlocked, true);
    assert.ok(!requests.includes('/renderer-blocked'));
    const [valid, invalid] = result.results;
    assert.equal(valid.state.status, 'ready');
    assert.equal(valid.state.currentVersion, '0.1.0');
    assert.equal(valid.state.availableVersion, '0.2.0');
    assert.equal(valid.state.progress, 100);
    assert.ok(valid.states.some((state: any) => state.status === 'checking'));
    assert.ok(valid.states.some((state: any) => state.status === 'downloading'));
    assert.deepEqual(valid.errors, []);
    assert.ok(path.resolve(valid.installerPath).startsWith(path.resolve(dataDir) + path.sep));
    assert.deepEqual(await readFile(valid.installerPath), installer);
    assert.equal(invalid.state.status, 'error');
    assert.ok(invalid.errors.some((error: any) => error.code === 'ERR_CHECKSUM_MISMATCH'));
    assert.equal(invalid.installerPath, null);
    assert.ok(!invalid.states.some((state: any) => state.status === 'ready'));
    assert.ok(!invalid.state.message.includes(baseUrl), 'The production controller must hide raw transport details');
    for (const item of result.results) {
      assert.equal(item.autoInstallOnAppQuit, false);
      assert.deepEqual(item.installCalls, { prepare: 0, quit: 0, relaunch: 0, onQuit: 0 });
    }
    assert.deepEqual(requests, ['/valid/latest.yml', '/valid/MongleTerminal-0.2.0-x64-setup.exe', '/corrupt/latest.yml', '/corrupt/MongleTerminal-0.2.0-x64-setup.exe']);
    proof.passed = true;
  } finally {
    await application?.close().catch(error => { proof.closeError = String(error); });
    proof.cleanedUp = !electronProcess || electronProcess.exitCode !== null || electronProcess.signalCode !== null;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...proof, requests, processLogs, finishedAt: new Date().toISOString() }, null, 2));
    assert.equal(proof.cleanedUp, true, 'The isolated Electron process must exit');
  }
});
