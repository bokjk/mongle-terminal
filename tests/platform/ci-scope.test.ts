import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { changedFiles, comparison, requiresWindows } from '../../scripts/ci-scope.ts';

const exec = promisify(execFile);
const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): any };

test('only known prose paths skip runtime verification; empty and unknown changes require it', () => {
  assert.equal(requiresWindows(['README.md', 'CHANGELOG.md', 'docs/validation/a.md']), false);
  for (const files of [[], ['apps/web/README.md'], ['docs/example.ts'], ['docs/../scripts/a.md'], ['package-lock.json'], ['.github/workflows/ci.yml'], ['README.md', 'apps/web/main.tsx']]) {
    assert.equal(requiresWindows(files), true, JSON.stringify(files));
  }
  assert.equal(requiresWindows(['README.md'], true), true);
  assert.equal(requiresWindows(['docs/USER-GUIDE.md'], false, ['docs/USER-GUIDE.md']), true);
});

test('release or unknown target branches cannot use the documentation-only route', () => {
  const event = (ref?: string) => ({ pull_request: { base: { sha: 'a'.repeat(40), ref }, head: { sha: 'b'.repeat(40) } } });
  assert.equal(comparison(event('dev')).force, false);
  assert.equal(comparison(event('main')).force, true);
  assert.equal(comparison(event()).force, true);
  for (const bad of [null, {}, { pull_request: { base: { sha: '--help' } } }]) assert.throws(() => comparison(bad));
});

test('real git diff retains deleted code and both sides of a code-to-doc rename; CLI needs no dependencies', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'mongle-ci-scope-'));
  try {
    const git = async (...args: string[]) => (await exec('git', args, { cwd: parent, windowsHide: true })).stdout.trim();
    await git('init');
    await git('config', 'user.name', 'CI fixture');
    await git('config', 'user.email', 'ci@example.invalid');
    await mkdir(path.join(parent, 'apps'));
    await mkdir(path.join(parent, 'docs'));
    await writeFile(path.join(parent, 'apps/code.ts'), 'export const n = 1;\n');
    await writeFile(path.join(parent, 'apps/deleted.ts'), 'export const n = 2;\n');
    await git('add', '.'); await git('commit', '-m', 'base');
    const base = await git('rev-parse', 'HEAD');
    await rename(path.join(parent, 'apps/code.ts'), path.join(parent, 'docs/code.md'));
    await rm(path.join(parent, 'apps/deleted.ts'));
    await git('add', '-A'); await git('commit', '-m', 'move code and delete');
    const head = await git('rev-parse', 'HEAD');
    const changes = await changedFiles(base, head, parent);
    assert.deepEqual(changes.files.sort(), ['apps/code.ts', 'apps/deleted.ts', 'docs/code.md']);
    assert.deepEqual(changes.deletedFiles.sort(), ['apps/code.ts', 'apps/deleted.ts']);
    assert.equal(requiresWindows(changes.files, false, changes.deletedFiles), true);

    await copyFile('scripts/ci-scope.ts', path.join(parent, 'ci-scope.ts'));
    const eventPath = path.join(parent, 'event.json'), output = path.join(parent, 'output');
    const run = (extra: NodeJS.ProcessEnv = {}) => exec(process.execPath, ['ci-scope.ts'], { cwd: parent, windowsHide: true, env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, ...extra } });
    await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: base, ref: 'dev' }, head: { sha: head } } }));
    await run(); assert.equal(await readFile(output, 'utf8'), 'windows_required=true\n');
    await writeFile(path.join(parent, 'docs/guide.md'), 'Documentation only\n');
    await git('add', 'docs/guide.md'); await git('commit', '-m', 'docs');
    const docsHead = await git('rev-parse', 'HEAD');
    await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: head, ref: 'dev' }, head: { sha: docsHead } } }));
    await writeFile(output, ''); await run(); assert.equal(await readFile(output, 'utf8'), 'windows_required=false\n');
    await writeFile(output, ''); await run({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
    assert.equal(await readFile(output, 'utf8'), 'windows_required=true\n');
    await rm(path.join(parent, 'docs/guide.md'));
    await git('add', '-A', '--', 'docs/guide.md'); await git('commit', '-m', 'delete docs');
    await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: docsHead, ref: 'dev' }, head: { sha: await git('rev-parse', 'HEAD') } } }));
    await writeFile(output, ''); await run(); assert.equal(await readFile(output, 'utf8'), 'windows_required=true\n');
    await writeFile(output, ''); await writeFile(eventPath, '{}');
    await assert.rejects(run); assert.equal(await readFile(output, 'utf8'), '');
    await assert.rejects(changedFiles('--help', head, parent));
  } finally {
    assert.ok(path.resolve(parent).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(parent, { recursive: true, force: true });
  }
});

test('CI routes metadata separately, keeps full release checks and fails a missing scope output', async () => {
  const workflow = yaml.load(await readFile('.github/workflows/ci.yml', 'utf8'));
  const description = yaml.load(await readFile('.github/workflows/pr-description.yml', 'utf8'));
  assert.equal(workflow.on.push, undefined, 'merge pushes must not repeat PR verification');
  assert.ok(workflow.on.pull_request.types.includes('edited'), 'retargeted PRs must be verified again');
  assert.ok(!workflow.on.pull_request.types.includes('ready_for_review'), 'draft publication reuses the same code check');
  assert.equal(workflow.on.pull_request.paths, undefined);
  assert.match(workflow.concurrency.group, /!github.event.changes.base && 'metadata' \|\| 'code'/);
  const job = workflow.jobs['windows-checks'];
  assert.match(job.name, /'Windows checks \(PR text only\)' \|\| 'Windows checks'/);
  assert.match(job.if, /always\(\).*github.event.changes.base/);
  assert.equal(job.needs, 'scope');
  assert.match(job['runs-on'], /== 'false' && 'ubuntu-24.04' \|\| 'windows-2022'/);
  assert.match(job.steps[0].run, /test "\$SCOPE_RESULT" = success/);
  assert.match(job.steps[0].run, /exit 1/);
  for (const step of job.steps.slice(1)) assert.match(step.if, /needs.scope.outputs.windows_required == 'true'/, step.name);
  assert.deepEqual(description.permissions, { contents: 'read' });
  assert.ok(description.on.pull_request.types.includes('edited'));
  assert.equal(description.jobs.description.name, 'PR description');
  const commands = description.jobs.description.steps.map((step: any) => step.run || '').join('\n');
  assert.match(commands, /node scripts\/check-contribution.ts/);
  assert.doesNotMatch(commands, /npm|npx|build/);
  assert.notEqual(description.concurrency.group, workflow.concurrency.group);
  const release = yaml.load(await readFile('.github/workflows/release.yml', 'utf8'));
  assert.deepEqual(release.on.push.tags, ['v*']);
  assert.equal(release.jobs.build['runs-on'], 'windows-2022');
});
