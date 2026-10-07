import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostCore } from '../../packages/host/core.js';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { detectShellProfiles } from '../../packages/shell-profiles/index.js';
import { reportedDirectory } from '../../packages/shell-profiles/integration.js';

test('directory reports reject malformed metadata and decode OSC 7 paths', () => {
  assert.equal(reportedDirectory('file://localhost/C:/work/%ED%95%9C%EA%B8%80%20folder', 7), 'C:\\work\\한글 folder');
  assert.equal(reportedDirectory('9;"C:\\work space"', 9), 'C:\\work space');
  assert.equal(reportedDirectory('file://localhost/home/user/work', 7), '/home/user/work');
  for (const value of ['9;relative', '9;C:\\bad\npath', '9;', '9;/' + 'x'.repeat(4096)]) assert.equal(reportedDirectory(value, 9), undefined);
  for (const value of ['https://example.com/path', 'file:///bad%ZZ', 'file:///path?query']) assert.equal(reportedDirectory(value, 7), undefined);
});

test('fragmented directory reports update metadata without appearing in output', async () => {
  const directories: string[] = [];
  const engine = new TerminalEngine({ cols: 80, rows: 24, onResponse() {}, onDirectory: cwd => directories.push(cwd) });
  try {
    for (const character of '\x1b]9;9;C:\\한글 폴더\x1b\\') await engine.write(character);
    await engine.write('\x1b]7;file:///home/work%20space\x07visible');
    assert.deepEqual(directories, ['C:\\한글 폴더', '/home/work space']);
    assert.equal((await engine.snapshot()).data, 'visible');
  } finally { await engine.dispose(); }
});

const profiles = await detectShellProfiles();
for (const profile of profiles.filter(p => p.kind !== 'wsl')) {
  test(`real ${profile.id}: cd broadcasts the current directory and preserves launch cwd`, { timeout: 30000 }, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'mongle-cwd-'));
    const destination = path.join(dataDir, '한글 space'); await mkdir(destination);
    await writeFile(path.join(destination,'cwd-proof.txt'),'current folder');
    const host = new HostCore({ dataDir:path.join(dataDir,'.host-private'), name: '경로 검사' });
    const ctx = { id: randomUUID(), deviceId: 'cwd-test', deviceName: '테스트', owner: true };
    const states: any[] = [];
    try {
      await host.init(); host.connect(ctx, event => { if (event.type === 'state') states.push(event.state); });
      const info = await host.handle('terminals.create', { groupId: host.getState().groups[0].id, profileId: profile.id, cwd: dataDir }, ctx);
      const current = () => host.getState().terminals.find(item => item.id === info.id)!;
      const wait = async (check: () => boolean) => {
        const deadline = Date.now() + 15000;
        while (!check()) { assert.ok(Date.now() < deadline, `directory report missing for ${profile.id}`); await new Promise(resolve => setTimeout(resolve, 60)); }
      };
      await wait(() => Boolean(current().currentCwd));
      assert.equal(await realpath(current().currentCwd!),await realpath(dataDir),'initial report must be usable by host file APIs');
      const state = host.getState(), ref = { id: info.id, generation: info.generation, hostId: state.hostId, bootId: state.bootId };
      const lease = await host.handle('control.acquire', { ...ref, cols: 80, rows: 24 }, ctx);
      await host.handle('terminal.ack', { ...ref, seq: lease.frame.seq, epoch: lease.epoch }, ctx);
      // Non-Korean Windows can use an output code page that cannot encode Hangul.
      const command = profile.kind === 'powershell' ? "[Console]::OutputEncoding=[Text.Encoding]::ASCII; Set-Location -LiteralPath './한글 space'" : profile.kind === 'cmd' ? 'cd /d "한글 space"' : "cd './한글 space'";
      await host.handle('terminal.input', { ...ref, epoch: lease.epoch, inputId: randomUUID(), clientInputSeq: 1, data: command + '\r' }, ctx);
      await wait(() => Boolean(current().currentCwd?.endsWith('한글 space')));
      await wait(() => states.some(s => s.terminals.find((t: any) => t.id === info.id)?.currentCwd?.endsWith('한글 space')));
      assert.equal(await realpath(current().currentCwd!), await realpath(destination));
      const fileRef={...ref,root:current().currentCwd!,path:''};
      assert.ok((await host.handle('files.list',fileRef,ctx)).entries.some((entry:any)=>entry.name==='cwd-proof.txt'));
      assert.equal((await host.handle('files.preview',{...fileRef,path:'cwd-proof.txt'},ctx)).text,'current folder');
      await host.handle('git.status',fileRef,ctx);
      assert.equal(current().cwd, dataDir);
      assert.equal(current().pid, info.pid);
    } finally { await host.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
}
