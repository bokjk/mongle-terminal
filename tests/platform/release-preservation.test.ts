// The .test.ts entry point
// is discovered by the existing regression command; cases remain plain JS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('unpublished source draft preservation workflow and whole-script offline regressions', { timeout: 180_000 }, () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cases = path.resolve(here, '../fixtures/release-preservation-cases.mjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', cases], {
    env, encoding: 'utf8', windowsHide: true, timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
