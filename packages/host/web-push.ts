import { createCipheriv, createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { AppError } from '../protocol/index.ts';

/** This host's P-256 VAPID keys in base64url: the 65-byte uncompressed public point and the 32-byte private scalar. */
export interface VapidKeys { publicKey: string; privateKey: string }
/** What a browser's PushSubscription.toJSON() gives a host: where to post and how to encrypt for it. */
export interface PushSubscriptionRecord { endpoint: string; p256dh: string; auth: string }
export interface PushMessage { ttl: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string; payload: unknown }
export type PushResult = { status: 'sent' } | { status: 'gone'; httpStatus: number } | { status: 'failed'; httpStatus?: number };

/** Contact for push services about this sender (RFC 8292 "sub"). */
export const VAPID_SUBJECT = 'https://github.com/bokjk/mongle-terminal-releases';
const RECORD_SIZE = 4096;
const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url');
const base64url = /^[A-Za-z0-9_-]+$/;

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  return { publicKey: encode(Buffer.concat([Buffer.from([4]), decode(jwk.x), decode(jwk.y)])), privateKey: jwk.d };
}

function point(value: string): { x: string; y: string } | undefined {
  if (!base64url.test(value)) return undefined;
  const bytes = decode(value);
  return bytes.length === 65 && bytes[0] === 4 ? { x: encode(bytes.subarray(1, 33)), y: encode(bytes.subarray(33)) } : undefined;
}
/** A P-256 public point that is really on the curve; ECDH with anything else must never be attempted. */
function validPoint(value: string): boolean {
  const xy = point(value);
  if (!xy) return false;
  try { createPublicKey({ key: { kty: 'EC', crv: 'P-256', ...xy }, format: 'jwk' }); return true; } catch { return false; }
}
export function validVapidKeys(value: unknown): value is VapidKeys {
  if (!value || typeof value !== 'object') return false;
  const keys = value as VapidKeys;
  if (typeof keys.publicKey !== 'string' || typeof keys.privateKey !== 'string' || !base64url.test(keys.privateKey) || decode(keys.privateKey).length !== 32) return false;
  // The stored public key must be the one the private scalar produces.
  try { const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(decode(keys.privateKey)); return encode(ecdh.getPublicKey()) === keys.publicKey && !!point(keys.publicKey); } catch { return false; }
}
function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const xy = point(keys.publicKey);
  if (!xy) throw new Error('Invalid VAPID public key');
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...xy, d: keys.privateKey }, format: 'jwk' });
}

/** RFC 8292 Authorization header: an ES256 JWT for the push service's origin that expires within 24 hours. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now(), subject = VAPID_SUBJECT): string {
  const header = encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encode(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject })));
  const signature = sign('sha256', Buffer.from(header + '.' + claims), { key: vapidPrivateKey(keys), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + header + '.' + claims + '.' + encode(signature) + ', k=' + keys.publicKey;
}

/**
 * RFC 8291 message encryption (aes128gcm, one record): only the browser that made the subscription
 * can read the payload; the push service sees its size and timing. The optional sender key and salt
 * exist for the RFC test vector only.
 */
export function encryptPushPayload(plaintext: Buffer, subscription: Pick<PushSubscriptionRecord, 'p256dh' | 'auth'>, fixed?: { senderPrivateKey: Buffer; salt: Buffer }): Buffer {
  if (plaintext.length + 17 > RECORD_SIZE) throw new AppError('PAYLOAD_TOO_LARGE', '알림 내용이 너무 깁니다.');
  const receiver = decode(subscription.p256dh), authSecret = decode(subscription.auth);
  const sender = createECDH('prime256v1');
  if (fixed) sender.setPrivateKey(fixed.senderPrivateKey); else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sender.computeSecret(receiver), authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? randomBytes(16);
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // A single record ends with the 0x02 delimiter and no padding.
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(RECORD_SIZE, 16); header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, record]);
}

const subscriptionSchema = z.object({
  endpoint: z.string().min(8).max(2048),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(32) }).strict(),
  expirationTime: z.number().nullable().optional(),
}).strict();

/** Accepts a browser push subscription whose endpoint is a public HTTPS push service and whose keys are well formed. */
export function validPushSubscription(value: unknown): PushSubscriptionRecord {
  const { endpoint, keys } = subscriptionSchema.parse(value);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new AppError('INVALID_SUBSCRIPTION', '알림 구독 주소가 올바르지 않습니다.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host) || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.ts.net'))
    throw new AppError('INVALID_SUBSCRIPTION', '브라우저의 알림 서비스 주소만 등록할 수 있습니다.');
  if (!validPoint(keys.p256dh) || !base64url.test(keys.auth) || decode(keys.auth).length !== 16)
    throw new AppError('INVALID_SUBSCRIPTION', '알림 구독 키가 올바르지 않습니다.');
  return { endpoint: url.href, p256dh: keys.p256dh, auth: keys.auth };
}

/** Topic lets a push service replace an undelivered message of the same notification (RFC 8030, at most 32 base64url characters). */
export function pushTopic(tag: string): string { return createHash('sha256').update(tag).digest('base64url').slice(0, 32); }

export interface SendOptions { fetch?: typeof fetch; now?: number; timeoutMs?: number }
/** Posts one encrypted message. 404/410 mean the browser dropped the subscription. Never follows redirects. */
export async function sendPush(subscription: PushSubscriptionRecord, message: PushMessage, keys: VapidKeys, options: SendOptions = {}): Promise<PushResult> {
  const body = encryptPushPayload(Buffer.from(JSON.stringify(message.payload)), subscription);
  const headers: Record<string, string> = {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.floor(message.ttl))), Urgency: message.urgency ?? 'normal',
    Authorization: vapidAuthorization(subscription.endpoint, keys, options.now),
  };
  if (message.topic) headers.Topic = message.topic;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(subscription.endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  } catch { return { status: 'failed' }; }
  await response.arrayBuffer().catch(() => undefined);
  if (response.status === 404 || response.status === 410) return { status: 'gone', httpStatus: response.status };
  return response.ok ? { status: 'sent' } : { status: 'failed', httpStatus: response.status };
}
