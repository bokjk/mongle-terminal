import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Team, TeamTemplate } from '../protocol/index.js';

/**
 * Teams and the user's own team templates, kept apart from sessions.sqlite: that store refuses
 * a newer user_version, so adding tables there would lock users out after a downgrade.
 */
export class TeamStore {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'agents.sqlite'));
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) { this.db.close(); throw new Error('더 새 버전에서 만든 팀 저장소입니다. 앱을 업데이트해 주세요.'); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'
      + 'CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, payload TEXT NOT NULL);'
      + 'CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, payload TEXT NOT NULL);'
      + 'PRAGMA user_version=1;');
  }
  private all<T>(table: 'teams' | 'templates'): T[] {
    const result: T[] = [];
    for (const row of this.db.prepare('SELECT payload FROM ' + table + ' ORDER BY rowid').all() as { payload: string }[]) {
      try { result.push(JSON.parse(row.payload) as T); } catch { /* an unreadable row is skipped, never repaired */ }
    }
    return result;
  }
  teams(): Team[] { return this.all<Team>('teams'); }
  templates(): TeamTemplate[] { return this.all<TeamTemplate>('templates'); }
  saveTeam(team: Team) { this.db.prepare('INSERT INTO teams(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(team.id, JSON.stringify(team)); }
  deleteTeam(id: string) { this.db.prepare('DELETE FROM teams WHERE id=?').run(id); }
  saveTemplate(template: TeamTemplate) { this.db.prepare('INSERT INTO templates(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(template.id, JSON.stringify(template)); }
  deleteTemplate(id: string) { this.db.prepare('DELETE FROM templates WHERE id=?').run(id); }
  close() { this.db.close(); }
}
