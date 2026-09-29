import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, errorResult, requestSchema, type ConnectionContext, type HostEvent, type Send, type ServerMessage, type Transport } from '../protocol/index.ts';

const MAX_SERVER_FRAME = 16 * 1024 * 1024;
const MAX_CLIENT_FRAME = 128 * 1024;
const MAX_LINE = 23 * 1024 * 1024;
const MAX_WRITE_QUEUE = 32 * 1024 * 1024;
const STARTUP_TIMEOUT = 15_000;
const REQUEST_TIMEOUT = 30_000;
let helperPromise: Promise<string> | undefined;

/** Build only from the checked-in development source; packaged builds set MONGLE_OWNER_HELPER. */
export function ensureHelper(): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new AppError('UNSUPPORTED_PLATFORM', '현재 로컬 연결은 Windows에서 지원합니다.'));
  if (!helperPromise) helperPromise = resolveHelper().catch(error => { helperPromise = undefined; throw error; });
  return helperPromise;
}

async function resolveHelper(): Promise<string> {
  if (process.env.MONGLE_OWNER_HELPER) {
    const supplied = path.resolve(process.env.MONGLE_OWNER_HELPER);
    if (!existsSync(supplied)) throw new AppError('HELPER_MISSING', '로컬 연결 구성 요소를 찾을 수 없습니다.');
    return supplied;
  }
  const roots = [process.cwd(), path.resolve(path.dirname(process.argv[1] || process.cwd()), '../..')];
  const root = roots.find(candidate => existsSync(path.join(candidate, 'platform/windows/OwnerPipe.cs')));
  if (!root) throw new AppError('HELPER_MISSING', '로컬 연결 구성 요소를 찾을 수 없습니다.');
  const source = path.join(root, 'platform/windows/OwnerPipe.cs');
  const target = path.join(root, 'platform/windows/OwnerPipe.exe');
  const [sourceInfo, targetInfo] = await Promise.all([stat(source), stat(target).catch(() => null)]);
  if (targetInfo && targetInfo.mtimeMs >= sourceInfo.mtimeMs) return target;
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(compiler)) throw new AppError('COMPILER_MISSING', 'Windows .NET Framework C# 컴파일러가 필요합니다.');
  await mkdir(path.dirname(target), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll', `/out:${target}`, source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new AppError('HELPER_BUILD_FAILED', `로컬 연결 구성 요소 빌드 실패: ${output}`)));
  });
  return target;
}

type BridgeMessage = { kind: 'ready' | 'connected' | 'disconnected' | 'message' | 'fatal'; id?: string; data?: string; message?: string; pipeName?: string; pid?: number; sid?: string };
type Bridge = { child: ChildProcessWithoutNullStreams; ready: Promise<BridgeMessage>; send(kind: 'send' | 'close', id?: string, message?: unknown): void; close(): Promise<void>; };

