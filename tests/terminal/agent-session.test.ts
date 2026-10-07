import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeTaskState, validAgentSession, type AgentSessionIdentity } from '../../packages/terminal/agent-status.js';
import { agentResumeCommand, resolveAgentExecutable } from '../../packages/shell-profiles/agent-resume.js';

const token = 'a'.repeat(64);
const idA = '0f8fad5b-d9cb-469f-a165-70867728950e', idB = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const hash = (id: string) => createHash('sha256').update(id).digest('hex');
const payload = (event: string, id: string, extra: Record<string, unknown> = {}) =>
  `mongle-agent;${token};${Buffer.from(JSON.stringify({event, session:hash(id), id, ...extra})).toString('base64')}`;

function tracker() {
  const seen: Array<AgentSessionIdentity | null> = []; let prompts = 0;
  const state = new ClaudeTaskState(token, {onSession: s => seen.push(s), onPrompt: () => { prompts++; }});
  return {state, seen, prompts: () => prompts};
}

test('only a UUID whose hash matches the authenticated session is recorded, with its cwd', () => {
  const {state, seen} = tracker();
  state.accept(`mongle-agent;${token};${Buffer.from(JSON.stringify({event:'SessionStart', session:hash(idA), id:idB})).toString('base64')}`);
  state.accept(`mongle-agent;${token};${Buffer.from(JSON.stringify({event:'SessionStart', session:hash('x'), id:'x'})).toString('base64')}`);
  state.accept(payload('SessionStart', idA).replace(token, 'c'.repeat(64)));
  assert.deepEqual(seen, [], 'mismatched hash, non-UUID or another shell token is ignored');
  state.accept(payload('SessionStart', idA, {cwd:'C:\\work\\a'}));
  assert.deepEqual(seen, [{provider:'claude', sessionId:idA, cwd:'C:\\work\\a'}]);
  state.accept(payload('UserPromptSubmit', idA, {cwd:'C:\\work\\a'}));
  assert.equal(seen.length, 1, 'repeated reports of the same conversation do not re-record');
  state.accept(payload('UserPromptSubmit', idA, {cwd:'C:\\work\\moved'}));
  assert.deepEqual(seen.at(-1), {provider:'claude', sessionId:idA, cwd:'C:\\work\\moved'}, 'a new cwd for the same conversation updates the record');
  state.accept(payload('SessionStart', idA, {cwd:'relative\\dir'}));
  assert.deepEqual(seen.at(-1), {provider:'claude', sessionId:idA}, 'a relative or invalid cwd is never stored');
});

test('/clear or a second conversation replaces the record; SessionEnd and the shell prompt drop it', () => {
  const {state, seen, prompts} = tracker();
  state.accept(payload('SessionStart', idA, {cwd:'C:\\w'}));
  state.accept(payload('SessionStart', idB, {cwd:'C:\\w'}));
  assert.equal((seen.at(-1) as AgentSessionIdentity).sessionId, idB, 'same folder, newer conversation wins exactly');
  state.accept(payload('SessionEnd', idA));
  assert.notEqual(seen.at(-1), null, 'the end of an older conversation does not clear the current one');
  state.accept(payload('SessionEnd', idB));
  assert.equal(seen.at(-1), null);
  state.accept(payload('SessionStart', idA, {cwd:'C:\\w'}));
  state.accept(`mongle-shell;${token}`);
  assert.equal(seen.at(-1), null, 'returning to the shell prompt means the CLI is no longer running');
  assert.equal(prompts(), 1);
  state.accept(`mongle-shell;${token}`);
  assert.equal(seen.filter(item => item === null).length, 2, 'no repeated clear without a record');
});

test('stored identities are revalidated', () => {
  assert.equal(validAgentSession({provider:'claude', sessionId:'not-a-uuid'}), undefined);
  assert.equal(validAgentSession({provider:'gemini', sessionId:idA}), undefined);
  assert.deepEqual(validAgentSession({provider:'codex', sessionId:idA.toUpperCase(), cwd:'\\\\server\\share'}), {provider:'codex', sessionId:idA, cwd:'\\\\server\\share'});
});

test('resume lines use only a host-resolved absolute executable and the validated UUID', () => {
  const exe = {path:'C:\\Users\\me\\.local\\bin\\claude.exe', kind:'exe' as const};
  const shim = {path:'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', kind:'cmd' as const};
  const claude = {provider:'claude' as const, sessionId:idA};
  const codex = {provider:'codex' as const, sessionId:idB};
  assert.equal(agentResumeCommand({kind:'powershell'}, claude, exe), `& "C:\\Users\\me\\.local\\bin\\claude.exe" --resume ${idA}\r`);
  assert.equal(agentResumeCommand({kind:'powershell'}, codex, undefined, {codexWrapper:true}), `__MongleCodex resume ${idB}\r`, 'Codex goes through the capturing wrapper');
  assert.equal(agentResumeCommand({kind:'powershell'}, codex, shim), undefined, 'no lifecycle pipe: plain shell only');
  assert.equal(agentResumeCommand({kind:'cmd'}, codex, shim, {codexWrapper:true}), undefined, 'the wrapper exists only in PowerShell');
  assert.equal(agentResumeCommand({kind:'powershell'}, claude, undefined), undefined);
  assert.equal(agentResumeCommand({kind:'bash'}, claude, exe), `"C:/Users/me/.local/bin/claude.exe" --resume ${idA}\r`);
  assert.equal(agentResumeCommand({kind:'bash'}, codex, shim), undefined, 'Bash cannot run a .cmd shim directly');
  assert.equal(agentResumeCommand({kind:'wsl'}, claude, exe), undefined, 'WSL is unsupported');
  assert.equal(agentResumeCommand({kind:'cmd'}, {provider:'claude', sessionId:'x & del *'} as any, exe), undefined);
  for (const bad of ['claude.exe', 'C:\\a&b\\claude.exe', 'C:\\100%\\claude.exe', 'C:\\a"b\\claude.exe', '\\\\server\\share\\claude.exe'])
    assert.equal(agentResumeCommand({kind:'powershell'}, claude, {path:bad, kind:'exe'}), undefined, bad);
});

test('executable lookup ignores relative PATH entries and prefers a native exe', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mongle-agent-exe-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const npm = path.join(root, 'npm'), native = path.join(root, 'native');
  await mkdir(npm); await mkdir(native);
  await writeFile(path.join(npm, 'codex.cmd'), '@echo off');
  assert.deepEqual(await resolveAgentExecutable('codex', {PATH:`.;relative${path.delimiter}${npm}`}), {path:path.join(npm, 'codex.cmd'), kind:'cmd'});
  await writeFile(path.join(native, 'codex.exe'), '');
  assert.deepEqual(await resolveAgentExecutable('codex', {Path:`${npm};${native}`}), {path:path.join(native, 'codex.exe'), kind:'exe'});
  const planted = path.join(root, 'project'); await mkdir(planted); await writeFile(path.join(planted, 'codex.exe'), '');
  const previous = process.cwd(); process.chdir(planted);
  try { assert.equal(await resolveAgentExecutable('codex', {PATH:'.;project'}), undefined, 'the working directory is never searched'); }
  finally { process.chdir(previous); }
});
