import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const f of ['js/time-model.js', 'js/routines-model.js', 'js/analytics-model.js'])
  vm.runInThisContext(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), { filename: f });
const A = globalThis.AyyamAnalytics;
const log = (o) => Object.assign({ done: {}, extra: [], hidden: {}, overrides: {} }, o);
const daily = (id, period) => ({ id, seriesId: id, title: id, time: '', timeValue: null, period, order: 0, rec: { freq: 'daily', from: '2026-10-01', to: null } });

// Five daily tasks all month; today = 2026-10-10.
function base(logs) {
  return {
    prefs: { dayTimezone: 'Africa/Cairo' },
    migrationDate: '2026-10-01',
    template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
    tplArchive: { since: '0000-00-00', versions: [] },
    routines: { r1: daily('r1', 'fajr'), r2: daily('r2', 'dhuhr'), r3: daily('r3', 'asr'), r4: daily('r4', 'maghrib'), r5: daily('r5', 'isha') },
    logs: logs || {},
  };
}
const TODAY = '2026-10-10';

test('month performance is over RECORDED days only: one 80% day + many unrecorded = 80%, never diluted', () => {
  // Oct 5 recorded at 4/5 = 80%; every other day untracked (no logs). Nothing else finished.
  const b = base({ '2026-10-05': log({ done: { r1: true, r2: true, r3: true, r4: true } }) });
  const m = A.monthSummary(b, 2026, 10, { today: TODAY });
  assert.equal(m.recordedDays, 1);
  assert.equal(m.expected, 5);        // only Oct 5 contributes to the denominator
  assert.equal(m.completed, 4);
  assert.equal(m.overallRatePct, 80); // 4/5 — NOT 4/(5*number-of-days)
});

test('unrecorded days never enter the denominator, and future days are excluded entirely', () => {
  const b = base({ '2026-10-05': log({ done: { r1: true, r2: true, r3: true, r4: true } }) });
  const m = A.monthSummary(b, 2026, 10, { today: TODAY });
  // Oct 11..31 are in the future → not scored as unrecorded and not in expected/completed.
  const futureUnrecorded = m.daySummaries.filter((s) => s.date > TODAY && s.state === 'unrecorded');
  // they still materialize tasks, but monthSummary must not have counted them anywhere:
  assert.equal(m.expected, 5);        // unchanged by the 21 future days
  assert.ok(m.unrecordedDays <= 9);   // only Oct 1-4,6-10 (<= today) can be unrecorded
  assert.ok(futureUnrecorded.length >= 1); // (they exist in daySummaries, but were `continue`d in scoring)
});

test('today (in-progress) shows a live class but is NOT counted in the month denominator', () => {
  // today has activity: 3/5 done → live "medium"; must not change expected/overall computed over finished days.
  const b = base({
    '2026-10-05': log({ done: { r1: true, r2: true, r3: true, r4: true } }),          // finished, 80%
    [TODAY]: log({ done: { r1: true, r2: true, r3: true } }),                          // in-progress, 3/5
  });
  const today = A.daySummary(b, TODAY, { today: TODAY });
  assert.equal(today.isInProgress, true);
  assert.equal(A.liveClass(today), 'medium');   // 0.6 → medium (live hint)
  // The A1 protection lives at the AGGREGATION level, not in classify(): monthSummary must skip today.
  const m = A.monthSummary(b, 2026, 10, { today: TODAY });
  assert.equal(m.expected, 5);                    // today excluded → denominator still only Oct 5
  assert.equal(m.completed, 4);
  assert.equal(m.overallRatePct, 80);
  assert.equal(m.highDays + m.mediumDays + m.lowDays, 1); // only Oct 5 classified; today not ranked
});

test('liveClass returns null when today has no activity yet (ring only, no dot)', () => {
  const b = base({});
  const today = A.daySummary(b, TODAY, { today: TODAY });
  assert.equal(today.state, 'unrecorded');
  assert.equal(A.liveClass(today), null);
});
