import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteSetup } from '../../packages/host/remote';

const dnsName='test.tail.ts.net', gatewayPort=43123, proxy=`http://127.0.0.1:${gatewayPort}`;
const endpoint=(port=443,target=proxy,dns=dnsName)=>({origin:`https://${dns}${port===443?'':`:${port}`}`,dnsName:dns,httpsPort:port,proxy:target});
const served=(port=443,target=proxy,dns=dnsName):any=>({TCP:{[port]:{HTTPS:true}},Web:{[`${dns}:${port}`]:{Handlers:{'/':{Proxy:target}}}}});
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}, initial:any={}, record?:unknown) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'mongle-remote-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'remote-serve.json');
  if(record!==undefined)await writeFile(file,typeof record==='string'?record:JSON.stringify(record));
  let config=structuredClone(initial), reads=0;
  const configured:(string|null)[]=[], mutations:string[][]=[];
  const setup=new RemoteSetup(dir,gatewayPort,async origin=>{configured.push(origin);});
  (setup as any).config=async()=>{reads++;return structuredClone(config);};
  (setup as any).run=async(args:string[])=>{
    if(args[0]==='status')return JSON.stringify({BackendState:'Running',Self:{DNSName:`${dnsName}.`}});
    mutations.push(args);
    const port=Number(args.find(arg=>arg.startsWith('--https='))?.split('=')[1]);
    if(args.includes('off')) {
      delete config.TCP?.[port];
      for(const key of Object.keys(config.Web??{}))if(key.endsWith(`:${port}`))delete config.Web[key];
    } else {
      (config.TCP??={})[port]={HTTPS:true};
      (config.Web??={})[`${dnsName}:${port}`]={Handlers:{'/':{Proxy:args.at(-1)}}};
    }
    return '';
  };
  return {setup,dir,file,configured,mutations,get config(){return config;},set config(value:any){config=structuredClone(value);},get reads(){return reads;}};
}

test('remote disable revokes gateway before attempting any VPN cleanup', async()=>{
  const calls:string[]=[];
  const setup = new RemoteSetup('unused',43123,async origin=>{calls.push(`configure:${origin}`);});
  (setup as any).managed=async()=>({origin:'https://test.tail.ts.net',dnsName:'test.tail.ts.net',httpsPort:443,proxy:'http://127.0.0.1:43123'});
  (setup as any).config=async()=>{calls.push('config');throw new Error('offline');};
  const result=await setup.disable();
  assert.deepEqual(calls,['configure:null','config']);
  assert.equal(result.ok,true);assert.equal(result.serveRemoved,false);assert.ok(result.warning);
});
test('remote disable preserves a Serve handler modified by another application',async()=>{
  let called=false;
  const setup=new RemoteSetup('unused',43123,async()=>{});
  (setup as any).managed=async()=>({origin:'https://test.tail.ts.net',dnsName:'test.tail.ts.net',httpsPort:443,proxy:'http://127.0.0.1:43123'});
  (setup as any).config=async()=>({Web:{'test.tail.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}}}});
  (setup as any).run=async()=>{called=true;};
  assert.equal((await setup.disable()).serveRemoved,false);assert.equal(called,false);
});
test('remote enable refuses a shared HTTPS cookie host without modifying Serve',async()=>{
  const setup=new RemoteSetup('unused',43123,async()=>{throw new Error('must not configure');});
  const calls:string[][]=[];
  (setup as any).managed=async()=>null;
  (setup as any).config=async()=>({Web:{'test.tail.ts.net:8443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}}}});
  (setup as any).run=async(args:string[])=>{calls.push(args);return JSON.stringify({BackendState:'Running',Self:{DNSName:'test.tail.ts.net.'}});};
  await assert.rejects(setup.enable(),(e:any)=>e.code==='SERVE_SHARED_HOST');assert.deepEqual(calls,[['status','--json']]);
});

for(const [name,record] of [['missing',undefined],['broken JSON','{'],['invalid origin',{...endpoint(),origin:'https://other.tail.ts.net'}]] as const) {
  test(`remote enable recovers ${name} management record only for its current exact gateway`,async t=>{
    const f=await fixture(t,served(8443),record);
    assert.deepEqual(await f.setup.enable(),endpoint(8443));
    assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),endpoint(8443));
    assert.deepEqual(f.mutations,[]);
    assert.deepEqual(f.configured,[endpoint(8443).origin]);
    assert.equal(f.reads,2);
  });
}

test('remote enable reuses a saved own route and diagnosis confirms the current gateway',async t=>{
  const f=await fixture(t,served(),endpoint());
  assert.deepEqual(await f.setup.enable(),endpoint());
  assert.equal((await f.setup.diagnose()).serveEnabled,true);
  assert.deepEqual(f.mutations,[]);
});

test('remote enable retargets an exclusively owned saved old gateway while retaining its HTTPS port',async t=>{
  const oldProxy='http://127.0.0.1:42000';
  const initial=served(8443,oldProxy);
  initial.TCP['22']={TCPForward:'127.0.0.1:22'};
  const f=await fixture(t,initial,endpoint(8443,oldProxy));
  assert.equal((await f.setup.diagnose()).serveEnabled,false);
  assert.deepEqual(await f.setup.enable(),endpoint(8443));
  assert.deepEqual(f.mutations,[['serve','--bg','--https=8443','--yes',proxy]]);
  assert.deepEqual(f.config.TCP['22'],initial.TCP['22']);
  assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),endpoint(8443));
});

for(const [name,change] of [
  ['unknown other proxy',(c:any)=>{c.Web[`${dnsName}:443`].Handlers['/'].Proxy='http://127.0.0.1:9000';}],
  ['extra path',(c:any)=>{c.Web[`${dnsName}:443`].Handlers['/docs']={Path:'C:\\docs'};}],
  ['other HTTPS port',(c:any)=>{c.TCP['8443']={HTTPS:true};c.Web[`${dnsName}:8443`]={Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}};}],
  ['same DNS with different letter case',(c:any)=>{c.Web[`${dnsName.toUpperCase()}:8443`]={Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}};}],
  ['public Funnel',(c:any)=>{c.AllowFunnel={[`${dnsName}:443`]:true};}],
  ['Funnel on another port',(c:any)=>{c.AllowFunnel={[`${dnsName}:8443`]:true};}],
  ['non-HTTPS TCP handler',(c:any)=>{c.TCP['443']={TCPForward:'127.0.0.1:43123'};}],
  ['mixed TCP handler',(c:any)=>{c.TCP['443'].TCPForward='127.0.0.1:9000';}],
] as const) {
  for(const saved of [false,true])test(`remote enable blocks ${name} with ${saved?'saved':'missing'} record`,async t=>{
    const config=served();change(config);
    const f=await fixture(t,config,saved?endpoint():undefined);
    await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_SHARED_HOST');
    assert.deepEqual(f.mutations,[]);
    assert.deepEqual(f.configured,[]);
    assert.deepEqual(f.config,config);
  });
}

