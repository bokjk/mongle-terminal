import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, createServer } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { connectOwnerPipe, ensureHelper, startOwnerPipe } from '../../packages/local-ipc/index.ts';
import { AppError, type ConnectionContext, type HostEvent, type Send } from '../../packages/protocol/index.ts';

const windows = process.platform === 'win32';
const run = promisify(execFile);
const eventually = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(label);
};

test('Windows owner IPC authenticates helper peers and bridges requests/events', { skip: !windows, timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-ipc-'));
  const dataDir = path.join(root, 'private');
  const connections = new Map<string, { context: ConnectionContext; send: Send }>();
  const events: HostEvent[] = [];
  const helper = await ensureHelper();
  assert.ok(path.isAbsolute(helper));
  const server = await startOwnerPipe({
    dataDir,
    onConnect(context, send) { connections.set(context.id, { context, send }); send({ type: 'notice', code: 'CONNECTED', message: '연결되었습니다.' }); },
    onRequest(method, params, context) {
      if (method === 'fail') throw new AppError('EXPECTED', '확인된 오류');
      if (method === 'large-snapshot') return 'x'.repeat(16 * 1024 * 1024 - 1024);
      return { method, params, owner: context.owner, id: context.id };
    },
    onDisconnect(id) { connections.delete(id); },
  });
  let client: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  let second: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
  try {
    client = await connectOwnerPipe({ dataDir, onEvent: event => events.push(event) });
    assert.ok(client.connectionId);
    const result = await client.request('echo', { value: '몽글🙂', count: 7 });
    assert.deepEqual(result, { method: 'echo', params: { value: '몽글🙂', count: 7 }, owner: true, id: client.connectionId });
    await eventually(() => events.some(event => event.type === 'notice' && event.code === 'CONNECTED'), 'initial event delivered');
    await assert.rejects(client.request('fail'), (error: unknown) => error instanceof AppError && error.code === 'EXPECTED');
    const messages = await Promise.all(Array.from({ length: 12 }, (_, index) => client!.request('echo', { index })));
    assert.deepEqual(messages.map(message => message.params.index), Array.from({ length: 12 }, (_, i) => i));
    assert.equal((await client.request<string>('large-snapshot')).length, 16 * 1024 * 1024 - 1024);
    await assert.rejects(client.request('oversized-input', { text: 'x'.repeat(128 * 1024) }), (error: unknown) => error instanceof AppError && error.code === 'IPC_FRAME_TOO_LARGE');
    assert.equal((await client.request('echo')).owner, true);
    second = await connectOwnerPipe({ dataDir });
    assert.notEqual(second.connectionId, client.connectionId);
    assert.equal(connections.size, 2);
    const oldId = client.connectionId;
    client.close();
    await eventually(() => !connections.has(oldId), 'client detach delivered');
    assert.equal((await second.request('echo')).owner, true);
    second.close();
    await eventually(() => connections.size === 0, 'all clients detached');

    // Windows ACL is inspected without printing or passing the actual secret to a shell.
    const aclCommand = "$ProgressPreference='SilentlyContinue'; $d = [System.IO.Directory]::GetAccessControl($args[0]); $f = [System.IO.File]::GetAccessControl([System.IO.Path]::Combine($args[0], 'owner.secret')); [pscustomobject]@{DirectoryProtected=$d.AreAccessRulesProtected; FileProtected=$f.AreAccessRulesProtected; DirectoryRules=@($d.Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}); FileRules=@($f.Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}); CurrentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress";
    // -Command arguments have PowerShell parsing ambiguity; encode a script containing a safely single-quoted literal.
    const script = aclCommand.replaceAll('$args[0]', "'" + dataDir.replaceAll("'", "''") + "'");
    const aclOutput = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    assert.equal(aclOutput.stderr, '', aclOutput.stderr);
    const acl = JSON.parse(aclOutput.stdout.trim());
    assert.equal(acl.DirectoryProtected, true);
    assert.equal(acl.FileProtected, true);
    assert.deepEqual(acl.DirectoryRules, [acl.CurrentSid]);
    assert.deepEqual(acl.FileRules, [acl.CurrentSid]);
    assert.equal((await readFile(path.join(dataDir, 'owner.secret'))).length, 32);
  } finally {
    client?.close(); second?.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows owner IPC rejects changed secrets and an untrusted peer executable', { skip: !windows, timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-auth-'));
  const dataDir = path.join(root, 'private');
  let connected = 0;
  let requests = 0;
  const server = await startOwnerPipe({ dataDir, onConnect() { connected++; }, onRequest() { requests++; return true; }, onDisconnect() {} });
  try {
    const file = path.join(dataDir, 'owner.secret');
    const original = await readFile(file);
    const tampered = Buffer.from(original); tampered[0] ^= 0xff;
    await writeFile(file, tampered);
    await assert.rejects(connectOwnerPipe({ dataDir }), (error: unknown) => error instanceof AppError && error.code === 'AUTH_FAILED');
    assert.equal(connected, 0);
    await writeFile(file, original);

    // The correct user SID is insufficient: a node.exe peer is not the installed helper.
    await new Promise<void>((resolve, reject) => {
      const socket = connect('\\\\.\\pipe\\' + server.pipeName);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('untrusted client was not closed')); }, 2000);
      socket.once('connect', () => socket.write(Buffer.from([1, 0, 0, 0, 0])));
      socket.on('error', () => {});
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(connected, 0);
    assert.equal(requests, 0);
    const good = await connectOwnerPipe({ dataDir });
    assert.equal(await good.request('after-rejection'), true);
    good.close();
    assert.equal(connected, 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows owner IPC refuses a second server and closes pending calls on shutdown', { skip: !windows, timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-close-'));
  const dataDir = path.join(root, 'private');
  const server = await startOwnerPipe({ dataDir, onConnect() {}, onRequest: () => new Promise(() => {}), onDisconnect() {} });
  try {
    await assert.rejects(startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} }), (error: unknown) => error instanceof AppError && error.code === 'HOST_ALREADY_RUNNING');
    const client = await connectOwnerPipe({ dataDir });
    const pending = assert.rejects(client.request('never'), /종료|disconnected|IPC/);
    await server.close();
    await pending;
    client.close();
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows owner IPC reports NO_HOST for fresh and stopped host directories', { skip: !windows, timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-absent-'));
  const dataDir = path.join(root, 'private');
  try {
    await assert.rejects(connectOwnerPipe({ dataDir }), (error: unknown) => error instanceof AppError && error.code === 'NO_HOST');
    const server = await startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} });
    await server.close();
    await assert.rejects(connectOwnerPipe({ dataDir }), (error: unknown) => error instanceof AppError && error.code === 'NO_HOST');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows owner instance guard survives forced helper death until its Node host exits', { skip: !windows, timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-guard-'));
  const dataDir = path.join(root, 'private');
  const moduleUrl = new URL('../../packages/local-ipc/index.ts', import.meta.url).href;
  const code = `
    const { startOwnerPipe } = await import(${JSON.stringify(moduleUrl)});
    const pipe = await startOwnerPipe({dataDir:${JSON.stringify(dataDir)},onConnect(){},onRequest(){},onDisconnect(){},onError(){process.stdout.write(JSON.stringify({helperClosed:true})+'\\n');}});
    process.stdout.write(JSON.stringify({helperPid:pipe.helperPid})+'\\n');
    setInterval(()=>{},1000);
  `;
  const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { windowsHide: true, stdio: 'pipe' });
  const exited = new Promise<void>(resolve => host.once('close', () => resolve()));
  let stderr = '';
  host.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let resolveReady!: (pid: number) => void;
  let resolveHelperClosed!: () => void;
  const ready = new Promise<number>(resolve => { resolveReady = resolve; });
  const helperClosed = new Promise<void>(resolve => { resolveHelperClosed = resolve; });
  const lines = createInterface({ input: host.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.helperPid) resolveReady(message.helperPid);
    if (message.helperClosed) resolveHelperClosed();
  });
  try {
    const helperPid = await Promise.race([ready, exited.then(() => { throw new Error('host startup failed: ' + stderr); })]);
    process.kill(helperPid);
    await helperClosed;
    assert.equal(host.exitCode, null);
    await assert.rejects(startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} }), (error: unknown) => error instanceof AppError && error.code === 'HOST_ALREADY_RUNNING');
    host.kill();
    await exited;
    const replacement = await startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} });
    await replacement.close();
    // Graceful close also releases the parent-side duplicate without requiring this test process to exit.
    const again = await startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} });
    await again.close();
  } finally {
    host.kill();
    await exited;
    lines.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows owner instance guard survives helper EOF and exception exits', { skip: !windows, timeout: 20_000 }, async () => {
  const helper = await ensureHelper();
  for (const mode of ['eof', 'invalid-json']) {
    const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-abnormal-'));
    const dataDir = path.join(root, 'private');
    const code = `
      import {spawn} from 'node:child_process';
      import {createInterface} from 'node:readline';
      const helper=spawn(${JSON.stringify(helper)},['server',${JSON.stringify(dataDir)},String(process.pid)],{windowsHide:true,stdio:'pipe'});
      const lines=createInterface({input:helper.stdout});
      lines.on('line',line=>{const message=JSON.parse(line);if(message.kind==='ready')process.stdout.write(JSON.stringify({ready:true})+'\\n');});
      helper.stderr.resume(); helper.stdin.on('error',()=>{});
      helper.once('close',code=>process.stdout.write(JSON.stringify({closed:true,code})+'\\n'));
      process.stdin.once('data',()=>{if(${JSON.stringify(mode)}==='eof')helper.stdin.end();else helper.stdin.write('not-json\\n');});
      setInterval(()=>{},1000);
    `;
    const host = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'pipe' });
    const exited = new Promise<void>(resolve => host.once('close', () => resolve()));
    let stderr = '';
    host.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let resolveReady!: () => void;
    let resolveClosed!: (code: number) => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    const closed = new Promise<number>(resolve => { resolveClosed = resolve; });
    const lines = createInterface({ input: host.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.ready) resolveReady();
      if (message.closed) resolveClosed(message.code);
    });
    try {
      await Promise.race([ready, exited.then(() => { throw new Error('host startup failed: ' + stderr); })]);
      host.stdin.write('trigger\n');
      const code = await closed;
      assert.equal(code, mode === 'eof' ? 0 : 1);
      assert.equal(host.exitCode, null);
      await assert.rejects(startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} }), (error: unknown) => error instanceof AppError && error.code === 'HOST_ALREADY_RUNNING');
      host.kill();
      await exited;
      const replacement = await startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} });
      await replacement.close();
    } finally {
      host.kill(); await exited; lines.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('Windows owner releases its parent guard when startup fails before readiness', { skip: !windows, timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-owner-startup-'));
  const dataDir = path.join(root, 'private');
  const first = await startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} });
  await first.close();
  const collision = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      collision.once('error', reject);
      collision.listen('\\\\.\\pipe\\' + first.pipeName, resolve);
    });
    await assert.rejects(startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} }), (error: unknown) => error instanceof AppError && error.code === 'IPC_ERROR');
    await new Promise<void>(resolve => collision.close(() => resolve()));
    const replacement = await startOwnerPipe({ dataDir, onConnect() {}, onRequest() {}, onDisconnect() {} });
    await replacement.close();
  } finally {
    if (collision.listening) await new Promise<void>(resolve => collision.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
