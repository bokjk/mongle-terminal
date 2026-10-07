import { useSyncExternalStore } from 'react';
import type { UpdateState } from '../../../packages/client/index';

export interface UpdateSnapshot {
  /** False for browsers and older desktop bridges without update IPC. */
  supported: boolean;
  state: UpdateState | null;
  error: string;
  busy: boolean;
}

type Bridge = NonNullable<Window['mongle']>;
const unsupported: UpdateSnapshot = { supported: false, state: null, error: '', busy: false };

function message(failure: unknown, fallback: string) { return failure instanceof Error ? failure.message : fallback; }

/** One app-wide subscription shared by the sidebar notice and settings. */
export class UpdateStore {
  private snapshot: UpdateSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private started = false;
  private eventVersion = 0;
  private generation = 0;
  private operation = false;

  constructor(private readonly bridge: Bridge | undefined) {
    const supported = !!(bridge?.getUpdateState && bridge.checkForUpdates && bridge.installUpdate && bridge.onUpdate);
    this.snapshot = supported ? { supported, state: null, error: '', busy: false } : unsupported;
  }

  getSnapshot = (): UpdateSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); };
  };

  private patch(changes: Partial<UpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }

  private start() {
    if (this.started || !this.snapshot.supported) return;
    this.started = true;
    const bridge = this.bridge!;
    const generation = this.generation;
    const live = () => generation === this.generation;
    // Subscribe first. A slower IPC response must not replace a newer event.
    this.unsubscribe = bridge.onUpdate!(value => { if (!live()) return; this.eventVersion += 1; this.patch({ state: value, error: '' }); });
    const version = this.eventVersion;
    void bridge.getUpdateState!().then(value => {
      if (live() && this.eventVersion === version) this.patch({ state: value });
    }).catch(failure => {
      if (live() && this.eventVersion === version) this.patch({ error: message(failure, '업데이트 상태를 확인하지 못했습니다.') });
    });
  }

  /** Releases the bridge subscription and ignores every pending response from it. */
  dispose() { this.generation += 1; this.unsubscribe?.(); this.unsubscribe = undefined; this.started = false; }

  check(): Promise<void> { return this.run(false); }
  install(): Promise<void> { return this.run(true); }

  private async run(install: boolean) {
    if (!this.snapshot.supported || this.operation) return;
    this.operation = true;
    this.patch({ busy: true, error: '' });
    const bridge = this.bridge!;
    const version = this.eventVersion;
    const generation = this.generation;
    const live = () => generation === this.generation;
    try {
      let next: UpdateState;
      if (install) {
        await bridge.installUpdate!();
        // A cancelled native confirmation leaves the downloaded update ready.
        next = await bridge.getUpdateState!();
      } else next = await bridge.checkForUpdates!();
      if (live() && this.eventVersion === version) this.patch({ state: next });
    } catch (failure) {
      if (live()) this.patch({ error: message(failure, '업데이트를 완료하지 못했습니다.') });
    } finally {
      this.operation = false;
      if (live()) this.patch({ busy: false });
    }
  }
}

let shared: UpdateStore | undefined;
let sharedBridge: Bridge | undefined;
export function updateStore(): UpdateStore {
  const bridge = typeof window === 'undefined' ? undefined : window.mongle;
  if (!shared || sharedBridge !== bridge) { shared?.dispose(); shared = new UpdateStore(bridge); sharedBridge = bridge; }
  return shared;
}

export function useAppUpdate(): UpdateSnapshot & { store: UpdateStore } {
  const store = updateStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, store };
}

/** Visible, non-percentage step text for the install lifecycle. */
export const INSTALL_STEPS: Array<{ phase: NonNullable<UpdateState['phase']>; label: string }> = [
  { phase: 'confirming', label: '설치 확인' },
  { phase: 'saving', label: '작업 저장·종료' },
  { phase: 'launching', label: '설치 프로그램 실행' },
];
