import { copyFile, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
type LockEntry = { version?: string; dev?: boolean; optional?: boolean; integrity?: string; resolved?: string };
type Package = { name: string; version: string; commit?: string; license?: string | { type?: string }; licenses?: Array<{ type?: string }>; homepage?: string; repository?: string | { url?: string } };
type Notice = { name: string; version: string; license: string; source: string; licenseOrigin?: string; integrity?: string; files: string[] };
const conptyCommit = '96f13a15deed0f2a0e4fc5e8a66847b51c0e78db';
const conptyVersion = '1.23.251008001';
const conptyHashes: Record<string, string> = {
  'conpty.dll': '7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed',
  'OpenConsole.exe': 'd1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc',
};
const sourceHashes: Record<string, string> = {
  'conpty-LICENSE': '5d177f23ecfeb0ea8e050b6a5a16355e1ae9a0b286436ca8f83ed08b3795be6b',
  'conpty-NOTICE.md': '224973ca2057b99324c6bf2ac40320c11938e3a2efd53dabbbce61bb66547281',
};
const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');
const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Only license/notice texts are copied, not source trees or binary payloads. */
async function licenseFiles(directory: string, prefix = '', depth = 0): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name)) result.push(relative);
    else if (entry.isDirectory() && depth < 5 && (depth > 0 || ['deps', 'third_party'].includes(entry.name))) {
      result.push(...await licenseFiles(directory, relative, depth + 1));
    }
  }
  return result.sort();
}

