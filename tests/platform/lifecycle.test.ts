import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { prepareRuntime, launchHost } from '../../apps/desktop/runtime';
import { HostRegistry, normalizeHostURL } from '../../apps/desktop/host-registry';
const exec = promisify(execFile);
const root = process.cwd();

test('host registry rejects privileged URL schemes and changed installation identities', async () => {
  for (const value of ['http://pc.example.ts.net', 'https://example.com', 'https://pc.example.ts.net.evil.com', 'https://user:secret@pc.example.ts.net', 'https://pc.example.ts.net/path', 'https://pc.example.ts.net/?token=secret']) assert.throws(() => normalizeHostURL(value));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mongle-registry-'));
  try {
    const registry = new HostRegistry(temp); await registry.load();
    const host = await registry.add({ name: '집 PC', url: 'https://pc.example.ts.net/' });
    await registry.bindIdentity(host.id, 'install-a');
    await assert.rejects(() => registry.bindIdentity(host.id, 'install-b'));
    await registry.select(host.id);
    const reopened = new HostRegistry(temp); await reopened.load(); assert.equal(reopened.selectedId, host.id); assert.equal(reopened.get(host.id).hostId, 'install-a');
    await reopened.remove(host.id); assert.equal(reopened.selectedId, 'local');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

for (const killJob of [false, true]) test(`independent bundled Node survives ${killJob ? 'parent kill-on-close Job' : 'launcher exit'}`, { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const native = await prepareRuntime(root);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mongle-lifecycle-'));
  const dataDir = path.join(temp, 'data 한글 space'); await mkdir(path.join(temp, 'dist/host'), { recursive: true }); await mkdir(dataDir);
  const entry = path.join(temp, 'dist/host/main.cjs'); const heartbeat = path.join(dataDir, 'heartbeat.json');
  await writeFile(entry, `const fs=require('node:fs');const path=require('node:path');const file=path.join(process.argv[process.argv.indexOf('--data-dir')+1],'heartbeat.json');let count=0;const tick=()=>fs.writeFileSync(file,JSON.stringify({pid:process.pid,count:++count}));tick();setInterval(tick,100);`);
  let pid: number | undefined;
  try {
    if (killJob) {
      const harness = path.join(temp, 'JobHarness.exe');
      await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/out:' + harness, path.join(root, 'tests/platform/JobHarness.cs')], { windowsHide: true });
      await exec(harness, [native.launcher, native.node, entry, dataDir], { windowsHide: true, timeout: 25_000 });
    } else {
      await exec(native.launcher, [native.node, entry, dataDir], { windowsHide: true });
    }
    const until = Date.now() + 10_000;
    let first: { pid: number; count: number } | undefined;
    while (!first && Date.now() < until) { try { first = JSON.parse(await readFile(heartbeat, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(first, 'host must write readiness after launcher exits'); pid = first.pid;
    await new Promise(resolve => setTimeout(resolve, 800));
    let second: {pid: number;count: number} | undefined;
    for(let i=0;i<20 && !second;i++) { try { second=JSON.parse(await readFile(heartbeat,'utf8')); } catch { await new Promise(resolve=>setTimeout(resolve,20)); } }
    assert.ok(second);
    assert.equal(second.pid, pid); assert.ok(second.count > first.count + 2, 'host keeps running after parent job is destroyed');
    process.kill(pid, 0);
  } finally {
    if (pid) { try { process.kill(pid); } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
    await rm(temp, { recursive: true, force: true });
  }
});
