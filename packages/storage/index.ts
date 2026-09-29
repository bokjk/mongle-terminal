import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, HostSettings, PresentationSnapshot, TerminalInfo } from '../protocol/index.js';

export interface PersistedHost {
  schemaVersion: 1;
  hostId: string;
  settings: HostSettings;
  groups: Group[];
  terminals: TerminalInfo[];
}

export interface PersistedSnapshot {
  terminalId: string;
  generation: string;
  snapshot: PresentationSnapshot;
}

/** One host is the only writer. Authentication has a separate durable store. */
export class HostStore {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'sessions.sqlite'));
    const version = (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if (version > 1) { this.db.close(); throw new Error('더 새 버전에서 만든 세션 저장소입니다. 앱을 업데이트해 주세요.'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (terminal_id TEXT PRIMARY KEY, generation TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  load(): PersistedHost | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('host') as { value: string } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.value) as PersistedHost;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.groups) || !Array.isArray(parsed.terminals)) throw new Error('지원하지 않는 세션 저장 형식입니다.');
    return parsed;
  }
  save(state: PersistedHost, clearSnapshots?: 'all' | string[], snapshots: PersistedSnapshot[] = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('host', JSON.stringify(state));
      if (clearSnapshots === 'all') this.db.exec('DELETE FROM snapshots');
      else if (clearSnapshots) for (const id of clearSnapshots) this.db.prepare('DELETE FROM snapshots WHERE terminal_id=?').run(id);
      // Shutdown commits the current frames and their metadata together. A
      // failed frame write must roll back the whole preflight before any PTY dies.
      for (const {terminalId, generation, snapshot} of snapshots) this.saveSnapshot(terminalId, generation, snapshot);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getSnapshot(id: string, generation: string): PresentationSnapshot | undefined {
    const row = this.db.prepare('SELECT payload FROM snapshots WHERE terminal_id=? AND generation=?').get(id, generation) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as PresentationSnapshot : undefined;
  }
  saveSnapshot(id: string, generation: string, snapshot: PresentationSnapshot) {
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024) throw new Error('터미널 기록이 저장 한도를 넘었습니다.');
    // Never evict a current frame silently. The caller reports storage failure.
    const total = this.db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS size FROM snapshots WHERE terminal_id<>?').get(id) as { size: number };
    if (total.size + Buffer.byteLength(payload) > 512 * 1024 * 1024) throw new Error('전체 터미널 기록 저장 한도를 넘었습니다.');
    this.db.prepare('INSERT INTO snapshots(terminal_id,generation,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(terminal_id) DO UPDATE SET generation=excluded.generation,payload=excluded.payload,updated_at=excluded.updated_at').run(id, generation, payload, Date.now());
  }
  clearSnapshot(id: string) { this.db.prepare('DELETE FROM snapshots WHERE terminal_id=?').run(id); }
  clearAllSnapshots() { this.db.exec('DELETE FROM snapshots;'); }
  close() { this.db.close(); }
}
