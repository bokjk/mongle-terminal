import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
const exec=promisify(execFile);
const openssl='C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
test('Electron remote bridge pairs, reuses isolated cookies and withholds credentials on identity change', {skip:process.platform!=='win32'||!existsSync(openssl),timeout:45000},async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'mongle-remote-'));
  try {
    await exec(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost'],{windowsHide:true});
    await build({entryPoints:['tests/platform/remote-probe.ts'],outfile:path.join(directory,'probe.cjs'),bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron','bufferutil','utf-8-validate'],logLevel:'silent'});
    const env: NodeJS.ProcessEnv={...process.env,MONGLE_REMOTE_PROBE:directory};delete env.ELECTRON_RUN_AS_NODE;
    await exec(path.resolve('node_modules/electron/dist/electron.exe'),[path.join(directory,'probe.cjs')],{env,windowsHide:true,timeout:35000,maxBuffer:65536});
    const result=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));assert.equal(result.ok,true,result.error);
  } finally {await rm(directory,{recursive:true,force:true});}
});
