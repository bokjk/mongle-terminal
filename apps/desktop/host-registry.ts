import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SavedHost } from './contracts';
import { AppError } from '../../packages/protocol/index';

const hostSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(60), url: z.string(), hostId: z.string().optional() });
export function normalizeHostURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Tailscale에서 표시한 HTTPS 주소를 입력하세요. 예: https://my-pc.example.ts.net');
  }
  return url.origin;
}
export class HostRegistry {
  private hosts: z.infer<typeof hostSchema>[] = [];
  private selected = 'local';
  constructor(private directory: string) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'desktop-hosts.json'), 'utf8'));
      this.hosts = z.array(hostSchema).max(50).parse(data.hosts).map(host => ({ ...host, url: normalizeHostURL(host.url) }));
      this.selected = this.hosts.some(h => h.id === data.selected) ? data.selected : 'local';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('저장한 컴퓨터 목록을 읽지 못했습니다. 원본 파일은 보존했습니다.'); }
  }
  list(): SavedHost[] { return [{ id: 'local', name: '현재 컴퓨터', local: true, selected: this.selected === 'local' }, ...this.hosts.map(h => ({ ...h, local: false, selected: h.id === this.selected }))]; }
  get selectedId() { return this.selected; }
  get(id: string) { const host = this.list().find(h => h.id === id); if (!host) throw new Error('등록되지 않은 컴퓨터입니다.'); return host; }
  async add(value: unknown) {
    const input = z.object({ name: z.string().trim().min(1).max(60), url: z.string().max(400) }).strict().parse(value);
    const url = normalizeHostURL(input.url);
    const old = this.hosts.find(h => h.url === url); if (old) return this.get(old.id);
    if (this.hosts.length >= 50) throw new Error('컴퓨터는 최대 50대까지 등록할 수 있습니다.');
    const host = { id: randomUUID(), name: input.name, url }; this.hosts.push(host); await this.save(); return this.get(host.id);
  }
  async remove(id: string) { if (id === 'local') throw new Error('현재 컴퓨터는 삭제할 수 없습니다.'); this.get(id); this.hosts = this.hosts.filter(h => h.id !== id); if (this.selected === id) this.selected = 'local'; await this.save(); }
  async select(id: string) { this.get(id); this.selected = id; await this.save(); }
  async bindIdentity(id: string, hostId: string) {
    if (id === 'local') return;
    const host = this.hosts.find(h => h.id === id)!;
    if (host.hostId && host.hostId !== hostId) throw new AppError('HOST_IDENTITY_CHANGED', '접속 대상의 설치 정보가 바뀌었습니다. 컴퓨터를 삭제한 뒤 다시 등록하세요.');
    if (!host.hostId) { host.hostId = hostId; await this.save(); }
  }
  private async save() { await mkdir(this.directory, { recursive: true }); const file = path.join(this.directory, 'desktop-hosts.json'); const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify({ hosts: this.hosts, selected: this.selected }, null, 2), { mode: 0o600 }); await rename(tmp, file); }
}
