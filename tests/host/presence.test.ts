import test from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_IDLE_MS, interpretPresence, readPcPresence, runPresenceHelper } from '../../packages/host/presence.ts';

test('a lock, another session or five minutes without input count as away', () => {
  assert.deepEqual(interpretPresence({ idleMs: 1000, session: 'active', locked: false }), { away: false, reason: 'active', idleMs: 1000 });
  assert.deepEqual(interpretPresence({ idleMs: 1000, session: 'active', locked: true }), { away: true, reason: 'locked', idleMs: 1000 });
  assert.deepEqual(interpretPresence({ idleMs: AWAY_IDLE_MS, session: 'active', locked: false }), { away: true, reason: 'idle', idleMs: AWAY_IDLE_MS });
  assert.deepEqual(interpretPresence({ idleMs: AWAY_IDLE_MS - 1, session: 'unknown', locked: null }), { away: false, reason: 'active', idleMs: AWAY_IDLE_MS - 1 }, 'input time alone decides when the lock state is unknown');
  assert.equal(interpretPresence({ idleMs: 10, session: 'other', locked: false }).reason, 'other-session');
  assert.deepEqual(interpretPresence({ idleMs: -1, session: 'unknown', locked: null }), { away: true, reason: 'unknown' });
  assert.deepEqual(interpretPresence({ idleMs: 'soon' }), { away: true, reason: 'unknown' });
});

test('a failed presence query lets a waiting request reach the phone', async () => {
  assert.deepEqual(await readPcPresence(async () => { throw new Error('helper missing'); }), { away: true, reason: 'unknown' });
});

test('the Windows helper reports only the lock state and the time since input', { skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 60_000 }, async () => {
  const value = await runPresenceHelper();
  assert.deepEqual(Object.keys(value).sort(), ['idleMs', 'kind', 'locked', 'session']);
  assert.ok(typeof value.idleMs === 'number' && value.idleMs >= -1);
  assert.ok(['active', 'other', 'unknown'].includes(value.session as string));
  assert.ok(([true, false, null] as unknown[]).includes(value.locked));
  assert.ok(['locked', 'idle', 'other-session', 'active', 'unknown'].includes(interpretPresence(value).reason));
});
