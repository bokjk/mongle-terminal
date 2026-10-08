import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { ClaudeTaskState, isAgentInputSignal } from '../../packages/terminal/agent-status.js';
import { PRESENTATION_VERSION } from '../../packages/terminal/types.js';

const token = 'a'.repeat(64), session = 'b'.repeat(64);
const digest = (c: string) => c.repeat(64);
const payload = (event: string, extra: Record<string, unknown> = {}, secret = token) =>
  'mongle-agent;' + secret + ';' + Buffer.from(JSON.stringify({event, session, ...extra})).toString('base64');
const osc = (event: string, extra = {}) => '\x1b]777;' + payload(event, extra) + '\x07';

test('Claude lifecycle tracks work, attention, every finished turn and errors', () => {
  const state = new ClaudeTaskState(token);
  assert.equal(state.accept(payload('Stop')), undefined, 'unbound late session cannot claim this shell');
  assert.deepEqual(state.accept(payload('UserPromptSubmit')), {status:'working', notify:false});
  assert.deepEqual(state.accept(payload('PermissionRequest')), {status:'attention', notify:true});
  assert.equal(state.accept(payload('Notification', {notification:'permission_prompt'})), undefined);
  assert.deepEqual(state.accept(payload('PostToolUse')), {status:'working', notify:false});
  assert.deepEqual(state.accept(payload('Stop')), {status:'completed', notify:true});
  // Claude 2.1.294: a message queued during a turn is answered in a second turn with its own Stop.
  assert.deepEqual(state.accept(payload('Stop')), {status:'completed', notify:true}, 'each finished turn is a new completion');
  assert.equal(state.accept(payload('Notification', {notification:'idle_prompt'})), undefined);
  state.accept(payload('UserPromptSubmit'));
  assert.deepEqual(state.accept(payload('StopFailure')), {status:'error', notify:true});
  assert.deepEqual(state.accept('mongle-shell;' + token), {status:'idle', notify:false});
  assert.equal(state.accept(payload('Stop')), undefined);
});

test('wrong token, old session, unknown/oversize events cannot change current state', () => {
  const state = new ClaudeTaskState(token);
  assert.equal(state.accept(payload('UserPromptSubmit', {}, 'c'.repeat(64))), undefined);
  state.accept(payload('UserPromptSubmit'));
  assert.equal(state.accept(payload('Stop', {session:'c'.repeat(64)})), undefined);
  assert.equal(state.accept(payload('invented')), undefined);
  assert.equal(state.accept(payload('Stop', {unused:'x'.repeat(3000)})), undefined);
  assert.equal(new ClaudeTaskState('').accept(payload('UserPromptSubmit')), undefined);
  assert.deepEqual(state.accept(payload('Stop', {interrupted:true})), {status:'idle', notify:false});
});

test('hook events use parser fence, record the alert number, and never enter saved terminal text', async t => {
  const states: Array<[string, number | undefined]> = [], counts: number[] = [];
  let live = true;
  const engine = new TerminalEngine({cols:60,rows:8,agentToken:token,onResponse(){},
    onAgentStatus:(s,count)=>states.push([s,count]),onNotification:n=>counts.push(n),notificationsEnabled:()=>live});
  t.after(()=>engine.dispose());
  await engine.write('visible' + osc('UserPromptSubmit'));
  const before = await engine.snapshot();
  const finish = osc('Stop');
  await engine.write(finish.slice(0,-1));
  assert.deepEqual(counts, []);
  await engine.write(finish.slice(-1));
  const after = await engine.snapshot();
  assert.equal(before.notificationCount,0);
  assert.equal(after.notificationCount,1);
  assert.equal(after.data,'visible');
  assert.deepEqual(states,[['working',undefined],['completed',1]]);
  await engine.write('\x07');
  assert.deepEqual(counts,[1,2],'a plain bell is a separate notification');
  assert.deepEqual(states.at(-1),['completed',1],'a plain bell never becomes the agent alert');
  assert.ok(!JSON.stringify(after).includes(token));
  live=false;
  await engine.write(osc('UserPromptSubmit')+osc('Stop'));
  assert.deepEqual(counts,[1,2]);
});

test('history restore cannot replay a live agent status', async t => {
  const states: string[] = [];
  const engine = new TerminalEngine({cols:60,rows:8,agentToken:token,onResponse(){},onAgentStatus:s=>states.push(s)});
  t.after(()=>engine.dispose());
  await engine.restoreHistory({kind:'presentation-v1',version:PRESENTATION_VERSION,cols:60,rows:8,data:osc('UserPromptSubmit')+osc('Stop')});
  assert.deepEqual(states,[]);
  assert.equal((await engine.snapshot()).notificationCount,0);
});

