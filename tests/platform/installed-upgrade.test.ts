import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs';
import { promisify } from 'node:util';
import { readFile, mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PREVIOUS_PUBLIC_VERSION, updateInstallerArgs, assertUpdateWindows, assertExactAgentRestores, findUpdatedDesktop, boundedObserverEvents, readInstalledHost, type WindowEvidence, type AgentFixtureRecord } from '../fixtures/installed-upgrade-evidence';

const run=promisify(execFile);
test('installed readiness retries missing/stale host-info and retains only a coherent authenticated connection',async()=>{
  const state={version:'0.3.16',hostId:'host',bootId:'boot'};
  const info={pid:42,hostId:'host',bootId:'boot'};
  const expected={version:'0.3.16',hostId:'host',dataDir:path.resolve('fixture-profile')};
  let closed=0;
  const connect=async()=>({close(){closed++;},async request<T>(name:string){return (name==='state.get'?state:{...info,dataDir:expected.dataDir}) as T;}});
  await assert.rejects(readInstalledHost(connect,async()=>{throw Object.assign(new Error('not written yet'),{code:'ENOENT'});},expected),{code:'ENOENT'});
  assert.equal(closed,1);
  await assert.rejects(readInstalledHost(connect,async()=>({...info,bootId:'previous-boot'}),expected));
  assert.equal(closed,2);
  const ready=await readInstalledHost(connect,async()=>info,expected);
  assert.equal(ready.info.pid,42);assert.equal(closed,2);
  ready.connection.close();assert.equal(closed,3);
  // Old desktop cleanup must keep its actual version rather than the candidate.
  await assert.rejects(readInstalledHost(connect,async()=>info,{...expected,version:'0.3.17'}));
  assert.equal(closed,4);
  for(const patch of [{hostId:'unrelated'},{bootId:'other'},{pid:43},{dataDir:path.resolve('wrong-profile')}]) {
    const wrong=async()=>({close(){closed++;},async request<T>(name:string){return (name==='state.get'?state:{...info,dataDir:expected.dataDir,...patch}) as T;}});
    await assert.rejects(readInstalledHost(wrong,async()=>info,expected));
  }
  assert.equal(closed,8);
  await assert.rejects(readInstalledHost(connect,async()=>info,{...expected,hostId:'another-owner'}));
  assert.equal(closed,9);
});
test('native realpath expands actual Windows short aliases without accepting another file',{skip:process.platform!=='win32'},async t=>{
  // A workspace file avoids MSIX TEMP redirection between Node and PowerShell.
  const base=path.resolve('.test-data');await mkdir(base,{recursive:true});
  const directory=await mkdtemp(path.join(base,'mongle-upgrade-path-'));
  t.after(async()=>{assert.equal(path.dirname(directory),base);assert.ok(path.basename(directory).startsWith('mongle-upgrade-path-'));await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'long executable name.exe'),other=path.join(directory,'other.exe');
  await writeFile(file,'fixture');await writeFile(other,'different fixture');
  const script=`Add-Type 'using System.Text; using System.Runtime.InteropServices; public class UpgradeShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder result, uint size); }'; $b=[Text.StringBuilder]::new(32768); $n=[UpgradeShortPath]::GetShortPathName($env:MONGLE_TEST_PATH,$b,32768); if($n -eq 0 -or $n -ge 32768){throw ('GetShortPathName failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()+' path='+$env:MONGLE_TEST_PATH)}; $b.ToString()`;
  const short=(await run('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,MONGLE_TEST_PATH:file},windowsHide:true,timeout:10000})).stdout.trim();
  const canonical=promisify(realpath.native);
  assert.equal(await canonical(short),await canonical(file));
  assert.notEqual(await canonical(short),await canonical(other));
  await assert.rejects(canonical(path.join(directory,'missing.exe')),{code:'ENOENT'});
  if(short.toLowerCase()===file.toLowerCase())t.diagnostic('8.3 aliases unavailable on this volume; existing-path identity checked only');
});
const installer='C:\\fixture\\Setup.exe', exe='C:\\fixture\\installed\\MongleTerminal.exe';
const progress:WindowEvidence={kind:'installer',pid:10,path:installer,visible:true,progress:true,commandLine:'',time:'2026-10-08T00:00:00.000Z'};
const desktop:WindowEvidence={kind:'desktop',pid:20,path:exe,visible:true,progress:false,commandLine:'"'+exe+'" --updated',time:'2026-10-08T00:00:01.000Z'};
test('observer diagnostics preserve raw failed observations with bounded records and line length',()=>{
  const raw=JSON.stringify({...desktop,path:'C:\\Users\\RUNNER~1\\app.exe'});
  assert.deepEqual(boundedObserverEvents('\uFEFF'+raw+'\r\n{partial'),{totalLines:2,rawLines:[raw,'{partial']});
  const bounded=boundedObserverEvents(Array.from({length:100},(_,i)=>String(i)+':'+ 'x'.repeat(9000)).join('\n'));
  assert.equal(bounded.totalLines,100);assert.equal(bounded.rawLines.length,64);
  assert.ok(bounded.rawLines[0].startsWith('36:'));
  assert.ok(bounded.rawLines.every(line=>line.length===8192));
});
test('both updater generations keep real update/relaunch flags and NSIS /D last',()=>{
  assert.equal(PREVIOUS_PUBLIC_VERSION,'0.3.16');
  assert.deepEqual(updateInstallerArgs('C:\\install path',true),['/S','--updated','--force-run','/currentuser','/D=C:\\install path']);
  assert.deepEqual(updateInstallerArgs('C:\\install path',false),['--updated','--force-run','/currentuser','/D=C:\\install path']);
});
test('visible updates preserve existing custom /D paths before the actual file installation page',async()=>{
  const template=await readFile('node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh','utf8');
  const include=await readFile('platform/windows/installer.nsh','utf8');
  // Pin the real builder contract: its pre-callback runs even if the preceding
  // directory page was skipped, and appends the name to a custom silent path.
  assert.match(template,/Function instFilesPre[\s\S]*?StrCpy \$INSTDIR "\$INSTDIR\\\$\{APP_FILENAME\}"[\s\S]*?FunctionEnd/);
  assert.ok(template.indexOf('!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre')<template.indexOf('!insertmacro customPageAfterChangeDir'));
  assert.ok(template.indexOf('!insertmacro customPageAfterChangeDir')<template.indexOf('!insertmacro MUI_PAGE_INSTFILES'));
  const override=include.match(/!macro customPageAfterChangeDir\s+([\s\S]*?)!macroend/)?.[1];assert.ok(override);
  assert.match(override,/!undef MUI_PAGE_CUSTOMFUNCTION_PRE\s+!define MUI_PAGE_CUSTOMFUNCTION_PRE mongleInstallFilesPre/);
  assert.match(override,/Function mongleInstallFilesPre\s+\$\{if\} \$\{isUpdated\}\s+\$\{andIf\} \$\{isForceRun\}\s+Return\s+\$\{endIf\}\s+Call instFilesPre\s+FunctionEnd/);
  assert.doesNotMatch(override,/StrCpy|ExecShell|ExecWait|Exec /,'callback only preserves the already resolved path, never launches an app');
});
test('window proof requires a visible NSIS progress control and the actual automatic --updated launch',()=>{
  assert.equal(assertUpdateWindows([progress,desktop],installer,exe,[20]).desktop.pid,20,'normal exit permits OS PID reuse');
  for(const events of [
    [desktop],
    [{...progress,visible:false},desktop],
    [{...progress,progress:false},desktop],
    [{...progress,path:'C:\\unrelated\\Setup.exe'},desktop],
    [progress,{...desktop,path:'C:\\other\\MongleTerminal.exe'}],
    [progress,{...desktop,commandLine:exe}],
    [progress,{...desktop,commandLine:exe+' --updated-other'}],
    [progress,{...desktop,time:'2026-10-07T23:59:00.000Z'}],
  ])assert.throws(()=>assertUpdateWindows(events,installer,exe,[]));
});
test('failed progress observation still tracks the exact automatic desktop for normal cleanup',()=>{
  const since='2026-10-08T00:00:00.000Z';
  assert.throws(()=>assertUpdateWindows([desktop],installer,exe,[]),'missing progress remains a failure');
  assert.equal(findUpdatedDesktop([desktop],exe,since)?.pid,desktop.pid);
  assert.equal(findUpdatedDesktop([{...desktop,visible:false}],exe,since)?.pid,desktop.pid,'process-only fallback can clean up a hidden desktop');
  for (const invalid of [
    {...desktop,path:'C:\\unrelated\\MongleTerminal.exe'},
    {...desktop,commandLine:exe},
    {...desktop,commandLine:exe+' --updated --type=renderer'},
    {...desktop,time:'2026-10-07T00:00:00.000Z'},
  ])assert.equal(findUpdatedDesktop([invalid],exe,since),undefined);
});
const sessions=[
  {provider:'claude',sessionId:'11111111-1111-4111-8111-111111111111'},
  {provider:'claude',sessionId:'22222222-2222-4222-8222-222222222222'},
  {provider:'codex',sessionId:'33333333-3333-4333-8333-333333333333'},
  {provider:'codex',sessionId:'44444444-4444-4444-8444-444444444444'},
];
const cwd='C:\\same workspace';
const records=():AgentFixtureRecord[]=>sessions.map(s=>({...s,cwd,pid:42,resumed:true,args:s.provider==='codex'?['resume','--no-daemon',s.sessionId]:['--resume',s.sessionId]}));
test('same-cwd fixture proof rejects missing, duplicated, wrong identity and latest-session resumes',()=>{
  assert.doesNotThrow(()=>assertExactAgentRestores(sessions,records(),cwd));
  assert.throws(()=>assertExactAgentRestores(sessions,records().slice(1),cwd));
  assert.throws(()=>assertExactAgentRestores(sessions,[...records(),records()[0]],cwd));
  const swapped=records();swapped[1].sessionId=swapped[0].sessionId;
  assert.throws(()=>assertExactAgentRestores(sessions,swapped,cwd));
  for(const patch of [{resumed:false},{cwd:'C:\\other'},{args:['--last']},{args:['--continue']}]) {
    const broken=records();Object.assign(broken[0],patch);
    assert.throws(()=>assertExactAgentRestores(sessions,broken,cwd));
  }
  const daemon=records();daemon[2].args=['resume',daemon[2].sessionId];
  assert.throws(()=>assertExactAgentRestores(sessions,daemon,cwd));
});
test('destructive installed-upgrade entry refuses local and self-hosted runs before installing',async()=>{
  for(const env of [{GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'github-hosted'},{GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'self-hosted'}]) {
    await assert.rejects(run(process.execPath,['--import','tsx','scripts/verify-installed-upgrade.ts'],{env:{...process.env,...env},timeout:20000}), (error:any)=>{
      assert.match(error.stderr,/Never install over|disposable hosted runner|win32/);return true;
    });
  }
});
test('Windows GUI fixture is syntax checked without loading Win32 code or operating a desktop',{skip:process.platform!=='win32'},async()=>{
  const file='tests/fixtures/installed-upgrade-windows.ps1';
  const command="$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path '"+file+"'),[ref]$t,[ref]$e); if($e.Count){$e | ForEach-Object {$_.ToString()}; exit 1}";
  await run('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:20000});
  const source=await readFile(file,'utf8');
  assert.ok(source.indexOf("RUNNER_ENVIRONMENT -ne 'github-hosted'")<source.indexOf('Add-Type'));
});

test('native observation bridge and isolated CLI launchers compile; fixture version probes launch no model',{skip:process.platform!=='win32'},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mongle-upgrade-helper-'));
  t.after(async()=>{assert.equal(path.dirname(directory),tmpdir());assert.ok(path.basename(directory).startsWith('mongle-upgrade-helper-'));await rm(directory,{recursive:true,force:true});});
  const source=await readFile('tests/fixtures/installed-upgrade-windows.ps1','utf8');
  const bridge=source.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/)?.[1];assert.ok(bridge);
  await writeFile(path.join(directory,'Bridge.cs'),bridge);
  const csc=path.join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  await run(csc,['/nologo','/target:library','/out:'+path.join(directory,'Bridge.dll'),path.join(directory,'Bridge.cs')],{windowsHide:true,timeout:20000});
  await run(csc,['/nologo','/out:'+path.join(directory,'claude.exe'),path.resolve('tests/fixtures/InstalledUpgradeAgent.cs')],{windowsHide:true,timeout:20000});
  await copyFile(path.join(directory,'claude.exe'),path.join(directory,'codex.exe'));
  await copyFile('tests/fixtures/installed-upgrade-agent.cjs',path.join(directory,'agent.cjs'));
  await writeFile(path.join(directory,'node.path'),process.execPath);
  await writeFile(path.join(directory,'fixture.json'),'{}');
  assert.equal((await run(path.join(directory,'claude.exe'),['--version'],{windowsHide:true,timeout:5000})).stdout.trim(),'2.1.292');
  assert.equal((await run(path.join(directory,'codex.exe'),['--version'],{windowsHide:true,timeout:5000})).stdout.trim(),'codex-cli 0.160.0');
});
