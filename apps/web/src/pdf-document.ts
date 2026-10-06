import { PDF_CHUNK_BYTES, PDF_PREVIEW_BYTES, type PdfChunk } from '../../../packages/protocol';
import type { ExplorerClient } from './explorer-queue';
import type { FileReference } from './use-file-documents';

export type PdfDocument = { data: Uint8Array; absolutePath: string; size: number };
export async function loadPdfDocument(client: ExplorerClient, reference: FileReference, path: string, signal: AbortSignal, check: () => void, progress: (value: number) => void): Promise<PdfDocument> {
  let data: Uint8Array | undefined, version: string | undefined, absolutePath = '';
  for (let offset = 0; !data || offset < data.length;) {
    signal.throwIfAborted(); check();
    const chunk = await client.request<PdfChunk>('files.pdf', { ...reference, path, offset, ...(version ? { version } : {}) }, signal);
    signal.throwIfAborted(); check();
    if (!Number.isInteger(chunk.size) || chunk.size < 5 || chunk.size > PDF_PREVIEW_BYTES || chunk.offset !== offset || !/^[a-f0-9]{64}$/.test(chunk.version) || chunk.path !== path || typeof chunk.absolutePath !== 'string' || typeof chunk.contentBase64 !== 'string' || chunk.contentBase64.length > Math.ceil(PDF_CHUNK_BYTES / 3) * 4) throw new Error('PDF 응답을 확인하지 못했습니다. 다시 열어 주세요.');
    if (data && (chunk.size !== data.length || chunk.version !== version || chunk.absolutePath !== absolutePath)) throw new Error('읽는 동안 PDF가 변경되었습니다. 다시 열어 주세요.');
    const binary = atob(chunk.contentBase64);
    if (binary.length !== Math.min(PDF_CHUNK_BYTES, chunk.size - offset)) throw new Error('PDF 일부를 읽지 못했습니다. 다시 열어 주세요.');
    data ??= new Uint8Array(chunk.size);
    for (let i = 0; i < binary.length; i++) data[offset + i] = binary.charCodeAt(i);
    version = chunk.version; absolutePath = chunk.absolutePath; offset += binary.length;
    progress(Math.round(offset / data.length * 100));
  }
  return { data, size: data.length, absolutePath };
}
