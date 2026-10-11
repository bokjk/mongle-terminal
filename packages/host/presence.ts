import { execFile } from 'node:child_process';
import { ensureHelper } from '../local-ipc/index.ts';

/** Whether anyone is at this PC, from the Windows lock state and the time since the last keyboard or mouse input. */
export interface PcPresence { away: boolean; reason: 'locked' | 'idle' | 'other-session' | 'active' | 'unknown'; idleMs?: number }
/** No input for this long counts as being away from the PC. */
export const AWAY_IDLE_MS = 5 * 60_000;

export interface PresenceProbe { idleMs?: unknown; session?: unknown; locked?: unknown }

export function interpretPresence(value: PresenceProbe): PcPresence {
  const idleMs = typeof value.idleMs === 'number' && Number.isFinite(value.idleMs) && value.idleMs >= 0 ? value.idleMs : undefined;
  // Another session has the console (a switched user or a disconnected remote session).
  if (value.session === 'other') return { away: true, reason: 'other-session', ...(idleMs !== undefined ? { idleMs } : {}) };
  if (value.locked === true) return { away: true, reason: 'locked', ...(idleMs !== undefined ? { idleMs } : {}) };
  if (idleMs !== undefined) return idleMs >= AWAY_IDLE_MS ? { away: true, reason: 'idle', idleMs } : { away: false, reason: 'active', idleMs };
  // Nothing shows that someone is here, so a waiting request still reaches the phone.
  return { away: true, reason: 'unknown' };
}

/** Runs the local helper's read-only presence query (platform/windows/OwnerPipe.cs). */
export async function runPresenceHelper(): Promise<PresenceProbe> {
  const helper = await ensureHelper();
  return new Promise((resolve, reject) => {
    execFile(helper, ['presence'], { windowsHide: true, timeout: 5_000, maxBuffer: 4_096 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try {
        const value = JSON.parse(String(stdout));
        if (!value || value.kind !== 'presence') throw new Error('Unexpected presence reply');
        resolve(value);
      } catch (failure) { reject(failure); }
    });
  });
}

export async function readPcPresence(run: () => Promise<PresenceProbe> = runPresenceHelper): Promise<PcPresence> {
  try { return interpretPresence(await run()); } catch { return { away: true, reason: 'unknown' }; }
}
