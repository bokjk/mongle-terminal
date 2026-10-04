import { useDeferredValue } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** No raw HTML, executable URL schemes, embedded documents, or automatic image requests. */
export function MarkdownPreview({ text, onCopyLink }: { text: string; onCopyLink(value: string): void }) {
  const deferred = useDeferredValue(text);
  return <article className="markdown-preview" aria-label="마크다운 미리보기" tabIndex={0}>
    {deferred ? <Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^(https?:|mailto:)/i.test(url) ? url : ''} components={{
      a: ({ href, children }) => href ? <button className="markdown-link" title={`${href} · 주소 복사`} onClick={() => onCopyLink(href)}>{children}</button> : <span>{children}</span>,
      img: ({ alt }) => <span className="markdown-image-note">이미지{alt ? `: ${alt}` : ''} · 외부 리소스는 불러오지 않습니다</span>,
    }}>{deferred}</Markdown> : <p className="markdown-empty">왼쪽에 마크다운을 입력하면 여기에 표시됩니다.</p>}
  </article>;
}
