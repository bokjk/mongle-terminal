import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, PROTOCOL_VERSION, type HostState, type Transport } from '../../packages/protocol/index';

export interface HostReadiness { pid: number; hostId: string; bootId: string; }
export interface FullExitSummary { runningTerminals: number; recordHistory: boolean; }
export interface FullExitDependencies {
  // This factory must always attach to the fixed, local data directory. A selected
  // renderer/remote transport is deliberately not accepted by this controller.
  connectLocal(onClose: () => void): Promise<Transport>;
  readReadiness(): Promise<HostReadiness | undefined>;
  isProcessAlive(pid: number): boolean;
  confirm(summary: FullExitSummary): Promise<boolean>;
  suspendDesktop(): Promise<void>;
  keepDesktop(): void;
  writeResumeManifest?(state: HostState): Promise<void>;
  quitDesktop(): void;
  showError(message: string): void;
  timeoutMs?: number;
  pollMs?: number;
}

export async function readHostReadiness(dataDir: string): Promise<HostReadiness | undefined> {
  let source: string;
  try { source = await readFile(path.join(dataDir, 'host-info.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let value: HostReadiness;
  try { value = JSON.parse(source); }
  catch { throw new AppError('HOST_STATE_INVALID', '현재 컴퓨터의 실행 상태 파일을 읽지 못했습니다.'); }
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.hostId !== 'string' || !value.hostId || typeof value.bootId !== 'string' || !value.bootId)
    throw new AppError('HOST_STATE_INVALID', '현재 컴퓨터의 실행 상태 파일이 올바르지 않습니다.');
  return value;
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

const missingHost = (error: unknown) => ['NO_HOST', 'PIPE_NOT_FOUND', 'ENOENT', 'ECONNREFUSED', 'HOST_UNAVAILABLE'].includes((error as { code?: string })?.code || '');
const sameHost = (a: HostReadiness, b: Pick<HostState, 'hostId' | 'bootId'>) => a.hostId === b.hostId && a.bootId === b.bootId;

/** One shutdown transaction, with the dialog as its only commit point. */
export class FullExitController {
  private pending: Promise<void> | undefined;
  constructor(private readonly dependencies: FullExitDependencies) {}

  run(action: Partial<Pick<FullExitDependencies, 'confirm' | 'quitDesktop' | 'showError'>> = {}): Promise<void> {
    if (!this.pending) {
      this.pending = this.perform(action).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  private async perform(action: Partial<Pick<FullExitDependencies, 'confirm' | 'quitDesktop' | 'showError'>>): Promise<void> {
    const d = { ...this.dependencies, ...action };
    const budget = Math.min(d.timeoutMs ?? 55_000, 55_000);
    let deadline = Date.now() + budget;
    let owner: Transport | undefined;
    let closed = false;
    let finished = false;
    let suspended = false;
    const within = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        void work.catch(() => {});
        throw new AppError('SHUTDOWN_TIMEOUT', '백그라운드 실행이 끝났는지 확인하는 시간이 초과되었습니다.');
      }
      try {
        return await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AppError('SHUTDOWN_TIMEOUT', '백그라운드 실행이 끝났는지 확인하는 시간이 초과되었습니다.')), remaining);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const attach = () => within(d.connectLocal(() => { closed = true; }).then(value => {
      if (finished) value.close();
      return value;
    }));
    const absent = async () => {
      const info = await within(d.readReadiness());
      if (info && d.isProcessAlive(info.pid)) throw new AppError('HOST_UNREACHABLE', '현재 컴퓨터의 백그라운드 실행이 남아 있지만 안전한 종료 연결을 만들지 못했습니다.');
    };
    try {
      try { owner = await attach(); }
      catch (error) { if (!missingHost(error)) throw error; await absent(); }
      const state = owner ? await within(owner.request<HostState>('state.get')) : undefined;
      if (state && state.protocolVersion !== PROTOCOL_VERSION) throw new AppError('VERSION_MISMATCH', '현재 컴퓨터의 호스트와 앱 버전이 다릅니다. 실행 중인 호스트와 같은 버전의 앱에서 종료하세요.');
      const initial = owner ? await within(d.readReadiness()) : undefined;
      if (state && (!initial || !sameHost(initial, state))) throw new AppError('HOST_CHANGED', '현재 컴퓨터의 실행 상태가 바뀌었습니다. 완전 종료를 다시 시도하세요.');
      const accepted = await d.confirm({ runningTerminals: state?.terminals.filter(terminal => terminal.status === 'running').length ?? 0, recordHistory: state?.settings.recordHistory ?? false });
      if (!accepted) return;

      // User time in the confirmation dialog does not consume the shutdown wait.
      deadline = Date.now() + budget;
      suspended = true;
      await within(d.suspendDesktop());
      if (!owner) {
        // Drain any older desktop launch before checking absence again. Never
        // launch a host here, and never quit over a newly started live host.
        try { owner = await attach(); }
        catch (error) { if (!missingHost(error)) throw error; await absent(); d.quitDesktop(); return; }
        throw new AppError('HOST_CHANGED', '확인하는 동안 백그라운드 실행이 시작됐습니다. 작업 수를 확인하도록 완전 종료를 다시 시도하세요.');
      }
      const current = await within(owner.request<HostState>('state.get'));
      const readiness = await within(d.readReadiness());
      if (closed || !initial || !readiness || readiness.pid !== initial.pid || !sameHost(readiness, state!) || current.hostId !== state!.hostId || current.bootId !== state!.bootId)
        throw new AppError('HOST_CHANGED', '현재 컴퓨터의 실행 상태가 바뀌었습니다. 완전 종료를 다시 시도하세요.');

      try { await within(owner.request('host.shutdown')); }
      catch (error) {
        // A host may close its pipe before its acknowledgement is delivered.
        // Only an IPC close can be reconciled against actual process completion;
        // storage, authentication, and other RPC failures remain failures.
        if (!closed || !['IPC_CLOSED', 'OFFLINE'].includes((error as { code?: string }).code || '')) throw error;
      }
      while (true) {
        const info = await within(d.readReadiness());
        if (info && (!sameHost(info, initial) || info.pid !== initial.pid)) throw new AppError('HOST_CHANGED', '종료하는 동안 다른 백그라운드 실행이 시작됐습니다. 앱을 유지합니다.');
        if (closed && !d.isProcessAlive(initial.pid) && !info) break;
        await within(new Promise(resolve => setTimeout(resolve, d.pollMs ?? 100)));
      }
      // Legacy hosts do not persist restart intent. Record only the identities
      // observed over this authenticated connection, after the old host is gone.
      if (d.writeResumeManifest) {
        try { await within(d.writeResumeManifest(current)); }
        catch { throw new AppError('RESTORE_SAVE_FAILED', '백그라운드 작업은 종료됐지만 다음 실행 복원 정보를 저장하지 못했습니다. 그룹과 보관된 출력은 기존 저장소에 남아 있습니다.'); }
      }
      d.quitDesktop();
    } catch (error) {
      if (suspended) d.keepDesktop();
      const message = error instanceof Error ? error.message : '안전한 완전 종료를 완료하지 못했습니다.';
      d.showError(`${message}\n\n앱은 종료하지 않았습니다. 현재 컴퓨터의 상태를 확인한 뒤 ‘다시 연결’하거나 완전 종료를 다시 시도하세요.`);
    } finally { finished = true; owner?.close(); }
  }
}
