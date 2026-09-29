// Executed only by remote-transport.test.ts in an isolated Electron profile.
import { app, session } from 'electron';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { RemoteTransport } from '../../apps/desktop/remote-transport';

const directory = process.env.MONGLE_REMOTE_PROBE!;
app.setPath('userData', path.join(directory, 'profile'));
void app.whenReady().then(async () => {
  let transport: RemoteTransport | undefined;
  let hostId = 'installation-a';
  let protocolVersion = 1;
  const calls: { path: string; cookie: boolean }[] = [];
  const server = https.createServer({key:readFileSync(path.join(directory,'key.pem')),cert:readFileSync(path.join(directory,'cert.pem'))}, (req,res) => {
    const route = req.url!; const cookie = (req.headers.cookie || '').includes('__Host-mongle=probe'); calls.push({path:route,cookie});
    const reply = (data:unknown,status=200) => { res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data)); };
    if (route === '/health') return reply({hostId,protocolVersion});
    if (route === '/v1/session') return reply(cookie?{authenticated:true,hostId,csrf:'csrf-probe'}:{authenticated:false});
    let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{
      assert.equal(req.headers.origin,origin);
      if(route==='/v1/pairings/request') { const value=JSON.parse(body);assert.equal(value.name,'desktop-test');return reply({requestId:'request-a',requesterSecret:'opaque'}); }
      if(route==='/v1/pairings/claim') {res.setHeader('Set-Cookie','__Host-mongle=probe; Secure; HttpOnly; SameSite=Strict; Path=/');return reply({authenticated:true,hostId,csrf:'csrf-probe'});}
      if(route==='/v1/ws-ticket') { assert.ok(cookie);assert.equal(req.headers['x-csrf-token'],'csrf-probe');return reply({ticket:'single-use'}); }
      return reply({error:{code:'NOT_FOUND',message:'missing'}},404);
    });
  });
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{assert.ok(req.headers.cookie?.includes('__Host-mongle=probe'));assert.equal(req.headers.origin,origin);wss.handleUpgrade(req,socket,head,ws=>{
    let authenticated=false;
    ws.on('message',bytes=>{const value=JSON.parse(bytes.toString());if(!authenticated){assert.equal(value.ticket,'single-use');authenticated=true;ws.send(JSON.stringify({type:'authenticated'}));return;}
      ws.send(JSON.stringify({type:'response',id:value.id,ok:true,result:value.method==='connection.info'?{id:'connection-a'}:value.params}));
    });
  });});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='https://127.0.0.1:'+(server.address() as import('node:net').AddressInfo).port;
  const host={id:'probe-host',name:'Probe',url:origin,local:false,selected:true};
  const ses=session.fromPartition('persist:mongle-host-probe-host',{cache:false});
  // Only this isolated test session trusts the generated localhost certificate.
  ses.setCertificateVerifyProc((request,callback)=>callback(request.hostname==='127.0.0.1'?0:-2));
  try {
    const bind=async(id:string)=>{assert.equal(id,'installation-a','installation changed before credentials');};
    transport=new RemoteTransport(host,bind,()=>{});
    assert.equal((await transport.connect()).paired,false);
    await transport.pairing('pairing.request',{code:'ABCDEFGHJK',name:'desktop-test'});
    await transport.pairing('pairing.claim',{requestId:'request-a',requesterSecret:'opaque'});
    transport.close();transport=new RemoteTransport(host,bind,()=>{});
    const connected=await transport.connect();assert.equal(connected.paired,true);assert.equal(connected.connectionId,'connection-a');
    assert.deepEqual(await transport.request('echo',{text:'몽글'}),{text:'몽글'});
    transport.close();hostId='installation-b';transport=new RemoteTransport(host,bind,()=>{});
    const before=calls.length;await assert.rejects(()=>transport!.connect(),/installation changed/);
    assert.deepEqual(calls.slice(before),[{path:'/health',cookie:false}]);
    assert.ok(calls.filter(call=>call.path==='/health').every(call=>!call.cookie));
    transport.close();hostId='installation-a';protocolVersion=2;transport=new RemoteTransport(host,bind,()=>{});
    const beforeVersion=calls.length;await assert.rejects(()=>transport!.connect(),(error:any)=>error.code==='VERSION_MISMATCH');
    assert.deepEqual(calls.slice(beforeVersion),[{path:'/health',cookie:false}]);
    await transport.forget();
    writeFileSync(path.join(directory,'result.json'),JSON.stringify({ok:true,cases:['pairing','persisted-cookie','csrf','websocket-cookie-origin','rpc','credential-free-identity-preflight','credential-free-version-gate']}));
  } catch(error) { writeFileSync(path.join(directory,'result.json'),JSON.stringify({ok:false,error:error instanceof Error?error.stack:String(error)})); }
  finally {transport?.close();for(const ws of wss.clients)ws.terminate();wss.close();server.close();app.quit();}
}).catch(error=>{writeFileSync(path.join(directory,'result.json'),JSON.stringify({ok:false,error:String(error)}));app.exit(1);});
