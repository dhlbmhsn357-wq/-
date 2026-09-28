import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
vm.runInThisContext(readFileSync(new URL('../../js/routines-model.js', import.meta.url), 'utf8'), { filename: 'js/routines-model.js' });
const R = globalThis.AyyamRoutines;

// A migrated bundle (migrationDate in the past => every test date goes through the routines path).
const B = (routines, logs) => ({ routines: R.cleanRoutines(routines), logs: logs || {}, template: {}, tplArchive: { since: '0000-00-00', versions: [] }, migrationDate: '2026-01-01' });
const titles = (b, d) => R.tasksForDate(b, d).map((t) => t.title);
const ids = (b, d) => R.tasksForDate(b, d).map((t) => t.id);
const weekly = (id, days, extra) => ({ id, seriesId: id, title: id, time: '', period: null, order: 0, rec: Object.assign({ freq: 'weekly', days, from: '2026-01-01', to: null }, extra || {}) });

// 1
test('this week only (once): appears only on its date', () => {
  const b = B({ o: { id: 'o', seriesId: 'o', title: 'مراجعة', order: 0, rec: { freq: 'once', on: '2026-10-01', from: '2026-01-01' } } });
  assert.deepEqual(titles(b, '2026-10-01'), ['مراجعة']);
  assert.deepEqual(titles(b, '2026-10-08'), []);
});
// 2
test('weekly on one weekday', () => {
  const b = B({ r: weekly('r', ['mon']) });
  assert.deepEqual(titles(b, '2026-09-28'), ['r']); // Monday
  assert.deepEqual(titles(b, '2026-09-27'), []);    // Sunday
});
// 3
test('daily: every day', () => {
  const b = B({ d: { id: 'd', seriesId: 'd', title: 'ورد', order: 0, rec: { freq: 'daily', from: '2026-01-01', to: null } } });
  assert.deepEqual(titles(b, '2026-09-28'), ['ورد']);
  assert.deepEqual(titles(b, '2026-09-27'), ['ورد']);
});
// 4
test('selected weekdays: ONE routine id across the chosen days', () => {
  const b = B({ r: weekly('r', ['sat', 'mon', 'wed']) });
  assert.deepEqual(titles(b, '2026-09-26'), ['r']); // Sat
  assert.deepEqual(titles(b, '2026-09-28'), ['r']); // Mon
  assert.deepEqual(titles(b, '2026-09-30'), ['r']); // Wed
  assert.deepEqual(titles(b, '2026-09-29'), []);    // Tue
  assert.deepEqual(ids(b, '2026-09-26'), ids(b, '2026-09-30')); // same occurrence identity
});
// 5
test('today-only edit: override affects only that date', () => {
  const b = B({ r: weekly('r', ['mon']) }, { '2026-09-28': { done: {}, extra: [], hidden: {}, overrides: { r: { title: 'معدّل اليوم' } } } });
  assert.deepEqual(titles(b, '2026-09-28'), ['معدّل اليوم']);
  assert.deepEqual(titles(b, '2026-10-05'), ['r']); // next Monday unchanged
});
// 6
test('future edit (split): past keeps old, future gets new; distinct occurrence ids; never double', () => {
  const start = { r: weekly('r', ['mon'], { from: '2026-01-01' }) };
  start.r.title = 'أصل';
  const map = R.splitRoutine(start, 'r', '2026-09-28', { title: 'جديد' });
  const b = B(map);
  assert.deepEqual(titles(b, '2026-09-21'), ['أصل']);  // before split
  assert.deepEqual(titles(b, '2026-09-28'), ['جديد']); // from split forward
  assert.notEqual(ids(b, '2026-09-21')[0], ids(b, '2026-09-28')[0]); // different segment ids
  assert.equal(R.tasksForDate(b, '2026-09-28').length, 1); // exactly one occurrence, no double
  assert.equal(map['r'].rec.to, '2026-09-27'); // old segment closed immutably at split-1
});
// 7
test('today-only delete: hidden removes just that date', () => {
  const b = B({ r: weekly('r', ['mon']) }, { '2026-09-28': { done: {}, extra: [], hidden: { r: true }, overrides: {} } });
  assert.deepEqual(titles(b, '2026-09-28'), []);
  assert.deepEqual(titles(b, '2026-10-05'), ['r']);
});
// 8
test('future delete (endRoutine): present before, absent from the end date', () => {
  const { routines } = R.endRoutine({ r: weekly('r', ['mon']) }, 'r', '2026-09-28');
  const b = B(routines);
  assert.deepEqual(titles(b, '2026-09-21'), ['r']);
  assert.deepEqual(titles(b, '2026-09-28'), []);
  assert.equal(routines['r'].rec.to, '2026-09-27');
});
// 9
test('done occurrence is a per-day log, never mutates the rule', () => {
  const routines = { r: weekly('r', ['mon']) };
  const b = B(routines, { '2026-09-28': { done: { r: true }, extra: [], hidden: {}, overrides: {} } });
  assert.equal(R.tasksForDate(b, '2026-09-28')[0].done, true);
  assert.equal(R.tasksForDate(b, '2026-10-05')[0].done, false); // next week not done
  assert.deepEqual(b.routines['r'].rec, weekly('r', ['mon']).rec); // rule unchanged
});
// 10
test('historical day is unchanged after a future rule change', () => {
  const start = { r: weekly('r', ['mon']) };
  start.r.title = 'أصل';
  const before = R.tasksForDate(B(start), '2026-09-21');
  const map = R.splitRoutine(start, 'r', '2026-09-28', { title: 'جديد' });
  const after = R.tasksForDate(B(map), '2026-09-21');
  assert.deepEqual(after, before); // the past does not move
});
// 11
test('split is deterministic: two devices derive the same new occurrence id', () => {
  const seed = () => { const s = { r: weekly('r', ['mon']) }; s.r.title = 'أصل'; return s; };
  const a = R.splitRoutine(seed(), 'r', '2026-09-28', { title: 'جديد' });
  const c = R.splitRoutine(seed(), 'r', '2026-09-28', { title: 'جديد' });
  assert.deepEqual(Object.keys(a).sort(), Object.keys(c).sort());
  assert.ok(a['r#2026-09-28']); // deterministic id = seriesId#fromDate
  assert.equal(a['r#2026-09-28'].seriesId, 'r'); // continuity across the split
});
// 12
test('offline creation is a pure map edit (no I/O), reflected immediately', () => {
  const map = {};
  map['n'] = weekly('n', ['tue']);
  assert.deepEqual(titles(B(map), '2026-09-29'), ['n']); // Tuesday
});

