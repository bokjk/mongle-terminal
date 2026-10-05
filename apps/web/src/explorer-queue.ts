import type { Transport } from '../../../packages/protocol/index';

export interface ExplorerClient extends Transport {
  request<T = any>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
}

const clients = new WeakMap<Transport, ExplorerClient>();

// Keep one shared two-read budget, including requests from an obsolete screen
// that are already on the wire. Only queued reads can be safely cancelled.
export function explorerClient(client: Transport): ExplorerClient {
  const existing = clients.get(client);
  if (existing) return existing;
  let active = 0;
  const waiting: Array<() => void> = [];
  const pump = () => { while (active < 2 && waiting.length) waiting.shift()!(); };
  const queued: ExplorerClient = {
    request: <T,>(method: string, params?: unknown, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(start);
        if (index !== -1) waiting.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('읽기 요청이 취소되었습니다.', 'AbortError'));
      };
      const start = () => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { abort(); return; }
        active++;
        void Promise.resolve().then(() => client.request<T>(method, params)).then(resolve, reject).finally(() => { active--; pump(); });
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      waiting.push(start); pump();
    }),
    subscribe: listener => client.subscribe(listener), close: () => client.close(),
  };
  // Reopening the panel must also respect reads still running from its last mount.
  clients.set(client, queued);
  // App and nested readers may both request a budget for the same client.
  // Wrapping a queue again would lose cancellation at the inner boundary.
  clients.set(queued, queued);
  return queued;
}
