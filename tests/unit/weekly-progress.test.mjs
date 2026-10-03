// Weekly progress must be computed from ALL 7 days' effective tasks (not today-only, not an average of
// opened days). Exercises AyyamRoutines.rangeCounts/dayCounts — the shared helper the hero Week card uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/routines-model.js', import.meta.url), 'utf8'), { filename: 'js/routines-model.js' });
const R = globalThis.AyyamRoutines;
const T = globalThis.AyyamTime;
const emptyDays = () => ({ sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] });

// 7 consecutive day-keys starting at a known Saturday (matches the app's Sat→Fri week).
const WEEK = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];

// Build a day's log holding `total` one-off (extra) tasks, `done` of them completed. Fully date-scoped,
// so each day's task count is exactly controlled (no dayCode guessing).
function day(key, total, done) {
  const extra = [], d = {};
  for (let i = 1; i <= total; i++) { const id = `${key}#${i}`; extra.push({ id, title: 'مهمة', period: null, time: '' }); if (i <= done) d[id] = true; }
  return { done: d, extra, hidden: {}, overrides: {}, excused: {}, replacements: {} };
}
function bundleOf(logs) { return { template: emptyDays(), tplArchive: { since: '0000-00-00', versions: [] }, logs, routines: {}, migrationDate: '' }; }

test('EXAMPLE 1: Sat 10/4 done, other 6 days 10/0 → weekly is NOT 40% (it is 4/70)', () => {
  const logs = {}; WEEK.forEach((k, i) => (logs[k] = day(k, 10, i === 0 ? 4 : 0)));
  const r = R.rangeCounts(bundleOf(logs), WEEK);
  assert.equal(r.total, 70);
  assert.equal(r.completed, 4);
  assert.notEqual(r.pct, 40);              // the bug would have shown 40 (Saturday-only)
  assert.equal(r.pct, Math.round(4 / 70 * 100)); // = 6
});

test('EXAMPLE 2: 7 days × 4 = 28 total, 2 completed → weekly = round(2/28*100) = 7%', () => {
  const logs = {}; WEEK.forEach((k) => (logs[k] = day(k, 4, 0)));
  logs[WEEK[0]] = day(WEEK[0], 4, 2);      // 2 done on one day
  const r = R.rangeCounts(bundleOf(logs), WEEK);
  assert.equal(r.total, 28);
  assert.equal(r.completed, 2);
  assert.equal(r.pct, 7);
});

test('EXAMPLE 3: empty days do not distort the denominator', () => {
  const logs = { [WEEK[0]]: day(WEEK[0], 4, 2) }; // only Saturday has tasks; the other 6 days are empty
  const r = R.rangeCounts(bundleOf(logs), WEEK);
  assert.equal(r.total, 4);                 // empty days added 0, not 0-of-something
  assert.equal(r.completed, 2);
  assert.equal(r.pct, 50);
});

test('EXAMPLE 4: routine occurrences on FUTURE days of the week are counted', () => {
  const routines = { r1: { id: 'r1', seriesId: 'r1', title: 'ورد يومي', time: '', timeValue: null, period: null, order: 0,
    rec: { freq: 'daily', from: '2000-01-01', to: null } } };
  const bundle = { template: emptyDays(), tplArchive: { since: '0000-00-00', versions: [] }, logs: {}, routines, migrationDate: '2000-01-01' };
  const r = R.rangeCounts(bundle, WEEK);
  assert.equal(r.total, 7);                 // one occurrence per day, all 7 days counted (incl. future)
  assert.equal(r.completed, 0);
  assert.equal(r.pct, 0);
});

test('EXAMPLE 5: hidden excluded; excused counted-not-complete; replaced original + replacement follow Today semantics', () => {
  const key = WEEK[0];
  const dc = T.dayCode(key);
  // base (template) task to exercise `hidden` (hidden only filters base occurrences, like Today)
  const template = emptyDays(); template[dc] = [{ id: 'baseHidden', title: 'مخفي', period: null, time: '', _order: 0 }];
  const log = {
    done: { normal: true, [R.replId('rep')]: true }, // a normal done + the replacement completed
    extra: [ { id: 'normal', title: 'عادي', period: null, time: '' },
             { id: 'exc', title: 'معذور', period: null, time: '' },
             { id: 'rep', title: 'مستبدل', period: null, time: '' } ],
    hidden: { baseHidden: true },
    overrides: {}, excused: { exc: { reason: 'travel' } },
    replacements: { rep: { task: { title: 'بديل', period: null, time: '' } } },
  };
  const bundle = { template, tplArchive: { since: '0000-00-00', versions: [] }, logs: { [key]: log }, routines: {}, migrationDate: '' };
  const c = R.dayCounts(bundle, key);
  // counted in total: normal + exc + rep(original) + replacement  = 4  (baseHidden is filtered out)
  assert.equal(c.total, 4);
  // completed: normal + replacement = 2  (excused & replaced-original are not "done")
  assert.equal(c.completed, 2);
});

test('EXAMPLE 6: a task change updates the weekly counts consistently', () => {
  const logs = {}; WEEK.forEach((k) => (logs[k] = day(k, 4, 0)));
  const before = R.rangeCounts(bundleOf(logs), WEEK);
  assert.equal(before.completed, 0);
  logs[WEEK[2]].done[`${WEEK[2]}#1`] = true; // complete one task mid-week
  const after = R.rangeCounts(bundleOf(logs), WEEK);
  assert.equal(after.total, before.total);
  assert.equal(after.completed, 1);
  assert.equal(after.pct, Math.round(1 / before.total * 100));
});

test('EXAMPLE 7: a task outside the week does not leak into the current week', () => {
  const outside = '2026-10-03'; // the day AFTER the week (Friday+1)
  const logs = { [WEEK[0]]: day(WEEK[0], 2, 1), [outside]: day(outside, 5, 5) };
  const r = R.rangeCounts(bundleOf(logs), WEEK);
  assert.equal(r.total, 2);   // only the in-week day counts; the outside day's 5 tasks are excluded
  assert.equal(r.completed, 1);
});

test('empty week → 0%', () => {
  assert.equal(R.rangeCounts(bundleOf({}), WEEK).pct, 0);
});
