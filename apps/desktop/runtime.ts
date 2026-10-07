import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
const execFileAsync = promisify(execFile);
async function digest(file: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

/** Protect the parent before Electron can create its profile or instance lock. */
export function prepareDesktopDataDirectory(root: string, dataDir: string): void {
  if (process.platform !== 'win32') throw new Error('현재 데스크톱 앱은 Windows에서 지원합니다.');
  const helper = path.resolve(root, 'platform/windows/OwnerPipe.exe');
  try {
    const output = execFileSync(helper, ['prepare', path.resolve(dataDir)], {
      windowsHide: true, timeout: 15_000, maxBuffer: 32_768,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== 'object' || !('kind' in result) || result.kind !== 'prepared') {
      throw new Error('로컬 보안 구성 요소의 준비 응답을 확인하지 못했습니다.');
    }
  } catch (error) {
    throw new Error('데이터 폴더를 안전하게 준비하지 못했습니다. 폴더 소유자와 접근 권한, 로컬 보안 구성 요소를 확인하세요.', { cause: error });
  }
}

export async function prepareRuntime(root: string, nodeExecutable = process.execPath) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('현재 배포는 Windows x64에서 빌드해야 합니다.');
  const runtime = path.join(root, 'runtime'); await mkdir(runtime, { recursive: true });
  const targetNode = path.join(runtime, 'node.exe');
  let identical = false;
  try { identical = await digest(nodeExecutable) === await digest(targetNode); } catch {}
  if (!identical) await copyFile(nodeExecutable, targetNode);
  const source = path.join(root, 'platform/windows/HostLauncher.cs'); const output = path.join(root, 'platform/windows/HostLauncher.exe');
  let compile = true; try { compile = (await stat(source)).mtimeMs > (await stat(output)).mtimeMs; } catch {}
  if (compile) {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    await execFileAsync(compiler, ['/nologo', '/target:exe', '/optimize+', '/reference:System.Management.dll', '/out:' + output, source], { windowsHide: true });
  }
  return { node: path.join(runtime, 'node.exe'), launcher: output };
}

export async function launchHost(root: string, dataDir: string): Promise<number> {
  const node = path.join(root, 'runtime/node.exe'), launcher = path.join(root, 'platform/windows/HostLauncher.exe'), entry = path.join(root, 'dist/host/main.cjs');
  await Promise.all([node, launcher, entry].map(file => access(file)));
  const integrationArgs = process.env.MONGLE_CLAUDE_CONFIG_DIR ? ['--claude-config-dir', process.env.MONGLE_CLAUDE_CONFIG_DIR] : process.env.MONGLE_DATA_DIR ? [] : ['--claude-integration'];
  // Same rule for Codex: isolated profiles touch only an explicitly named Codex home.
  if (process.env.MONGLE_CODEX_HOME) integrationArgs.push('--codex-home', process.env.MONGLE_CODEX_HOME);
  else if (!process.env.MONGLE_DATA_DIR) integrationArgs.push('--codex-integration');
  const { stdout } = await execFileAsync(launcher, [node, entry, dataDir, ...integrationArgs], { cwd: root, windowsHide: true, timeout: 20_000, maxBuffer: 32_768 });
  const pid = Number(stdout.trim()); if (!Number.isInteger(pid) || pid < 1) throw new Error('호스트 실행 응답을 확인하지 못했습니다.'); return pid;
}
