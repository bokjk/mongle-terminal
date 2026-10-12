import test from 'node:test';
import assert from 'node:assert/strict';
import { pathForShell, uploadToTerminal, UPLOAD_LIMIT_BYTES } from '../../apps/web/src/terminal-upload';

const target = { id: 't', hostId: 'h', bootId: 'b', generation: 'g', root: 'C:\\work' };
const file = (bytes: number, name = 'shot.png') => Object.assign(new Blob([new Uint8Array(bytes).fill(65)]), { name });

test('saved paths are typed the way each shell reads them', () => {
  const plain = 'C:\\work\\.mongle-attachments\\20261012-153000-abcd1234-shot.png';
  assert.equal(pathForShell(plain, 'powershell'), plain);
  assert.equal(pathForShell(plain, 'cmd'), plain);
  assert.equal(pathForShell('C:\\내 작업\\a.png', 'powershell'), "'C:\\내 작업\\a.png'");
  assert.equal(pathForShell("C:\\it's\\a.png", 'powershell'), "'C:\\it''s\\a.png'");
  assert.equal(pathForShell('C:\\My Work\\a.png', 'cmd'), '"C:\\My Work\\a.png"');
  assert.equal(pathForShell(plain, 'bash'), "'" + plain + "'", 'bash would eat the backslashes');
  assert.equal(pathForShell('C:\\work\\.mongle-attachments\\a.png', 'wsl'), '/mnt/c/work/.mongle-attachments/a.png');
  assert.equal(pathForShell('D:\\My Work\\a.png', 'wsl'), "'/mnt/d/My Work/a.png'");
});

test('a file goes up in ordered chunks with progress, and any failure or abort cancels it on the PC', async () => {
  const calls: Array<[string, any]> = [];
  const client = { request: async (method: string, params: any) => { calls.push([method, params]); if (method === 'files.upload.begin') return { uploadId: 'u', chunkBytes: 4 }; if (method === 'files.upload.finish') return { path: 'C:\\work\\x.png', name: 'x.png' }; return {}; } };
  const progress: number[] = [];
  assert.deepEqual(await uploadToTerminal(client as any, target, file(10), sent => progress.push(sent)), { path: 'C:\\work\\x.png', name: 'x.png' });
  assert.deepEqual(calls.map(([method, params]) => method === 'files.upload.chunk' ? [params.offset, Buffer.from(params.dataBase64, 'base64').toString()] : method), ['files.upload.begin', [0, 'AAAA'], [4, 'AAAA'], [8, 'AA'], 'files.upload.finish']);
  assert.deepEqual(progress, [4, 8, 10]);
  assert.deepEqual(calls[0]![1], { ...target, name: 'shot.png', size: 10 });

  calls.length = 0;
  const failing = { request: async (method: string, params: any) => { calls.push([method, params]); if (method === 'files.upload.begin') return { uploadId: 'u', chunkBytes: 4 }; if (method === 'files.upload.chunk' && params.offset === 4) throw new Error('끊김'); return {}; } };
  await assert.rejects(uploadToTerminal(failing as any, target, file(10)), /끊김/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.at(-1)![0], 'files.upload.cancel');

  calls.length = 0;
  const abort = new AbortController();
  await assert.rejects(uploadToTerminal(client as any, target, file(10), sent => { if (sent === 4) abort.abort(); }, abort.signal), { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(([method]) => method), ['files.upload.begin', 'files.upload.chunk', 'files.upload.cancel']);

  calls.length = 0;
  // Cancelled while the PC was still answering finish: the saved file is reported, never returned as typed.
  const late = new AbortController();
  const slowFinish = { request: async (method: string) => { if (method === 'files.upload.begin') return { uploadId: 'u', chunkBytes: 16 }; if (method === 'files.upload.finish') { late.abort(); return { path: 'C:\\work\\late.png', name: 'late.png' }; } return {}; } };
  await assert.rejects(uploadToTerminal(slowFinish as any, target, file(10), undefined, late.signal), (error: any) => error.name === 'AbortError' && error.saved?.path === 'C:\\work\\late.png');
  calls.length = 0;
  await assert.rejects(uploadToTerminal(client as any, target, file(UPLOAD_LIMIT_BYTES + 1)), /10 MiB/);
  await assert.rejects(uploadToTerminal(client as any, target, file(0)), /빈 파일/);
  assert.deepEqual(calls, [], 'refused files never reach the PC');
});
