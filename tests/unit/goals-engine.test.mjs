// P1-B — Progress Engine + Pace Engine (pure, deterministic, no AI, no forecasting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/goals-model.js', import.meta.url), 'utf8'), { filename: 'js/goals-model.js' });
const G = globalThis.AyyamGoals;
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('progress — count / quantity: current / target', () => {
  assert.ok(near(G.progress({ measurement_type: 'count', current_value: 5, target_value: 12 }).pct, 41.666, 0.01));
  const q = G.progress({ measurement_type: 'quantity', current_value: 12, target_value: 30, unit: 'ساعة' });
  assert.ok(near(q.pct, 40)); assert.equal(q.current, 12); assert.equal(q.target, 30);
});

test('progress — percentage: current is the percent (clamped)', () => {
  assert.deepEqual(G.progress({ measurement_type: 'percentage', current_value: 65 }), { pct: 65, current: 65, target: 100 });
  assert.equal(G.progress({ measurement_type: 'percentage', current_value: 120 }).pct, 100); // clamp
});

test('progress — milestones: completed / total', () => {
  const g = { measurement_type: 'milestones', milestones: [{ completed: true }, { completed: true }, { completed: false }, { completed: false }] };
  assert.deepEqual(G.progress(g), { pct: 50, current: 2, target: 4 });
  assert.deepEqual(G.progress({ measurement_type: 'milestones', milestones: [] }), { pct: 0, current: 0, target: 0 }); // no div-by-zero
});

test('progress — linked_activity: uses injected linkedValue, else falls back to current_value', () => {
  assert.ok(near(G.progress({ measurement_type: 'linked_activity', target_value: 10, current_value: 1 }, { linkedValue: 3 }).pct, 30));
  assert.ok(near(G.progress({ measurement_type: 'linked_activity', target_value: 10, current_value: 4 }).pct, 40)); // no linkedValue → fallback
});

test('progress — zero/invalid target and negative values never throw or exceed [0,100]', () => {
  assert.equal(G.progress({ measurement_type: 'count', current_value: 5, target_value: 0 }).pct, 0);
  assert.equal(G.progress({ measurement_type: 'count', current_value: -3, target_value: 12 }).pct, 0);
  assert.equal(G.progress({ measurement_type: 'count', current_value: 99, target_value: 12 }).pct, 100);
  assert.equal(G.progress(null).pct, 0);
});

test('timeElapsedPct — inclusive window: start day ≈ 1/total, end day = 100, outside clamps', () => {
  const g = { start_date: '2026-10-01', end_date: '2026-10-07' }; // 7-day window
  assert.ok(near(G.timeElapsedPct(g, '2026-10-01'), 100 / 7, 0.01)); // day 1
  assert.ok(near(G.timeElapsedPct(g, '2026-10-04'), (4 / 7) * 100, 0.01));
  assert.equal(G.timeElapsedPct(g, '2026-10-07'), 100); // last day
  assert.equal(G.timeElapsedPct(g, '2026-09-30'), 0);   // before start
  assert.equal(G.timeElapsedPct(g, '2026-10-20'), 100); // after end
  assert.equal(G.timeElapsedPct({ start_date: 'x', end_date: 'y' }, '2026-10-01'), 0); // invalid
});

test('paceStatus — terminal states short-circuit; completion from progress', () => {
  assert.equal(G.paceStatus(10, 50, { status: 'paused' }), 'paused');
  assert.equal(G.paceStatus(10, 50, { status: 'archived' }), 'archived');
  assert.equal(G.paceStatus(100, 40, { status: 'not_started' }), 'completed');
  assert.equal(G.paceStatus(130, 40, {}), 'completed');
});

test('paceStatus — no verdict before MIN_ELAPSED_PCT (no day-1 false alarms / 1-day jitter)', () => {
  assert.equal(G.paceStatus(0, 10, {}), 'on_track');  // 10% elapsed < 15% → too early
  assert.equal(G.paceStatus(0, 3, {}), 'on_track');   // day 1 of ~30
});

test('paceStatus — on_track / at_risk / behind thresholds (percentage-point gaps)', () => {
  assert.equal(G.paceStatus(50, 50, {}), 'on_track');   // gap 0
  assert.equal(G.paceStatus(46, 50, {}), 'on_track');   // gap -4 (within 5)
  assert.equal(G.paceStatus(40, 50, {}), 'at_risk');    // gap -10
  assert.equal(G.paceStatus(31, 50, {}), 'at_risk');    // gap -19 (within 20)
  assert.equal(G.paceStatus(29, 50, {}), 'behind');     // gap -21
  assert.equal(G.paceStatus(80, 50, {}), 'on_track');   // ahead of schedule
});

test('evaluate — one deterministic call returns progress + elapsed + pace for a card', () => {
  const g = { measurement_type: 'count', current_value: 6, target_value: 12, start_date: '2026-10-01', end_date: '2026-10-31', status: 'on_track' };
  const e = G.evaluate(g, '2026-10-16');
  assert.equal(e.current, 6); assert.equal(e.target, 12);
  assert.ok(near(e.progress_pct, 50));
  assert.ok(near(e.time_elapsed_pct, (16 / 31) * 100, 0.01));
  assert.equal(e.pace_status, 'on_track'); // 50% done vs ~51.6% elapsed → within tolerance
});