test('occurrencesForDate never yields two segments of one series (defensive against overlap)', () => {
  // two overlapping segments of series "s" — engine must pick exactly one, deterministically
  const routines = R.cleanRoutines({
    a: { id: 'a', seriesId: 's', title: 'A', order: 0, rec: { freq: 'weekly', days: ['mon'], from: '2026-01-01', to: null } },
    b: { id: 'b', seriesId: 's', title: 'B', order: 0, rec: { freq: 'weekly', days: ['mon'], from: '2026-06-01', to: null } },
  });
  const occ = R.occurrencesForDate(routines, '2026-09-28', 'mon');
  assert.equal(occ.length, 1);
  assert.equal(occ[0].id, 'b'); // latest `from` wins
});

test('structured timeValue flows through occurrences and today-only overrides', () => {
  const withTv = { id:'r', seriesId:'r', title:'ت', timeValue:'09:05', order:0, rec:{ freq:'daily', from:'2026-01-01', to:null } };
  assert.equal(R.tasksForDate(B({ r: withTv }), '2026-09-28')[0].timeValue, '09:05');
  const b = B({ r: withTv }, { '2026-09-28': { done:{}, extra:[], hidden:{}, overrides:{ r:{ title:'ت', timeValue:'18:30' } } } });
  assert.equal(R.tasksForDate(b, '2026-09-28')[0].timeValue, '18:30'); // override wins for that date
  assert.equal(R.tasksForDate(b, '2026-09-29')[0].timeValue, '09:05'); // other days keep the routine time
});

test('pre-migration dates fall back to legacy template/tplArchive, ignoring routines', () => {
  const b = { routines: R.cleanRoutines({ r: weekly('r', ['mon']) }), logs: {}, migrationDate: '2026-09-01',
    template: { mon: [{ id: 'old', title: 'قديم', time: '', period: null }], sat: [], sun: [], tue: [], wed: [], thu: [], fri: [] },
    tplArchive: { since: '0000-00-00', versions: [] } };
  assert.deepEqual(titles(b, '2026-08-24'), ['قديم']); // < migrationDate (a Monday) -> legacy template only
  assert.deepEqual(titles(b, '2026-09-28'), ['r']);    // >= migrationDate -> routines
});
