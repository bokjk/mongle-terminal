import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execute('git', ['-c', 'user.name=Mongle Test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
  return stdout;
}
export async function gitFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-git-'));
  const repository = path.join(root, '작업 프로젝트'), data = path.join(repository, '.app-private');
  await mkdir(path.join(repository, 'src'), { recursive: true }); await mkdir(data);
  await git(repository, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(repository, '.gitignore'), '.app-private/\nignored/\n');
  await writeFile(path.join(repository, 'README.md'), '# Test project\n');
  await writeFile(path.join(repository, 'src', 'modified.ts'), 'export const value = 1;\n');
  await writeFile(path.join(repository, 'staged.txt'), 'before\n');
  await writeFile(path.join(repository, 'deleted.txt'), 'delete me\n');
  await writeFile(path.join(repository, '이전 이름.txt'), 'rename me\n');
  await git(repository, 'add', '--', '.'); await git(repository, 'commit', '-qm', 'fixture');
  return { root, repository, data };
}