test('parallel tool completion cannot clear another tool permission request',()=>{
  const state=new ClaudeTaskState(token),tool=digest('c'),other=digest('d');
  state.accept(payload('UserPromptSubmit'));
  assert.deepEqual(state.accept(payload('PermissionRequest',{tool})),{status:'attention',notify:true});
  assert.equal(state.accept(payload('PreToolUse',{tool:other})),undefined);
  assert.equal(state.accept(payload('PostToolUse',{tool:other})),undefined);
  assert.deepEqual(state.accept(payload('PostToolUse',{tool})),{status:'working',notify:false});
});

test('identical parallel tool inputs from older hooks keep attention conservatively until both finish',()=>{
  const state=new ClaudeTaskState(token),tool=digest('c');
  state.accept(payload('UserPromptSubmit'));
  state.accept(payload('PreToolUse',{tool}));state.accept(payload('PreToolUse',{tool}));
  state.accept(payload('PermissionRequest',{tool}));
  assert.equal(state.accept(payload('PostToolUse',{tool})),undefined);
  assert.deepEqual(state.accept(payload('PostToolUse',{tool})),{status:'working',notify:false});
});

test('call ids finish the requested call even when an answer rewrites its input',()=>{
  // Claude 2.1.294 AskUserQuestion: PreToolUse(question), PermissionRequest, then PostToolUse with the answers added.
  const state=new ClaudeTaskState(token),call=digest('e');
  state.accept(payload('UserPromptSubmit'));
  assert.deepEqual(state.accept(payload('PreToolUse',{tool:digest('c'),call,question:true})),{status:'attention',notify:true});
  assert.equal(state.accept(payload('PermissionRequest',{tool:digest('c')})),undefined,'the same request is not counted twice');
  assert.deepEqual(state.accept(payload('PostToolUse',{tool:digest('d'),call})),{status:'working',notify:false});
  assert.equal(state.accept(payload('PreToolUse',{tool:digest('f'),call:digest('9')})),undefined,'no stale request turns the next tool into attention');
});

test('a request answered in this terminal leaves attention; approval proves itself and rejection stays quiet',()=>{
  const state=new ClaudeTaskState(token),tool=digest('c');
  state.accept(payload('UserPromptSubmit'));
  state.accept(payload('PreToolUse',{tool,call:digest('1')}));
  assert.deepEqual(state.accept(payload('PermissionRequest',{tool})),{status:'attention',notify:true});
  assert.equal(state.observeInput('\x1b[B'),undefined,'navigation is not an answer');
  assert.deepEqual(state.observeInput('\x1b[B\x1b[B\r'),{status:'idle',notify:false});
  assert.equal(state.accept(payload('Notification',{notification:'permission_prompt'})),undefined,'a late reminder is not a new request');
  assert.deepEqual(state.accept(payload('PostToolUse',{tool,call:digest('1')})),{status:'working',notify:false},'approval');
  assert.deepEqual(state.accept(payload('Stop')),{status:'completed',notify:true});
  // Claude 2.1.294 sends no hook at all after "No" in a permission dialog.
  state.accept(payload('UserPromptSubmit'));
  state.accept(payload('PreToolUse',{tool,call:digest('2')}));
  state.accept(payload('PermissionRequest',{tool}));
  assert.equal(state.observeInput('3'),undefined,'a digit may only move the selection');
  assert.deepEqual(state.observeInput('\r'),{status:'idle',notify:false});
  assert.equal(state.observeInput('\r'),undefined);
  assert.equal(state.accept(payload('Notification',{notification:'idle_prompt'})),undefined);
});

test('an answer to one of two pending requests keeps attention for the other',()=>{
  const state=new ClaudeTaskState(token);
  state.accept(payload('UserPromptSubmit'));
  state.accept(payload('PreToolUse',{tool:digest('c'),call:digest('1')}));state.accept(payload('PreToolUse',{tool:digest('d'),call:digest('2')}));
  state.accept(payload('PermissionRequest',{tool:digest('c')}));state.accept(payload('PermissionRequest',{tool:digest('d')}));
  assert.equal(state.observeInput('\r'),undefined);
  assert.deepEqual(state.observeInput('\r'),{status:'idle',notify:false});
});

