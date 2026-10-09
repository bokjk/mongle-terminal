import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../protocol/index.ts';

const PAIRING_MS = 3 * 60_000;
const SESSION_MS = 30 * 24 * 60 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function safeEqual(a: string, b: string) {
  const aBytes = Buffer.from(a), bBytes = Buffer.from(b);
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes, bBytes);
}
export interface AuthSession {
  deviceId: string; name: string; createdAt: number; expiresAt: number; origin: string; csrf: string;
}
interface PairingRow {
  id: string; secret_hash: string; name: string; origin: string; status: string; created_at: number; expires_at: number; approved_by: string | null;
}
interface SessionRow {
  id: string; name: string; token_hash: string; csrf: string; origin: string; created_at: number; expires_at: number; revoked: number; approved_by: string | null;
}
/** A paired device that approves another request through its own remote address. */
export interface PairingApprover { name: string; origin: string }

/** Authentication writes are synchronous FULL-durability transactions, independent of layout writes. */
export class AuthStore {
  private db: DatabaseSync;
  constructor(path: string, private now: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairings (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_by TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, approved_by TEXT);
    `);
    // Databases from earlier versions lack the approver column. Older hosts ignore it after a downgrade.
    for (const table of ['pairings', 'sessions']) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {name: string}[];
      if (!columns.some(column => column.name === 'approved_by')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN approved_by TEXT`);
    }
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve first error */ } throw error; }
  }
  getOrigin(): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key='remote_origin'").get() as {value: string} | undefined)?.value || undefined;
  }
  setOrigin(origin: string | undefined) {
    return this.transaction(() => {
      const previous = this.getOrigin();
      this.db.prepare("INSERT INTO settings(key,value) VALUES('remote_origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(origin || '');
      if (previous && previous !== origin) {
        this.db.prepare('UPDATE sessions SET revoked=1 WHERE origin=?').run(previous);
        this.db.prepare("UPDATE pairings SET status='rejected' WHERE origin=? AND status IN ('pending','approved')").run(previous);
      }
      return previous;
    });
  }
  createCode() {
    const code = Array.from({length: 10}, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = this.now() + PAIRING_MS;
    this.transaction(() => {
      this.db.prepare('DELETE FROM codes').run();
      this.db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(this.now() - SESSION_MS);
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.now() - SESSION_MS);
      this.db.prepare('INSERT INTO codes(hash,expires_at) VALUES (?,?)').run(digest(code), expiresAt);
    });
    return {code, expiresAt};
  }
  requestPairing(code: string, name: string, origin: string) {
    // A failed attempt must be committed too; throw only outside the transaction.
    const result = this.transaction(() => {
      const row = this.db.prepare('SELECT hash,expires_at,attempts,consumed FROM codes WHERE hash=?').get(digest(code)) as {hash:string;expires_at:number;attempts:number;consumed:number} | undefined;
      if (!row || row.consumed || row.expires_at <= this.now() || row.attempts >= 5) {
        this.db.prepare('UPDATE codes SET attempts=attempts+1 WHERE consumed=0').run();
        return undefined;
      }
      const active = this.db.prepare("SELECT count(*) AS n FROM pairings WHERE status IN ('pending','approved') AND expires_at>?").get(this.now()) as {n:number};
      if (active.n >= 20) throw new AppError('RATE_LIMITED', '진행 중인 기기 연결 요청이 너무 많습니다.');
      const requestId = randomUUID(), requesterSecret = secret();
      const expiresAt = row.expires_at;
      this.db.prepare('UPDATE codes SET consumed=1 WHERE hash=?').run(row.hash);
      this.db.prepare("INSERT INTO pairings(id,secret_hash,name,origin,status,created_at,expires_at) VALUES(?,?,?,?,'pending',?,?)")
        .run(requestId, digest(requesterSecret), name, origin, this.now(), expiresAt);
      return {requestId, requesterSecret, expiresAt};
    });
    if (!result) throw new AppError('INVALID_PAIRING', '연결 코드가 잘못되었거나 만료되었습니다.');
    return result;
  }
  private pairing(requestId: string, requesterSecret: string, origin: string): PairingRow {
    const row = this.db.prepare('SELECT * FROM pairings WHERE id=?').get(requestId) as unknown as PairingRow | undefined;
    if (!row || !safeEqual(row.secret_hash, digest(requesterSecret)) || row.origin !== origin)
      throw new AppError('INVALID_PAIRING', '연결 요청을 확인할 수 없습니다.');
    return row;
  }
  pairingStatus(requestId: string, requesterSecret: string, origin: string) {
    const row = this.pairing(requestId, requesterSecret, origin);
    return {status: row.expires_at <= this.now() ? 'expired' : row.status, expiresAt: row.expires_at};
  }
  /** The PC sees every request. A paired device passes its own origin and sees only requests made through that address. */
  listPairings(origin?: string) {
    const rows = (origin === undefined
      ? this.db.prepare('SELECT id,name,status,created_at,expires_at FROM pairings WHERE expires_at>? ORDER BY created_at DESC LIMIT 100').all(this.now() - PAIRING_MS)
      : this.db.prepare('SELECT id,name,status,created_at,expires_at FROM pairings WHERE expires_at>? AND origin=? ORDER BY created_at DESC LIMIT 100').all(this.now() - PAIRING_MS, origin)) as unknown as PairingRow[];
    return rows.map(row => ({requestId: row.id, name: row.name, status: row.expires_at <= this.now() ? 'expired' : row.status, createdAt: row.created_at, expiresAt: row.expires_at}));
  }
  /** Without an approver the PC decides. A paired device may decide only a request made through its own origin and is recorded as the approver. */
  decidePairing(requestId: string, approved: boolean, approver?: PairingApprover) {
    this.transaction(() => {
      const status = approved ? 'approved' : 'rejected';
      const result = approver
        ? this.db.prepare("UPDATE pairings SET status=?, approved_by=? WHERE id=? AND status='pending' AND expires_at>? AND origin=?").run(status, approved ? approver.name : null, requestId, this.now(), approver.origin)
        : this.db.prepare("UPDATE pairings SET status=? WHERE id=? AND status='pending' AND expires_at>?").run(status, requestId, this.now());
      if (!result.changes) throw new AppError('INVALID_PAIRING', '승인할 수 있는 연결 요청이 없습니다.');
    });
  }
  claimPairing(requestId: string, requesterSecret: string, origin: string): {token: string; session: AuthSession} {
    return this.transaction(() => {
      const row = this.pairing(requestId, requesterSecret, origin);
      if (row.status !== 'approved' || row.expires_at <= this.now()) throw new AppError('PAIRING_NOT_APPROVED', '연결이 승인된 뒤 다시 시도해 주세요.');
      const count = this.db.prepare('SELECT count(*) AS n FROM sessions WHERE revoked=0 AND expires_at>?').get(this.now()) as {n:number};
      if (count.n >= 100) throw new AppError('DEVICE_LIMIT', '연결 기기 수가 많습니다. 사용하지 않는 기기를 해제해 주세요.');
      const token = secret(), deviceId = randomUUID(), csrf = secret(), createdAt = this.now(), expiresAt = createdAt + SESSION_MS;
      this.db.prepare('INSERT INTO sessions(id,token_hash,csrf,name,origin,created_at,expires_at,approved_by) VALUES(?,?,?,?,?,?,?,?)')
        .run(deviceId, digest(token), csrf, row.name, origin, createdAt, expiresAt, row.approved_by ?? null);
      this.db.prepare("UPDATE pairings SET status='claimed' WHERE id=?").run(requestId);
      return {token, session: {deviceId, name: row.name, createdAt, expiresAt, origin, csrf}};
    });
  }
  authenticate(token: string, origin: string): AuthSession | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND revoked=0 AND expires_at>? AND origin=?').get(digest(token), this.now(), origin) as unknown as SessionRow | undefined;
    return row ? {deviceId: row.id, name: row.name, createdAt: row.created_at, expiresAt: row.expires_at, origin: row.origin, csrf: row.csrf} : undefined;
  }
  isActive(deviceId: string, origin: string) {
    return !!this.db.prepare('SELECT id FROM sessions WHERE id=? AND origin=? AND revoked=0 AND expires_at>?').get(deviceId, origin, this.now());
  }
  listDevices() {
    const rows = this.db.prepare('SELECT id,name,origin,created_at,expires_at,revoked,approved_by FROM sessions ORDER BY CASE WHEN revoked=0 AND expires_at>? THEN 0 ELSE 1 END, created_at DESC LIMIT 200').all(this.now()) as unknown as SessionRow[];
    return rows.map(row => ({deviceId: row.id, name: row.name, origin: row.origin, createdAt: row.created_at, expiresAt: row.expires_at, revoked: !!row.revoked || row.expires_at <= this.now(), ...(row.approved_by ? {approvedBy: row.approved_by} : {})}));
  }
  revoke(deviceId: string) {
    this.transaction(() => {
      if (!this.db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(deviceId).changes)
        throw new AppError('DEVICE_NOT_FOUND', '연결 기기를 찾을 수 없습니다.');
    });
  }
  close() { this.db.close(); }
}
