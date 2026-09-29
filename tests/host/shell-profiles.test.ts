import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { detectShellProfiles, resolveShellLaunch, safeShellEnvironment } from '../../packages/shell-profiles/index.js';
import type { ShellProfile } from '../../packages/protocol/index.js';

const execFileAsync = promisify(execFile);

test('detected profiles reference installed files and unique stable IDs', async () => {
  const profiles = await detectShellProfiles();
  assert.ok(profiles.length > 0, 'This supported development OS must provide a shell');
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length);
  for (const profile of profiles) {
    assert.equal(path.isAbsolute(profile.executable), true);
    assert.equal((await stat(profile.executable)).isFile(), true);
    if (profile.kind === 'wsl') {
      assert.equal(profile.id, `wsl:${profile.args[1]}`);
      assert.equal(profile.args[0], '-d');
      assert.ok(profile.args[1]?.length);
    }
  }
  if (process.platform === 'win32') {
    assert.ok(profiles.some((profile) => profile.id === 'cmd'));
    assert.ok(profiles.some((profile) => profile.id === 'powershell-legacy'));
  }
});

test('launch preserves a directory with spaces, uses home by default, and validates invalid paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mongle shell spaces '));
  const executable = process.execPath;
  const profile: ShellProfile = { id: 'test', name: 'test', executable, args: [], kind: 'bash' };
  try {
    const launch = await resolveShellLaunch(profile, directory);
    assert.equal(launch.cwd, directory);
    const { stdout } = await execFileAsync(launch.executable, ['-e', 'process.stdout.write(process.cwd())'], { cwd: launch.cwd, env: safeShellEnvironment() });
    assert.equal(stdout, directory);
    assert.equal((await resolveShellLaunch(profile)).cwd, homedir());
    await assert.rejects(resolveShellLaunch(profile, path.join(directory, 'missing')), { code: 'INVALID_CWD' });
    const file = path.join(directory, 'not a directory.txt');
    await writeFile(file, 'test');
    await assert.rejects(resolveShellLaunch(profile, file), { code: 'INVALID_CWD' });
    await assert.rejects(resolveShellLaunch(profile, 'bad\0path'), { code: 'INVALID_CWD' });
    await assert.rejects(resolveShellLaunch({ ...profile, executable: path.join(directory, 'missing.exe') }, directory), { code: 'SHELL_NOT_FOUND' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('installed system shell starts in the explicitly chosen directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mongle actual shell '));
  try {
    const profiles = await detectShellProfiles();
    const profile = profiles.find((entry) => entry.kind === 'powershell') ?? profiles.find((entry) => entry.id === 'bash');
    assert.ok(profile);
    const launch = await resolveShellLaunch(profile, directory);
    const command = profile.kind === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command', '(Get-Location).Path'] : ['-c', 'pwd'];
    const { stdout } = await execFileAsync(launch.executable, [...launch.args, ...command], {
      cwd: launch.cwd, env: safeShellEnvironment(), windowsHide: true, timeout: 15_000,
    });
    // CI runners can expose TEMP as an 8.3 short path (C:\Users\RUNNER~1) while the
    // shell reports the long form; compare the canonical locations instead.
    assert.equal(await realpath(stdout.trim()), await realpath(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('relative working directories are rejected while empty values still select home', async () => {
  const profile: ShellProfile = { id: 'test', name: 'test', executable: process.execPath, args: [], kind: 'bash' };
  const relativePaths = ['.', '..', 'packages'];
  if (process.platform === 'win32') relativePaths.push('C:Users', '\\Windows', '/Windows');
  for (const directory of relativePaths) {
    await assert.rejects(resolveShellLaunch(profile, directory), { code: 'INVALID_CWD' });
  }
  assert.equal((await resolveShellLaunch(profile, '')).cwd, homedir());
  assert.equal((await resolveShellLaunch(profile, '   ')).cwd, homedir());
});

test('WSL keeps the real Windows path as one --cd argument without drive rewriting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mongle wsl spaces '));
  const profile: ShellProfile = { id: 'wsl:Test Distribution', name: 'WSL', executable: process.execPath, args: ['-d', 'Test Distribution'], kind: 'wsl' };
  try {
    const launch = await resolveShellLaunch(profile, directory);
    assert.deepEqual(launch.args, ['-d', 'Test Distribution', '--cd', directory]);
    assert.deepEqual(profile.args, ['-d', 'Test Distribution']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shell environment excludes host authentication and launcher injection while preserving user CLI settings', () => {
  const additions = {
    MONGLE_AUTH_TOKEN: 'test-only-secret', mongle_owner_pipe: 'private-pipe',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=/unwanted-hook', NODE_CHANNEL_FD: '3',
    npm_config_registry: 'https://launcher.invalid', npm_lifecycle_event: 'host',
    VSCODE_IPC_HOOK_CLI: 'private-hook', CODEX_INTERNAL_TEST: 'test', TSX_TSCONFIG_PATH: 'internal',
    MONGLE_TEST_USER_SETTING: 'internal', TEST_USER_CLI_SETTING: 'retain-me', OPENAI_API_KEY: 'test-only-user-key',
  };
  const previous = Object.fromEntries(Object.keys(additions).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, additions);
    const env = safeShellEnvironment();
    for (const key of Object.keys(additions).filter((key) => !['TEST_USER_CLI_SETTING', 'OPENAI_API_KEY'].includes(key))) {
      assert.equal(env[key], undefined, `${key} must not reach shell children`);
    }
    assert.equal(env.TEST_USER_CLI_SETTING, 'retain-me');
    assert.equal(env.OPENAI_API_KEY, 'test-only-user-key');
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.COLORTERM, 'truecolor');
    assert.equal(env.CHERE_INVOKING, '1');
    assert.ok(Object.entries(env).some(([key, value]) => key.toUpperCase() === 'PATH' && value.length > 0));
    assert.equal(process.env.MONGLE_AUTH_TOKEN, additions.MONGLE_AUTH_TOKEN, 'sanitizing never mutates the host environment');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
