import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentInbox, DraftTracker, cleanAgentMessage, type InboxFacts } from '../../packages/host/agent-inbox.js';
import type { AgentStatus } from '../../packages/protocol/index.js';

const timing = { typingQuietMs: 80, startSettleMs: 40, submitDelayMs: 20, deliveryAckMs: 300 };
const START = '\x1b[200~', END = '\x1b[201~';

function fixture() {
  const writes: string[] = [];
  const facts: InboxFacts = { supported: true, dnd: false };
  let changes = 0;
  const inbox = new AgentInbox({ write: data => { writes.push(data); return true; }, facts: () => ({ ...facts }), changed: () => { changes++; } }, timing);
  const status = (value: AgentStatus | undefined) => { facts.status = value; inbox.statusChanged(value); };
  return { inbox, writes, facts, status, changes: () => changes };
}
async function until(check: () => boolean, message: string, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a message keeps only text, tabs and line breaks', () => {
  assert.equal(cleanAgentMessage('  hi\x1b[201~\r\nnext\x07\tend\x9b2J\u2028  '), 'hi[201~\rnext\tend2J');
  assert.equal(cleanAgentMessage('\x1b\x03\r\n'), '');
});

test('the draft tracker knows only whether typed text may remain', () => {
  const draft = new DraftTracker();
  assert.equal(draft.observe('\x1b[A\x1b[I'), false); assert.equal(draft.draft, false, 'arrows and focus reports are not text');
  draft.observe('abc'); assert.equal(draft.draft, true);
  draft.observe('\x7f\x7f\x7f'); assert.equal(draft.draft, true, 'deleting leaves the answer unknown');
  assert.equal(draft.observe('\r'), true); assert.equal(draft.draft, false);
  draft.observe(START + 'line\rline' + END); assert.equal(draft.draft, true, 'Enter inside a paste is text');
  assert.equal(draft.observe('\x1b[13;28;13;1;0;1_'), true, 'win32-input-mode Enter press submits'); assert.equal(draft.draft, false);
  draft.observe('\x1b[13;28;13;0;0;1_'); assert.equal(draft.draft, false, 'a key release is not typing');
  draft.observe('\x1b[65;30;97;1;0;1_'); assert.equal(draft.draft, true, 'a win32 letter press is typing');
});

test('nothing is written before the agent proves it runs, then one paste and a separate Enter', async () => {
  const { inbox, writes, status } = fixture();
  inbox.add('hello\rworld', 'phone');
  assert.equal(inbox.summary()?.hold, 'no-agent');
  inbox.agentStarted();
  assert.equal(inbox.summary()?.hold, 'starting', 'a CLI that just started may not have drawn its input box');
  assert.deepEqual(writes, []);
  await until(() => writes.length === 2, 'paste and Enter after the start settles');
  assert.deepEqual(writes, [START + 'hello\rworld' + END, '\r']);
  assert.equal(inbox.summary()?.delivered, 1);
  inbox.add('second', 'phone');
  assert.equal(inbox.summary()?.hold, 'delivering', 'the next message waits for the turn to start');
  status('working');
  assert.equal(inbox.summary()?.hold, 'busy');
  status('attention');
  assert.equal(inbox.summary()?.hold, 'attention');
  status('completed');
  await until(() => writes.length === 4, 'delivered when the turn ends');
  assert.equal(writes[2], START + 'second' + END);
});

test('a person typing, a draft or an unanswered submit holds the message; force skips only typing', async () => {
  const { inbox, writes, status } = fixture();
  status('idle'); inbox.agentStarted();
  await sleep(timing.startSettleMs + 10);
  inbox.observeInput('dra');
  const id = inbox.add('msg', 'pc');
  assert.equal(inbox.summary()?.hold, 'typing');
  await sleep(timing.typingQuietMs * 2);
  assert.equal(writes.length, 0, 'a draft holds beyond the quiet window');
  inbox.observeInput('\r');
  assert.equal(inbox.summary()?.hold, 'unconfirmed', 'what the person submitted has not been answered by a hook');
  inbox.agentReported();
  assert.equal(inbox.summary()?.hold, 'typing', 'still within the quiet window');
  await until(() => writes.length === 2, 'delivered after the quiet window');
  status('working'); status('completed');
  inbox.observeInput('x');
  const second = inbox.add('forced', 'pc');
  assert.equal(inbox.summary()?.hold, 'typing');
  assert.equal(inbox.force(second), true);
  await until(() => writes.length === 4, 'force skips typing');
  assert.equal(writes[2], START + 'forced' + END);
  status('working');
  const third = inbox.add('busy', 'pc'); inbox.force(third);
  assert.equal(inbox.summary()?.hold, 'busy', 'force never skips a working agent');
  assert.equal(id.length, 36);
});

