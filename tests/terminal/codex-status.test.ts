import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { CodexTaskState, validCodexEvent, type CodexAgentEvent, type CodexTurnEvent } from '../../packages/terminal/agent-status.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const T1 = digest('turn-1'), T2 = digest('turn-2'), S = digest('subagent-turn'), A = digest('agent-a'), B = digest('agent-b');
const turn = (event: CodexTurnEvent, id = T1, extra: {agent?: string; question?: true} = {}): CodexAgentEvent => ({event, turn:id, ...extra});

test('Codex turns show work, requests and every completion; a late or other turn changes nothing', () => {
  const state = new CodexTaskState();
  assert.equal(state.accept(turn('Stop')), undefined, 'no turn in progress');
  assert.deepEqual(state.accept(turn('UserPromptSubmit')), {status:'working', notify:false});
  assert.deepEqual(state.accept(turn('PermissionRequest')), {status:'attention', notify:true});
  assert.deepEqual(state.accept(turn('PostToolUse')), {status:'working', notify:false}, 'the approved tool finished');
  assert.equal(state.accept(turn('PreToolUse')), undefined, 'only the question tool is a request');
  assert.deepEqual(state.accept(turn('PreToolUse', T1, {question:true})), {status:'attention', notify:true});
  assert.deepEqual(state.accept(turn('PostToolUse', T1, {question:true})), {status:'working', notify:false});
  assert.equal(state.accept(turn('PermissionRequest', T2)), undefined, 'another turn');
  assert.deepEqual(state.accept(turn('Stop')), {status:'completed', notify:true});
  assert.equal(state.accept(turn('PostToolUse')), undefined, 'a background tool report after the end');
  assert.equal(state.accept(turn('Stop')), undefined, 'the same end twice');
  assert.deepEqual(state.accept(turn('UserPromptSubmit', T2)), {status:'working', notify:false});
  assert.equal(state.accept(turn('Stop', T1)), undefined, 'a late end of the previous turn');
  assert.deepEqual(state.accept(turn('Interrupt', T2)), {status:'idle', notify:false});
  assert.equal(state.accept(turn('Stop', T2)), undefined);
  state.accept(turn('UserPromptSubmit'));
  assert.equal(state.accept({event:'SessionStart', source:'compact'}), undefined, 'compaction keeps the turn');
  assert.deepEqual(state.accept(turn('Stop')), {status:'completed', notify:true}, 'each finished turn is a new completion');
  state.accept(turn('UserPromptSubmit', T2));
  assert.deepEqual(state.accept({event:'SessionStart', source:'clear'}), {status:'idle', notify:false}, '/clear starts a new conversation');
  assert.equal(state.accept(turn('Stop', T2)), undefined);
  state.accept(turn('UserPromptSubmit'));
  assert.deepEqual(state.accept({event:'SessionEnd'}), {status:'idle', notify:false});
  state.accept(turn('UserPromptSubmit', T2));
  assert.deepEqual(state.reset(), {status:'idle', notify:false}, 'back at the shell prompt');
  assert.equal(state.accept(turn('Stop', T2)), undefined);
});

test('a subagent request waits for that subagent; its own prompt and end are not the user turn', () => {
  const state = new CodexTaskState();
  assert.equal(state.accept(turn('PermissionRequest', S, {agent:A})), undefined, 'no user turn in progress');
  state.accept(turn('UserPromptSubmit'));
  assert.deepEqual(state.accept(turn('PermissionRequest', S, {agent:A})), {status:'attention', notify:true}, 'subagents have their own turn ids');
  assert.equal(state.accept(turn('PostToolUse')), undefined, 'a main-thread tool does not answer the subagent');
  assert.equal(state.accept(turn('PostToolUse', digest('other'), {agent:B})), undefined, 'neither does another subagent');
  assert.equal(state.accept(turn('Stop', S, {agent:A})), undefined);
  assert.equal(state.accept(turn('UserPromptSubmit', S, {agent:A})), undefined);
  assert.deepEqual(state.accept(turn('PostToolUse', S, {agent:A})), {status:'working', notify:false});
  assert.deepEqual(state.accept(turn('Stop')), {status:'completed', notify:true});
});

