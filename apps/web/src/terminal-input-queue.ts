type Encoding = 'utf8' | 'binary';
type Chunk = { data: string; encoding: Encoding; bytes: number };

const MAX_PENDING_BYTES = 64 * 1024;
// Leave room for JSON escaping and the local IPC envelope, even for binary
// strings. The host validates UTF-8 request size before decoding binary input.
const MAX_BATCH_BYTES = 8 * 1024;
const encoder = new TextEncoder();

/** One live lease's input. Accepted requests are never replayed or retried. */
export class TerminalInputQueue {
  private queued: Chunk[] = [];
  private pendingBytes = 0;
  private inFlight?: Promise<void>;
  private paused = false;
  private closed = false;
  private discardedInput = false;

  constructor(private readonly options: {
    isCurrent(): boolean;
    send(data: string, encoding: Encoding): Promise<unknown>;
    failed(error: unknown): void;
  }) {}

  get hasPendingInput(): boolean { return this.inFlight !== undefined || this.queued.length > 0 || this.discardedInput; }

  enqueue(data: string, encoding: Encoding): void {
    if (this.closed || !data) return;
    if (!this.options.isCurrent()) { this.close(); return; }
    const bytes = encoder.encode(data).length;
    if (this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.fail(new Error('입력 전송이 지연되어 입력을 멈췄습니다. 내용을 확인하고 제어권을 다시 가져와 주세요.'));
      return;
    }
    this.pendingBytes += bytes;
    const append = (text: string, size: number) => {
      const last = this.queued.at(-1);
      if (last?.encoding === encoding && last.bytes + size <= MAX_BATCH_BYTES) { last.data += text; last.bytes += size; }
      else this.queued.push({ data: text, encoding, bytes: size });
    };
    if (bytes <= MAX_BATCH_BYTES) append(data, bytes);
    else {
      let part = '', partBytes = 0;
      // Iterating code points keeps surrogate pairs intact across batches.
      for (const character of data) {
        const size = encoder.encode(character).length;
        if (partBytes + size > MAX_BATCH_BYTES) { append(part, partBytes); part = ''; partBytes = 0; }
        part += character; partBytes += size;
      }
      if (part) append(part, partBytes);
    }
    this.pump();
  }

  /** A resize waits only for the request already sent, never its paused queue. */
  pause(): Promise<void> { this.paused = true; return this.inFlight || Promise.resolve(); }
  resume(): void { if (!this.closed) { this.paused = false; this.pump(); } }
  close(): void { this.discardedInput ||= this.queued.length > 0; this.closed = true; this.queued = []; this.pendingBytes = 0; }

  private fail(error: unknown): void {
    if (this.closed) return;
    const current = this.options.isCurrent();
    this.close();
    if (current) this.options.failed(error);
  }

  private pump(): void {
    if (this.closed || this.paused || this.inFlight || !this.queued.length) return;
    if (!this.options.isCurrent()) { this.close(); return; }
    const chunk = this.queued.shift()!;
    let sent: Promise<unknown>;
    try { sent = this.options.send(chunk.data, chunk.encoding); }
    catch (error) { this.fail(error); return; }
    this.inFlight = Promise.resolve(sent).then(
      () => { this.pendingBytes = Math.max(0, this.pendingBytes - chunk.bytes); },
      error => { this.fail(error); },
    ).then(() => { this.inFlight = undefined; this.pump(); });
  }
}
