import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addableComputers, ownRemoteOrigin } from '../../apps/desktop/computer-search';

test('the add-computer dialog offers only new, valid Mongle PCs', () => {
  const reply = {available: true, checkedAt: 1, computers: [
    {name: 'office-pc', origin: 'https://office-pc.tail1234.ts.net'},
    {name: 'office-pc again', origin: 'https://office-pc.tail1234.ts.net/'},
    {name: 'laptop', origin: 'https://laptop.tail1234.ts.net:8443'},
    {name: 'this pc', origin: 'https://home-pc.tail1234.ts.net'},
    {name: 'registered', origin: 'https://studio.tail1234.ts.net'},
    {name: 'plain http', origin: 'http://evil.tail1234.ts.net'},
    {name: 'elsewhere', origin: 'https://example.com'},
    {name: 'with path', origin: 'https://x.tail1234.ts.net/admin'},
    {name: '  \u0007  ', origin: 'https://nameless.tail1234.ts.net'},
    {name: 'x'.repeat(100), origin: 'https://long.tail1234.ts.net'},
    null, 'junk',
  ]};
  const result = addableComputers(reply, [{url: undefined}, {url: 'https://studio.tail1234.ts.net'}], 'https://home-pc.tail1234.ts.net');
  assert.deepEqual(result.computers, [
    {name: 'office-pc', origin: 'https://office-pc.tail1234.ts.net'},
    {name: 'laptop', origin: 'https://laptop.tail1234.ts.net:8443'},
    {name: 'nameless', origin: 'https://nameless.tail1234.ts.net'},
    {name: 'x'.repeat(60), origin: 'https://long.tail1234.ts.net'},
  ], 'Duplicates, this PC, non-Mongle addresses and malformed rows are dropped; names are cleaned');
  assert.equal(result.alreadyAdded, 1, 'A PC already in the computer list is counted, not offered');
  assert.equal(result.available, true);
  assert.equal('message' in result, false);
  assert.deepEqual(addableComputers({available: false, message: 'Tailscale에서 로그인하고 네트워크에 연결해 주세요.', computers: []}, []),
    {computers: [], available: false, alreadyAdded: 0, message: 'Tailscale에서 로그인하고 네트워크에 연결해 주세요.'});
  assert.deepEqual(addableComputers(null, []), {computers: [], available: true, alreadyAdded: 0});
  assert.deepEqual(addableComputers({computers: 'nope', message: 7}, []), {computers: [], available: true, alreadyAdded: 0});
});

test('a list from another PC never offers this PC back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mongle-own-origin-'));
  try {
    assert.equal(await ownRemoteOrigin(dir), undefined, 'Remote access was never turned on');
    await writeFile(path.join(dir, 'remote-serve.json'), JSON.stringify({origin: 'https://home-pc.tail1234.ts.net', dnsName: 'home-pc.tail1234.ts.net', httpsPort: 443, proxy: 'http://127.0.0.1:50000'}));
    assert.equal(await ownRemoteOrigin(dir), 'https://home-pc.tail1234.ts.net');
    await writeFile(path.join(dir, 'remote-serve.json'), '{broken');
    assert.equal(await ownRemoteOrigin(dir), undefined);
    await writeFile(path.join(dir, 'remote-serve.json'), JSON.stringify({origin: 'https://example.com'}));
    assert.equal(await ownRemoteOrigin(dir), undefined);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