test('keys: the preselected approval keeps work visible; other answers and cancel keys wait for Codex', () => {
  const state = new CodexTaskState();
  state.accept(turn('UserPromptSubmit'));
  assert.equal(state.observeInput('x'), undefined, 'typing while Codex works');
  state.accept(turn('PermissionRequest'));
  assert.deepEqual(state.observeInput('\r'), {status:'working', notify:false}, 'Enter on the preselected "Yes, proceed"');
  state.accept(turn('PermissionRequest'));
  assert.equal(state.observeInput('\x1b[B'), undefined, 'moving the selection');
  assert.deepEqual(state.observeInput('\r'), {status:'idle', notify:false}, 'an answer that may be a rejection');
  assert.deepEqual(state.accept(turn('PostToolUse')), {status:'working', notify:false}, 'the approval proves itself');
  state.accept(turn('PermissionRequest'));
  assert.deepEqual(state.observeInput('\x1b'), {status:'idle', notify:false}, 'Esc declines');
  assert.deepEqual(state.accept(turn('Stop')), {status:'completed', notify:true}, 'the turn went on and ended');
  state.accept(turn('UserPromptSubmit', T2));
  state.accept(turn('PreToolUse', T2, {question:true}));
  assert.deepEqual(state.observeInput('\r'), {status:'idle', notify:false}, 'a question may have more screens');
  assert.deepEqual(state.accept(turn('PostToolUse', T2, {question:true})), {status:'working', notify:false});
  assert.deepEqual(state.observeInput('\x03'), {status:'idle', notify:false}, 'Ctrl+C while Codex works');
  assert.equal(state.accept(turn('Interrupt', T2)), undefined, 'Codex confirms the interrupt');
  assert.equal(state.accept(turn('PostToolUse', T2)), undefined, 'a tool of the interrupted turn');
  state.accept(turn('UserPromptSubmit'));
  state.accept(turn('PermissionRequest'));
  state.accept(turn('PermissionRequest', S, {agent:A}));
  assert.equal(state.observeInput('\r'), undefined, 'the second request is shown next');
  assert.deepEqual(state.accept(turn('PostToolUse', S, {agent:A})), {status:'working', notify:false});
  state.accept(turn('PermissionRequest'));
  assert.equal(state.observeInput('\x1b[200~a\r'), undefined, 'Enter inside a bracketed paste is text');
  assert.equal(state.observeInput('b\r\x1b[201~'), undefined, 'also when the paste spans input chunks');
  assert.deepEqual(state.observeInput('\r'), {status:'idle', notify:false}, 'the paste reached the request first');
});

test('only the shapes the managed hook sends are accepted', () => {
  assert.deepEqual(validCodexEvent({event:'SessionStart', source:'resume', token:'x'}), {event:'SessionStart', source:'resume'});
  assert.deepEqual(validCodexEvent({event:'SessionStart', source:'other'}), {event:'SessionStart'});
  assert.deepEqual(validCodexEvent({event:'SessionEnd', turn:T1}), {event:'SessionEnd'});
  assert.deepEqual(validCodexEvent({event:'Stop', turn:T1, agent:A, question:true, prompt:'secret'}), {event:'Stop', turn:T1, agent:A, question:true});
  assert.deepEqual(validCodexEvent({event:'Stop', turn:T1, question:'yes'}), {event:'Stop', turn:T1});
  for (const bad of [null, 'Stop', {event:'Stop'}, {event:'Stop', turn:'turn-1'}, {event:'PreCompact', turn:T1}, {event:'Stop', turn:T1, agent:'agent-a'}, {event:'Stop', turn:T1.toUpperCase()}])
    assert.equal(validCodexEvent(bad), undefined, JSON.stringify(bad));
});

test('the engine orders Codex events after parsed output, numbers their alerts, and the shell prompt ends them', async t => {
  const token = 'a'.repeat(64), states: Array<[string, number | undefined, string | undefined]> = [], counts: number[] = [];
  let live = true;
  const engine = new TerminalEngine({cols:60, rows:8, agentToken:token, onResponse(){}, notificationsEnabled:()=>live,
    onAgentStatus:(status, count, provider)=>states.push([status, count, provider]), onNotification:n=>counts.push(n)});
  t.after(()=>engine.dispose());
  assert.equal(await engine.acceptCodexEvent(turn('UserPromptSubmit')), true);
  assert.equal(await engine.acceptCodexEvent(turn('PermissionRequest')), true);
  assert.equal(await engine.observeInput('\r'), true);
  await engine.write('\x07');
  assert.equal(await engine.acceptCodexEvent(turn('Stop')), true);
  assert.deepEqual(states, [['working', undefined, 'codex'], ['attention', 1, 'codex'], ['working', undefined, 'codex'], ['completed', 3, 'codex']]);
  assert.deepEqual(counts, [1, 2, 3], 'a plain bell between them stays its own notification');
  assert.equal(await engine.acceptCodexEvent(turn('Stop')), false, 'a repeated end');
  await engine.acceptCodexEvent(turn('UserPromptSubmit', T2));
  await engine.write('\x1b]777;mongle-shell;' + token + '\x07');
  assert.deepEqual(states.at(-1), ['idle', undefined, 'codex'], 'back at the shell prompt');
  live = false;
  assert.equal(await engine.acceptCodexEvent(turn('UserPromptSubmit')), false);
  assert.deepEqual(counts, [1, 2, 3]);
});
