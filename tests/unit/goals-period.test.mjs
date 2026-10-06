// P1-A — Goals period-window math + goal factory (pure, no I/O).
// Week starts Saturday (matches the app). Monthly = whole calendar month. Quarterly = calendar quarter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/goals-model.js', import.meta.url), 'utf8'), { filename: 'js/goals-model.js' });
const T = globalThis.AyyamTime;
const G = globalThis.AyyamGoals;

test('weekly bounds: Saturday→Friday window that contains the anchor, any weekday', () => {
  for (const anchor of ['2026-10-06', '2026-10-03', '2026-10-09', '2026-01-01', '2026-12-31']) {
    const b = G.periodBounds('weekly', anchor);
    assert.equal(T.dayCode(b.start_date), 'sat', `start is Saturday for ${anchor}`);
    assert.equal(T.diffDays(b.end_date, b.start_date), 6, '7-day window');
    assert.ok(T.cmpKey(b.start_date, anchor) <= 0 && T.cmpKey(anchor, b.end_date) <= 0, 'anchor inside window');
  }
});

test('monthly bounds: first..last of the calendar month (incl. leap February)', () => {
  assert.deepEqual(G.periodBounds('monthly', '2026-10-06'), { start_date: '2026-10-01', end_date: '2026-10-31' });
  assert.deepEqual(G.periodBounds('monthly', '2026-02-10'), { start_date: '2026-02-01', end_date: '2026-02-28' }); // non-leap
  assert.deepEqual(G.periodBounds('monthly', '2024-02-15'), { start_date: '2024-02-01', end_date: '2024-02-29' }); // leap
  assert.deepEqual(G.periodBounds('monthly', '2026-12-31'), { start_date: '2026-12-01', end_date: '2026-12-31' }); // year edge
});

test('quarterly bounds: the calendar quarter the anchor falls in', () => {
  assert.deepEqual(G.periodBounds('quarterly', '2026-01-15'), { start_date: '2026-01-01', end_date: '2026-03-31' }); // Q1
  assert.deepEqual(G.periodBounds('quarterly', '2026-05-20'), { start_date: '2026-04-01', end_date: '2026-06-30' }); // Q2
  assert.deepEqual(G.periodBounds('quarterly', '2026-08-01'), { start_date: '2026-07-01', end_date: '2026-09-30' }); // Q3
  assert.deepEqual(G.periodBounds('quarterly', '2026-10-06'), { start_date: '2026-10-01', end_date: '2026-12-31' }); // Q4
});

test('invalid anchor → empty window (never throws)', () => {
  assert.deepEqual(G.periodBounds('weekly', 'not-a-date'), { start_date: '', end_date: '' });
  assert.deepEqual(G.periodBounds('nonsense', '2026-10-06'), { start_date: '', end_date: '' });
  assert.deepEqual(G.periodBounds('monthly', null), { start_date: '', end_date: '' });
});

test('newGoal: sane defaults + correct period window for the anchor', () => {
  const g = G.newGoal({ title: 'إنهاء النسخة الأولى', period_type: 'monthly', measurement_type: 'percentage', target_value: 100 }, 1700000000000, '2026-10-06');
  assert.equal(g.title, 'إنهاء النسخة الأولى');
  assert.equal(g.period_type, 'monthly');
  assert.equal(g.measurement_type, 'percentage');
  assert.equal(g.start_date, '2026-10-01');
  assert.equal(g.end_date, '2026-10-31');
  assert.equal(g.current_value, 0);
  assert.equal(g.status, 'not_started');
  assert.equal(g.area, null);
  assert.deepEqual(g.milestones, []);
  assert.deepEqual(g.links, []);
  assert.equal(g.created_at, 1700000000000);
  assert.ok(typeof g.id === 'string' && g.id.length > 0);
});

test('newGoal: out-of-range enums fall back to safe defaults', () => {
  const g = G.newGoal({ period_type: 'yearly', measurement_type: 'vibes', area: 'astrology', status: 'winning' }, 1, '2026-10-06');
  assert.equal(g.period_type, 'weekly');
  assert.equal(g.measurement_type, 'count');
  assert.equal(g.area, null);
  assert.equal(g.status, 'not_started');
});
