import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { encryptPushPayload, generateVapidKeys, pushTopic, sendPush, validPushSubscription, validVapidKeys, vapidAuthorization } from '../../packages/host/web-push.ts';

const joined = (value: string) => value.replace(/\s+/g, '');
// RFC 8291 section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPublic: joined('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: joined(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`),
};

function browserKeys() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
/** What a browser does with a received message, written from the RFC independently of the sender code. */
function decryptAsBrowser(body: Buffer, browser: ReturnType<typeof browserKeys>) {
  const salt = body.subarray(0, 16), recordSize = body.readUInt32BE(16), idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength), record = body.subarray(21 + idLength);
  const receiverPublic = browser.ecdh.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', browser.ecdh.computeSecret(senderPublic), browser.auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(recordSize, 4096); assert.equal(idLength, 65); assert.equal(padded.at(-1), 2);
  return { plaintext: padded.subarray(0, -1), salt, senderPublic };
}

test('message encryption reproduces the RFC 8291 example byte for byte', () => {
  const body = encryptPushPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.receiverPublic, auth: RFC.authSecret },
    { senderPrivateKey: Buffer.from(RFC.senderPrivate, 'base64url'), salt: Buffer.from(RFC.salt, 'base64url') });
  assert.equal(body.toString('base64url'), RFC.body);
  // 86-octet header and 58 octets of ciphertext. (The example request line says 145; the body it shows is 144 octets.)
  assert.equal(body.length, 144);
});

test('each message has a fresh sender key and salt and only the subscribing browser can read it', () => {
  const browser = browserKeys(), other = browserKeys();
  const payload = Buffer.from(JSON.stringify({ title: 'PC', body: '작업 · PowerShell: Claude가 확인을 기다리고 있습니다.' }));
  const first = encryptPushPayload(payload, browser.subscription), second = encryptPushPayload(payload, browser.subscription);
  const a = decryptAsBrowser(first, browser), b = decryptAsBrowser(second, browser);
  assert.deepEqual(a.plaintext, payload); assert.deepEqual(b.plaintext, payload);
  assert.notDeepEqual(a.salt, b.salt); assert.notDeepEqual(a.senderPublic, b.senderPublic);
  assert.equal(first.includes(Buffer.from('Claude')), false, 'no plaintext on the wire');
  assert.throws(() => decryptAsBrowser(first, other), 'another browser cannot decrypt');
  assert.throws(() => encryptPushPayload(Buffer.alloc(4096), browser.subscription), /너무 깁니다/);
});

test('VAPID authorization is an ES256 token for the push service origin that its public key verifies', () => {
  const keys = generateVapidKeys();
  assert.equal(validVapidKeys(keys), true);
  assert.equal(validVapidKeys({ ...keys, privateKey: 'x' }), false);
  assert.equal(validVapidKeys({ ...keys, publicKey: generateVapidKeys().publicKey }), false, 'a public key from another pair');
  const now = Date.UTC(2026, 9, 12);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc?x=1', keys, now));
  assert.ok(match);
  const [, header, claims, signature, key] = match;
  assert.equal(key, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const values = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(values.aud, 'https://fcm.googleapis.com');
  assert.equal(values.exp, now / 1000 + 12 * 3600);
  assert.match(values.sub, /^https:\/\//);
  const raw = Buffer.from(key, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(header + '.' + claims), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
});

test('only public HTTPS push endpoints with well-formed keys are accepted', () => {
  const { subscription } = browserKeys();
  const keys = { p256dh: subscription.p256dh, auth: subscription.auth };
  assert.equal(validPushSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }).endpoint, 'https://fcm.googleapis.com/fcm/send/x');
  assert.equal(validPushSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys, expirationTime: null }).p256dh, keys.p256dh);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://a.localhost/x', 'https://printer.local/x', 'https://pc.tail1234.ts.net/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://intranet/x', 'not a url'])
    assert.throws(() => validPushSubscription({ endpoint, keys }), Error, endpoint);
  const offCurve = Buffer.alloc(65, 1); offCurve[0] = 4;
  assert.throws(() => validPushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, p256dh: offCurve.toString('base64url') } }));
  assert.throws(() => validPushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: randomBytes(12).toString('base64url') } }));
  assert.throws(() => validPushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys, extra: true }));
});

test('sending posts the encrypted message with Web Push headers and reports dropped subscriptions', async () => {
  const browser = browserKeys();
  const subscription = { endpoint: 'https://push.example.net/push/abc', ...browser.subscription };
  const vapid = generateVapidKeys();
  const calls: Array<{ url: unknown; init: any }> = [];
  const respond = (status: number) => (async (url: unknown, init: any) => { calls.push({ url, init }); return new Response(null, { status }); }) as unknown as typeof fetch;
  assert.deepEqual(await sendPush(subscription, { ttl: 900, urgency: 'high', topic: pushTopic('attention-1'), payload: { title: 'x' } }, vapid, { fetch: respond(201) }), { status: 'sent' });
  const { url, init } = calls[0];
  assert.equal(url, subscription.endpoint);
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm'); assert.equal(init.headers.TTL, '900'); assert.equal(init.headers.Urgency, 'high');
  assert.match(init.headers.Topic, /^[A-Za-z0-9_-]{32}$/);
  assert.match(init.headers.Authorization, /^vapid t=.+, k=/);
  assert.equal(decryptAsBrowser(Buffer.from(init.body), browser).plaintext.toString(), JSON.stringify({ title: 'x' }));
  assert.deepEqual(await sendPush(subscription, { ttl: 1, payload: {} }, vapid, { fetch: respond(410) }), { status: 'gone', httpStatus: 410 });
  assert.deepEqual(await sendPush(subscription, { ttl: 1, payload: {} }, vapid, { fetch: respond(404) }), { status: 'gone', httpStatus: 404 });
  assert.deepEqual(await sendPush(subscription, { ttl: 1, payload: {} }, vapid, { fetch: respond(429) }), { status: 'failed', httpStatus: 429 });
  assert.deepEqual(await sendPush(subscription, { ttl: 1, payload: {} }, vapid, { fetch: (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch }), { status: 'failed' });
});