/** Generate from the lockfile and installed metadata; never infer the app's own license. */
export async function generateNotices(root = process.cwd(), options: { strict?: boolean; nodeExecutable?: string } = {}) {
  root = path.resolve(root);
  const docs = path.join(root, 'docs');
  const out = path.join(docs, 'licenses');
  await mkdir(out, { recursive: true });
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> };
  const notices: Notice[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const copy = async (source: string, relative: string) => {
    const target = path.join(out, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    return slash(path.relative(docs, target));
  };
  for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!relative || entry.dev || !relative.includes('node_modules/')) continue;
    const directory = path.join(root, relative);
    if (!await exists(path.join(directory, 'package.json'))) {
      if (entry.optional) skipped.push(`${relative}@${entry.version} (this platform not installed)`);
      else errors.push(`Missing production package: ${relative}`);
      continue;
    }
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as Package;
    if (pkg.version !== entry.version) errors.push(`Lockfile version mismatch: ${relative}`);
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = key.replaceAll('@', '').replaceAll('/', '__');
    const files = await licenseFiles(directory);
    const copiedFiles = await Promise.all(files.map(file => copy(path.join(directory, file), path.join(label, file))));
    let licenseOrigin: string | undefined;
    if (!files.length && ['@xterm/headless', '@xterm/addon-serialize'].includes(pkg.name)) {
      // Those npm archives omit the monorepo LICENSE. The sibling xterm package
      // carries the original file and an exact matching upstream commit marker.
      const xtermRoot = path.join(root, 'node_modules/@xterm/xterm');
      const xterm = JSON.parse(await readFile(path.join(xtermRoot, 'package.json'), 'utf8')) as Package;
      if (pkg.commit && pkg.commit === xterm.commit && pkg.license === xterm.license) {
        copiedFiles.push(await copy(path.join(xtermRoot, 'LICENSE'), path.join(label, 'LICENSE')));
        licenseOrigin = `https://github.com/xtermjs/xterm.js/blob/${pkg.commit}/LICENSE (same-commit @xterm/xterm archive)`;
      }
    }
    if (!copiedFiles.length) errors.push(`Missing original license text: ${key}`);
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map(l => l.type).join(' OR ') ?? 'UNKNOWN';
    if (license === 'UNKNOWN') errors.push(`Missing license metadata: ${key}`);
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    notices.push({ name: pkg.name, version: pkg.version, license, source: repository || pkg.homepage || entry.resolved || '', licenseOrigin, integrity: entry.integrity,
      files: copiedFiles });
  }

  const electron = JSON.parse(await readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')) as Package;
  const electronFiles: string[] = [];
  for (const filename of ['LICENSE', 'LICENSES.chromium.html']) {
    const file = path.join(root, 'node_modules/electron/dist', filename);
    if (await exists(file)) electronFiles.push(await copy(file, path.join(`electron-${electron.version}`, filename)));
    else errors.push(`Missing Electron distribution notice: ${filename}`);
  }
  notices.push({ name: 'Electron / Chromium runtime', version: electron.version, license: 'MIT and bundled third-party licenses', source: 'https://github.com/electron/electron', files: electronFiles });

  const node = path.resolve(options.nodeExecutable || process.env.MONGLE_NODE_PATH || process.execPath);
  const nodeVersion = (await exec(node, ['--version'], { windowsHide: true })).stdout.trim();
  const nodeLicense = path.join(path.dirname(node), 'LICENSE');
  const nodeFiles: string[] = [];
  if (await exists(nodeLicense)) nodeFiles.push(await copy(nodeLicense, `node-${nodeVersion}/LICENSE`));
  else errors.push(`Missing LICENSE adjacent to bundled Node source: ${node}`);
  const runtimeNode = path.join(root, 'runtime/node.exe');
  if (await exists(runtimeNode) && await sha256(runtimeNode) !== await sha256(node)) errors.push('Bundled Node differs from license source executable. Pass its source as nodeExecutable.');
  notices.push({ name: 'Node.js independent host runtime', version: nodeVersion, license: 'Node.js MIT and bundled third-party licenses', source: `https://github.com/nodejs/node/tree/${nodeVersion}`, files: nodeFiles });

  const conptyFiles: string[] = [];
  for (const [filename, expected] of Object.entries(sourceHashes)) {
    const file = path.join(docs, 'license-sources', filename);
    if (!await exists(file)) { errors.push(`Missing pinned ConPTY license source: ${filename}`); continue; }
    if (await sha256(file) !== expected) errors.push(`Pinned ConPTY notice changed: ${filename}`);
    conptyFiles.push(await copy(file, path.join(`conpty-${conptyVersion}`, filename.replace('conpty-', ''))));
  }
  for (const [filename, expected] of Object.entries(conptyHashes)) {
    const file = path.join(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty', filename);
    if (!await exists(file) || await sha256(file) !== expected) errors.push(`ConPTY binary version changed: ${filename}. Review original upstream license before packaging.`);
  }
  const nuspec = path.join(docs, 'license-sources/conpty.nuspec');
  if (await exists(nuspec)) conptyFiles.push(await copy(nuspec, `conpty-${conptyVersion}/Microsoft.Windows.Console.ConPTY.nuspec`));
  else errors.push('Missing original ConPTY nuspec license metadata.');
  notices.push({ name: 'Microsoft.Windows.Console.ConPTY / OpenConsole', version: conptyVersion, license: 'MIT plus upstream notices (conservative superset)', source: `https://github.com/microsoft/terminal/tree/${conptyCommit}`, files: conptyFiles });

  const manifest = { schemaVersion: 1, lockfileSha256: await sha256(path.join(root, 'package-lock.json')), productionPackages: seen.size, notices, skippedOptionalPackages: skipped, errors,
    conptyProvenance: { release: 'v1.23.12811.0', commit: conptyCommit,
      originalPackage: `https://github.com/microsoft/terminal/releases/download/v1.23.12811.0/Microsoft.Windows.Console.ConPTY.${conptyVersion}.nupkg`,
      packageSha256: 'f7e142a99f5dfee573ace98676b3c7c2fcdb870bc90b238086a4d80a36fcf099', binarySha256: conptyHashes, noticeSha256: sourceHashes } };
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const rows = notices.map(n => `| ${cell(n.name)} | ${cell(n.version)} | ${cell(n.license)} | ${n.files.map(f => `[${cell(path.basename(f))}](${f})`).join(' · ')} |`).join('\n');
  const markdown = `# 제3자 소프트웨어 고지\n\n이 문서는 \`scripts/notices.ts\`가 lockfile과 실제 설치된 production 의존성 메타데이터에서 생성합니다. 의존성 고지 원문은 연결된 파일에 수정 없이 보존합니다. 몽글터미널 자체의 공개 라이선스는 아직 결정하지 않았으며 \`private\`/\`UNLICENSED\`입니다. 아래 라이선스를 앱 자체의 라이선스로 해석하지 않습니다.\n\n## 포함 구성요소\n\n| 구성요소 | 버전 | 라이선스 메타데이터 | 고지 원문 |\n|---|---|---|---|\n${rows}\n\nProduction 직접·전이 의존성 ${seen.size}개와 별도 런타임 고지를 수집했습니다. 번들링 과정에서 제거된 코드에 대한 고지가 포함될 수 있습니다. 빌드 도구 자체는 배포하지 않는 범위에서 제외하며, Electron/Chromium은 개발 의존성에 선언되어도 실제 앱에 들어가므로 별도로 포함합니다. \`node-addon-api\`와 node-pty의 winpty 고지 역시 실제 설치 패키지에서 보존합니다.\n\n## 바이너리와 출처\n\nElectron의 \`LICENSES.chromium.html\`과 Node 설치본의 \`LICENSE\`는 각각 런타임에 포함된 여러 구성요소의 고지를 담고 있습니다. 런타임 버전이나 빌드 원본이 바뀌면 해당 배포물의 원문으로 다시 생성해야 합니다.\n\nConPTY와 OpenConsole은 [Microsoft 공식 릴리스 v1.23.12811.0](https://github.com/microsoft/terminal/releases/tag/v1.23.12811.0)의 \`${conptyVersion}\` 패키지를 사용합니다. npm node-pty x64 바이너리와 원본 nupkg 파일의 SHA-256을 대조했습니다. nupkg는 MIT 메타데이터만 포함하므로 [고정 소스 커밋](${notices[notices.length - 1].source})의 LICENSE와 NOTICE를 보존합니다. NOTICE는 상위 Windows Terminal 프로젝트의 넓은 고지 목록입니다. 목록의 모든 구성요소가 이 ConPTY 바이너리에 포함되었다고 단정하지 않습니다.\n\nxterm 어댑터는 xterm.js 6.0.0 내부 구조에 의존하는 몽글 코드입니다. xterm 원본 고지를 유지하며 업스트림 패키지 버전 변경 시 관련 검증이 필요합니다.\n\n[생성 명세와 무결성 값](licenses/manifest.json)에 각 패키지 출처, npm 무결성 값, 고정된 ConPTY 출처와 누락 사항을 기록합니다. 전체 \`docs/licenses\`와 이 문서를 배포물에 함께 포함해야 합니다.\n\n## 생성 검증\n\n${errors.length ? '**고지 생성 오류가 남아 있습니다. 배포 전에 해결해야 합니다.**\n\n' + errors.map(e => '- ' + e).join('\n') : '필수 원문 누락·lockfile 버전 불일치·고정 바이너리 불일치를 발견하지 않았습니다. 이는 자동 수집 검사 결과이며 별도 법률 검토를 뜻하지 않습니다.'}\n${skipped.length ? '\n이 플랫폼에 설치되지 않은 optional 패키지:\n\n' + skipped.map(s => '- ' + s).join('\n') + '\n' : ''}`;
  await writeFile(path.join(docs, 'THIRD-PARTY-NOTICES.md'), markdown);
  if (options.strict && errors.length) throw new Error(`Third-party notice verification failed:\n${errors.join('\n')}`);
  return { productionPackages: seen.size, notices: notices.length, errors, output: path.join(docs, 'THIRD-PARTY-NOTICES.md') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateNotices(process.cwd(), { strict: process.argv.includes('--strict') });
  console.log(JSON.stringify(result, null, 2));
}