test('remote enable never retargets an old route shared with another DNS name on the same port',async t=>{
  const oldProxy='http://127.0.0.1:42000', config=served(443,oldProxy);
  config.Web['other.tail.ts.net:443']={Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}};
  const f=await fixture(t,config,endpoint(443,oldProxy));
  await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_CONFLICT');
  assert.deepEqual(f.mutations,[]);assert.deepEqual(f.configured,[]);
});

test('remote enable after a DNS rename preserves the old alias and creates a free current endpoint',async t=>{
  const oldDns='old.tail.ts.net', oldProxy='http://127.0.0.1:42000';
  const f=await fixture(t,served(443,oldProxy,oldDns),endpoint(443,oldProxy,oldDns));
  assert.deepEqual(await f.setup.enable(),endpoint(8443));
  assert.deepEqual(f.mutations,[['serve','--bg','--https=8443','--yes',proxy]]);
  assert.equal(f.config.Web[`${oldDns}:443`].Handlers['/'].Proxy,oldProxy);
  assert.deepEqual(f.configured,[endpoint(8443).origin]);
});

for(const mode of ['create','recover','retarget'] as const)test(`remote enable cancels ${mode} when Serve changes before the operation`,async t=>{
  const oldProxy='http://127.0.0.1:42000';
  const initial=mode==='create'?{}:served(443,mode==='retarget'?oldProxy:proxy);
  const f=await fixture(t,initial,mode==='retarget'?endpoint(443,oldProxy):undefined);
  let reads=0;
  (f.setup as any).config=async()=>++reads===1?structuredClone(initial):served(443,'http://127.0.0.1:9000');
  await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_CHANGED');
  assert.deepEqual(f.mutations,[]);assert.deepEqual(f.configured,[]);
});

test('remote enable verifies DNS exclusivity again after creating the endpoint',async t=>{
  const f=await fixture(t);
  let reads=0;
  (f.setup as any).config=async()=>{
    if(++reads<3)return {};
    const changed=served();
    changed.Web[`${dnsName}:8443`]={Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}};
    return changed;
  };
  await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_VERIFY');
  assert.equal(f.mutations.length,1);assert.deepEqual(f.configured,[]);
  await assert.rejects(readFile(f.file,'utf8'),(error:any)=>error.code==='ENOENT');
});

test('management record read errors are reported instead of being mistaken for missing metadata',async t=>{
  const f=await fixture(t,served());
  await mkdir(f.file);
  await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_RECORD_READ');
  assert.deepEqual(f.mutations,[]);assert.deepEqual(f.configured,[]);
});

