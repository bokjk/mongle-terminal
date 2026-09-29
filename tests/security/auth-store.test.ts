import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { AuthStore } from '../../packages/auth/store.ts';

const origin = 'https://mongle.example-tailnet.ts.net';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mongle-auth-'));
  const path = join(root, 'auth.sqlite');
  let clock = Date.now();
  let store = new AuthStore(path, () => clock);
  return {
    get store() { return store; },
    setTime(value: number) { clock = value; },
    pair() {
      const code = store.createCode();
      const request = store.requestPairing(code.code, 'Phone', origin);
      store.decidePairing(request.requestId, true);
      return store.claimPairing(request.requestId, request.requesterSecret, origin);
    },
    reopen() { store.close(); store = new AuthStore(path, () => clock); },
    close() {
      store.close();
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith('mongle-auth-'));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('pairing expiry is enforced even after local approval', () => {
  const f = fixture();
  try {
    const code = f.store.createCode();
    const request = f.store.requestPairing(code.code, 'Phone', origin);
    f.store.decidePairing(request.requestId, true);
    f.setTime(request.expiresAt);
    assert.equal(f.store.pairingStatus(request.requestId, request.requesterSecret, origin).status, 'expired');
    assert.throws(() => f.store.claimPairing(request.requestId, request.requesterSecret, origin));
    assert.equal(f.store.listDevices().length, 0);
  } finally { f.close(); }
});

test('authenticated sessions survive reopening, enforce expiry, and keep revocation durable', () => {
  const f = fixture();
  try {
    const auth = f.pair();
    f.reopen();
    assert.equal(f.store.authenticate(auth.token, origin)?.deviceId, auth.session.deviceId);
    assert.equal(f.store.authenticate(auth.token, 'https://another.example-tailnet.ts.net'), undefined);
    f.store.revoke(auth.session.deviceId);
    f.reopen();
    assert.equal(f.store.authenticate(auth.token, origin), undefined);
    assert.equal(f.store.isActive(auth.session.deviceId, origin), false);
    const later = f.pair();
    f.setTime(later.session.expiresAt);
    assert.equal(f.store.authenticate(later.token, origin), undefined);
    assert.equal(f.store.isActive(later.session.deviceId, origin), false);
  } finally { f.close(); }
});

test('pairing secrets and generated codes cannot be reused or claimed from a different origin', () => {
  const f = fixture();
  try {
    const code = f.store.createCode();
    const request = f.store.requestPairing(code.code, 'Phone', origin);
    assert.throws(() => f.store.requestPairing(code.code, 'Second device', origin));
    f.store.decidePairing(request.requestId, true);
    assert.throws(() => f.store.claimPairing(request.requestId, request.requesterSecret, 'https://different.ts.net'));
    assert.throws(() => f.store.claimPairing(request.requestId, 'wrong-requester-secret', origin));
    const session = f.store.claimPairing(request.requestId, request.requesterSecret, origin);
    assert.ok(f.store.authenticate(session.token, origin));
    assert.throws(() => f.store.claimPairing(request.requestId, request.requesterSecret, origin));
    assert.equal(f.store.listDevices().length, 1);
  } finally { f.close(); }
});

test('guessing attempts are retained after rejected requests and a replacement code restores pairing', () => {
  const f = fixture();
  try {
    const code = f.store.createCode();
    for (let index = 0; index < 5; index++) {
      assert.throws(() => f.store.requestPairing(`WRONGCODE${index}`, 'Intruder', origin));
    }
    f.reopen();
    assert.throws(() => f.store.requestPairing(code.code, 'Phone', origin), 'failed guesses must not roll back their limit counters');
    const replacement = f.store.createCode();
    assert.throws(() => f.store.requestPairing(code.code, 'Phone', origin));
    const request = f.store.requestPairing(replacement.code, 'Phone', origin);
    assert.equal(f.store.pairingStatus(request.requestId, request.requesterSecret, origin).status, 'pending');
  } finally { f.close(); }
});

test('changing or disabling the remote origin revokes old sessions and pending approvals durably', () => {
  const f = fixture();
  try {
    f.store.setOrigin(origin);
    const auth = f.pair();
    const code = f.store.createCode();
    const request = f.store.requestPairing(code.code, 'Second device', origin);
    f.store.decidePairing(request.requestId, true);
    f.store.setOrigin('https://new-host.example-tailnet.ts.net');
    f.reopen();
    assert.equal(f.store.authenticate(auth.token, origin), undefined);
    assert.equal(f.store.pairingStatus(request.requestId, request.requesterSecret, origin).status, 'rejected');
    assert.throws(() => f.store.claimPairing(request.requestId, request.requesterSecret, origin));
    f.store.setOrigin(undefined);
    f.reopen();
    assert.equal(f.store.getOrigin(), undefined);
  } finally { f.close(); }
});
