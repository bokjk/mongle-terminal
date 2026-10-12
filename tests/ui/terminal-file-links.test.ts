import test from 'node:test';
import assert from 'node:assert/strict';
import Headless from '@xterm/headless';
import type { IBuffer } from '@xterm/xterm';
import { findPaths, pathAtCell, resolveTerminalPath, OUTSIDE_FOLDER } from '../../apps/web/src/terminal-file-links';

const paths = (text: string) => findPaths(text).map(match => match.path);

test('terminal output paths are found in Windows, relative and agent forms without linking ordinary words', () => {
  assert.deepEqual(paths('● Update(src\\app.ts) and Read(docs/USER-GUIDE.md)'), ['src\\app.ts', 'docs/USER-GUIDE.md']);
  assert.deepEqual(paths('error at C:\\work\\몽글\\src\\main.tsx:12:5.'), ['C:\\work\\몽글\\src\\main.tsx']);
  assert.deepEqual(findPaths('src/a.ts:12:5').map(({ line, column }) => [line, column]), [[12, 5]]);
  assert.deepEqual(findPaths('App.tsx(120,8): error TS2322').map(({ path, line, column }) => [path, line, column]), [['App.tsx', 120, 8]]);
  assert.deepEqual(paths('see README.md, then .\\scripts\\build.ps1'), ['README.md', '.\\scripts\\build.ps1']);
  // Code, versions, hosts and web addresses stay text; so does a path that climbs out of the folder.
  assert.deepEqual(paths('console.log(x) v1.2.3 example.com node/v24.1 https://github.com/a/b.md ..\\up\\a.ts'), []);
  // A Unix home or absolute path never becomes a partial Windows link.
  assert.deepEqual(paths('~/notes/a.md /usr/lib/x.so \\\\server\\share\\a.txt'), []);
});

test('only files inside the terminal folder resolve, with any separator or letter case', () => {
  const root = 'C:\\Work\\Project';
  assert.deepEqual(resolveTerminalPath(root, 'src/app.ts'), { ok: true, path: 'src\\app.ts' });
  assert.deepEqual(resolveTerminalPath(root + '\\', '.\\README.md'), { ok: true, path: 'README.md' });
  assert.deepEqual(resolveTerminalPath(root, 'c:/work/project/docs/a.md'), { ok: true, path: 'docs\\a.md' });
  for (const outside of ['C:\\Work\\Project2\\a.md', 'D:\\Work\\Project\\a.md', 'C:\\Work\\a.md', 'src\\..\\..\\a.md', 'a\\:b.md'])
    assert.deepEqual(resolveTerminalPath(root, outside), { ok: false, reason: OUTSIDE_FOLDER });
});

test('a path wrapped across rows and after wide characters is found under every cell it covers', async () => {
  const terminal = new Headless.Terminal({ cols: 20, rows: 6, allowProposedApi: true });
  await new Promise<void>(resolve => terminal.write('한글 수정: src\\components\\Pane.tsx 완료', resolve));
  const buffer = terminal.buffer.active as unknown as IBuffer;
  // "한글 수정: " takes 11 cells, so the path starts at column 11 and wraps onto the next row.
  assert.equal(pathAtCell(buffer, 10, 0), undefined);
  assert.equal(pathAtCell(buffer, 11, 0)?.path, 'src\\components\\Pane.tsx');
  assert.equal(pathAtCell(buffer, 3, 1)?.path, 'src\\components\\Pane.tsx');
  assert.equal(pathAtCell(buffer, 19, 1), undefined);
  terminal.dispose();
});

