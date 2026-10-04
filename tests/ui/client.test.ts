import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserClient } from '../../packages/client/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function browserFixture(fetch: typeof globalThis.fetch) {
  const oldFetch = globalThis.fetch;
  const oldSocket = globalThis.WebSocket;
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const sockets: ControlledSocket[] = [];
  class ControlledSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    readonly sent: any[] = [];
    constructor(readonly url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    authenticate() { this.readyState = 1; this.onopen?.(); this.message({ type: 'authenticated', connectionId: 'current' }); }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://test.tailnet.ts.net/' } });
  globalThis.WebSocket = ControlledSocket as unknown as typeof WebSocket;
  globalThis.fetch = fetch;
  const client = new BrowserClient();
  return {
    client,
    sockets,
    cleanup() {
      client.close();
      for (const socket of sockets) socket.onclose?.();
      globalThis.fetch = oldFetch;
      globalThis.WebSocket = oldSocket;
      if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
      else delete (globalThis as any).location;
    },
  };
}

test('reconnect replaces an in-flight session lookup and ignores its late result', async () => {
  const first = deferred<Response>();
  const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  const fixture = browserFixture((async (url, init) => {
    calls.push({ url: String(url), signal: init?.signal });
    return calls.length === 1 ? first.promise : response({ authenticated: false });
  }) as typeof fetch);
  const states: string[] = [];
  fixture.client.onConnection(info => states.push(info.status));
  try {
    fixture.client.reconnect();
    await flush();
    assert.equal(calls.length, 2, 'reconnect must immediately start a fresh session lookup');
    assert.equal(calls[0].signal?.aborted, true, 'the superseded lookup must be cancelled');
    assert.equal(states.at(-1), 'pairing');
    first.resolve(response({ authenticated: true, csrf: 'obsolete-csrf' }));
    await flush();
    assert.deepEqual(calls.map(call => call.url), ['/v1/session', '/v1/session']);
    assert.equal(fixture.sockets.length, 0);
    assert.equal(states.at(-1), 'pairing');
  } finally { first.resolve(response({ authenticated: false })); fixture.cleanup(); await flush(); }
});

test('closing during session lookup cancels it without publishing a late error or retry', async () => {
  const lookup = deferred<Response>();
  let signal: AbortSignal | null | undefined;
  const fixture = browserFixture((async (_url, init) => { signal = init?.signal; return lookup.promise; }) as typeof fetch);
  const states: string[] = [];
  fixture.client.onConnection(info => states.push(info.status));
  try {
    fixture.client.close();
    lookup.reject(new Error('late network failure'));
    await flush();
    assert.equal(signal?.aborted, true);
    assert.deepEqual(states, ['connecting']);
  } finally { fixture.cleanup(); }
});

test('a replaced socket cannot publish connection state or host events', async () => {
  const nextSession = deferred<Response>();
  let sessionCount = 0;
  const fixture = browserFixture((async url => String(url) === '/v1/session'
    ? ++sessionCount === 1 ? response({ authenticated: true, csrf: 'csrf' }) : nextSession.promise
    : response({ ticket: 'ticket' })) as typeof fetch);
  const states: string[] = [];
  const events: unknown[] = [];
  fixture.client.onConnection(info => states.push(info.status));
  fixture.client.subscribe(event => events.push(event));
  try {
    await flush();
    const old = fixture.sockets[0];
    old.authenticate();
    fixture.client.reconnect();
    old.message({ type: 'authenticated', connectionId: 'obsolete' });
    old.message({ type: 'terminal.output', terminalId: 'obsolete', data: 'stale' });
    assert.equal(states.at(-1), 'connecting');
    assert.deepEqual(events, []);
    nextSession.resolve(response({ authenticated: false }));
    await flush();
    assert.equal(states.at(-1), 'pairing');
  } finally { nextSession.resolve(response({ authenticated: false })); fixture.cleanup(); await flush(); }
});

test('closing settles pending input immediately even if the socket close event is delayed', async () => {
  const fixture = browserFixture((async url => response(String(url) === '/v1/session'
    ? { authenticated: true, csrf: 'csrf' } : { ticket: 'ticket' })) as typeof fetch);
  try {
    await flush();
    fixture.sockets[0].authenticate();
    const input = fixture.client.request('terminal.input', { data: 'command\r' });
    const settled = input.then(() => 'resolved', (error: Error & { code?: string }) => error.code);
    fixture.client.close();
    assert.equal(await Promise.race([settled, flush().then(() => 'still pending')]), 'CONNECTION_LOST');
    assert.equal(fixture.sockets[0].sent.filter(frame => frame.method === 'terminal.input').length, 1);
  } finally { fixture.cleanup(); }
});

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
