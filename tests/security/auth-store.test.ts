import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('each issuer keeps its own pairing code while failed guesses still lock every live code', () => {
  const f = fixture();
  try {
    const pc = f.store.createCode();
    const phone = f.store.createCode('device:phone');
    const laptop = f.store.createCode('device:laptop');
    const replacement = f.store.createCode('device:phone');
    const fromPc = f.store.requestPairing(pc.code, 'Office PC', origin);
    assert.equal(f.store.pairingStatus(fromPc.requestId, fromPc.requesterSecret, origin).status, 'pending', 'Codes made on paired devices leave the PC code valid');
    assert.throws(() => f.store.requestPairing(phone.code, 'Tablet', origin), /연결 코드가 잘못되었거나 만료되었습니다/, "A new code replaces only the same issuer's previous code");
    for (let index = 1; index < 5; index++) assert.throws(() => f.store.requestPairing(`WRONGCODE${index}`, 'Intruder', origin));
    f.reopen();
    assert.throws(() => f.store.requestPairing(laptop.code, 'Laptop', origin), 'Five failed guesses lock the codes of every issuer');
    assert.throws(() => f.store.requestPairing(replacement.code, 'Phone', origin));
    const request = f.store.requestPairing(f.store.createCode('device:phone').code, 'Phone', origin);
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

test('a paired device decides only requests made through its own address and is recorded as the approver', () => {
  const f = fixture();
  try {
    const phone = f.pair();
    const loopback = 'http://127.0.0.1:43123';
    const local = f.store.requestPairing(f.store.createCode().code, 'Local browser', loopback);
    const pendingNames = (items: { name: string; status: string }[]) => items.filter(item => item.status === 'pending').map(item => item.name);
    assert.deepEqual(pendingNames(f.store.listPairings(origin)), []);
    assert.deepEqual(pendingNames(f.store.listPairings(loopback)), ['Local browser']);
    assert.deepEqual(pendingNames(f.store.listPairings()), ['Local browser'], 'The PC still sees every request');
    const approver = { name: phone.session.name, origin };
    assert.throws(() => f.store.decidePairing(local.requestId, true, approver), /승인할 수 있는 연결 요청이 없습니다/);
    assert.equal(f.store.pairingStatus(local.requestId, local.requesterSecret, loopback).status, 'pending');

    const remote = f.store.requestPairing(f.store.createCode().code, 'Home PC', origin);
    f.store.decidePairing(remote.requestId, true, approver);
    const home = f.store.claimPairing(remote.requestId, remote.requesterSecret, origin);
    f.reopen();
    const devices = f.store.listDevices();
    assert.equal(devices.find(device => device.deviceId === home.session.deviceId)?.approvedBy, 'Phone');
    assert.equal(devices.find(device => device.deviceId === phone.session.deviceId)?.approvedBy, undefined);

    const unknown = f.store.requestPairing(f.store.createCode().code, 'Unknown', origin);
    f.store.decidePairing(unknown.requestId, false, approver);
    assert.equal(f.store.pairingStatus(unknown.requestId, unknown.requesterSecret, origin).status, 'rejected');
    assert.throws(() => f.store.claimPairing(unknown.requestId, unknown.requesterSecret, origin));
  } finally { f.close(); }
});

test('an authentication store from an earlier version keeps its devices and gains the approver and code issuer columns', () => {
  const root = mkdtempSync(join(tmpdir(), 'mongle-auth-'));
  const path = join(root, 'auth.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE pairings (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0);
    `);
    legacy.prepare('INSERT INTO sessions(id,token_hash,csrf,name,origin,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), 'a'.repeat(64), 'csrf', 'Old phone', origin, Date.now(), Date.now() + 60_000);
    legacy.prepare('INSERT INTO codes(hash,expires_at) VALUES(?,?)').run(createHash('sha256').update('LEGACY2345').digest('hex'), Date.now() + 60_000);
    legacy.close();
    const store = new AuthStore(path);
    try {
      assert.deepEqual(store.listDevices().map(device => [device.name, device.approvedBy, device.revoked]), [['Old phone', undefined, false]]);
      store.createCode('device:old-phone');
      const tablet = store.requestPairing('LEGACY2345', 'Tablet', origin);
      assert.equal(store.pairingStatus(tablet.requestId, tablet.requesterSecret, origin).status, 'pending', 'A code left by the earlier PC host survives a code made on a paired device');
      const request = store.requestPairing(store.createCode().code, 'New PC', origin);
      store.decidePairing(request.requestId, true, { name: 'Old phone', origin });
      store.claimPairing(request.requestId, request.requesterSecret, origin);
      assert.equal(store.listDevices().find(device => device.name === 'New PC')?.approvedBy, 'Old phone');
    } finally { store.close(); }
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('mongle-auth-'));
    rmSync(root, { recursive: true, force: true });
  }
});