test('remote disable safely removes a recovered route and its durable management record',async t=>{
  const f=await fixture(t,served());
  await f.setup.enable();
  assert.deepEqual(await f.setup.disable(),{ok:true,serveRemoved:true});
  assert.deepEqual(f.mutations,[['serve','--https=443','off']]);
  assert.deepEqual(f.configured,[endpoint().origin,null]);
  await assert.rejects(readFile(f.file,'utf8'),(error:any)=>error.code==='ENOENT');
});

test('remote disable preserves another DNS route sharing the HTTPS port',async t=>{
  const config=served();
  config.Web['other.tail.ts.net:443']={Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}};
  const f=await fixture(t,config,endpoint());
  const result=await f.setup.disable();
  assert.equal(result.serveRemoved,false);assert.ok(result.warning);
  assert.deepEqual(f.configured,[null]);assert.deepEqual(f.mutations,[]);
  assert.deepEqual(JSON.parse(await readFile(f.file,'utf8')),endpoint());
});

test('remote disable preserves a route changed between its two ownership checks',async t=>{
  const f=await fixture(t,served(),endpoint());
  let reads=0;
  (f.setup as any).config=async()=>served(443,++reads===1?proxy:'http://127.0.0.1:9000');
  assert.equal((await f.setup.disable()).serveRemoved,false);
  assert.deepEqual(f.configured,[null]);assert.deepEqual(f.mutations,[]);
});

test('concurrent enable requests perform one Serve write then reuse the verified endpoint',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([f.setup.enable(),f.setup.enable()]);
  assert.deepEqual(results,[endpoint(),endpoint()]);
  assert.equal(f.mutations.length,1);
});

test('remote disable waits for an earlier enable to finish and leaves application access revoked',async t=>{
  const f=await fixture(t);
  let entered!:()=>void, release!:()=>void;
  const configuring=new Promise<void>(resolve=>{entered=resolve;});
  const finish=new Promise<void>(resolve=>{release=resolve;});
  (f.setup as any).configure=async(origin:string|null)=>{
    f.configured.push(origin);
    if(origin){entered();await finish;}
  };
  const enabling=f.setup.enable();
  await configuring;
  const disabling=f.setup.disable();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.configured,[endpoint().origin]);
  assert.equal(f.mutations.length,1);
  release();
  await enabling;
  assert.equal((await disabling).serveRemoved,true);
  assert.deepEqual(f.configured,[endpoint().origin,null]);
});

for(const scope of ['Foreground','Services'] as const) {
  for(const mode of ['web','funnel','tls'] as const)test(`remote enable rejects shared cookie host in ${scope} ${mode} configuration`,async t=>{
    const nested=mode==='web'?served(8443,'http://127.0.0.1:9000'):mode==='funnel'?{AllowFunnel:{[`${dnsName}:8443`]:true}}:{TCP:{8443:{TCPForward:'127.0.0.1:9000',TerminateTLS:dnsName}}};
    const config={...served(),[scope]:{other:nested}};
    const f=await fixture(t,config,endpoint());
    await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_SHARED_HOST');
    assert.deepEqual(f.mutations,[]);assert.deepEqual(f.configured,[]);
  });
}

test('remote enable rejects a root TLS proxy sharing the cookie host on another port',async t=>{
  const config=served();
  config.TCP[8443]={TCPForward:'127.0.0.1:9000',TerminateTLS:`${dnsName.toUpperCase()}.`};
  const f=await fixture(t,config,endpoint());
  await assert.rejects(f.setup.enable(),(error:any)=>error.code==='SERVE_SHARED_HOST');
  assert.deepEqual(f.mutations,[]);assert.deepEqual(f.configured,[]);
});

test('remote enable skips a foreground occupied port and preserves unrelated service configuration',async t=>{
  const foreground={TCP:{443:{TCPForward:'127.0.0.1:9000'}}};
  const service=served(8443,'http://127.0.0.1:9001','another.tail.ts.net');
  const config={Foreground:{other:foreground},Services:{'svc:other':service}};
  const f=await fixture(t,config);
  assert.deepEqual(await f.setup.enable(),endpoint(8443));
  assert.deepEqual(f.config.Foreground,config.Foreground);
  assert.deepEqual(f.config.Services,config.Services);
  assert.deepEqual(f.mutations,[['serve','--bg','--https=8443','--yes',proxy]]);
});

test('remote disable preserves a foreground handler occupying the same HTTPS port',async t=>{
  const config={...served(),Foreground:{other:{TCP:{443:{TCPForward:'127.0.0.1:9000'}}}}};
  const f=await fixture(t,config,endpoint());
  assert.equal((await f.setup.disable()).serveRemoved,false);
  assert.deepEqual(f.configured,[null]);assert.deepEqual(f.mutations,[]);
});
