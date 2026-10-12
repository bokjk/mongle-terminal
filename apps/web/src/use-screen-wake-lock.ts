import { useEffect, useState } from 'react';

type WakeLockSentinelLike = { release(): Promise<void> };
type WakeLockSource = { request(type: 'screen'): Promise<WakeLockSentinelLike> };

/** The Screen Wake Lock API needs a secure page (HTTPS or localhost) and a browser that has it. */
export function screenWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof window !== 'undefined' && window.isSecureContext;
}

/**
 * Holds the screen awake once. A request can resolve after it was cancelled (the page hid, the
 * setting was turned off); that late lock is released at once. Refusals (battery saver, policy) are quiet.
 */
export function holdScreenAwake(source: WakeLockSource): () => void {
  let cancelled = false;
  let lock: WakeLockSentinelLike | undefined;
  void source.request('screen').then(granted => {
    if (cancelled) void granted.release().catch(() => {});
    else lock = granted;
  }).catch(() => {});
  return () => { cancelled = true; if (lock) void lock.release().catch(() => {}); lock = undefined; };
}

/**
 * Keeps the screen on while active and the page is visible. The browser drops the lock when the
 * page hides, and the system may drop it (battery saver); it is asked again the next time the page shows.
 */
export function useScreenWakeLock(active: boolean) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!active || !visible || !screenWakeLockSupported()) return;
    return holdScreenAwake((navigator as unknown as { wakeLock: WakeLockSource }).wakeLock);
  }, [active, visible]);
}

