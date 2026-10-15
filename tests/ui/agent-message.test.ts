import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HostState, TerminalInfo } from '../../packages/protocol/index.js';
import { AgentInboxBanner, agentHoldDescription, agentName, canMessageAgent } from '../../apps/web/src/AgentMessage.js';

const state = { hostId: 'h', bootId: 'b', capabilities: ['agent.messages'] } as unknown as HostState;
const terminal = (extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id: 't', groupId: 'g', title: 'PowerShell', profileId: 'pwsh', cwd: 'C:/w', generation: '1', status: 'running', cols: 80, rows: 24, ...extra });
const request = async () => undefined as never;

test('messages can be sent only to a hook-proven agent on a host that supports them', () => {
  assert.equal(canMessageAgent(state, terminal({ agentReady: true })), true);
  assert.equal(canMessageAgent(state, terminal()), false, 'no agent proved itself');
  assert.equal(canMessageAgent(state, terminal({ agentReady: true, status: 'exited' })), false);
  assert.equal(canMessageAgent({ ...state, capabilities: [] }, terminal({ agentReady: true })), false, 'an older host has no inbox');
  assert.equal(agentName(terminal({ agentProvider: 'codex' })), 'Codex');
  assert.equal(agentName(terminal({ agentProvider: 'claude' })), 'Claude Code');
});

test('every hold reason has a plain description', () => {
  for (const reason of ['no-agent', 'starting', 'busy', 'attention', 'unconfirmed', 'typing', 'dnd', 'delivering'] as const)
    assert.ok(agentHoldDescription(reason).length > 4, reason);
  assert.equal(agentHoldDescription('busy'), '지금 작업이 끝나면 전달');
});

test('the banner shows what waits and offers "send now" only for typing holds', () => {
  const render = (info: TerminalInfo) => renderToStaticMarkup(createElement(AgentInboxBanner, { state, info, request, onError: () => {} }));
  assert.equal(render(terminal()), '', 'nothing waits');
  const message = { id: 'm1', preview: '검토를 시작해 주세요', createdAt: 1, from: 'phone' };
  const busy = render(terminal({ agentProvider: 'claude', agentInbox: { messages: [message, { ...message, id: 'm2' }], hold: 'busy', delivered: 0 } }));
  assert.match(busy, /보낼 메시지 2개/);
  assert.match(busy, /지금 작업이 끝나면 전달/);
  assert.match(busy, /검토를 시작해 주세요/);
  assert.doesNotMatch(busy, /지금 보내기/, 'a working agent is never interrupted');
  assert.match(busy, /맨 앞 메시지 취소/);
  assert.match(render(terminal({ agentInbox: { messages: [message], hold: 'typing', delivered: 0 } })), /지금 보내기/);
  assert.doesNotMatch(render(terminal({ agentInbox: { messages: [{ ...message, force: true }], hold: 'typing', delivered: 0 } })), /지금 보내기/, 'already forced');
  assert.equal(render(terminal({ status: 'exited', agentInbox: { messages: [message], delivered: 0 } })), '');
});
