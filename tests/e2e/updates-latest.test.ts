import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { _electron, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';

const root = process.cwd();
const enabled = process.platform === 'win32' && process.env.MONGLE_E2E_UPDATES === '1';
const output = path.join(root, 'test-results/e2e/updates-latest');

// The production controller with the real updater, Electron HTTP and checksum
// verification. A release published while an older download waits must replace it,
// and installation must continue with the newest one. Installers never run here.
const helper = `
import { app } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { GuardedNsisUpdater } from './apps/desktop/updater-driver';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import { UpdateController } from './apps/desktop/updater';

app.setPath('userData', process.env.MONGLE_UPDATE_TEST_DATA!);
app.setPath('sessionData', process.env.MONGLE_UPDATE_TEST_DATA!);
app.disableHardwareAcceleration();
globalThis.__updatesLatest = async ({ baseUrl, dataDir }) => {
  await app.whenReady();
  const config = path.join(dataDir, 'app-update.yml');
  await writeFile(config, 'updaterCacheDirName: downloads\\n');
  const driver = new GuardedNsisUpdater(() => false, {
    version: '0.1.0', name: 'mongle-update-latest-test', isPackaged: true,
    appUpdateConfigPath: config, userDataPath: dataDir,
    baseCachePath: path.join(dataDir, 'cache'),
    whenReady: () => app.whenReady(),
    quit: () => { throw new Error('Installer execution is forbidden in this test'); },
    relaunch: () => { throw new Error('Relaunch is forbidden in this test'); },
    onQuit: () => { throw new Error('Automatic installation must be disabled'); }
  });
  driver.httpExecutor = new ElectronHttpExecutor(null);
  driver.setFeedURL({ provider: 'generic', url: baseUrl + '/feed/' });
  driver.disableDifferentialDownload = true;
  driver.logger = null;
  const states = [], errors = [], prepared = [];
  // Hash the installer while it exists; replacing a download deletes the outdated file.
  const digest = async file => file ? createHash('sha512').update(await readFile(file)).digest('base64') : null;
  driver.on('error', error => errors.push({ code: error.code, message: error.message }));
  const controller = new UpdateController({
    currentVersion: '0.1.0', driver,
    publish: state => states.push(state),
    // Record which download installation would use, then decline like a cancelled confirmation.
    prepareInstall: async () => { prepared.push({ version: controller.getState().availableVersion, installer: driver.installerPath, sha512: await digest(driver.installerPath) }); return false; },
    allowInstallerQuit: () => { throw new Error('Installation is forbidden'); },
    installFailed: () => { throw new Error('Installation is forbidden'); }
  });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label + ' ' + JSON.stringify({ states, errors })); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  try {
    await controller.check();
    await until(() => controller.getState().status === 'ready', 'first release downloaded');
    const first = { state: controller.getState(), installer: driver.installerPath, sha512: await digest(driver.installerPath) };
    await fetch(baseUrl + '/publish-newer');
    const installFrom = states.length;
    await controller.install();
    await until(() => prepared.length > 0, 'installation continued with the newest release');
    await until(() => controller.getState().status === 'ready', 'declined confirmation keeps the newest download');
    const install = states.slice(installFrom);
    const second = { state: controller.getState(), installer: driver.installerPath };
    const recheckFrom = states.length;
    await controller.check();
    await new Promise(resolve => setTimeout(resolve, 300));
    return { first, second, install, recheck: states.slice(recheckFrom), prepared, errors, final: controller.getState() };
  } finally { controller.dispose(); }
};
`;

test('a release published while an older download waits replaces it and installation continues with the newest', { skip: !enabled, timeout: 60000 }, async () => {
  await mkdir(output, { recursive: true });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-update-latest-'));
  const electronData = path.join(dataDir, 'electron');
  await mkdir(electronData);
  // Deliberately non-executable data. These tests must never run installers.
  const bytes = (version: string) => Buffer.from(`Mongle update fixture ${version} only.\n`.repeat(8192));
  const installers: Record<string, Buffer> = { '0.2.0': bytes('0.2.0'), '0.3.0': bytes('0.3.0') };
  let offered = '0.2.0';
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (pathname === '/publish-newer') { offered = '0.3.0'; response.writeHead(204).end(); return; }
    const installer = installers[offered];
    const name = `MongleTerminal-${offered}-x64-setup.exe`;
    const hash = createHash('sha512').update(installer).digest('base64');
    if (pathname === '/feed/latest.yml') {
      response.writeHead(200, { 'Content-Type': 'text/yaml' });
      response.end(`version: ${offered}\nfiles:\n  - url: ${name}\n    sha512: ${hash}\n    size: ${installer.length}\npath: ${name}\nsha512: ${hash}\nreleaseDate: '2026-10-12T00:00:00.000Z'\n`);
    } else if (pathname.startsWith('/feed/') && pathname.endsWith('.exe')) {
      const version = /MongleTerminal-(\d+\.\d+\.\d+)-x64-setup\.exe$/.exec(pathname)?.[1];
      const body = version ? installers[version] : undefined;
      if (!body) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
      response.end(body);
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
    await build({ stdin: { contents: helper, resolveDir: root, sourcefile: 'updates-latest-fixture.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: path.join(dataDir, 'main.cjs') });
    await writeFile(path.join(dataDir, 'package.json'), JSON.stringify({ name: 'mongle-updater-latest-test', version: '0.1.0', main: 'main.cjs' }));
    const env: NodeJS.ProcessEnv = { ...process.env, MONGLE_UPDATE_TEST_DATA: electronData };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [dataDir], cwd: dataDir, env: env as Record<string, string>, timeout: 20000 });
    electronProcess = application.process();
    electronProcess.stderr?.on('data', data => processLogs.push(String(data)));
    const result = await application.evaluate((_electron, args) => (globalThis as any).__updatesLatest(args), { baseUrl, dataDir });
    proof.result = result;
    assert.deepEqual(result.errors, []);
    assert.equal(result.first.state.availableVersion, '0.2.0');
    const sha512 = (version: string) => createHash('sha512').update(installers[version]).digest('base64');
    assert.equal(result.first.sha512, sha512('0.2.0'));
    // Installation asked again, downloaded the newer release and continued with it only.
    assert.deepEqual(result.prepared.map((item: any) => item.version), ['0.3.0']);
    assert.equal(result.prepared[0].sha512, sha512('0.3.0'));
    assert.deepEqual(await readFile(result.prepared[0].installer), installers['0.3.0']);
    assert.equal(existsSync(result.first.installer), false, 'the outdated installer is gone and cannot be launched');
    const steps = result.install.map((state: any) => state.status === 'installing' ? `installing:${state.phase}:${state.availableVersion}` : `${state.status}:${state.availableVersion}`);
    assert.equal(steps[0], 'installing:checking:0.2.0');
    assert.ok(steps.includes('downloading:0.3.0'));
    assert.ok(steps.indexOf('installing:confirming:0.3.0') > steps.indexOf('downloading:0.3.0'));
    assert.ok(!steps.includes('installing:confirming:0.2.0'), 'never asks to install the outdated download');
    assert.ok(!steps.slice(0, steps.indexOf('installing:confirming:0.3.0')).includes('ready:0.3.0'), 'goes straight to the confirmation');
    assert.equal(result.second.state.availableVersion, '0.3.0');
    // A later check with nothing newer keeps the ready download without another download.
    assert.ok(result.recheck.every((state: any) => state.status === 'ready' && state.availableVersion === '0.3.0'));
    assert.equal(result.final.status, 'ready');
    const downloads = requests.filter(item => item.endsWith('.exe'));
    assert.deepEqual(downloads, ['/feed/MongleTerminal-0.2.0-x64-setup.exe', '/feed/MongleTerminal-0.3.0-x64-setup.exe']);
    assert.equal(requests.filter(item => item === '/feed/latest.yml').length, 3, 'first check, the check before installing, and the later check');
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
