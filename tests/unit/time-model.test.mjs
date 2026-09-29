import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../js/time-model.js', import.meta.url), 'utf8'), { filename: 'js/time-model.js' });
const T = globalThis.AyyamTime;

// An instant late enough in UTC that positive-offset zones have already ticked to the next calendar day.
const NIGHT = Date.parse('2026-09-27T22:30:00Z');

test('todayKey: canonical day depends on timezone, not the raw instant', () => {
  assert.equal(T.todayKey('Etc/UTC', NIGHT), '2026-09-27');
  assert.equal(T.todayKey('Asia/Riyadh', NIGHT), '2026-09-28');   // fixed UTC+3 -> crossed midnight
  assert.equal(T.todayKey('Etc/GMT+5', NIGHT), '2026-09-27');     // fixed UTC-5 -> still 27th
});

test('todayKey: DST-capable zone (Africa/Cairo) returns a well-formed key at the boundary', () => {
  const k = T.todayKey('Africa/Cairo', NIGHT);
  assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(k === '2026-09-27' || k === '2026-09-28');
  // invalid tz falls back safely (never throws)
  assert.match(T.todayKey('Not/AZone', NIGHT), /^\d{4}-\d{2}-\d{2}$/);
});

test('dayCode: weekday is timezone-independent', () => {
  assert.equal(T.dayCode('2026-09-28'), 'mon');   // matches the app fixtures (الاثنين ٢٨)
  assert.equal(T.dayCode('2026-09-27'), 'sun');
  assert.equal(T.dayCode('2026-09-26'), 'sat');
  assert.equal(T.dayCode('2028-02-29'), 'tue');   // leap day
  assert.equal(T.dayCode('bad'), null);
});

test('addDays: month / year / leap / non-leap boundaries', () => {
  assert.equal(T.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(T.addDays('2028-02-28', 1), '2028-02-29');   // leap
  assert.equal(T.addDays('2026-02-28', 1), '2026-03-01');   // non-leap
  assert.equal(T.addDays('2026-01-01', -1), '2025-12-31');
});

test('addDays: DST transition day is pure calendar math (no off-by-one)', () => {
  // Egypt ends DST around late October; calendar arithmetic must be unaffected.
  assert.equal(T.addDays('2026-10-29', 1), '2026-10-30');
  assert.equal(T.addDays('2026-10-30', -1), '2026-10-29');
  assert.equal(T.diffDays('2026-11-01', '2026-10-01'), 31);
});

test('startOfWeekKey: Saturday start', () => {
  assert.equal(T.startOfWeekKey('2026-09-28'), '2026-09-26'); // Monday -> back to Saturday
  assert.equal(T.dayCode('2026-09-26'), 'sat');
  assert.equal(T.startOfWeekKey('2026-09-26'), '2026-09-26'); // Saturday -> itself
});

test('resolveDayTimezone: explicit > location > device/Cairo, invalid ignored', () => {
  assert.equal(T.resolveDayTimezone({ dayTimezone: 'Asia/Riyadh' }), 'Asia/Riyadh');
  assert.equal(T.resolveDayTimezone({ dayTimezone: 'Bad/Zone', location: { tz: 'Africa/Cairo' } }), 'Africa/Cairo');
  assert.equal(T.resolveDayTimezone({ location: { tz: 'Etc/UTC' } }), 'Etc/UTC');
  const fallback = T.resolveDayTimezone({});
  assert.ok(T.isValidTz(fallback)); // device tz or Cairo — always a valid IANA zone
});
