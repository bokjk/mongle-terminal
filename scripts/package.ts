import { build, Platform, Arch } from 'electron-builder';
import { cp, mkdir, readFile, copyFile, access, rm, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRuntime } from '../apps/desktop/runtime';
import { ensureHelper } from '../packages/local-ipc/index';
import { generateNotices } from './notices';
import { verifyWindowsIcon } from './verify-windows-icon';
import { writeReleaseChecksums } from './release-check';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'mongle-terminal') throw new Error('Run packaging from the Mongle Terminal project directory.');
const outputFlag = process.argv.indexOf('--output');
const outputName = outputFlag < 0 ? 'release' : process.argv[outputFlag + 1];
if (!outputName || !/^release(?:-[a-z0-9-]+)?$/.test(outputName)) throw new Error('--output must be release or a release-<name> directory within the project.');
const outputDir = path.join(root, outputName);
// Build the source first; package from a dedicated directory with host-native
// modules kept outside ASAR and never rebuilt for Electron's ABI.
await import('./build');
await prepareRuntime(root);
await ensureHelper();
await generateNotices(root, { strict: true, nodeExecutable: process.execPath });
const bundle = path.join(root, 'release-stage', outputName, 'hostbundle');
if (!path.resolve(bundle).startsWith(path.resolve(root) + path.sep) || path.basename(bundle) !== 'hostbundle') throw new Error('Invalid generated staging directory.');
await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });
for (const relative of ['runtime', 'platform/windows', 'dist/host', 'dist/web']) await cp(path.join(root, relative), path.join(bundle, relative), { recursive: true });
const nativePackages = new Set<string>();
async function copyDependency(name: string) {
  if (nativePackages.has(name)) return; nativePackages.add(name);
  const source = path.join(root, 'node_modules', name);
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  await cp(source, path.join(bundle, 'node_modules', name), { recursive: true, filter: file => !file.includes(path.sep + '.git' + path.sep) });
  for (const dependency of Object.keys(manifest.dependencies || {})) await copyDependency(dependency);
}
await copyDependency('node-pty');
await copyFile(path.join(path.dirname(process.execPath), 'LICENSE'), path.join(bundle, 'runtime/NODE-LICENSE.txt'));
for (const relative of ['docs']) {
  try { await access(path.join(root, relative)); await cp(path.join(root, relative), path.join(bundle, relative), { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const makeInstaller = !process.argv.includes('--dir');
const requiredNativeFiles = [
  'node-pty/package.json', 'node-pty/lib/index.js',
  'node-pty/prebuilds/win32-x64/conpty.node',
  'node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node-pty/prebuilds/win32-x64/conpty/conpty.dll',
  'node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
  'node-addon-api/package.json',
];
async function verifyPackagedHost(appOutDir: string) {
  try {
    await access(path.join(appOutDir, 'resources/mongle-installed.json'));
    throw new Error('NSIS installation marker must not be included in ZIP or unpacked builds.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const installed = path.join(appOutDir, 'resources/hostbundle');
  const modules = path.join(installed, 'node_modules');
  // electron-builder may omit node_modules from extraResources. Copy explicitly
  // after its file filters, before archiving. Never rely on development parents.
  await cp(path.join(bundle, 'node_modules'), modules, { recursive: true });
  for (const relative of requiredNativeFiles) await access(path.join(modules, relative));
  const hostEntry = path.join(installed, 'dist/host/main.cjs');
  const resolver = createRequire(hostEntry);
  const resolved = resolver.resolve('node-pty');
  if (!path.resolve(resolved).toLowerCase().startsWith(path.resolve(modules).toLowerCase() + path.sep)) throw new Error('Packaged node-pty resolved outside the application: ' + resolved);
  const source = `const p=require('node:path');const r=require('node:module').createRequire(process.argv[1]);const resolved=r.resolve('node-pty');if(!resolved.toLowerCase().startsWith(p.resolve(process.argv[2]).toLowerCase()+p.sep))throw new Error('External dependency fallback');r('node-pty');r(p.join(process.argv[2],'node-pty/prebuilds/win32-x64/conpty.node'));r(p.join(process.argv[2],'node-pty/prebuilds/win32-x64/conpty_console_list.node'));process.stdout.write(JSON.stringify({node:process.version,nativeModulesLoaded:true}));`;
  const { stdout } = await promisify(execFile)(path.join(installed, 'runtime/node.exe'), ['-e', source, hostEntry, modules], { cwd: os.tmpdir(), windowsHide: true, timeout: 10_000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
  console.log('Packaged host dependency check: ' + stdout);
}
async function verifyZip(zipPath: string) {
  const file = await open(zipPath, 'r');
  try {
    const size = (await file.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65_557)); await file.read(tail, 0, tail.length, size - tail.length);
    let end = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('ZIP central directory is missing');
    const length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (length === 0xffffffff || offset === 0xffffffff || offset + length > size) throw new Error('Unsupported or invalid ZIP directory');
    const directory = Buffer.alloc(length); await file.read(directory, 0, length, offset);
    const entries: string[] = [];
    for (let at = 0; at < directory.length;) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP entry');
      const nameSize = directory.readUInt16LE(at + 28), extraSize = directory.readUInt16LE(at + 30), commentSize = directory.readUInt16LE(at + 32);
      entries.push(directory.subarray(at + 46, at + 46 + nameSize).toString('utf8').replace(/\\/g, '/'));
      at += 46 + nameSize + extraSize + commentSize;
    }
    for (const relative of requiredNativeFiles) {
      const suffix = 'resources/hostbundle/node_modules/' + relative;
      if (!entries.some(entry => entry === suffix || entry.endsWith('/' + suffix))) throw new Error('Native dependency missing from ZIP: ' + suffix);
    }
    console.log(`ZIP native dependency check: ${requiredNativeFiles.length} required files present across ${entries.length} entries.`);
  } finally { await file.close(); }
}
// Packaging must never create or modify a GitHub release, even with GH_TOKEN
// present or on a CI tag. The separate release workflow creates drafts only.
const results = await build({ projectDir: root, publish: 'never', targets: Platform.WINDOWS.createTarget(makeInstaller ? ['nsis', 'zip'] : ['dir'], Arch.x64), config: {
  appId: 'dev.mongle.terminal', productName: 'Mongle Terminal', executableName: 'MongleTerminal',
  directories: { output: outputName, buildResources: 'platform/windows' },
  electronDist: 'node_modules/electron/dist',
  files: ['dist/desktop/**', 'package.json', '!node_modules/**'],
  extraResources: [{ from: bundle, to: 'hostbundle' }],
  afterPack: async context => { await verifyPackagedHost(context.appOutDir); },
  asar: true, npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
  extraMetadata: { main: 'dist/desktop/main.cjs', dependencies: {} },
  publish: { provider: 'github', owner: 'bokjk', repo: 'mongle-terminal', channel: 'latest', releaseType: 'draft', tagNamePrefix: 'v' },
  generateUpdatesFilesForAllChannels: false,
  win: { target: ['nsis', 'zip'], icon: 'platform/windows/icon.ico', signAndEditExecutable: true, signExecutable: false, artifactName: 'MongleTerminal-${version}-${arch}.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, include: 'platform/windows/installer.nsh', artifactName: 'MongleTerminal-Setup-${version}-${arch}.${ext}', runAfterFinish: false, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: '몽글터미널', installerIcon: 'platform/windows/icon.ico', uninstallerIcon: 'platform/windows/icon.ico' },
} });
console.log('Packaged executable icon check: ' + JSON.stringify(await verifyWindowsIcon(path.join(outputDir, 'win-unpacked/MongleTerminal.exe'), path.join(root, 'platform/windows/icon.ico'))));
for (const artifact of results) if (artifact.endsWith('.zip')) await verifyZip(artifact);
if (makeInstaller) console.log('Release metadata and checksums: ' + JSON.stringify(await writeReleaseChecksums(outputDir, pkg.version)));
console.log(JSON.stringify({ artifacts: results, bundledNodeVersion: process.version, hostNativePackages: [...nativePackages], signed: false }, null, 2));
