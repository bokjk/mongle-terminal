import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserClient } from '../../packages/client/index.js';

test('browser transport authenticates before requests, sends CSRF in headers, never replays uncertain input',async()=>{
  const oldFetch=globalThis.fetch;const oldSocket=globalThis.WebSocket;const locationDescriptor=Object.getOwnPropertyDescriptor(globalThis,'location');
  const http:Array<{url:string;init:RequestInit|undefined}>=[];const sent:any[]=[];const sockets:FakeSocket[]=[];
  class FakeSocket{
    static OPEN=1;readyState=0;onopen?:()=>void;onmessage?:(event:{data:string})=>void;onclose?:()=>void;onerror?:()=>void;
    constructor(readonly url:string){sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
    send(value:string){const frame=JSON.parse(value);sent.push(frame);if(frame.type==='authenticate')queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'authenticated'})}));else if(frame.method!=='terminal.input')queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'response',id:frame.id,ok:true,result:{ok:true}})}));}
    close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
  }
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://test.tailnet.ts.net/'}});
  globalThis.WebSocket=FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch=(async(url,init)=>{http.push({url:String(url),init});return new Response(JSON.stringify(String(url)==='/v1/session'?{authenticated:true,csrf:'csrf-test'}:{ticket:'single-use-ticket'}),{status:200,headers:{'Content-Type':'application/json'}});}) as typeof fetch;
  const client=new BrowserClient();
  try{
    await new Promise<void>(resolve=>{const unsubscribe=client.onConnection(info=>{if(info.status==='connected'){unsubscribe();resolve();}});});
    assert.equal(http[1].url,'/v1/ws-ticket');assert.equal((http[1].init!.headers as Record<string,string>)['X-CSRF-Token'],'csrf-test');assert.equal(sockets[0].url.toString(),'wss://test.tailnet.ts.net/v1/ws');
    assert.deepEqual(sent[0],{type:'authenticate',ticket:'single-use-ticket'});
    assert.deepEqual(await client.request('state.get'),{ok:true});
    const input=client.request('terminal.input',{data:'sensitive-command\r'});sockets[0].close();await assert.rejects(input,/마지막 입력/);
    client.reconnect();await new Promise<void>(resolve=>{const unsubscribe=client.onConnection(info=>{if(info.status==='connected'){unsubscribe();resolve();}});});
    assert.equal(sent.filter(frame=>frame.method==='terminal.input').length,1);
    assert.equal(http.some(item=>item.url.includes('csrf-test')||item.url.includes('single-use-ticket')),false);
    assert.ok(http.every(item=>item.init?.credentials==='same-origin'&&item.init?.cache==='no-store'));
  }finally{client.close();globalThis.fetch=oldFetch;globalThis.WebSocket=oldSocket;if(locationDescriptor)Object.defineProperty(globalThis,'location',locationDescriptor);else delete(globalThis as any).location;}
});
