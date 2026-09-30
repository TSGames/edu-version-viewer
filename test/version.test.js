import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionKey, isAtLeast } from '../src/version.js';

test('versionKey parses numeric parts, null for unknown', () => {
  assert.deepEqual(versionKey('9.1.2'), [9, 1, 2]);
  assert.deepEqual(versionKey('11.0-SNAPSHOT'), [11, 0]);
  assert.equal(versionKey(null), null);
  assert.equal(versionKey('abc'), null);
});

test('isAtLeast compares numerically, inclusive, unknown fails', () => {
  assert.equal(isAtLeast('11.0', '11.0'), true);
  assert.equal(isAtLeast('11.0.0', '11.0'), true);
  assert.equal(isAtLeast('11', '11.0'), true);
  assert.equal(isAtLeast('10.9.9', '11.0'), false);
  assert.equal(isAtLeast('10.0', '9.0'), true); // not a string compare
  assert.equal(isAtLeast(null, '9.0'), false);
});
