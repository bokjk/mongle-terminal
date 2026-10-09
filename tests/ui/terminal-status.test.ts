import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalInfo } from '../../packages/protocol/index.js';
import { aggregateTerminalStatus, terminalStatus, terminalStatusDescription } from '../../apps/web/src/TerminalStatus.js';
import type { TerminalNotice } from '../../apps/web/src/use-terminal-notifications.js';

const terminal = (id: string, agentStatus?: TerminalInfo['agentStatus']): TerminalInfo => ({id, groupId:'g', title:id, profileId:'pwsh', cwd:'C:/w', generation:'1', status:'running', cols:80, rows:24,
  ...(agentStatus ? {agentStatus, agentProvider:'claude' as const} : {})});
const unseen = (agentUnread = true): TerminalNotice => ({unread:true, agentUnread});

test('a single terminal shows only hook-proven Claude states or an unseen notification', () => {
  assert.equal(terminalStatus(terminal('a', 'completed')), undefined, 'a read completion leaves nothing behind');
  assert.equal(terminalStatus(terminal('a', 'completed'), unseen(false))?.kind, 'notification', 'a later plain notification is not a completion');
  assert.equal(terminalStatus(terminal('a', 'completed'), unseen())?.kind, 'completed');
  assert.equal(terminalStatus({...terminal('a', 'working'), status:'exited'}), undefined);
  const working = terminalStatus(terminal('a', 'working'), unseen());
  assert.deepEqual(working, {kind:'working', unread:false, alsoUnread:true});
  assert.equal(terminalStatusDescription(working), '작업 중 · 미확인 알림');
  assert.equal(terminalStatusDescription(terminalStatus(terminal('a', 'attention'), unseen())), '확인 요청 · 미확인');
});

test('groups keep every unseen alert visible beside the most urgent state', () => {
  const both = aggregateTerminalStatus([terminal('a', 'error'), terminal('b', 'attention')], new Map([['b', unseen()]]));
  assert.equal(both?.kind, 'error');
  assert.equal(both?.unread, true);
  assert.equal(both?.alsoUnread, true, 'a read error cannot hide a new request');
  assert.equal(terminalStatusDescription(both), '오류 1개 · 확인 요청 1개 · 미확인 1개');
  const own = aggregateTerminalStatus([terminal('a', 'attention')], new Map([['a', unseen()]]));
  assert.equal(own?.alsoUnread, false, 'a request explains its own alert');
  assert.equal(terminalStatusDescription(own), '확인 요청 · 미확인');
  const work = aggregateTerminalStatus([terminal('a', 'working'), terminal('b', 'completed')], new Map([['b', unseen()]]));
  assert.deepEqual([work?.kind, work?.alsoUnread], ['working', true]);
  assert.equal(terminalStatusDescription(work), '작업 중 1개 · 미확인 1개');
  assert.equal(aggregateTerminalStatus([terminal('a', 'idle'), terminal('b')], new Map()), undefined);
});

