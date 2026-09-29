import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {connectOwnerPipe} from '../packages/local-ipc/index.js';

// Read-only check; never sends shell input, changes pairing or stops the host.
const [base, ownerHelper, evidenceName] = process.argv.slice(2);
if (!base || !ownerHelper || !/^[a-z-]+$/.test(evidenceName ?? '')) {
  throw new Error('Usage: verify-live-web.ts <HTTPS base URL> <OwnerPipe.exe> <evidence-name>');
}
if (new URL(base).protocol !== 'https:') throw new Error('Expected HTTPS base URL.');
process.env.MONGLE_OWNER_HELPER = ownerHelper;
const html = await fetch(base, {signal:AbortSignal.timeout(15000)}).then(response => {
  if (!response.ok) throw new Error(`Index HTTP ${response.status}`);
  return response.text();
});
if (html !== fs.readFileSync('dist/web/index.html', 'utf8')) throw new Error('Live HTML mismatch.');
const codeAssets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map(match => match[1]);
if (!codeAssets.some(asset => asset.endsWith('.js')) || !codeAssets.some(asset => asset.endsWith('.css'))) throw new Error('Expected JS and CSS assets.');
const assets = [...new Set([
  ...codeAssets,
  './icon-32.png', './icon-192.png', './icon-512.png', './manifest.webmanifest',
])];
const verified = [];
for (const asset of assets) {
  const bytes = await fetch(new URL(asset, base), {signal:AbortSignal.timeout(15000)}).then(response => {
    if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
    return response.arrayBuffer();
  });
  const body = Buffer.from(new Uint8Array(bytes));
  if (!body.equals(fs.readFileSync(path.join('dist/web', asset)))) throw new Error(`Live asset mismatch: ${asset}`);
  verified.push({asset, sha256:crypto.createHash('sha256').update(body).digest('hex')});
}
const dataDir = path.join(process.env.LOCALAPPDATA!, 'MongleTerminal');
const owner = await connectOwnerPipe({dataDir});
try {
  const state = await owner.request('state.get');
  const hostInfo = JSON.parse(fs.readFileSync(path.join(dataDir, 'host-info.json'), 'utf8'));
  const result = {
    checkedAt:new Date().toISOString(), hostId:state.hostId, hostPid:hostInfo.pid,
    bootId:state.bootId, httpsAssets:verified,
    terminals:state.terminals.map((terminal:any) => ({id:terminal.id, pid:terminal.pid, status:terminal.status, cols:terminal.cols, rows:terminal.rows})),
  };
  fs.mkdirSync('test-results', {recursive:true});
  fs.writeFileSync(`test-results/${evidenceName}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { owner.close(); }
