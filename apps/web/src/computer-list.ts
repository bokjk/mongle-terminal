/** A Mongle address the user added on this device. The browser keeps it per site, so each PC's page has its own list. */
export type SavedComputer = { name: string; origin: string };
export type ComputerRow = SavedComputer & { saved: boolean };
export const SAVED_COMPUTERS_KEY = 'mongle.savedComputers';
export const MAX_SAVED_COMPUTERS = 20;
const dnsPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/;

/** Accepts what people paste from the Tailscale app or Mongle settings and returns the exact origin. Only Mongle's Tailscale HTTPS addresses are allowed. */
export function computerOrigin(value: string): string {
  const text = value.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new Error('https://컴퓨터.테일넷.ts.net 형식의 주소를 입력해 주세요.'); }
  if (url.protocol !== 'https:' || !dnsPattern.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('https://컴퓨터.테일넷.ts.net 형식의 몽글 접속 주소만 추가할 수 있습니다.');
  return url.origin;
}

export function defaultComputerName(origin: string) { return new URL(origin).hostname.split('.')[0]; }

export function loadSavedComputers(storage: Pick<Storage, 'getItem'> = localStorage): SavedComputer[] {
  let value: unknown;
  try { value = JSON.parse(storage.getItem(SAVED_COMPUTERS_KEY) || '[]'); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const list: SavedComputer[] = [];
  for (const item of value) {
    if (!item || typeof item.name !== 'string' || typeof item.origin !== 'string') continue;
    let origin: string;
    try { origin = computerOrigin(item.origin); } catch { continue; }
    const name = item.name.trim().slice(0, 40);
    if (name && !list.some(saved => saved.origin === origin)) list.push({name, origin});
    if (list.length >= MAX_SAVED_COMPUTERS) break;
  }
  return list;
}

export function storeSavedComputers(list: SavedComputer[], storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(SAVED_COMPUTERS_KEY, JSON.stringify(list.slice(0, MAX_SAVED_COMPUTERS))); } catch { /* Saved addresses are a convenience; private browsing may refuse storage. */ }
}

/** Adding an address that is already saved updates its name. */
export function addSavedComputer(list: SavedComputer[], name: string, address: string, currentOrigin: string): SavedComputer[] {
  const origin = computerOrigin(address);
  if (origin === currentOrigin) throw new Error('지금 보고 있는 컴퓨터의 주소입니다.');
  if (list.length >= MAX_SAVED_COMPUTERS && !list.some(item => item.origin === origin)) throw new Error(`주소는 ${MAX_SAVED_COMPUTERS}개까지 추가할 수 있습니다.`);
  const label = name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 40) || defaultComputerName(origin);
  return [...list.filter(item => item.origin !== origin), {name: label, origin}];
}

/** Found PCs keep their order. A saved entry for the same address supplies the name the user chose. */
export function computerRows(discovered: SavedComputer[], saved: SavedComputer[], currentOrigin: string): ComputerRow[] {
  const named = new Map(saved.map(item => [item.origin, item]));
  const rows: ComputerRow[] = [];
  for (const item of discovered) if (item.origin !== currentOrigin && !rows.some(row => row.origin === item.origin)) rows.push(named.has(item.origin) ? {...named.get(item.origin)!, saved: true} : {...item, saved: false});
  for (const item of saved) if (item.origin !== currentOrigin && !rows.some(row => row.origin === item.origin)) rows.push({...item, saved: true});
  return rows;
}
