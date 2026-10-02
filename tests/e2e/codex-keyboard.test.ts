import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron,expect,type ElectronApplication } from '@playwright/test';
import { connectOwnerPipe } from '../../packages/local-ipc';
import type { HostState,TerminalInfo } from '../../packages/protocol';

const executable=process.env.MONGLE_E2E_CODEX_EXECUTABLE;
const launchArgs=process.env.MONGLE_E2E_CODEX_ARGS??'--no-daemon --sandbox read-only';
const shell=process.env.MONGLE_E2E_CODEX_SHELL||'cmd';
const packaged=Boolean(process.env.MONGLE_E2E_EXE);
const appExecutable=path.resolve(process.env.MONGLE_E2E_EXE||'node_modules/electron/dist/electron.exe');
test('real Electron and installed Codex retain Shift+Enter as a composer newline',{skip:!executable||process.platform!=='win32',timeout:90000},async()=>{
  assert.ok(executable&&!/["\r\n&|<>]/.test(executable));
  const parent=path.resolve(process.env.MONGLE_E2E_DATA_ROOT||path.join(tmpdir(),'mongle-keyboard-e2e'));await mkdir(parent,{recursive:true});
  const root=await mkdtemp(path.join(parent,'codex-')),dataDir=path.join(root,'host'),profile=path.join(root,'codex-profile'),workspace=path.join(root,'workspace');
  await mkdir(profile);await mkdir(workspace);
  // The test never submits a model request. A loopback-only provider also prevents
  // accidental use of real credentials or a billable external model endpoint.
  await writeFile(path.join(profile,'config.toml'),'model_provider = "input-test"\nmodel = "gpt-4.1"\ncheck_for_update_on_startup = false\n[history]\npersistence = "none"\n[analytics]\nenabled = false\n[model_providers.input-test]\nname = "Input test (local only)"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n');
  const output=path.resolve(`test-results/e2e/codex-keyboard-${shell}-${launchArgs.includes('--no-daemon')?'direct':'default'}${packaged?'-packaged':''}`);await mkdir(output,{recursive:true});
  const previousHelper=process.env.MONGLE_OWNER_HELPER;
  if(packaged)process.env.MONGLE_OWNER_HELPER=path.join(path.dirname(appExecutable),'resources/hostbundle/platform/windows/OwnerPipe.exe');
  let app:ElectronApplication|undefined,owner:Awaited<ReturnType<typeof connectOwnerPipe>>|undefined;
  const result:{passed:boolean;checks:string[];error?:string;cleanupError?:string}={passed:false,checks:[]};
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined&&!/^(CODEX_|OPENAI_)/i.test(entry[0])));delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:appExecutable,args:packaged?[]:[process.cwd()],cwd:process.cwd(),env:{...env,MONGLE_DATA_DIR:dataDir},timeout:30000});
    const page=await app.firstWindow();page.setDefaultTimeout(20000);await expect(page.getByRole('button',{name:'프로젝트 열기',exact:true})).toBeEnabled();
    owner=await connectOwnerPipe({dataDir});const initial=await owner.request<HostState>('state.get'),group=initial.groups[0];
    await owner.request('groups.update',{id:group.id,revision:group.revision,name:'키보드 확인',cwd:workspace,profileId:'cmd'});
    const terminal=await owner.request<TerminalInfo>('terminals.create',{groupId:group.id,profileId:'cmd',cwd:workspace});
    const pane=page.locator(`[data-terminal-id="${terminal.id}"]`);await expect(pane).toBeVisible();await pane.locator('.xterm-screen').click({position:{x:20,y:40}});
    // A prompt in scrollback is not a ready shell. Wait for the current tail so
    // fast typing after Codex/PowerShell exits cannot race the process handoff.
    const prompt=async(value:string)=>expect.poll(async()=>{
      const rows=await pane.locator('.xterm-rows > div').allTextContents();
      return rows.map(row=>row.trim()).filter(Boolean).at(-1);
    },{timeout:15000}).toBe(value);
    await expect(pane.locator('.controlled')).toBeVisible();
    await prompt(`${workspace}>`);
    if(shell==='powershell'){
      const ps=initial.profiles.find(p=>p.id==='powershell')||initial.profiles.find(p=>p.kind==='powershell');assert.ok(ps);
      const init=`Set-PSReadLineOption -HistorySaveStyle SaveNothing; $env:CODEX_HOME='${profile.replaceAll("'","''")}'`;
      await page.keyboard.type(`"${ps.executable}" -NoLogo -NoProfile -NoExit -Command "${init}"`,{delay:2});await page.keyboard.press('Enter');
      await prompt(`PS ${workspace}>`);
      await page.keyboard.type(`& '${executable.replaceAll("'","''")}' ${launchArgs} -C '${workspace.replaceAll("'","''")}'`,{delay:2});
    }else await page.keyboard.type(`set "CODEX_HOME=${profile}"&& "${executable}" ${launchArgs} -C "${workspace}"`,{delay:2});
    await page.keyboard.press('Enter');
    // The composer is drawn before startup onboarding settles. Do not type into
    // that transient frame: Enter could select setup instead of editing text.
    await expect(pane.locator('.xterm-rows')).toContainText('OpenAI Codex',{timeout:15000});
    for(let attempt=0;attempt<60;attempt++){
      const text=await pane.locator('.xterm-rows').innerText();
      if(text.includes('Set up default sandbox')){await page.keyboard.press('Escape');await page.waitForTimeout(250);break;}
      if(text.includes('Ask Codex to do anything')&&!text.includes('Input disabled')){
        await page.waitForTimeout(1500);
        const next=await pane.locator('.xterm-rows').innerText();
        if(next.includes('Ask Codex to do anything')&&!next.includes('Set up default sandbox')&&!next.includes('Input disabled'))break;
      }
      await page.waitForTimeout(250);
    }
    await expect(pane.locator('.xterm-rows')).not.toContainText('Input disabled',{timeout:20000});
    await expect(pane.locator('.xterm-rows')).not.toContainText('enter select');
    await page.keyboard.press('Control+u');await page.keyboard.type('FIRST_LINE',{delay:15});
    // Never press Enter while an onboarding modal owns input.
    await expect(pane.locator('.xterm-rows')).toContainText('FIRST_LINE');
    await page.keyboard.press('Shift+Enter');await page.keyboard.type('SECOND_LINE',{delay:15});
    await expect.poll(async()=>{
      const rows=await pane.locator('.xterm-rows > div').allTextContents();
      const first=rows.findIndex(row=>row.includes('FIRST_LINE')),second=rows.findIndex(row=>row.includes('SECOND_LINE'));
      return first>=0&&second===first+1&&!rows.some(row=>row.includes('FIRST_LINE')&&row.includes('SECOND_LINE'));
    }).toBe(true);
    await page.screenshot({animations:'disabled',path:path.join(output,'codex-shift-enter.png')});
    result.checks.push('Installed Codex TUI keeps two typed lines in its composer after a real browser Shift+Enter; no prompt submitted.');
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Process',code:'Enter',windowsVirtualKeyCode:229,nativeVirtualKeyCode:13,modifiers:8});
    await cdp.send('Input.insertText',{text:'한'});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,modifiers:8});
    await page.keyboard.type('THIRD_LINE',{delay:15});
    await expect.poll(async()=>{
      const rows=await pane.locator('.xterm-rows > div').allTextContents(),second=rows.findIndex(row=>row.includes('SECOND_LINE한')),third=rows.findIndex(row=>row.includes('THIRD_LINE'));
      return second>=0&&third===second+1;
    }).toBe(true);
    await page.screenshot({animations:'disabled',path:path.join(output,'codex-korean-shift-enter.png')});
    await cdp.detach();result.checks.push('Chromium IME composition commits the final Korean syllable before Shift+Enter exactly once in the actual Codex composer.');
    await page.keyboard.press('Control+c');await page.waitForTimeout(200);await page.keyboard.press('Control+c');
    if(shell==='powershell'){await prompt(`PS ${workspace}>`);await page.keyboard.type('exit');await page.keyboard.press('Enter');}
    await prompt(`${workspace}>`);
    await page.keyboard.type('echo NORMAL_ENTER_OK>enter-result.txt');await page.keyboard.press('Enter');
    await expect.poll(()=>readFile(path.join(workspace,'enter-result.txt'),'utf8').catch(()=>'')).toContain('NORMAL_ENTER_OK');
    result.checks.push('Normal Enter still executes a command in the parent CMD shell after Codex exits.');result.passed=true;
  }catch(error){result.error=String(error);await app?.windows()[0]?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;}
  finally{await app?.close().catch(()=>{});if(!owner)owner=await connectOwnerPipe({dataDir}).catch(()=>undefined);if(owner){try{await owner.request('host.shutdown');}catch(error){result.cleanupError=String(error);}owner.close();}if(previousHelper===undefined)delete process.env.MONGLE_OWNER_HELPER;else process.env.MONGLE_OWNER_HELPER=previousHelper;await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2));}
});