async function launchBridge(mode: 'server' | 'client', dataDir: string, onMessage: (message: BridgeMessage) => void, onClose: (error: Error) => void): Promise<Bridge> {
  const helper = await ensureHelper();
  const child = spawn(helper, [mode, path.resolve(dataDir), ...(mode === 'server' ? [String(process.pid)] : [])], { windowsHide: true, stdio: 'pipe' });
  let settled = false;
  let closed = false;
  let partial: string[] = [];
  let partialLength = 0;
  let stderr = '';
  let readyResolve!: (message: BridgeMessage) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<BridgeMessage>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const finish = (error: Error) => {
    if (closed) return;
    closed = true;
    clearTimeout(startupTimer);
    if (!settled) { settled = true; readyReject(error); }
    onClose(error);
  };
  const startupTimer = setTimeout(() => { finish(new AppError('IPC_TIMEOUT', '로컬 연결 응답 시간이 초과되었습니다.')); child.kill(); }, STARTUP_TIMEOUT);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf('\n', offset);
      const part = chunk.slice(offset, end < 0 ? chunk.length : end);
      partial.push(part);
      partialLength += part.length;
      if (partialLength > MAX_LINE) { finish(new AppError('IPC_PROTOCOL', '로컬 연결 메시지가 너무 큽니다.')); child.kill(); return; }
      if (end < 0) return;
      const line = partial.join('').trimEnd();
      partial = [];
      partialLength = 0;
      offset = end + 1;
      if (!line) continue;
      try {
        const message = JSON.parse(line) as BridgeMessage;
        if (message.kind === 'ready') {
          if (settled) throw new Error('Duplicate bridge readiness');
          settled = true;
          clearTimeout(startupTimer);
          readyResolve(message);
        } else if (message.kind === 'fatal') {
          throw new Error(message.message || 'Owner bridge stopped');
        } else onMessage(message);
      } catch {
        finish(new AppError('IPC_PROTOCOL', '로컬 연결 구성 요소가 올바르지 않은 메시지를 보냈습니다.'));
        child.kill();
        return;
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.stdin.on('error', () => { finish(new AppError('IPC_CLOSED', '로컬 연결이 종료되었습니다.')); child.kill(); });
  child.once('error', error => { finish(error); child.kill(); });
  child.once('close', () => {
    const reported = /^OWNER_IPC_ERROR:([A-Z_]+):([^\r\n]*)/m.exec(stderr);
    finish(new AppError(reported?.[1] || 'IPC_CLOSED', reported?.[2] || stderr.trim() || '로컬 연결이 종료되었습니다.'));
  });
  return {
    child,
    ready,
    send(kind, id, message) {
      if (closed || child.stdin.destroyed) throw new AppError('IPC_CLOSED', '로컬 연결이 종료되었습니다.');
      const payload = message === undefined ? undefined : Buffer.from(JSON.stringify(message), 'utf8');
      if (payload && payload.length > (mode === 'server' ? MAX_SERVER_FRAME : MAX_CLIENT_FRAME)) throw new AppError('IPC_FRAME_TOO_LARGE', '로컬 연결 메시지가 너무 큽니다.');
      const line = JSON.stringify({ kind, id, data: payload?.toString('base64') }) + '\n';
      const budget = MAX_WRITE_QUEUE + (mode === 'server' && kind === 'close' ? 64 * 1024 : 0);
      if (child.stdin.writableLength + Buffer.byteLength(line) > budget) {
        // A slow owner view must not tear down the shared helper and its live terminal host.
        // The server dispatcher detaches that connection using the small reserved close budget.
        if (mode === 'server') throw new AppError('IPC_BACKPRESSURE', '로컬 연결의 출력 대기열이 가득 찼습니다.');
        finish(new AppError('IPC_BACKPRESSURE', '로컬 연결이 출력을 처리하지 못했습니다. 다시 연결하세요.'));
        child.kill();
        throw new AppError('IPC_BACKPRESSURE', '로컬 연결의 출력 대기열이 가득 찼습니다.');
      }
      child.stdin.write(line);
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill(), 1500);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (!child.stdin.destroyed) child.stdin.end('{"kind":"stop"}\n'); else child.kill();
      });
    },
  };
}

function decode(message: BridgeMessage, limit: number): unknown {
  if (typeof message.data !== 'string' || message.data.length > MAX_LINE) throw new AppError('INVALID_REQUEST', '올바르지 않은 로컬 요청입니다.');
  const payload = Buffer.from(message.data, 'base64');
  if (payload.length > limit) throw new AppError('IPC_FRAME_TOO_LARGE', '로컬 연결 메시지가 너무 큽니다.');
  return JSON.parse(payload.toString('utf8'));
}

export interface OwnerPipeOptions {
  dataDir: string;
  onConnect(context: ConnectionContext, send: Send): void;
  onRequest(method: string, params: unknown, context: ConnectionContext): unknown | Promise<unknown>;
  onDisconnect(connectionId: string): void;
  onError?: (error: Error) => void;
}

