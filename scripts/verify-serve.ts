/** Manual integration check: temporarily creates a PRIVATE Serve route, restores it. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchHost } from '../apps/desktop/runtime';
import { connectOwnerPipe } from '../packages/local-ipc/index';
import WebSocket from 'ws';
const root=process.cwd(), dataDir=path.join(root,'.test-data',`serve-${randomUUID()}`);
await mkdir(dataDir,{recursive:true});
process.env.MONGLE_OWNER_HELPER=path.join(root,'platform/windows/OwnerPipe.exe');
let owner:Awaited<ReturnType<typeof connectOwnerPipe>>|undefined;
let socket:WebSocket|undefined;
const result:Record<string,unknown>={testedAt:new Date().toISOString(),scope:'This Windows PC through private Tailscale HTTPS/WSS. Other PC and physical mobile not tested.'};
try {
  await launchHost(root,dataDir);
  const deadline=Date.now()+30_000;
  while(!owner&&Date.now()<deadline){try {const candidate=await connectOwnerPipe({dataDir});try{await candidate.request('state.get');owner=candidate;}catch{candidate.close();}}catch{}if(!owner)await new Promise(r=>setTimeout(r,250));}
  if(!owner)throw new Error('Test host did not start.');
  const state=await owner.request('state.get');
  const remote=await owner.request('remote.enable');
  result.serveEnabled=true;
  const origin=remote.origin;
  const health=await fetch(`${origin}/health`,{signal:AbortSignal.timeout(15_000)}).then(r=>r.json()) as any;
  if(health.hostId!==state.hostId)throw new Error('HTTPS host identity mismatch.');
  const post=async(route:string,body:unknown,cookie?:string,csrf?:string)=>{
    const response=await fetch(`${origin}${route}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});
    const data=await response.json() as any;
    if(!response.ok)throw new Error(`HTTPS request rejected: ${data.error?.code??response.status}`);
    return {data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const code=await owner.request('pairing.create');
  const pairing=(await post('/v1/pairings/request',{code:code.code,name:'연결 검증용 기기'})).data;
  await owner.request('pairing.approve',{requestId:pairing.requestId});
  const claim=await post('/v1/pairings/claim',{requestId:pairing.requestId,requesterSecret:pairing.requesterSecret});
  const ticket=(await post('/v1/ws-ticket',{},claim.cookie,claim.data.csrf)).data.ticket;
  socket=new WebSocket(`${origin.replace('https:','wss:')}/v1/ws`,{headers:{Origin:origin,Cookie:claim.cookie!}});
  const received=await new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('WSS timeout')),15_000);
    socket!.on('error',error=>{clearTimeout(timer);reject(error);});
    socket!.on('open',()=>socket!.send(JSON.stringify({type:'authenticate',ticket})));
    socket!.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='authenticated')socket!.send(JSON.stringify({type:'request',id:'verify-state',method:'state.get',params:{}}));if(message.type==='response'&&message.id==='verify-state'){clearTimeout(timer);resolve(message);}});
  });
  if(!received.ok||received.result.hostId!==state.hostId)throw new Error('WSS state mismatch.');
  result.status='PASS';result.https=true;result.pairing=true;result.websocket=true;
} catch(error) {result.status='BLOCKED';result.reason=error instanceof Error?error.message:String(error);const cause=(error as {cause?:{code?:string;message?:string}})?.cause;if(cause)result.cause={code:cause.code,message:cause.message};}
finally {
  socket?.terminate();
  if(owner){try{result.cleanup=await owner.request('remote.disable');}catch{result.cleanup='Could not confirm Serve cleanup.';}try{await owner.request('host.shutdown');}catch{}owner.close();}
  await mkdir(path.join(root,'docs/validation'),{recursive:true});
  await writeFile(path.join(root,'docs/validation/serve-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
