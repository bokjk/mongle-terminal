import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostState } from '../../../packages/protocol/index';

type Receipt = { generation: string; count: number };
type Receipts = Record<string, Receipt>;
export type PresentedNotification = { hostId: string; bootId: string; terminalId: string; generation: string; count: number };
const key = (hostId: string) => `mongle.notifications.read.${hostId}`;
const scope = (value: PresentedNotification) => `${value.hostId}:${value.bootId}:${value.terminalId}:${value.generation}`;
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function load(hostId: string): Receipts {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(hostId)) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 512).filter(([, receipt]) => receipt && typeof receipt.generation === 'string' && validCount(receipt.count)));
  } catch { return {}; }
}

/** Read only the selected, visible presentation; a state update is not proof that it was displayed. */
export function useTerminalNotifications(state: HostState | undefined, activeId: string, canView: boolean) {
  const [saved, setSaved] = useState<{ hostId: string; receipts: Receipts }>();
  const [viewRevision, refreshView] = useState(0);
  const presented = useRef(new Map<string, number>());
  const terminal = state?.terminals.find(item => item.id === activeId);
  const count = terminal?.notificationCount;
  const activeScope = state && terminal ? scope({hostId: state.hostId, bootId: state.bootId, terminalId: terminal.id, generation: terminal.generation, count: 0}) : '';
  useEffect(() => {
    if (!state) return;
    const hostId = state.hostId;
    const reload = () => setSaved({hostId, receipts: load(hostId)});
    const changed = (event: StorageEvent) => { if (event.key === key(hostId) || event.key === null) reload(); };
    reload(); window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [state?.hostId]);
  useEffect(() => {
    const changed = () => refreshView(value => value + 1);
    window.addEventListener('focus', changed); window.addEventListener('blur', changed);
    document.addEventListener('visibilitychange', changed); document.addEventListener('focusin', changed);
    return () => {
      window.removeEventListener('focus', changed); window.removeEventListener('blur', changed);
      document.removeEventListener('visibilitychange', changed); document.removeEventListener('focusin', changed);
    };
  }, []);
  const onPresented = useCallback((value: PresentedNotification) => {
    if (!validCount(value.count)) return;
    const id = scope(value);
    // Pane remount/reconnect starts with an empty renderer even in the same
    // host boot and process generation. Keep durable receipts, not old pixels.
    if (value.count === 0) {
      if (presented.current.delete(id)) refreshView(revision => revision + 1);
      return;
    }
    if ((presented.current.get(id) || 0) >= value.count) return;
    presented.current.set(id, value.count);
    if (presented.current.size > 512) presented.current.delete(presented.current.keys().next().value!);
    refreshView(revision => revision + 1);
  }, []);
  useEffect(() => {
    if (!state || !terminal || !canView || saved?.hostId !== state.hostId || !validCount(count) || !count) return;
    const previous = saved.receipts[terminal.id];
    const readCount = Math.min(count, presented.current.get(activeScope) || 0);
    if (!readCount || (previous?.generation === terminal.generation && previous.count >= readCount)) return;
    const visible = () => document.visibilityState === 'visible' && document.hasFocus()
      && !document.querySelector('[role="dialog"], [role="alertdialog"]')
      && !(document.activeElement instanceof Element && document.activeElement.closest('.file-workspace'))
      && Boolean(document.getElementById(`terminal-panel-${terminal.id}`)?.getClientRects().length);
    if (!visible()) return;
    const timer = setTimeout(() => {
      if (!visible()) return;
      // Merge another window's receipts before saving, and prune removed/restarted sessions.
      const stored = load(state.hostId);
      const next: Receipts = {};
      for (const info of state.terminals) {
        const receipts = [saved.receipts[info.id], stored[info.id]].filter(item => item?.generation === info.generation);
        const read = Math.max(0, ...receipts.map(item => item.count), info.id === terminal.id ? readCount : 0);
        if (read) next[info.id] = {generation: info.generation, count: read};
      }
      try { localStorage.setItem(key(state.hostId), JSON.stringify(next)); } catch { /* Keep this window's receipts when storage is unavailable. */ }
      setSaved({hostId: state.hostId, receipts: next});
    }, 750);
    return () => clearTimeout(timer);
  }, [state?.hostId, state?.bootId, activeScope, count, canView, saved, viewRevision]);
  const unread = new Set<string>();
  if (state) for (const info of state.terminals) {
    const receipt = saved?.hostId === state.hostId ? saved.receipts[info.id] : undefined;
    if (validCount(info.notificationCount) && info.notificationCount > 0
      && (receipt?.generation !== info.generation || receipt.count < info.notificationCount)) unread.add(info.id);
  }
  return {unread, onPresented};
}
