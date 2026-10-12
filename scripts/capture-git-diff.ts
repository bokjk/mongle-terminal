/** Capture the Git review and single-file diff for the README with a disposable HostCore and demo repository.
 * Windows + Chrome + a built dist/web are required. Run: npx tsx scripts/capture-git-diff.ts
 * Paths are shown through a temporary drive letter, so no user folder appears in the images.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { HostCore } from '../packages/host/core.js';
import type { ConnectionContext, TerminalInfo } from '../packages/protocol/index.js';

assert.equal(process.platform, 'win32', 'This capture uses real Windows shells.');
assert.ok(existsSync('dist/web/index.html'), 'Run npm run build first.');
const root = path.resolve('.test-data/readme-git-diff');
await mkdir(root, { recursive: true });
const isolated = await mkdtemp(path.join(root, 'capture-'));
const drive = ['X', 'Y', 'Z', 'W', 'V'].find(letter => !existsSync(`${letter}:\\`));
assert.ok(drive, 'A free temporary drive letter is required for anonymous demo paths.');
let driveMapped = false, browser: Browser | undefined;
const host = new HostCore({ dataDir: path.join(isolated, 'host'), name: '작업용 PC' });
const connection: ConnectionContext = { id: randomUUID(), deviceId: randomUUID(), deviceName: '데모 데스크톱', owner: true };
const errors: string[] = [], webRoot = path.resolve('dist/web');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const file = path.resolve(webRoot, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(webRoot + path.sep)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});

const before = `import { readFile } from 'node:fs/promises';

export interface Session { id: string; title: string; cwd: string }

export async function loadSessions(file: string): Promise<Session[]> {
  const text = await readFile(file, 'utf8');
  return JSON.parse(text);
}

export function findSession(sessions: Session[], id: string) {
  return sessions.find(session => session.id === id);
}

export function sessionLabel(session: Session) {
  return session.title;
}

export function sortSessions(sessions: Session[]) {
  return [...sessions].sort((a, b) => a.title.localeCompare(b.title));
}
`;
const committed = before.replace("export function sessionLabel(session: Session) {\n  return session.title;\n}", "export function sessionLabel(session: Session) {\n  return session.title || session.cwd;\n}");
const working = committed.replace("  const text = await readFile(file, 'utf8');\n  return JSON.parse(text);", "  const text = await readFile(file, 'utf8').catch(() => '[]');\n  const sessions: Session[] = JSON.parse(text);\n  return sessions.filter(session => session.id && session.cwd);");

try {
  execFileSync('subst.exe', [`${drive}:`, isolated], { windowsHide: true });
  driveMapped = true;
  const repository = `${drive}:\\workspace`;
  await mkdir(path.join(repository, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Mongle Demo', '-c', 'user.email=demo@example.invalid', '-c', 'core.hooksPath=NUL', '-c', 'core.autocrlf=false', ...args], { cwd: repository, windowsHide: true });
  await writeFile(path.join(repository, 'src', 'sessions.ts'), before);
  await writeFile(path.join(repository, 'src', 'format.ts'), `export const formatTitle = (title: string) => title.trim();\n`);
  await writeFile(path.join(repository, 'README.md'), '# Demo project\n\nREADME demo only.\n');
  git('init', '-q', '--initial-branch=main'); git('add', '.'); git('commit', '-qm', 'demo base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('checkout', '-qb', 'feat/session-labels');
  await writeFile(path.join(repository, 'src', 'sessions.ts'), committed);
  await writeFile(path.join(repository, 'src', 'labels.ts'), `import type { Session } from './sessions';\n\nexport const shortLabel = (session: Session) => session.title.slice(0, 24);\n`);
  git('add', '.'); git('commit', '-qm', 'show folder when a session has no title');
  await writeFile(path.join(repository, 'src', 'sessions.ts'), working);
  await writeFile(path.join(repository, 'src', 'format.ts'), `export const formatTitle = (title: string) => title.trim().replace(/\\s+/g, ' ');\n`);

  await host.init();
  host.connect(connection, () => {});
  const group = host.getState().groups[0];
  await host.handle('groups.update', { id: group.id, name: '데모 프로젝트', cwd: repository, revision: group.revision }, connection);
  const terminal: TerminalInfo = await host.handle('terminals.create', { groupId: host.getState().groups[0].id, profileId: 'cmd', cwd: repository }, connection);
  await host.handle('terminals.rename', { id: terminal.id, title: '세션 라벨 작업' }, connection);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeBinding('hostRequest', async (_source, method: string, params: unknown) => host.handle(method, params, connection));
  await page.addInitScript('window.__name = function (fn) { return fn; };');
  await page.addInitScript(() => {
    const listeners = new Set<any>(); (window as any).__hostListeners = listeners;
    (window as any).mongle = { request: (method: string, params: unknown) => (window as any).hostRequest(method, params), subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, onConnection: (fn: any) => { fn({ status: 'connected', owner: true }); return () => {}; }, listHosts: async () => [{ id: 'demo', name: '작업용 PC', local: true, selected: true }] };
  });
  host.disconnect(connection.id);
  host.connect(connection, event => { void page.evaluate(value => { for (const listener of (window as any).__hostListeners || []) listener(value); }, event).catch(() => {}); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator(`[data-terminal-id="${terminal.id}"] textarea`).focus();
  await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('button', { name: '어둡게', exact: true }).click(); await page.getByRole('button', { name: '설정 닫기' }).click();
  await page.getByRole('button', { name: '파일 탐색기', exact: true }).click();
  const explorer = page.getByRole('complementary', { name: '파일 탐색기' }), editor = page.getByRole('region', { name: '파일 편집기', exact: true });
  await explorer.getByRole('tab', { name: /^Git/ }).click();
  await explorer.getByRole('button', { name: '변경 검토 열기' }).click();
  const review = editor.locator('.document-body:not([hidden]) .git-review');
  await expect(review.locator('.review-section')).toHaveCount(3);
  await expect(review.locator('.review-section[data-path="src/sessions.ts"] .cm-content')).toContainText('session.title || session.cwd');
  await expect(review.locator('.review-summary')).not.toContainText('읽는 중');
  await page.mouse.move(1400, 880); await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/assets', { recursive: true });
  const visible = async () => assert.ok(!/C:\\Users\\|tail[\w-]*\.ts\.net/i.test(await page.locator('body').innerText()), 'Capture must not contain personal paths or real remote hosts');
  await visible(); await page.screenshot({ path: 'docs/assets/git-review.png' });
  await explorer.getByRole('region', { name: '작업 폴더 변경', exact: true }).getByRole('button', { name: 'src/sessions.ts · 수정됨' }).click();
  const diff = editor.locator('.document-body:not([hidden]) .diff-view');
  await expect(diff.locator('.diff-overview-mark')).toHaveCount(2);
  await page.mouse.move(1400, 880); await visible();
  await page.screenshot({ path: 'docs/assets/git-diff.png' });
  assert.deepEqual(errors, []);
  console.log('Captured real UI: docs/assets/git-review.png, docs/assets/git-diff.png (1440×900) from an isolated demo repository.');
} finally {
  host.disconnect(connection.id);
  await browser?.close();
  await host.close();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  if (driveMapped) {
    const mappings = execFileSync('subst.exe', { encoding: 'utf8', windowsHide: true });
    assert.ok(mappings.split(/\r?\n/).some(line => line.toLowerCase().includes(`${drive!.toLowerCase()}:\\:`) && line.toLowerCase().endsWith(isolated.toLowerCase())), 'Only remove our own temporary drive mapping');
    execFileSync('subst.exe', [`${drive}:`, '/D'], { windowsHide: true });
  }
  assert.ok(path.resolve(isolated).startsWith(root + path.sep), 'Only remove the current capture data');
  await rm(isolated, { recursive: true, force: true });
}