test('identical parallel calls each keep their own permission request',()=>{
  const state=new ClaudeTaskState(token),tool=digest('c');
  state.accept(payload('UserPromptSubmit'));
  state.accept(payload('PreToolUse',{tool,call:digest('1')}));state.accept(payload('PreToolUse',{tool,call:digest('2')}));
  state.accept(payload('PermissionRequest',{tool}));state.accept(payload('PermissionRequest',{tool}));
  assert.equal(state.observeInput('\r'),undefined,'the second request is still visible');
  assert.equal(state.accept(payload('PostToolUse',{tool,call:digest('1')})),undefined);
  assert.deepEqual(state.observeInput('\r'),{status:'idle',notify:false});
});

test('Enter inside a bracketed paste is text, also when the paste spans input chunks',()=>{
  const state=new ClaudeTaskState(token);
  state.accept(payload('UserPromptSubmit'));state.accept(payload('PreToolUse',{tool:digest('c'),call:digest('1'),question:true}));
  assert.equal(state.observeInput('\x1b[200~first\rsecond\x1b[201~'),undefined);
  assert.equal(state.observeInput('\x1b[200~long'),undefined);
  assert.equal(state.observeInput('er\rtext'),undefined,'a later chunk of the same paste');
  assert.equal(state.observeInput('end\x1b[201~'),undefined);
  assert.deepEqual(state.observeInput('\x1b[200~x\x1b[201~\r'),{status:'idle',notify:false},'Enter typed after the paste submits');
});

test('idle prompt ends stale work or requests, and compaction keeps the running turn',()=>{
  let now=0;const state=new ClaudeTaskState(token,{},()=>now);
  state.accept(payload('UserPromptSubmit'));
  assert.equal(state.accept(payload('SessionStart',{source:'compact'})),undefined);
  assert.deepEqual(state.accept(payload('PreToolUse',{tool:digest('c'),call:digest('1')})),undefined,'still working after compaction');
  // A lost Stop: Claude reports its own prompt idle about a minute later.
  now+=61_000;
  assert.deepEqual(state.accept(payload('Notification',{notification:'idle_prompt'})),{status:'completed',notify:true});
  state.accept(payload('UserPromptSubmit'));state.accept(payload('PermissionRequest',{tool:digest('d')}));
  assert.equal(state.accept(payload('Notification',{notification:'idle_prompt'})),undefined,'a reminder racing the new prompt is stale');
  now+=61_000;
  assert.deepEqual(state.accept(payload('Notification',{notification:'idle_prompt'})),{status:'idle',notify:false});
  assert.deepEqual(state.accept(payload('UserPromptSubmit')),{status:'working',notify:false});
  assert.deepEqual(state.accept(payload('SessionStart',{source:'clear'})),{status:'idle',notify:false},'a cleared conversation starts over');
});

test('delivered cancel lowers work until the same conversation proves it went on',async t=>{
  const states:string[]=[],engine=new TerminalEngine({cols:60,rows:8,agentToken:token,onResponse(){},onAgentStatus:s=>states.push(s)});
  t.after(()=>engine.dispose());
  await engine.write(osc('UserPromptSubmit')+osc('PreToolUse',{tool:digest('c'),call:digest('1')}));
  await engine.observeInput('\x1b[A');assert.deepEqual(states,['working']);
  await engine.observeInput('\x1b');assert.deepEqual(states,['working','idle']);
  await engine.write(osc('PostToolUse',{tool:digest('c'),call:digest('1')}));
  assert.deepEqual(states,['working','idle'],'a tool that finished after the key does not prove more work');
  assert.equal((await engine.snapshot()).notificationCount,0);
  // Claude 2.1.294: Esc that only closed the slash-command menu; the turn continued and ended normally.
  await engine.write(osc('Stop'));
  assert.deepEqual(states,['working','idle','completed']);
  assert.equal((await engine.snapshot()).notificationCount,1);
  await engine.write(osc('UserPromptSubmit'));await engine.observeInput('\x03');
  assert.deepEqual(states,['working','idle','completed','working','idle'],'a real interrupt sends no further hook');
});

test('only cancel keys and answers reach the agent observer',()=>{
  for(const data of ['\x03','\x1b','\x1b[27u','\x1b[99;5u','\r','yes\r','\x1b[B\r','\x1b[200~text','text\x1b[201~'])assert.equal(isAgentInputSignal(data),true,JSON.stringify(data));
  for(const data of ['\x1b[A','a','1','3','\x1b\x1b','\n'])assert.equal(isAgentInputSignal(data),false,JSON.stringify(data));
});
