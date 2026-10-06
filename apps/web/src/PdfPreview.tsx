import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, PDFWorker, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import type { PdfDocument } from './pdf-document';

type Props = { pdf: PdfDocument; page: number; zoom: number; onView(page: number, zoom: number): void };
function openPdf(pdf: PdfDocument) {
  const port = new Worker(new URL('./pdf-preview.worker.ts', import.meta.url), { type: 'module' });
  let worker: PDFWorker | undefined;
  try {
    worker = PDFWorker.create({ port });
    const base = new URL('./pdf-assets/', window.document.baseURI).href;
    const task = getDocument({ data: pdf.data.slice(), worker, cMapUrl: base + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', useWasm: false,
      useWorkerFetch: false, enableXfa: false, stopAtErrors: true, maxImageSize: 32 * 1024 * 1024,
      canvasMaxAreaInBytes: 32 * 1024 * 1024, verbosity: 0 });
    return { port, worker, task };
  } catch (error) { worker?.destroy(); port.terminate(); throw error; }
}
export default function PdfPreview({ pdf, page, zoom, onView }: Props) {
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [error, setError] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState('');
  const passwordReply = useRef<((password: string) => void) | undefined>(undefined);
  const [rendering, setRendering] = useState(false);
  const [width, setWidth] = useState(0), [scale, setScale] = useState(1);
  const viewport = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null);
  const stop = useRef<() => void>(() => {});
  const renderQueue = useRef<Promise<void>>(Promise.resolve());
  const renderedPage = useRef<PDFPageProxy | undefined>(undefined);
  const pageNumber = Math.min(document?.numPages || page, Math.max(1, page));
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    setDocument(undefined); setError(''); setPasswordPrompt('');
    // Only our local font/decoder resources are fetched. No annotation or JS
    // action layer is installed. Avoid eval/Wasm CSP exceptions and main-thread parsing.
    let resources: ReturnType<typeof openPdf>;
    try { resources = openPdf(pdf); }
    catch { setError('PDF 뷰어를 시작하지 못했습니다. 파일을 다시 열어 주세요.'); return; }
    const { port, worker, task } = resources;
    const destroy = () => { if (disposed) return; disposed = true; passwordReply.current = undefined; void task.destroy().catch(() => {}); worker.destroy(); port.terminate(); };
    stop.current = destroy;
    let timer = window.setTimeout(() => { setError('PDF를 여는 데 시간이 너무 오래 걸립니다. 다시 열어 주세요.'); destroy(); }, 30000);
    task.onPassword = (reply: (password: string) => void, reason: number) => {
      if (disposed) return;
      window.clearTimeout(timer); passwordReply.current = password => {
        setPasswordPrompt(''); reply(password);
        timer = window.setTimeout(() => { setError('PDF를 열지 못했습니다. 다시 열어 주세요.'); destroy(); }, 30000);
      };
      setPasswordPrompt(reason === 2 ? '암호가 맞지 않습니다. 다시 입력해 주세요.' : '암호로 보호된 PDF입니다.');
    };
    void task.promise.then(value => { if (!disposed) { setDocument(value); setPasswordPrompt(''); } }, () => {
      if (!disposed) { setError('PDF를 열지 못했습니다. 손상되었거나 지원하지 않는 문서일 수 있습니다.'); destroy(); }
    }).finally(() => window.clearTimeout(timer));
    return () => { window.clearTimeout(timer); destroy(); };
  }, [pdf]);

  useEffect(() => {
    const target = surface.current;
    if (!document || !target || width < 1 || error) return;
    let cancelled = false, render: RenderTask | undefined, text: TextLayer | undefined, sheet: PDFPageProxy | undefined;
    target.replaceChildren(); setRendering(true);
    viewport.current?.scrollTo(0, 0);
    // PDF.js paints with requestAnimationFrame. Hidden/occluded windows may
    // receive no frames or only one per second; wall time is not render time.
    let elapsed = 0, previousFrame = performance.now(), frame = 0;
    const watch = (now: number) => {
      elapsed += Math.min(100, now - previousFrame); previousFrame = now;
      if (elapsed >= 30000) {
        cancelled = true;
        setRendering(false); setError('이 페이지를 표시하는 데 시간이 너무 오래 걸립니다. PDF를 다시 열어 주세요.');
        render?.cancel(); text?.cancel(); stop.current();
      } else frame = requestAnimationFrame(watch);
    };
    frame = requestAnimationFrame(watch);
    // Finish cancellation before starting another render of a shared PDF page.
    renderQueue.current = renderQueue.current.then(async () => {
      if (cancelled) return;
      sheet = await document.getPage(pageNumber);
      if (cancelled) return;
      // Keep the current page's operator stream for zoom/resize. Cleaning it
      // after every cancelled render can invalidate a new render of that page.
      if (renderedPage.current !== sheet) renderedPage.current?.cleanup();
      renderedPage.current = sheet;
      const natural = sheet.getViewport({ scale: 1 });
      const requested = zoom || Math.max(0.1, (width - 32) / natural.width);
      const displayScale = Math.min(requested, 8192 / Math.max(natural.width, natural.height));
      if (!Number.isFinite(displayScale) || displayScale <= 0) throw Error('Invalid PDF dimensions');
      const view = sheet.getViewport({ scale: displayScale });
      const pixelScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12 * 1024 * 1024 / (view.width * view.height)));
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(view.width * pixelScale)); canvas.height = Math.max(1, Math.floor(view.height * pixelScale));
      canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
      canvas.setAttribute('aria-label', `PDF ${pageNumber}페이지`); canvas.setAttribute('role', 'img');
      const layer = window.document.createElement('div'); layer.className = 'pdf-text-layer';
      target.style.width = `${view.width}px`; target.style.height = `${view.height}px`;
      target.style.setProperty('--total-scale-factor', String(displayScale));
      target.replaceChildren(canvas, layer); setScale(displayScale);
      render = sheet.render({ canvas, viewport: view, transform: [pixelScale, 0, 0, pixelScale, 0, 0] });
      await render.promise;
      render = undefined;
      if (cancelled) return;
      text = new TextLayer({ textContentSource: sheet.streamTextContent(), container: layer, viewport: view });
      await text.render();
      text = undefined;
    }).catch(() => { if (!cancelled) setError('PDF 페이지를 표시하지 못했습니다. 디스크 파일을 다시 열어 주세요.'); })
      .finally(() => { cancelAnimationFrame(frame); if (!cancelled) setRendering(false); });
    return () => { cancelled = true; cancelAnimationFrame(frame); render?.cancel(); text?.cancel(); target.replaceChildren(); };
  }, [document, pageNumber, zoom, width, error]);

  return <div className="pdf-preview" aria-label="PDF 미리보기">
    <div className="pdf-toolbar" role="group" aria-label="PDF 보기 도구">
      <button className="icon-button" aria-label="이전 페이지" disabled={!document || !!error || pageNumber <= 1} onClick={() => onView(pageNumber - 1, zoom)}><ChevronLeft size={16}/></button>
      <form key={pageNumber} onSubmit={event => { event.preventDefault(); const value = Number(new FormData(event.currentTarget).get('page')); if (Number.isInteger(value) && value >= 1 && value <= (document?.numPages || 1)) onView(value, zoom); }}>
        <input className="pdf-page-number" name="page" type="number" min={1} max={document?.numPages || 1} defaultValue={pageNumber} aria-label="PDF 페이지 번호" disabled={!document || !!error}/>
      </form><span aria-label="전체 페이지">/ {document?.numPages || '—'}</span>
      <button className="icon-button" aria-label="다음 페이지" disabled={!document || !!error || pageNumber >= document.numPages} onClick={() => onView(pageNumber + 1, zoom)}><ChevronRight size={16}/></button>
      <span className="pdf-toolbar-divider"/>
      <button className="icon-button" aria-label="PDF 축소" disabled={!document || !!error || scale <= 0.5} onClick={() => onView(pageNumber, Math.max(0.5, Math.round(scale * 80) / 100))}><ZoomOut size={15}/></button>
      <span className="pdf-zoom-value">{Math.round(scale * 100)}%</span>
      <button className="icon-button" aria-label="PDF 확대" disabled={!document || !!error || scale >= 3} onClick={() => onView(pageNumber, Math.min(3, Math.round(scale * 125) / 100))}><ZoomIn size={15}/></button>
      <button className="button subtle" aria-pressed={zoom === 0} disabled={!document || !!error} onClick={() => onView(pageNumber, 0)}>너비 맞춤</button>
    </div>
    {passwordPrompt && <form className="pdf-password" onSubmit={event => { event.preventDefault(); const form = event.currentTarget; passwordReply.current?.(String(new FormData(form).get('password') || '')); form.reset(); }}>
      <p role="status">{passwordPrompt}</p><label>PDF 암호<input name="password" type="password" autoComplete="off" autoFocus required/></label><button className="button" type="submit">열기</button>
    </form>}
    {error && <p className="file-message" role="alert">{error}</p>}
    {!error && !passwordPrompt && (!document || rendering) && <p className="pdf-loading" role="status">{document ? 'PDF 페이지를 표시하는 중…' : 'PDF를 준비하는 중…'}</p>}
    <div className="pdf-viewport" ref={viewport} tabIndex={0} aria-label="PDF 페이지" aria-busy={rendering} hidden={!!error || !!passwordPrompt}>
      <div className="pdf-page" ref={surface}/>
    </div>
  </div>;
}
