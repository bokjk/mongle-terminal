import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const groups = {
  native: ['test-results/e2e/clipboard/result.json', 'test-results/e2e/update-desktop/result.json'],
  installed: ['test-results/installed-upgrade/result.json'],
} as const;

/** Keep bounded, allowlisted evidence in job logs even when artifact storage is full. */
export function validationSummary(file: string, bytes: Buffer) {
  if (bytes.length > 1024 * 1024) throw new Error('Validation result is too large.');
  let value: any;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid validation JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('Invalid validation result.');
  return { file, passed: value.passed === true, cleanedUp: value.cleanedUp === true,
    resultSha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function recordValidationSummary(group: string, root = process.cwd(), summaryFile?: string) {
  if (group !== 'native' && group !== 'installed') throw new Error('Expected native or installed validation group.');
  const results = await Promise.all(groups[group].map(async file => validationSummary(file, await readFile(path.join(root, file)))));
  const report = JSON.stringify({ group, results }, null, 2);
  console.log(report);
  if (summaryFile) await appendFile(summaryFile, '\n## Verification evidence\n\n~~~json\n' + report + '\n~~~\n');
  if (results.some(result => !result.passed || !result.cleanedUp)) throw new Error('Validation or isolated process cleanup did not pass.');
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: record-validation-summary.ts native|installed');
  await recordValidationSummary(process.argv[2], process.cwd(), process.env.GITHUB_STEP_SUMMARY);
}
