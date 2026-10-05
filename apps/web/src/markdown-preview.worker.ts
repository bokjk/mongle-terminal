import { renderMarkdown } from './render-markdown';
import type { MarkdownRequest, MarkdownResult } from './markdown-render-queue';

self.onmessage = ({ data }: MessageEvent<MarkdownRequest>) => {
  let result: MarkdownResult;
  try { result = { id: data.id, html: renderMarkdown(data.text) }; }
  catch (error) { result = { id: data.id, error: error instanceof Error ? error.message : '미리보기를 만들지 못했습니다.' }; }
  self.postMessage(result);
};
