import { spawn } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHostReadiness } from '../../apps/desktop/full-exit';
import { connectOwnerPipe } from '../../packages/local-ipc/index';
import type { HostState } from '../../packages/protocol';

export interface HostStartupProbeResult {
  started: boolean;
  ready: boolean;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stderrTruncated: boolean;
  error?: string;
  cleanup: { method: 'not-needed' | 'normal' | 'forced'; exited: boolean; error?: string };
}

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function strictChild(parent:string,candidate:string){const relative=path.relative(parent,candidate);return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);}
async function bounded<T>(promise:Promise<T>,ms:number,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** Failure diagnostics only. Never substitute this host for the E2E's own host. */
export async function probeHostStartup(options:{buildRoot:string;isolated:string;timeoutMs?:number}):Promise<HostStartupProbeResult>{
  const result:HostStartupProbeResult={started:false,ready:false,timedOut:false,exitCode:null,signal:null,stderr:'',stderrTruncated:false,cleanup:{method:'not-needed',exited:true}};
  const buildRoot=path.resolve(options.buildRoot),isolated=path.resolve(options.isolated);
  const redact=(value:unknown)=>{
    let text=value instanceof Error?value.message:String(value);
    for(const [source,replacement] of [[isolated,'<isolated-profile>'],[buildRoot,'<build-root>'],[process.env.USERPROFILE,'<user-profile>']] as const){
      if(source)for(const variant of [source,source.replaceAll('\\','/')])text=text.replaceAll(variant,replacement);
    }
    return text.replace(/\b(?:[A-Fa-f0-9]{64}|[A-Za-z0-9_-]{43})\b/g,'<redacted>').slice(-8192);
  };
  let child:ReturnType<typeof spawn>|undefined,exited=true,closed=true;
  let owner:Awaited<ReturnType<typeof connectOwnerPipe>>|undefined;
  let abandonConnection=false,stderr='';
  try{
    if(process.platform!=='win32')throw new Error('The host startup probe requires Windows.');
    const temporary=await realpath(tmpdir()),actualIsolated=await realpath(isolated);
    if(!strictChild(temporary,actualIsolated))throw new Error('The startup probe must stay inside an isolated TEMP directory.');
    const dataDir=path.join(actualIsolated,'probe-profile');
    // Never reuse an existing profile or create the final folder on behalf of
    // the host: its own mkdir/OwnerPipe initialization is what this probes.
    try{await lstat(dataDir);throw new Error('The startup probe profile already exists.');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const executable=path.join(buildRoot,'runtime/node.exe'),entry=path.join(buildRoot,'dist/host/main.cjs'),helper=path.join(buildRoot,'platform/windows/OwnerPipe.exe');
    await Promise.all([executable,entry,helper].map(file=>access(file)));
    const env:NodeJS.ProcessEnv={...process.env,MONGLE_DATA_DIR:dataDir,MONGLE_OWNER_HELPER:helper,MONGLE_NATIVE_HELPER:helper};
    // Match Playwright's Electron environment; never inherit a Node preload or
    // Electron-as-Node switch into this standalone diagnostic process.
    delete env.NODE_OPTIONS;delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(executable,[entry,'--data-dir',dataDir],{cwd:buildRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    exited=false;closed=false;result.cleanup.exited=false;
    child.once('spawn',()=>{result.started=true;});
    child.once('error',error=>{result.error=redact(error);if(!child?.pid)exited=true;});
    child.once('exit',(code,signal)=>{result.exitCode=code;result.signal=signal;exited=true;});
    child.once('close',()=>{closed=true;});
    // Drain stdout without recording readiness identifiers or terminal data.
    child.stdout!.resume();
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data',(chunk:string)=>{stderr+=chunk;if(stderr.length>8192){result.stderrTruncated=true;stderr=stderr.slice(-8192);}});
    const deadline=Date.now()+Math.max(1000,Math.min(options.timeoutMs??10000,10000));
    while(!exited&&Date.now()<deadline){
      const readiness=await readHostReadiness(dataDir);
      if(readiness){
        if(readiness.pid!==child.pid)throw new Error('Probe readiness does not match the process started by this probe.');
        result.ready=true;
        const connection=connectOwnerPipe({dataDir});
        void connection.then(value=>{if(abandonConnection)value.close();},()=>{});
        owner=await bounded(connection,5000,'Probe owner connection timed out.');
        const state=await bounded(owner.request<HostState>('state.get'),5000,'Probe state request timed out.');
        if(state.hostId!==readiness.hostId||state.bootId!==readiness.bootId||state.terminals.length!==0)throw new Error('Probe owner identity or empty-profile check failed.');
        result.cleanup.method='normal';
        await bounded(owner.request('host.shutdown'),5000,'Probe normal shutdown timed out.');
        break;
      }
      await delay(100);
    }
    result.timedOut=!exited&&!result.ready;
  }catch(error){result.error=redact(error);}
  finally{
    abandonConnection=true;owner?.close();
    if(child&&!exited){
      if(result.cleanup.method==='normal'){
        const deadline=Date.now()+5000;while(!exited&&Date.now()<deadline)await delay(50);
      }
      if(!exited){
        // Only this retained ChildProcess may be terminated; never enumerate
        // user hosts or kill a process tree. Its OwnerPipe receives stdin EOF.
        result.cleanup.method='forced';
        try{if(!child.kill())result.cleanup.error='The probe process could not be terminated.';}
        catch(error){result.cleanup.error=redact(error);}
        const deadline=Date.now()+5000;while(!exited&&Date.now()<deadline)await delay(50);
      }
    }
    result.cleanup.exited=exited;
    if(!exited)result.cleanup.error??='The explicitly spawned probe process did not exit.';
    const drainDeadline=Date.now()+500;while(exited&&!closed&&Date.now()<drainDeadline)await delay(20);
    result.stderr=redact(stderr);
  }
  return result;
}
