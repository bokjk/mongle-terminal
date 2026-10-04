export type MarkdownRequest = { id: number; text: string };
export type MarkdownResult = { id: number; html?: string; error?: string };
type WorkerPort = {
  postMessage(request: MarkdownRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<MarkdownResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

/** One running render and one newest draft; rapid typing cannot grow a backlog. */
export class MarkdownRenderQueue {
  private sequence = 0;
  private running?: number;
  private pending?: MarkdownRequest;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private worker: WorkerPort, private publish: (result: MarkdownResult) => void) {
    worker.onmessage = ({ data }) => {
      if (this.closed || data.id !== this.running) return;
      clearTimeout(this.timer); this.running = undefined;
      if (data.id === this.sequence) this.publish(data);
      this.flush();
    };
    worker.onerror = event => { event.preventDefault(); this.fail(); };
  }
  render(text: string) {
    if (this.closed) return;
    this.pending = { id: ++this.sequence, text };
    this.flush();
  }
  private flush() {
    if (this.closed || this.running !== undefined || !this.pending) return;
    const next = this.pending; this.pending = undefined; this.running = next.id;
    this.timer = setTimeout(() => this.fail(), 10_000);
    try { this.worker.postMessage(next); } catch { this.fail(); }
  }
  private fail() {
    if (this.closed) return;
    this.publish({ id: this.sequence, error: '미리보기를 처리하지 못했습니다. 편집 내용은 유지됩니다. 편집 모드로 전환한 뒤 다시 시도해 주세요.' });
    this.dispose();
  }
  dispose() {
    this.closed = true; this.pending = undefined;
    clearTimeout(this.timer);
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate();
  }
}
