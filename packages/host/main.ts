import { writeFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { HostCore } from './core';
import { startGateway } from './gateway';
import { startOwnerPipe } from '../local-ipc/index';
import { AppError, type ConnectionContext, type Send } from '../protocol';
import { RemoteSetup } from './remote';

async function main() {
const { values } = parseArgs({ options: { 'data-dir': {type:'string'}, port:{type:'string'}, 'web-root':{type:'string'}, name:{type:'string'} } });
const dataDir = path.resolve(values['data-dir'] ?? process.env.MONGLE_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'MongleTerminal'));
const webRoot = path.resolve(values['web-root'] ?? path.join(path.dirname(process.argv[1]), '../web'));
const bundledHelper = path.resolve(path.dirname(process.argv[1]), '../../platform/windows/OwnerPipe.exe');
if (!process.env.MONGLE_OWNER_HELPER && existsSync(bundledHelper)) process.env.MONGLE_OWNER_HELPER = bundledHelper;
let core: HostCore | undefined;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let remote: RemoteSetup | undefined;
let closing = false;
let shutdownAccepted = false;
const owners = new Map<string, {ctx:ConnectionContext;send:Send}>();
let ownerPipe: Awaited<ReturnType<typeof startOwnerPipe>> | undefined;
let ownerPipeLost = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await gateway?.close();
  await core?.close();
  // Remove only this boot's readiness record while its instance guard is held.
  try { const info=JSON.parse(await readFile(path.join(dataDir,'host-info.json'),'utf8')); if(info.bootId===core?.getState().bootId)await unlink(path.join(dataDir,'host-info.json')); } catch {}
  await ownerPipe?.close();
  process.exit(0);
}
try {
  ownerPipe = await startOwnerPipe({
    dataDir,
    onConnect(ctx:ConnectionContext, send:Send) { owners.set(ctx.id,{ctx,send}); core?.connect(ctx,send); },
    async onRequest(method:string, params:unknown, ctx:ConnectionContext) {
      if (!core || !gateway || closing || shutdownAccepted) throw new AppError('HOST_UNAVAILABLE','실행부를 준비하거나 종료하고 있습니다.');
      if (method === 'host.shutdown') {
        // Acknowledge only after durable, queued preflight. Storage failure must
        // reach the owner before anything closes so the GUI can remain open.
        const result=await core.handle(method,params,ctx);
        shutdownAccepted=true;
        setTimeout(()=>void shutdown(),100);
        return result;
      }
      if (method === 'host.info') return {port:gateway.port,dataDir,hostId:core.getState().hostId,bootId:core.getState().bootId};
      if (method === 'remote.diagnose') return remote?.diagnose();
      if (method === 'remote.enable') return remote?.enable();
      if (method === 'remote.disable') return remote?.disable();
      if (/^(pairing\.|devices\.|remote\.)/.test(method)) return gateway.ownerRequest(method,params);
      return core.handle(method,params,ctx);
    },
    onDisconnect(id:string) { owners.delete(id); core?.disconnect(id); },
    onError() { ownerPipeLost=true; if(ownerPipe){process.stderr.write('Owner channel failed; shutting down the host safely.\n');void shutdown();} }
  });
  if(ownerPipeLost)throw new AppError('IPC_CLOSED','로컬 연결 실행부가 중단되었습니다.');
  core = new HostCore({dataDir,name:values.name});
  await core.init();
  let port=values.port?Number(values.port):0;
  if(!values.port) {try {const stored=JSON.parse(await readFile(path.join(dataDir,'gateway-port.json'),'utf8'));if(Number.isInteger(stored.port)&&stored.port>1024&&stored.port<65536)port=stored.port;}catch{}}
  gateway = await startGateway({core,dataDir,webRoot,port});
  await writeFile(path.join(dataDir,'gateway-port.json'),JSON.stringify({port:gateway.port}));
  remote = new RemoteSetup(dataDir,gateway.port,origin=>gateway!.ownerRequest('remote.configure',{origin}));
  for (const {ctx,send} of owners.values()) core.connect(ctx,send);
  gateway.onOwnerEvents(event => { for (const {send} of owners.values()) send(event); });
  await writeFile(path.join(dataDir,'host-info.json'), JSON.stringify({pid:process.pid,hostId:core.getState().hostId,bootId:core.getState().bootId,port:gateway.port,protocolVersion:1}));
  process.stdout.write(JSON.stringify({ready:true,pid:process.pid,port:gateway.port})+'\n');
  process.on('SIGINT',()=>void shutdown());
  process.on('SIGTERM',()=>void shutdown());
} catch(error) {
  process.stderr.write(`Host startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  await gateway?.close().catch(()=>{});
  await core?.close().catch(()=>{});
  await ownerPipe?.close().catch(()=>{});
  process.exitCode=1;
}
}
void main().catch(()=>{ process.stderr.write('Host startup failed.\n'); process.exitCode=1; });
