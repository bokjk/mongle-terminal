import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordValidationSummary, validationSummary } from '../../scripts/record-validation-summary.js';

test('validation log evidence omits arbitrary result data and keeps failure explicit', () => {
  const result = validationSummary('fixture', Buffer.from(JSON.stringify({ passed: true, cleanedUp: false,
    processLogs: 'SECRET ::warning::untrusted', error: 'PRIVATE', session: { token: 'SECRET' } })));
  assert.equal(result.passed, true); assert.equal(result.cleanedUp, false);
  assert.match(result.resultSha256, /^[a-f0-9]{64}$/);
  assert.ok(!/SECRET|PRIVATE|warning/.test(JSON.stringify(result)));
  assert.throws(() => validationSummary('fixture', Buffer.from('SYNTHETIC_SECRET')), { message: 'Invalid validation JSON.' });
  assert.throws(() => validationSummary('fixture', Buffer.alloc(1024 * 1024 + 1)), /too large/);
});

test('required validation evidence rejects missing results, failed cleanup and unsupported paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-summary-'));
  try {
    await assert.rejects(recordValidationSummary('../arbitrary', root), /Expected/);
    await assert.rejects(recordValidationSummary('installed', root), /ENOENT/);
    const directory = path.join(root, 'test-results/installed-upgrade'); await mkdir(directory, { recursive: true });
    const result = path.join(directory, 'result.json'), summary = path.join(root, 'summary.md');
    await writeFile(result, JSON.stringify({ passed: true, cleanedUp: false }));
    await assert.rejects(recordValidationSummary('installed', root, summary), /did not pass/);
    await writeFile(result, JSON.stringify({ passed: true, cleanedUp: true }));
    assert.equal((await recordValidationSummary('installed', root, summary))[0].passed, true);
    assert.match(await readFile(summary, 'utf8'), /resultSha256/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mongle-summary-'));
    await rm(root, { recursive: true, force: true });
  }
});