test('do-not-disturb, cancel and the shell prompt stop delivery', async () => {
  const { inbox, writes, facts, status } = fixture();
  status('idle'); inbox.agentStarted();
  facts.dnd = true;
  const id = inbox.add('later', 'pc');
  await sleep(timing.startSettleMs + 20);
  inbox.pump();
  assert.equal(inbox.summary()?.hold, 'dnd');
  assert.equal(inbox.cancel(id), true);
  assert.equal(inbox.cancel(id), false);
  assert.equal(inbox.summary(), undefined, 'nothing waits and nothing was delivered');
  facts.dnd = false;
  inbox.add('race', 'pc');
  await until(() => writes.length === 1, 'pasted');
  inbox.agentStopped();
  await sleep(timing.submitDelayMs * 3);
  assert.deepEqual(writes, [START + 'race' + END], 'no Enter once the prompt is the shell\'s: it would run the text');
  inbox.add('after', 'pc');
  assert.equal(inbox.summary()?.hold, 'no-agent');
  facts.dnd = true; inbox.pump();
  assert.equal(inbox.summary()?.hold, 'no-agent', 'an ended agent explains the wait before do-not-disturb does');
});

test('an unanswered delivery stops blocking after the acknowledgement window', async () => {
  const { inbox, writes, status } = fixture();
  status('idle'); inbox.agentStarted();
  inbox.add('one', 'pc'); inbox.add('two', 'pc');
  await until(() => writes.length === 2, 'first delivered');
  assert.equal(inbox.summary()?.hold, 'delivering');
  await until(() => writes.length === 4, 'second delivered after the window', timing.deliveryAckMs * 4);
  inbox.dispose();
  inbox.add('gone', 'pc');
  assert.equal(writes.length, 4, 'a disposed inbox writes nothing');
});

test('every message settles once: delivered with its Enter, cancelled, or lost when the agent or terminal ends', async () => {
  const writes: string[] = [];
  const facts: InboxFacts = { supported: true, dnd: false };
  const settled: [string, string][] = [];
  const inbox = new AgentInbox({ write: data => { writes.push(data); return true; }, facts: () => ({ ...facts }), changed: () => {}, settled: (id, outcome) => { settled.push([id, outcome]); } }, timing);
  assert.equal(inbox.add('first', 'phone', false, 'given-id'), 'given-id', 'the caller may choose the id it records');
  const cancelled = inbox.add('second', 'phone');
  assert.equal(inbox.cancel(cancelled), true);
  assert.deepEqual(settled, [[cancelled, 'cancelled']]);
  inbox.agentStarted();
  await until(() => settled.length === 2, 'the first message is delivered');
  assert.deepEqual(settled[1], ['given-id', 'delivered']);
  assert.deepEqual(writes, [START + 'first' + END, '\r']);
  const waiting = inbox.add('third', 'phone');
  assert.equal(inbox.summary()?.hold, 'delivering');
  inbox.dispose();
  assert.deepEqual(settled.at(-1), [waiting, 'failed'], 'what still waited when the terminal ended is not delivered');
  assert.equal(new Set(settled.map(([id]) => id)).size, settled.length, 'no message settles twice');
});

test('a paste whose Enter never went out is reported as not delivered', async () => {
  const facts: InboxFacts = { supported: true, dnd: false };
  const settled: [string, string][] = [];
  const writes: string[] = [];
  const inbox = new AgentInbox({ write: data => { writes.push(data); return true; }, facts: () => ({ ...facts }), changed: () => {}, settled: (id, outcome) => { settled.push([id, outcome]); } }, { ...timing, submitDelayMs: 200 });
  inbox.agentStarted();
  await sleep(timing.startSettleMs + 10);
  inbox.pump();
  const id = inbox.add('pasted only', 'phone');
  assert.equal(writes.length, 1, 'the paste went out');
  inbox.agentStopped();
  assert.deepEqual(settled, [[id, 'failed']], 'the shell has the prompt again, so the Enter is withheld');
  await sleep(250);
  assert.deepEqual(writes, [START + 'pasted only' + END], 'no Enter after the agent stopped');
  assert.equal(settled.length, 1);
});

test('views see every added or cancelled message even while the hold stays the same', () => {
  const facts: InboxFacts = { supported: true, dnd: false, status: 'working' };
  const seen: (number | undefined)[] = [];
  let inbox!: AgentInbox;
  inbox = new AgentInbox({ write: () => true, facts: () => ({ ...facts }), changed: () => { seen.push(inbox.summary()?.messages.length); } }, timing);
  inbox.agentStarted();
  const first = inbox.add('first', 'phone');
  assert.equal(inbox.summary()?.hold, 'busy');
  inbox.add('second', 'phone');
  assert.equal(seen.at(-1), 2, 'the second message reaches views although the hold is still busy');
  inbox.cancel(first);
  assert.equal(seen.at(-1), 1, 'a cancel reaches views although the hold is still busy');
});
