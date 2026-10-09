import test from 'node:test';
import assert from 'node:assert/strict';
import { hostClockOffset } from '../../apps/web/src/host-clock';

test('the host clock offset corrects a fast phone clock without trusting slow or uneven replies', () => {
  const sentAt = 1_000_000;
  // The host runs four minutes behind the phone, and a quick reply measures it.
  assert.equal(hostClockOffset(sentAt - 240_000 + 100, sentAt, sentAt + 200, 0), -240_000);
  // Small jitter keeps the current value so the countdown does not skip seconds.
  assert.equal(hostClockOffset(sentAt + 500, sentAt, sentAt + 200, 0), 0);
  // A six-second request whose reply arrives at once looks three seconds ahead. It cannot replace an accurate value.
  assert.equal(hostClockOffset(sentAt + 6_000, sentAt, sentAt + 6_000, 0), 0);
  // A large skew measured on a slow reply is still corrected, and a later quick reply refines it.
  const slow = hostClockOffset(sentAt - 240_000 + 6_000, sentAt, sentAt + 6_000, 0);
  assert.equal(slow, -237_000);
  assert.equal(hostClockOffset(sentAt - 240_000 + 100, sentAt, sentAt + 200, slow), -240_000);
  // Older hosts send no time, and invalid values never move the clock.
  for (const value of [undefined, null, '1000', Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(hostClockOffset(value, sentAt, sentAt + 200, -240_000), -240_000);
});
