import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPdfDocument } from '../../apps/web/src/pdf-document';
import { PDF_CHUNK_BYTES, PDF_PREVIEW_BYTES } from '../../packages/protocol';
import type { ExplorerClient } from '../../apps/web/src/explorer-queue';
const reference = { id: 't', hostId: 'h', bootId: 'b', generation: 'g', root: 'C:/test' };
function fixture(data: Buffer, alter: (chunk: any, calls: number) => void = () => {}) {
  let calls = 0;
  const client = { request: async (_: string, p: any) => {
    const chunk = { path: 'report.pdf', absolutePath: 'C:/test/report.pdf', size: data.length, offset: p.offset, version: 'a'.repeat(64), contentBase64: data.subarray(p.offset, p.offset + PDF_CHUNK_BYTES).toString('base64') };
    alter(chunk, ++calls); return chunk;
  } } as ExplorerClient;
  return { client, calls: () => calls };
}
test('PDF loader assembles bounded chunks exactly and reports progress', async () => {
  const data = Buffer.alloc(PDF_CHUNK_BYTES * 2 + 23, 0xbd), h = fixture(data), progress: number[] = [];
  const pdf = await loadPdfDocument(h.client, reference, 'report.pdf', new AbortController().signal, () => {}, value => progress.push(value));
  assert.deepEqual(Buffer.from(pdf.data), data); assert.equal(h.calls(), 3); assert.equal(progress.at(-1), 100);
});
test('PDF loader stops subsequent reads after close or host change', async () => {
  const controller = new AbortController(), h = fixture(Buffer.alloc(PDF_CHUNK_BYTES * 2), () => controller.abort());
  await assert.rejects(loadPdfDocument(h.client, reference, 'report.pdf', controller.signal, () => {}, () => {}), { name: 'AbortError' });
  assert.equal(h.calls(), 1);
  let valid = true; const changed = fixture(Buffer.alloc(PDF_CHUNK_BYTES * 2), () => { valid = false; });
  await assert.rejects(loadPdfDocument(changed.client, reference, 'report.pdf', new AbortController().signal, () => { if (!valid) throw Error('host changed'); }, () => {}), /host changed/);
  assert.equal(changed.calls(), 1);
});
test('PDF loader rejects changed revisions, truncated and oversized responses', async () => {
  for (const modify of [(c: any, n: number) => { if (n === 2) c.version = 'b'.repeat(64); }, (c: any) => { c.contentBase64 = 'YQ=='; }, (c: any) => { c.size = PDF_PREVIEW_BYTES + 1; }]) {
    const h = fixture(Buffer.alloc(PDF_CHUNK_BYTES + 10), modify);
    await assert.rejects(loadPdfDocument(h.client, reference, 'report.pdf', new AbortController().signal, () => {}, () => {}));
    assert.ok(h.calls() <= 2);
  }
});
