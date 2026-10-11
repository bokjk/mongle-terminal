import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComputerSearch, SavedHost } from './contracts';
import { normalizeHostURL } from './host-registry';

const MAX_NAME = 60;

/**
 * What the PC app's "add computer" dialog offers: Mongle PCs the connected host found in the tailnet,
 * minus this PC and PCs already in the computer list. Malformed replies never reach the dialog.
 */
export function addableComputers(reply: unknown, hosts: Pick<SavedHost, 'url'>[], ownOrigin?: string): ComputerSearch {
  const value = reply as { computers?: unknown; available?: unknown; message?: unknown } | null;
  const registered = new Set(hosts.flatMap(host => host.url ? [host.url] : []));
  const seen = new Set<string>();
  const computers: ComputerSearch['computers'] = [];
  let alreadyAdded = 0;
  for (const item of Array.isArray(value?.computers) ? value.computers : []) {
    let origin: string;
    try { origin = normalizeHostURL(String((item as { origin?: unknown } | null)?.origin ?? '')); } catch { continue; }
    if (origin === ownOrigin || seen.has(origin)) continue;
    seen.add(origin);
    if (registered.has(origin)) { alreadyAdded++; continue; }
    const label = String((item as { name?: unknown } | null)?.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
    computers.push({ name: label || new URL(origin).hostname.split('.')[0], origin });
  }
  return { computers, available: value?.available !== false, alreadyAdded, ...(typeof value?.message === 'string' ? { message: value.message.slice(0, 300) } : {}) };
}

/** This PC's own Mongle address, so a list from another PC never offers this PC back. */
export async function ownRemoteOrigin(dataDir: string): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(path.join(dataDir, 'remote-serve.json'), 'utf8')) as { origin?: unknown };
    return typeof record?.origin === 'string' ? normalizeHostURL(record.origin) : undefined;
  } catch { return undefined; }
}
