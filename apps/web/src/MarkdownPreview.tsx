import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownRenderQueue, type MarkdownResult } from './markdown-render-queue';

type Props = { text: string; onCopyLink(value: string): void };
/** Parsing runs off the UI thread; all inserted HTML comes from renderMarkdown. */
export const MarkdownPreview = memo(function MarkdownPreview({ text, onCopyLink }: Props) {
  const queue = useRef<MarkdownRenderQueue>(undefined);
  const [result, setResult] = useState<MarkdownResult>();
  useEffect(() => {
    try {
      const worker = new Worker(new URL('./markdown-preview.worker.ts', import.meta.url), { type: 'module' });
      queue.current = new MarkdownRenderQueue(worker, setResult);
    } catch {
      setResult({ id: 0, error: '미리보기를 시작하지 못했습니다. 편집 내용은 유지됩니다.' });
    }
    return () => { queue.current?.dispose(); queue.current = undefined; };
  }, []);
  useEffect(() => { queue.current?.render(text); }, [text]);
  const content = useMemo(() => result?.error ? { children: <p role="status">{result.error}</p> }
    : result?.html !== undefined ? { dangerouslySetInnerHTML: { __html: result.html } }
    : { children: <p className="markdown-empty" role="status">미리보기를 준비하는 중…</p> }, [result]);
  return <article className="markdown-preview" aria-label="마크다운 미리보기" tabIndex={0} onClick={event => {
    const link = (event.target as Element).closest<HTMLButtonElement>('button[data-markdown-url]');
    const url = link?.dataset.markdownUrl;
    if (url && /^(https?:|mailto:)/i.test(url)) onCopyLink(url);
  }} {...content}/>;
});
