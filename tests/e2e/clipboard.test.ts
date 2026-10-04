import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { isProcessAlive, readHostReadiness } from '../../apps/desktop/full-exit';
import type { ConnectionInfo } from '../../apps/desktop/contracts';
import { connectOwnerPipe } from '../../packages/local-ipc/index';
import type { HostState } from '../../packages/protocol/index';
import { probeClipboardAccess } from '../helpers/windows-clipboard';
import { probeHostStartup } from '../helpers/host-startup-probe';

const inside = (parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

test('desktop clipboard: native roundtrip or real access-denied feedback',
  { skip: process.platform !== 'win32' || (process.env.MONGLE_E2E_CLIPBOARD !== '1' && process.env.MONGLE_E2E_CLIPBOARD_DENIED !== '1'), timeout: 120000 }, async () => {
    const root = process.cwd();
    const denied = process.env.MONGLE_E2E_CLIPBOARD_DENIED === '1';
    assert.ok(!(denied && process.env.MONGLE_E2E_CLIPBOARD === '1'), 'Select either normal clipboard E2E or the access-denied E2E');
    const parent = path.resolve(process.env.MONGLE_E2E_DATA_ROOT || tmpdir());
    assert.ok(inside(path.resolve(tmpdir()), parent), 'OwnerPipe clipboard E2E data must stay under TEMP');
    await mkdir(parent, { recursive: true });
    assert.ok(inside(await realpath(tmpdir()), await realpath(parent)), 'The actual E2E parent must stay under TEMP');
    const isolated = await mkdtemp(path.join(parent, 'mongle-clipboard-'));
    assert.equal(path.dirname(isolated), parent);
    const dataDir = path.join(isolated, 'host'), fixture = path.join(isolated, 'fixture');
    const childPidFile = path.join(fixture, 'child.pid');
    await mkdir(fixture);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = process.env.MONGLE_E2E_EXE ? path.resolve(process.env.MONGLE_E2E_EXE) : undefined;
    const helper = process.env.MONGLE_OWNER_HELPER;
    let application: ElectronApplication | undefined, page: Page | undefined;
    let owner: Awaited<ReturnType<typeof connectOwnerPipe>> | undefined;
    let passed = false, launched = false, clipboardCaptured = false;
    let failure: unknown, preflight: Awaited<ReturnType<typeof probeClipboardAccess>> | undefined;
    let clipboardRestoration = 'not needed';
    const pids = new Set<number>(), errors: string[] = [], cleanupErrors: string[] = [];
    const connectionHistory: Array<{ elapsedMs: number; status: ConnectionInfo['status']; owner: boolean; error?: string }> = [];
    const startedAt = Date.now();
    let electronStderr = '', connectionSubscribed = false;
    let storageDiagnostics: unknown;
    let hostStartupDiagnostics: unknown;
    let initialHostReady = false;
    const redactDiagnostic = (value: string) => value
      .split(isolated).join('<isolated-profile>')
      .replace(/((?:authorization|token|password|secret|pairingCode|authKey)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
      .replace(/\b(?:[a-f\d]{32,}|[A-Za-z\d+/_-]{40,}={0,2})\b/gi, '<redacted>');
    const output = path.join(root, 'test-results/e2e', denied ? 'clipboard-denied' : 'clipboard'); await mkdir(output, { recursive: true });
    const rememberHost = async () => { const readiness = await readHostReadiness(dataDir); if (readiness) pids.add(readiness.pid); return readiness; };
    try {
      preflight = await probeClipboardAccess();
      if (denied) assert.deepEqual(preflight, { available: false, error: 5 }, 'Access-denied E2E requires actual Windows clipboard error 5');
      else assert.ok(preflight.available, `Native Windows clipboard is unavailable (OpenClipboard error ${preflight.error}); the clipboard E2E cannot run here.`);
      if (executable) process.env.MONGLE_OWNER_HELPER = path.join(path.dirname(executable), 'resources/hostbundle/platform/windows/OwnerPipe.exe');
      const script = path.join(fixture, 'clipboard-input.cjs');
      await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); process.stdin.setRawMode(true); process.stdout.write('\\x1b[2J\\x1b[H'); console.log('MONGLE_CLIP_COPY'); process.stdin.on('data', b => console.log('RX:' + b.toString('hex')));\n`);
      launched = true;
      const app = application = await _electron.launch({ executablePath: executable || path.join(root, 'node_modules/electron/dist/electron.exe'), args: executable ? [] : [root], cwd: root, env: { ...env, MONGLE_DATA_DIR: dataDir }, timeout: 30000 });
      pids.add(app.process().pid!);
      // This process belongs to the fresh isolated profile. Keep a bounded
      // failure-only stderr tail; never collect clipboard or host auth state.
      app.process().stderr?.on('data', chunk => { electronStderr = (electronStderr + String(chunk)).slice(-16 * 1024); });
      page = await app.firstWindow(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('__recordClipboardConnection', (info: Pick<ConnectionInfo, 'status' | 'owner' | 'error'>) => {
        connectionHistory.push({ elapsedMs: Date.now() - startedAt, status: info.status, owner: info.owner,
          ...(info.error ? { error: redactDiagnostic(info.error).slice(0, 2048) } : {}) });
        if (connectionHistory.length > 32) connectionHistory.shift();
      });
      await page.waitForFunction(() => typeof (window as any).mongle?.onConnection === 'function');
      await page.evaluate(() => {
        const scope = window as any;
        // The real preload subscribes before requesting the current state.
        // Only status/error fields leave this isolated renderer, never IDs.
        scope.mongle.onConnection((info: { status: string; owner: boolean; error?: string }) => {
          void scope.__recordClipboardConnection({ status: info.status, owner: info.owner, error: info.error }).catch(() => {});
        });
      });
      connectionSubscribed = true;
      // Locator assertions have their own 5s default, independent of the page
      // timeout. A cold CI host may use the app's entire 15s startup window.
      await expect(page.getByRole('button', { name: '새 터미널', exact: true })).toBeEnabled({ timeout: 30000 });
      initialHostReady = true;
      if (!denied) {
        // Eagerly materialize every format before a write. Its contents stay
        // only in this Electron process, never in test logs or artifacts.
        await app.evaluate(async ({ clipboard, ClipboardItem }) => {
          const previous = [];
          for (const item of await clipboard.read()) {
            const formats: ConstructorParameters<typeof ClipboardItem>[0] = {};
            for (const type of item.types) {
              const value = await item.getType(type);
              formats[type] = 'arrayBuffer' in value ? new Blob([await value.arrayBuffer()], { type: value.type }) : { title: value.title, url: value.url };
            }
            if (Object.keys(formats).length) previous.push(new ClipboardItem(formats));
          }
          (globalThis as any).__previousClipboard = previous;
        });
        clipboardCaptured = true;
      }
      owner = await connectOwnerPipe({ dataDir });
      const readiness = await rememberHost(), initial = await owner.request<HostState>('state.get');
      assert.ok(readiness);
      assert.equal(initial.hostId, readiness.hostId); assert.equal(initial.bootId, readiness.bootId);
      assert.equal(initial.terminals.length, 0, 'The clipboard test must start in its own empty profile');
      const cmd = initial.profiles.find(profile => profile.kind === 'cmd'); assert.ok(cmd);
      await page.getByRole('button', { name: '새 터미널', exact: true }).click();
      // cmd /d avoids user PowerShell profiles and persistent command history.
      const editor = page.getByRole('dialog', { name: '새 터미널', exact: true });
      await editor.getByRole('combobox').selectOption(cmd.id);
      await editor.getByLabel('시작 폴더', { exact: true }).fill(fixture);
      await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
      await page.getByText('여기서 제어 중', { exact: true }).waitFor();
      for (const terminal of (await owner.request<HostState>('state.get')).terminals) if (terminal.pid) pids.add(terminal.pid);
      // A raw-mode child reports received bytes, so copying must never send ETX
      // and pasting must arrive exactly once without running shell commands.
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(`"${process.execPath}" "${script}"`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.xterm-rows > div')).some(row => row.textContent?.trim() === 'MONGLE_CLIP_COPY'));
      const selectMarker = async () => {
        const box = await page!.locator('.xterm-rows > div').filter({ hasText: /^MONGLE_CLIP_COPY\s*$/ }).last().boundingBox();
        assert.ok(box);
        await page!.mouse.dblclick(box.x + 35, box.y + box.height / 2);
      };
      await selectMarker();
      if (denied) {
        await expect(page.locator('.toast')).toContainText('복사하지 못했습니다.');
        await expect(page.locator('.clipboard-feedback')).toHaveCount(0);
        // Dismiss without moving focus away from the terminal, then require a
        // new failure notification from the explicit Ctrl+C attempt.
        await page.getByRole('button', { name: '알림 닫기', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
        await expect(page.locator('.toast')).toHaveCount(0);
        await page.keyboard.press('Control+c');
        await expect(page.locator('.toast')).toContainText('복사하지 못했습니다.');
        await expect(page.locator('.clipboard-feedback')).toHaveCount(0);
        assert.ok(!(await page.locator('.xterm-rows').innerText()).includes('RX:03'), 'Copy failure must not turn Ctrl+C into an interrupt');
        assert.deepEqual(await probeClipboardAccess(), { available: false, error: 5 });
        // This only registers a synthetic origin in this isolated host's DB;
        // it never starts Tailscale Serve or makes an external connection.
        await owner.request('remote.configure', { origin: 'https://clipboard-test.example.ts.net' });
        await page.getByRole('button', { name: '설정', exact: true }).click();
        const settings = page.getByRole('dialog', { name: '설정', exact: true });
        await settings.getByRole('tab', { name: '원격 연결', exact: true }).click();
        await settings.getByRole('button', { name: '접속 주소 복사', exact: true }).click();
        await expect(settings.getByRole('alert')).toHaveText('복사하지 못했습니다. 주소나 코드를 직접 선택해 복사해 주세요.');
        await expect(settings.getByText('복사했습니다.', { exact: true })).toHaveCount(0);
        await settings.getByRole('button', { name: '연결 코드 만들기', exact: true }).click();
        await expect(settings.getByRole('button', { name: '연결 코드 복사', exact: true })).toBeEnabled();
        await expect(settings.getByRole('alert')).toHaveCount(0);
        await settings.getByRole('button', { name: '연결 코드 복사', exact: true }).click();
        await expect(settings.getByRole('alert')).toHaveText('복사하지 못했습니다. 주소나 코드를 직접 선택해 복사해 주세요.');
        await expect(settings.getByText('복사했습니다.', { exact: true })).toHaveCount(0);
        await settings.getByRole('button', { name: '설정 닫기', exact: true }).click();
        await owner.request('remote.configure', { origin: null });
      } else {
      await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'MONGLE_CLIP_COPY')).toBe(true);
      await page.keyboard.press('Control+c');
      await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'MONGLE_CLIP_COPY')).toBe(true);
      await expect(page.getByRole('status').filter({ hasText: '선택한 내용을 복사했습니다.' })).toBeVisible();
      assert.ok(!(await page.locator('.xterm-rows').innerText()).includes('RX:03'));
      await page.keyboard.press('Control+Shift+c');
      await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'MONGLE_CLIP_COPY')).toBe(true);
      await page.locator('.xterm-helper-textarea').click({ force: true });
      await page.keyboard.press('Control+c');
      await expect(page.locator('.xterm-rows')).toContainText('RX:03');
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_PASTE'));
      await page.keyboard.press('Control+v');
      const hex = Buffer.from('MONGLE_CLIP_PASTE').toString('hex');
      await expect(page.locator('.xterm-rows')).toContainText('RX:' + hex);
      assert.equal((await page.locator('.xterm-rows').innerText()).split('RX:' + hex).length - 1, 1);
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_SHIFT'));
      await page.keyboard.press('Control+Shift+v');
      await expect(page.locator('.xterm-rows')).toContainText('RX:' + Buffer.from('MONGLE_CLIP_SHIFT').toString('hex'));
      await selectMarker();
      await page.locator('.terminal-canvas').click({ button: 'right', modifiers: ['Shift'], position: { x: 120, y: 100 } });
      const menu = page.getByRole('dialog', { name: '터미널 복사와 붙여넣기' });
      await menu.getByRole('button', { name: '복사', exact: false }).click();
      await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'MONGLE_CLIP_COPY')).toBe(true);
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_RIGHT'));
      await page.locator('.terminal-canvas').click({ button: 'right', position: { x: 120, y: 100 } });
      await expect(page.locator('.xterm-rows')).toContainText('RX:' + Buffer.from('MONGLE_CLIP_RIGHT').toString('hex'));
      await app.evaluate(({ clipboard }) => clipboard.writeText('MONGLE_CLIP_LINE1\nMONGLE_CLIP_LINE2'));
      await page.locator('.terminal-canvas').click({ button: 'right', position: { x: 120, y: 100 } });
      await page.getByRole('heading', { name: '여러 줄을 붙여넣을까요?' }).waitFor();
      await page.getByRole('button', { name: '취소', exact: true }).click();
      assert.ok(!(await page.locator('.xterm-rows').innerText()).includes(Buffer.from('MONGLE_CLIP_LINE1').toString('hex')));
      }
      await page.screenshot({ path: path.join(output, 'desktop.png') });
      assert.deepEqual(errors, []); passed = true;
    } catch (error) { failure = error; }
    finally {
      if (!passed) await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      if (!passed && launched) {
        try {
          const literal = "'" + dataDir.replaceAll("'", "''") + "'";
          const script = `$ErrorActionPreference='Stop'; $folder=${literal}; $exists=[System.IO.Directory]::Exists($folder); $sameOwner=$false; $administrators=$false; if($exists){$owner=[System.IO.Directory]::GetAccessControl($folder).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $sameOwner=$owner -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $administrators=$owner -eq 'S-1-5-32-544'}; $secretExists=[System.IO.File]::Exists([System.IO.Path]::Combine($folder,'owner.secret')); [System.Console]::Write(('{{"directoryExists":{0},"ownerMatchesCurrentUser":{1},"ownerIsAdministrators":{2},"ownerSecretExists":{3}}}' -f $exists.ToString().ToLowerInvariant(),$sameOwner.ToString().ToLowerInvariant(),$administrators.ToString().ToLowerInvariant(),$secretExists.ToString().ToLowerInvariant()))`;
          const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 });
          storageDiagnostics = JSON.parse(stdout);
        } catch (error) { storageDiagnostics = { error: redactDiagnostic(String(error)).slice(0, 2048) }; }
      }
      if (clipboardCaptured && application) {
        try {
          clipboardRestoration = await application.evaluate(async ({ clipboard }) => {
            // Match exact test-owned values; do not overwrite content copied by
            // the user or another application while this test was running.
            const current = (await clipboard.readText()).replace(/\r\n/g, '\n');
            const values = ['MONGLE_CLIP_COPY', 'MONGLE_CLIP_PASTE', 'MONGLE_CLIP_SHIFT', 'MONGLE_CLIP_RIGHT', 'MONGLE_CLIP_LINE1\nMONGLE_CLIP_LINE2'];
            if (!values.includes(current)) return 'preserved external content';
            const previous = (globalThis as any).__previousClipboard;
            if (!Array.isArray(previous)) throw new Error('The clipboard backup is unavailable.');
            if (previous.length) await clipboard.write(previous); else clipboard.clear();
            delete (globalThis as any).__previousClipboard;
            return 'restored';
          });
        } catch (error) { cleanupErrors.push(`Clipboard restore: ${String(error)}`); }
      }
      // Stop the GUI before its isolated host, so reconnect cannot start a new
      // host during cleanup. OwnerPipe cleanup also works after renderer failure.
      if (application) await application.close().catch(error => cleanupErrors.push(`Electron close: ${String(error)}`));
      else if (launched) cleanupErrors.push('Electron launch did not return an application; GUI cleanup could not be verified.');
      if (!passed && launched && !initialHostReady) {
        try {
          hostStartupDiagnostics = await probeHostStartup({ buildRoot: executable ? path.join(path.dirname(executable), 'resources/hostbundle') : root, isolated });
        } catch (error) { hostStartupDiagnostics = { error: redactDiagnostic(String(error)).slice(0, 2048) }; }
      }
      try {
        await rememberHost();
        try {
          const childPid = Number(await readFile(childPidFile, 'utf8'));
          assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'The test child PID must be valid');
          pids.add(childPid);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        // The pipe starts before host-info.json. Do not assume a missing
        // readiness file means no host exists after a startup failure.
        const startupDeadline = Date.now() + 15000;
        while (!owner && launched) {
          try { owner = await connectOwnerPipe({ dataDir }); }
          catch (error) {
            const missing = ['NO_HOST', 'PIPE_NOT_FOUND', 'ENOENT', 'ECONNREFUSED', 'HOST_UNAVAILABLE'].includes((error as { code?: string }).code || '');
            if (!missing || Date.now() >= startupDeadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
        if (owner) {
          let state: HostState;
          for (;;) {
            try { state = await owner.request<HostState>('state.get'); break; }
            catch (error) {
              if (!['HOST_UNAVAILABLE', 'STARTING'].includes((error as { code?: string }).code || '') || Date.now() >= startupDeadline) throw error;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
          let current = await rememberHost();
          while (!current && Date.now() < startupDeadline) { await new Promise(resolve => setTimeout(resolve, 100)); current = await rememberHost(); }
          assert.ok(current && state.hostId === current.hostId && state.bootId === current.bootId, 'Cleanup must target this isolated host');
          for (const terminal of state.terminals) if (terminal.pid) pids.add(terminal.pid);
          await owner.request('host.shutdown');
        }
        const deadline = Date.now() + 10000;
        while ([...pids].some(isProcessAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        const remaining = await rememberHost();
        assert.ok(![...pids].some(isProcessAlive) && (!remaining || !isProcessAlive(remaining.pid)), 'Isolated app, host and shell processes must exit');
      } catch (error) { cleanupErrors.push(`Isolated host cleanup: ${String(error)}`); }
      finally { owner?.close(); }
      if (helper === undefined) delete process.env.MONGLE_OWNER_HELPER; else process.env.MONGLE_OWNER_HELPER = helper;
      const cleanedUp = cleanupErrors.length === 0;
      await writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: passed && cleanedUp, cleanedUp, mode: denied ? 'access denied' : 'native clipboard', preflight, clipboardRestoration, errors, cleanupErrors,
        ...(!passed ? { startupDiagnostics: { isolatedProfile: true, connectionSubscribed, connectionHistory, storageDiagnostics, hostStartupDiagnostics, electronStderr: redactDiagnostic(electronStderr) } } : {}),
        ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) }, null, 2));
    }
    if (failure) throw failure;
    assert.deepEqual(cleanupErrors, []);
  });
