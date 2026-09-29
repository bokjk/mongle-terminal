import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteSetup } from '../../packages/host/remote';

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
