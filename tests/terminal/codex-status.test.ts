import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { TerminalEngine } from '../../packages/terminal/engine.js';
import { CODEX_PROMPT_WAIT_MS, CodexTaskState, validCodexEvent, type CodexAgentEvent, type CodexTurnEvent } from '../../packages/terminal/agent-status.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const T1 = digest('turn-1'), T2 = digest('turn-2'), S = digest('subagent-turn'), A = digest('agent-a'), B = digest('agent-b');
const RUN = digest('tool-run'), READ = digest('tool-read');
const turn = (event: CodexTurnEvent, id = T1, extra: {agent?: string; tool?: string; question?: true} = {}): CodexAgentEvent => ({event, turn:id, ...extra});
const PROMPT = {prompt:true, review:false}, REVIEW = {prompt:false, review:true};
/** A permission request that Codex then shows to the user. */
const ask = (state: CodexTaskState, event = turn('PermissionRequest')) => {
  assert.equal(state.accept(event), undefined, 'not shown before Codex decides who answers');
  return state.observeScreen(PROMPT);
};

test('Codex turns show work, requests and every completion; a late or other turn changes nothing', () => {
  const state = new CodexTaskState();
  assert.equal(state.accept(turn('Stop')), undefined, 'no turn in progress');
  assert.deepEqual(state.accept(turn('UserPromptSubmit')), {status:'working', notify:false});
  assert.deepEqual(ask(state), {status:'attention', notify:true});
  assert.deepEqual(state.accept(turn('PostToolUse')), {status:'working', notify:false}, 'the approved tool finished');
  assert.equal(state.accept(turn('PreToolUse')), undefined, 'only the question tool is a request');
  assert.deepEqual(state.accept(turn('PreToolUse', T1, {question:true})), {status:'attention', notify:true});
  assert.deepEqual(state.accept(turn('PostToolUse', T1, {question:true})), {status:'working', notify:false});
  assert.equal(state.accept(turn('PermissionRequest', T2)), undefined, 'another turn');
  assert.equal(state.awaitingPrompt, false, 'and nothing waits for it');
  assert.deepEqual(state.accept(turn('Stop')), {status:'completed', notify:true});
  assert.equal(state.accept(turn('PostToolUse')), undefined, 'a late tool report after the end');
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

test('a finished tool answers only its own request; a tool that ran alongside leaves it waiting', () => {
  const state = new CodexTaskState();
  state.accept(turn('UserPromptSubmit'));
  assert.deepEqual(ask(state, turn('PermissionRequest', T1, {tool:RUN})), {status:'attention', notify:true});
  assert.equal(state.accept(turn('PostToolUse', T1, {tool:READ})), undefined, 'the read that ran alongside finished first');
  assert.deepEqual(state.accept(turn('PostToolUse', T1, {tool:RUN})), {status:'working', notify:false}, 'the approved command finished');
  ask(state, turn('PermissionRequest', T1, {tool:RUN}));
  assert.equal(state.accept(turn('PermissionRequest', T1, {tool:RUN})), undefined, 'the same command asked again alongside');
  assert.equal(state.observeScreen(PROMPT), undefined);
  assert.equal(state.accept(turn('PostToolUse', T1, {tool:RUN})), undefined, 'one of the two finished');
  assert.deepEqual(state.accept(turn('PostToolUse', T1, {tool:RUN})), {status:'working', notify:false});
  ask(state, turn('PermissionRequest', T1, {tool:RUN}));
  assert.deepEqual(state.accept(turn('PostToolUse')), {status:'working', notify:false}, 'a report of an older hook script has no digest');
});

test('a request answered by the Codex automatic review is never shown or notified', () => {
  const state = new CodexTaskState();
  state.accept(turn('UserPromptSubmit'));
  assert.equal(state.accept(turn('PermissionRequest', T1, {tool:RUN})), undefined);
  assert.equal(state.awaitingPrompt, true);
  assert.equal(state.observeScreen({prompt:false, review:false}), undefined, 'nothing drawn yet');
  assert.equal(state.awaitingPrompt, true);
  assert.equal(state.observeScreen(REVIEW), undefined, 'the review answers and nobody is asked');
  assert.equal(state.awaitingPrompt, false);
  assert.equal(state.accept(turn('PostToolUse', T1, {tool:RUN})), undefined, 'approved: the command ran and work goes on');
  state.accept(turn('PermissionRequest', T1, {tool:READ}));
  assert.equal(state.observeScreen(REVIEW), undefined, 'denied: no report of it follows');
  assert.equal(state.accept(turn('PostToolUse', T1, {tool:RUN})), undefined, 'the next tool does not show it either');
  assert.equal(state.showOverdue(), undefined);
  assert.deepEqual(state.accept(turn('Stop')), {status:'completed', notify:true}, 'the only notification of the turn');
});

test('a request whose prompt is not recognized in time is shown as before; a key may answer it first', () => {
  let now = 1_000;
  const state = new CodexTaskState(() => now);
  state.accept(turn('UserPromptSubmit'));
  state.accept(turn('PermissionRequest', T1, {tool:RUN}));
  assert.equal(state.promptWait(), CODEX_PROMPT_WAIT_MS);
  now += CODEX_PROMPT_WAIT_MS - 1;
  assert.equal(state.showOverdue(), undefined);
  assert.equal(state.promptWait(), 1);
  now += 1;
  assert.deepEqual(state.showOverdue(), {status:'attention', notify:true});
  assert.equal(state.promptWait(), undefined);
  assert.deepEqual(state.observeInput('\r'), {status:'working', notify:false}, 'its preselection holds as before');
  state.accept(turn('PermissionRequest', T1, {tool:READ}));
  assert.equal(state.observeInput('\r'), undefined, 'answered before its screen was recognized');
  assert.equal(state.awaitingPrompt, false);
  now += CODEX_PROMPT_WAIT_MS;
  assert.equal(state.showOverdue(), undefined, 'so it is never shown');
});

test('a subagent request waits for that subagent; its own prompt and end are not the user turn', () => {
  const state = new CodexTaskState();
  assert.equal(state.accept(turn('PermissionRequest', S, {agent:A})), undefined, 'no user turn in progress');
  assert.equal(state.awaitingPrompt, false);
  state.accept(turn('UserPromptSubmit'));
  assert.deepEqual(ask(state, turn('PermissionRequest', S, {agent:A})), {status:'attention', notify:true}, 'subagents have their own turn ids');
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
  ask(state);
  assert.deepEqual(state.observeInput('\r'), {status:'working', notify:false}, 'Enter on the preselected "Yes, proceed"');
  ask(state);
  assert.equal(state.observeInput('\x1b[B'), undefined, 'moving the selection');
  assert.deepEqual(state.observeInput('\r'), {status:'idle', notify:false}, 'an answer that may be a rejection');
  assert.deepEqual(state.accept(turn('PostToolUse')), {status:'working', notify:false}, 'the approval proves itself');
  ask(state);
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
  ask(state);
  assert.equal(state.accept(turn('PermissionRequest', S, {agent:A})), undefined);
  assert.equal(state.observeScreen(PROMPT), undefined, 'a second prompt while the first is shown');
  assert.equal(state.observeInput('\r'), undefined, 'the second request is shown next');
  assert.deepEqual(state.accept(turn('PostToolUse', S, {agent:A})), {status:'working', notify:false});
  ask(state);
  assert.equal(state.observeInput('\x1b[200~a\r'), undefined, 'Enter inside a bracketed paste is text');
  assert.equal(state.observeInput('b\r\x1b[201~'), undefined, 'also when the paste spans input chunks');
  assert.deepEqual(state.observeInput('\r'), {status:'idle', notify:false}, 'the paste reached the request first');
});

test('only the shapes the managed hook sends are accepted', () => {
  assert.deepEqual(validCodexEvent({event:'SessionStart', source:'resume', token:'x'}), {event:'SessionStart', source:'resume'});
  assert.deepEqual(validCodexEvent({event:'SessionStart', source:'other'}), {event:'SessionStart'});
  assert.deepEqual(validCodexEvent({event:'SessionEnd', turn:T1}), {event:'SessionEnd'});
  assert.deepEqual(validCodexEvent({event:'Stop', turn:T1, agent:A, question:true, prompt:'secret'}), {event:'Stop', turn:T1, agent:A, question:true});
  assert.deepEqual(validCodexEvent({event:'PostToolUse', turn:T1, tool:RUN, command:'secret'}), {event:'PostToolUse', turn:T1, tool:RUN});
  assert.deepEqual(validCodexEvent({event:'Stop', turn:T1, question:'yes'}), {event:'Stop', turn:T1});
  for (const bad of [null, 'Stop', {event:'Stop'}, {event:'Stop', turn:'turn-1'}, {event:'PreCompact', turn:T1}, {event:'Stop', turn:T1, agent:'agent-a'},
    {event:'Stop', turn:T1.toUpperCase()}, {event:'PostToolUse', turn:T1, tool:'echo secret'}])
    assert.equal(validCodexEvent(bad), undefined, JSON.stringify(bad));
});

test('the engine orders Codex events after parsed output, numbers their alerts, and the shell prompt ends them', async t => {
  const token = 'a'.repeat(64), states: Array<[string, number | undefined, string | undefined]> = [], counts: number[] = [];
  let live = true;
  const engine = new TerminalEngine({cols:60, rows:8, agentToken:token, onResponse(){}, notificationsEnabled:()=>live,
    onAgentStatus:(status, count, provider)=>states.push([status, count, provider]), onNotification:n=>counts.push(n)});
  t.after(()=>engine.dispose());
  assert.equal(await engine.acceptCodexEvent(turn('UserPromptSubmit')), true);
  assert.equal(await engine.acceptCodexEvent(turn('PermissionRequest')), false, 'Codex has not drawn its prompt yet');
  await engine.write('Would you like to run the following command?\r\n');
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

test('the engine shows a Codex request only once Codex asks the user, at any width', async t => {
  const states: Array<[string, number | undefined]> = [];
  const engine = new TerminalEngine({cols:40, rows:6, onResponse(){}, onAgentStatus:(status, count)=>states.push([status, count])});
  t.after(()=>engine.dispose());
  await engine.acceptCodexEvent(turn('UserPromptSubmit'));
  await engine.acceptCodexEvent(turn('PermissionRequest', T1, {tool:RUN}));
  await engine.write('\x1b[2J\x1b[H• Reviewing approval request (3s • esc to interrupt)');
  assert.equal(await engine.acceptCodexEvent(turn('PostToolUse', T1, {tool:RUN})), false, 'the automatic review approved it');
  assert.deepEqual(states, [['working', undefined]], 'nothing was shown or notified');
  await engine.acceptCodexEvent(turn('PermissionRequest', T1, {tool:READ}));
  await engine.write('\x1b[2J\x1b[H  Would you like to run the\r\n  following command?');
  assert.deepEqual(states.at(-1), ['attention', 1], 'a title Codex wrapped itself');
  await engine.acceptCodexEvent(turn('PostToolUse', T1, {tool:READ}));
  await engine.acceptCodexEvent(turn('PermissionRequest', T1, {tool:RUN}));
  await engine.write('\x1b[2J\x1b[HWould you like to make the following edits?');
  assert.deepEqual(states.at(-1), ['attention', 2], 'a title the terminal wrapped');
});

test('the engine shows a Codex request anyway when neither prompt nor review appears in time', async t => {
  const states: string[] = [];
  const engine = new TerminalEngine({cols:40, rows:6, onResponse(){}, onAgentStatus:status=>states.push(status)});
  t.after(()=>engine.dispose());
  await engine.acceptCodexEvent(turn('UserPromptSubmit'));
  await engine.acceptCodexEvent(turn('PermissionRequest', T1, {tool:RUN}));
  await engine.write('a prompt worded some other way');
  assert.deepEqual(states, ['working']);
  await new Promise(resolve => setTimeout(resolve, CODEX_PROMPT_WAIT_MS + 300));
  assert.deepEqual(states, ['working', 'attention']);
});

test('the engine reports while Codex asks whether to trust new or changed hooks', async t => {
  const seen: boolean[] = [];
  const engine = new TerminalEngine({cols:60, rows:12, onResponse(){}, onCodexHooksReview:visible=>seen.push(visible)});
  t.after(()=>engine.dispose());
  await engine.write('Hooks need review\r\n2. Trust all and continue\r\n');
  assert.deepEqual(seen, [], 'the same words in ordinary shell output');
  await engine.write('\x1b[?1049h\x1b[H  Hooks need review\r\n  2 hooks are new or changed.\r\n\r\n> 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without trusting');
  assert.deepEqual(seen, [true]);
  await engine.write('\x1b[2J\x1b[H> Ask Codex to do anything');
  assert.deepEqual(seen, [true, false], 'answered');
  await engine.write('\x1b[?1049l');
  assert.deepEqual(seen, [true, false]);
});
