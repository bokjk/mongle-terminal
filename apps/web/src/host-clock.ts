/**
 * Pairing expiry times come from the host clock. A device whose clock runs fast would otherwise hide a valid code
 * or request, so the settings screen keeps the host-minus-device offset measured from replies.
 */
export function hostClockOffset(serverTime: unknown, sentAt: number, receivedAt: number, previous: number) {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return previous;
  const offset = serverTime - (sentAt + receivedAt) / 2;
  // Uneven network delay can shift the estimate by up to half the round trip, so only a larger change replaces the
  // current value. Changes under a second are ignored so the countdown does not skip.
  return Math.abs(offset - previous) > Math.max(1000, receivedAt - sentAt) ? offset : previous;
}
