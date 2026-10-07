import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { ClaudeTaskState } from '../../packages/terminal/agent-status.js';
import { PRESENTATION_VERSION } from '../../packages/terminal/types.js';

const token = 'a'.repeat(64), session = 'b'.repeat(64);
const payload = (event: string, extra: Record<string, unknown> = {}, secret = token) =>
  `mongle-agent;${secret};${Buffer.from(JSON.stringify({event, session, ...extra})).toString('base64')}`;
const osc = (event: string, extra = {}) => `\x1b]777;${payload(event, extra)}\x07`;

test('Claude lifecycle tracks work, attention, completion, errors and suppresses repeated idle notifications', () => {
  const state = new ClaudeTaskState(token);
  assert.equal(state.accept(payload('Stop')), undefined, 'unbound late session cannot claim this shell');
  assert.deepEqual(state.accept(payload('UserPromptSubmit')), {status:'working', notify:false});
  assert.deepEqual(state.accept(payload('PermissionRequest')), {status:'attention', notify:true});
  assert.equal(state.accept(payload('Notification', {notification:'permission_prompt'})), undefined);
  assert.deepEqual(state.accept(payload('PostToolUse')), {status:'working', notify:false});
  assert.deepEqual(state.accept(payload('Stop')), {status:'completed', notify:true});
  assert.equal(state.accept(payload('Stop')), undefined);
  assert.equal(state.accept(payload('Notification', {notification:'idle_prompt'})), undefined);
  state.accept(payload('UserPromptSubmit'));
  assert.deepEqual(state.accept(payload('StopFailure')), {status:'error', notify:true});
  assert.deepEqual(state.accept(`mongle-shell;${token}`), {status:'idle', notify:false});
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

test('hook events use parser fence, generate one unread receipt, and never enter saved terminal text', async t => {
  const states: string[] = [], counts: number[] = [];
  let live = true;
  const engine = new TerminalEngine({cols:60,rows:8,agentToken:token,onResponse(){},
    onAgentStatus:s=>states.push(s),onNotification:n=>counts.push(n),notificationsEnabled:()=>live});
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
  assert.deepEqual(states,['working','completed']);
  assert.ok(!JSON.stringify(after).includes(token));
  live=false;
  await engine.write(osc('UserPromptSubmit')+osc('Stop'));
  assert.deepEqual(counts,[1]);
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
  const state=new ClaudeTaskState(token),tool='c'.repeat(64),other='d'.repeat(64);
  state.accept(payload('UserPromptSubmit'));
  assert.deepEqual(state.accept(payload('PermissionRequest',{tool})),{status:'attention',notify:true});
  assert.equal(state.accept(payload('PreToolUse',{tool:other})),undefined);
  assert.equal(state.accept(payload('PostToolUse',{tool:other})),undefined);
  assert.deepEqual(state.accept(payload('PostToolUse',{tool})),{status:'working',notify:false});
});

test('identical parallel tool inputs keep attention conservatively until both finish',()=>{
  const state=new ClaudeTaskState(token),tool='c'.repeat(64);
  state.accept(payload('UserPromptSubmit'));
  state.accept(payload('PreToolUse',{tool}));state.accept(payload('PreToolUse',{tool}));
  state.accept(payload('PermissionRequest',{tool}));
  assert.equal(state.accept(payload('PostToolUse',{tool})),undefined);
  assert.deepEqual(state.accept(payload('PostToolUse',{tool})),{status:'working',notify:false});
});

test('delivered cancel clears stale work without inventing completion or consuming receipts',async t=>{
  const states:string[]=[],engine=new TerminalEngine({cols:60,rows:8,agentToken:token,onResponse(){},onAgentStatus:s=>states.push(s)});
  t.after(()=>engine.dispose());
  await engine.write(osc('UserPromptSubmit'));
  await engine.observeInput('\x1b[A');assert.deepEqual(states,['working']);
  await engine.observeInput('\x1b');assert.deepEqual(states,['working','idle']);
  await engine.write(osc('Stop'));assert.deepEqual(states,['working','idle']);
  assert.equal((await engine.snapshot()).notificationCount,0);
  await engine.write(osc('UserPromptSubmit')+osc('Stop'));
  assert.deepEqual(states,['working','idle','working','completed']);
});
