import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, matches } from '../src/cron.js';

test('parses every-15-minutes', () => {
  const p = parseCron('*/15 * * * *');
  assert.deepEqual([...p.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.equal(p.hour.size, 24);
});

test('parses ranges and lists', () => {
  const p = parseCron('0 9-17 * * 1,3,5');
  assert.ok(p.hour.has(9) && p.hour.has(17) && !p.hour.has(8));
  assert.deepEqual([...p.dow].sort((a, b) => a - b), [1, 3, 5]);
});

test('parses range with step', () => {
  const p = parseCron('0 0-12/3 * * *');
  assert.deepEqual([...p.hour].sort((a, b) => a - b), [0, 3, 6, 9, 12]);
});

test('rejects wrong field count', () => {
  assert.throws(() => parseCron('* * * *'));
  assert.throws(() => parseCron('* * * * * *'));
});

test('rejects out-of-range values', () => {
  assert.throws(() => parseCron('60 * * * *'));
  assert.throws(() => parseCron('* 24 * * *'));
});

test('matches at the right minute', () => {
  const expr = '*/15 * * * *';
  const p = parseCron(expr);
  const parts = expr.split(' ');
  assert.equal(matches(p, new Date(2026, 0, 1, 10, 15, 0), parts), true);
  assert.equal(matches(p, new Date(2026, 0, 1, 10, 16, 0), parts), false);
});

test('day-of-week restriction matches', () => {
  // 2026-06-22 is a Monday (dow=1)
  const expr = '0 8 * * 1';
  const p = parseCron(expr);
  const parts = expr.split(' ');
  assert.equal(matches(p, new Date(2026, 5, 22, 8, 0, 0), parts), true);
  assert.equal(matches(p, new Date(2026, 5, 23, 8, 0, 0), parts), false);
});

test('DOM and DOW both restricted -> OR semantics', () => {
  const expr = '0 0 1 * 1'; // 1st of month OR Monday
  const p = parseCron(expr);
  const parts = expr.split(' ');
  // 2026-06-01 is a Monday — matches both; pick a non-Monday 1st: 2026-07-01 is Wednesday
  assert.equal(matches(p, new Date(2026, 6, 1, 0, 0, 0), parts), true); // is 1st
  // A Monday that isn't the 1st: 2026-06-08
  assert.equal(matches(p, new Date(2026, 5, 8, 0, 0, 0), parts), true); // is Monday
  // Neither 1st nor Monday: 2026-06-09 (Tuesday)
  assert.equal(matches(p, new Date(2026, 5, 9, 0, 0, 0), parts), false);
});
