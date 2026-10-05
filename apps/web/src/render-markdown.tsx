import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FILE_EDIT_BYTES } from '../../../packages/protocol';

// Only this trusted renderer produces preview HTML. Raw HTML is never parsed;
// React escapes both text and attributes, including copied link destinations.
export function renderMarkdown(text: string): string {
  if (new TextEncoder().encode(text).length > FILE_EDIT_BYTES) throw new Error('마크다운 미리보기는 UTF-8 기준 64 KiB까지 지원합니다.');
  return renderToStaticMarkup(text ? <Markdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={url => /^(https?:|mailto:)/i.test(url) ? url : ''} components={{
      a: ({ href, children }) => href ? <button type="button" className="markdown-link" title={`${href} · 주소 복사`} data-markdown-url={href}>{children}</button> : <span>{children}</span>,
      img: ({ alt }) => <span className="markdown-image-note">이미지{alt ? `: ${alt}` : ''} · 외부 리소스는 불러오지 않습니다</span>,
    }}>{text}</Markdown> : <p className="markdown-empty">왼쪽에 마크다운을 입력하면 여기에 표시됩니다.</p>);
}
