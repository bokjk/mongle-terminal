import test from 'node:test';
import assert from 'node:assert/strict';
import { addKeyBarItem, DEFAULT_KEY_BAR, isDefaultKeyBar, KEY_BAR_KEYS, KEY_BAR_MAX, moveKeyBarItem, removeKeyBarItem, sanitizeKeyBar } from '../../apps/web/src/key-bar';

test('a saved key bar keeps known keys once, in order, within the limit', () => {
  assert.deepEqual(sanitizeKeyBar(undefined), [...DEFAULT_KEY_BAR]);
  assert.deepEqual(sanitizeKeyBar('esc'), [...DEFAULT_KEY_BAR]);
  assert.deepEqual(sanitizeKeyBar([]), [], 'an emptied bar stays empty');
  assert.deepEqual(sanitizeKeyBar(['home', 'esc', 'home', 'removed-key', 3, null, 'pipe']), ['home', 'esc', 'pipe']);
  assert.equal(sanitizeKeyBar(KEY_BAR_KEYS.map(key => key.id)).length, KEY_BAR_MAX);
  assert.equal(new Set(KEY_BAR_KEYS.map(key => key.id)).size, KEY_BAR_KEYS.length);
  assert.ok(DEFAULT_KEY_BAR.every(id => KEY_BAR_KEYS.some(key => key.id === id)));
});

test('moving, adding and removing keys never duplicates or drops another key', () => {
  const bar = ['esc', 'tab', 'ctrl'];
  assert.deepEqual(moveKeyBarItem(bar, 'tab', -1), ['tab', 'esc', 'ctrl']);
  assert.deepEqual(moveKeyBarItem(bar, 'tab', 1), ['esc', 'ctrl', 'tab']);
  assert.deepEqual(moveKeyBarItem(bar, 'esc', -1), bar);
  assert.deepEqual(moveKeyBarItem(bar, 'ctrl', 1), bar);
  assert.deepEqual(addKeyBarItem(bar, 'home'), ['esc', 'tab', 'ctrl', 'home']);
  assert.deepEqual(addKeyBarItem(bar, 'tab'), bar);
  assert.deepEqual(removeKeyBarItem(bar, 'tab'), ['esc', 'ctrl']);
  const full = sanitizeKeyBar(KEY_BAR_KEYS.map(key => key.id));
  assert.deepEqual(addKeyBarItem(full, KEY_BAR_KEYS.at(-1)!.id), full, 'a full bar takes no more keys');
  assert.equal(isDefaultKeyBar([...DEFAULT_KEY_BAR]), true);
  assert.equal(isDefaultKeyBar(moveKeyBarItem(DEFAULT_KEY_BAR, 'tab', -1)), false);
});
