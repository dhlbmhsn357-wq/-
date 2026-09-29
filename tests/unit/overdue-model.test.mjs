import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as adhan from 'adhan';

for (const f of ['js/time-model.js', 'js/routines-model.js', 'js/overdue-model.js'])
  vm.runInThisContext(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), { filename: f });
const O = globalThis.AyyamOverdue;

const LOC = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' };
const DATE = '2026-10-01';
const log = (o) => Object.assign({ done: {}, extra: [], hidden: {}, overrides: {} }, o);
const daily = (id, period, timeValue) => ({ id, seriesId: id, title: id, time: '', timeValue: timeValue || null, period, order: 0, rec: { freq: 'daily', from: '2026-09-01', to: null } });

function bundle(logs) {
  return {
    prefs: { dayTimezone: 'Africa/Cairo', location: LOC },
    migrationDate: '2026-09-01',
    template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
    tplArchive: { since: '0000-00-00', versions: [] },
    routines: {
      f: daily('f', 'fajr'), d: daily('d', 'dhuhr'), a: daily('a', 'asr'),
      m: daily('m', 'maghrib'), i: daily('i', 'isha'),
    },
    logs: logs || {},
  };
}
// Real prayer instants for the fixture date/location, so `now` sits truly inside each window.
const params = adhan.CalculationMethod.Egyptian();
const pt = new adhan.PrayerTimes(new adhan.Coordinates(LOC.lat, LOC.lng), new Date(2026, 9, 1, 12), params);
const after = (p) => pt[p].getTime() + 60 * 1000; // one minute after the prayer begins
const titles = (res) => res.tasks.map((t) => t.title).sort();
const run = (b, nowMs) => O.overdueForNow(b, { adhan, now: nowMs, today: DATE, location: LOC });

test('before fajr: nothing is overdue yet', () => {
  const res = run(bundle(), new Date('2026-10-01T00:10:00+02:00').getTime());
  assert.equal(res.available, true);
  assert.equal(res.count, 0);
});
test('inside fajr: no period has ended yet', () => {
  assert.deepEqual(titles(run(bundle(), after('fajr'))), []);
});
test('inside dhuhr: only fajr is overdue', () => {
  assert.deepEqual(titles(run(bundle(), after('dhuhr'))), ['f']);
});
test('inside asr: fajr + dhuhr overdue', () => {
  assert.deepEqual(titles(run(bundle(), after('asr'))), ['d', 'f']);
});
test('inside maghrib: fajr + dhuhr + asr overdue', () => {
  assert.deepEqual(titles(run(bundle(), after('maghrib'))), ['a', 'd', 'f']);
});
test('inside isha: everything before isha overdue (isha itself is NOT)', () => {
  assert.deepEqual(titles(run(bundle(), after('isha'))), ['a', 'd', 'f', 'm']);
});
test('completed tasks are never overdue', () => {
  const res = run(bundle({ [DATE]: log({ done: { f: true } }) }), after('dhuhr'));
  assert.deepEqual(titles(res), []);
});
test('hidden (deleted-today) tasks do not appear', () => {
  const res = run(bundle({ [DATE]: log({ hidden: { d: true } }) }), after('asr'));
  assert.deepEqual(titles(res), ['f']); // d hidden → only fajr remains overdue
});
test('future periods never appear as overdue', () => {
  const res = run(bundle(), after('dhuhr'));
  assert.ok(!titles(res).includes('i') && !titles(res).includes('a') && !titles(res).includes('m'));
});
test('a timed task inside the current period is overdue once its exact time passed', () => {
  // a dhuhr task at 05:00 (already long past by dhuhr) → overdue even though dhuhr is the current period
  const b = bundle({});
  b.routines.timed = daily('timed', 'dhuhr', '05:00');
  const res = run(b, after('dhuhr'));
  assert.ok(titles(res).includes('timed'));
});
test('a free task with no time is not overdue during the day', () => {
  const b = bundle({});
  b.routines.free = daily('free', null, null);
  const res = run(b, after('isha'));
  assert.ok(!titles(res).includes('free'));
});
test('a free timed task becomes overdue after its time', () => {
  const b = bundle({});
  b.routines.freeT = daily('freeT', null, '00:05'); // 00:05 — passed by any daytime "now"
  const res = run(b, after('dhuhr'));
  assert.ok(titles(res).includes('freeT'));
});
test('no adhan → card hidden (never guesses boundaries)', () => {
  const res = O.overdueForNow(bundle(), { now: after('isha'), today: DATE, location: LOC, adhan: null });
  assert.equal(res.available, false);
  assert.equal(res.count, 0);
});