/** Owner RPC is available only over the SID-restricted native named pipe. */
export async function startOwnerPipe(options: OwnerPipeOptions): Promise<{ pipeName: string; helperPid: number; close(): Promise<void> }> {
  const contexts = new Map<string, ConnectionContext>();
  const outstanding = new Map<string, number>();
  let intentionalClose = false;
  let bridge!: Bridge;
  const disconnect = (id: string) => {
    if (contexts.delete(id)) { outstanding.delete(id); options.onDisconnect(id); }
  };
  const sendTo = (id: string, message: ServerMessage) => {
    if (!contexts.has(id)) return;
    try { bridge.send('send', id, message); }
    catch { disconnect(id); try { bridge.send('close', id); } catch {} }
  };
  bridge = await launchBridge('server', options.dataDir, message => {
    if (!message.id) return;
    const id = message.id;
    if (message.kind === 'connected') {
      const context: ConnectionContext = { id, deviceId: 'local-owner', deviceName: '현재 컴퓨터', owner: true };
      contexts.set(id, context);
      try { options.onConnect(context, data => sendTo(id, data)); }
      catch { disconnect(id); bridge.send('close', id); }
    } else if (message.kind === 'disconnected') disconnect(id);
    else if (message.kind === 'message') {
      const context = contexts.get(id);
      if (!context) return;
      let request: ReturnType<typeof requestSchema.parse>;
      try { request = requestSchema.parse(decode(message, MAX_CLIENT_FRAME)); }
      catch { bridge.send('close', id); return; }
      if ((outstanding.get(id) || 0) >= 64) { bridge.send('close', id); return; }
      outstanding.set(id, (outstanding.get(id) || 0) + 1);
      Promise.resolve().then(() => options.onRequest(request.method, request.params, context)).then(result => {
        if (contexts.has(id)) sendTo(id, { type: 'response', id: request.id, ok: true, result });
      }, error => {
        if (contexts.has(id)) sendTo(id, { type: 'response', id: request.id, ok: false, error: errorResult(error) });
      }).catch(() => { disconnect(id); try { bridge.send('close', id); } catch {} }).finally(() => {
        if (contexts.has(id)) outstanding.set(id, Math.max(0, (outstanding.get(id) || 1) - 1));
      });
    }
  }, error => {
    for (const id of contexts.keys()) disconnect(id);
    if (!intentionalClose) options.onError?.(error);
  });
  const ready = await bridge.ready;
  return { pipeName: ready.pipeName!, helperPid: ready.pid!, async close() { intentionalClose = true; await bridge.close(); } };
}

export interface OwnerConnectionOptions { dataDir: string; onEvent?: (message: HostEvent) => void; onClose?: (error: Error) => void; }

/** Only the Electron main process uses this transport. Never import it from a renderer. */
export async function connectOwnerPipe(options: OwnerConnectionOptions): Promise<Transport & { connectionId: string }> {
  const listeners = new Set<(message: HostEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let closed = false;
  let intentionalClose = false;
  const bridge = await launchBridge('client', options.dataDir, message => {
    if (message.kind !== 'message') return;
    const data = decode(message, MAX_SERVER_FRAME) as ServerMessage;
    if (data.type === 'response') {
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new AppError(data.error.code, data.error.message));
    } else {
      for (const listener of listeners) { try { listener(data); } catch { /* A UI subscriber cannot kill the transport. */ } }
    }
  }, error => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    if (!intentionalClose) options.onClose?.(error);
  });
  const ready = await bridge.ready;
  if (!ready.id) { await bridge.close(); throw new AppError('IPC_PROTOCOL', '로컬 연결 ID가 없습니다.'); }
  return {
    connectionId: ready.id,
    request<T>(method: string, params: unknown = {}): Promise<T> {
      if (closed) return Promise.reject(new AppError('IPC_CLOSED', '로컬 연결이 종료되었습니다.'));
      if (pending.size >= 64) return Promise.reject(new AppError('IPC_BUSY', '처리 중인 요청이 너무 많습니다.'));
      const id = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new AppError('IPC_TIMEOUT', '로컬 요청 응답 시간이 초과되었습니다.')); }, REQUEST_TIMEOUT);
        pending.set(id, { resolve, reject, timer });
        try { bridge.send('send', undefined, { type: 'request', id, method, params }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { intentionalClose = true; void bridge.close(); },
  };
}
