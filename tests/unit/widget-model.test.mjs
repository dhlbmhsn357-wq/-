import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../native-web/widget-model.js', import.meta.url), 'utf8'), { filename: 'native-web/widget-model.js' });
const W = globalThis.AyyamWidget;

const NOW = '2026-09-27T10:00:00.000Z';
const build = (tasks, extra = {}) => W.buildSnapshot({ date: '2026-09-27', dayLabel: 'الأحد ٢٧ سبتمبر', tasks, now: NOW, ...extra });

test('normal day: done/total/next/remaining reflect the app-ordered tasks (schema 2)', () => {
  const s = build([
    { id: 'a', title: 'الفجر', time: 'قبل الفجر', period: 'fajr', done: true },
    { id: 'b', title: 'ورد القرآن', time: 'الظهر – ٣:٣٠', period: 'dhuhr', done: true },
    { id: 'c', title: 'الجيم', time: 'المغرب – العشاء', period: 'maghrib', done: false },
  ]);
  assert.equal(s.schema, 2);
  assert.equal(s.total, 3);
  assert.equal(s.done, 2);
  assert.equal(s.remaining, 1);
  assert.equal(s.pct, 67);                      // round(2/3*100)
  assert.equal(s.next.id, 'c');                 // first NOT-done in app order
  assert.equal(s.next.title, 'الجيم');
  assert.equal(s.next.period, 'maghrib');
  assert.deepEqual(s.upcoming, []);             // nothing incomplete after the next
  assert.deepEqual(s.remainingPeriods, ['maghrib']);
  assert.equal(s.allDone, false);
  assert.equal(s.empty, false);
  assert.equal(s.date, '2026-09-27');
});

test('no tasks → empty', () => {
  const s = build([]);
  assert.equal(s.total, 0);
  assert.equal(s.empty, true);
  assert.equal(s.allDone, false);
  assert.equal(s.next, null);
  assert.deepEqual(s.upcoming, []);
  assert.deepEqual(s.remainingPeriods, []);
});

test('all done → allDone, next null, no remaining periods', () => {
  const s = build([{ id: 'a', title: 'x', period: 'fajr', done: true }, { id: 'b', title: 'y', period: 'isha', done: true }]);
  assert.equal(s.allDone, true);
  assert.equal(s.next, null);
  assert.equal(s.remaining, 0);
  assert.equal(s.pct, 100);
  assert.deepEqual(s.remainingPeriods, []);
});

test('upcoming = incomplete tasks after the next, in real order', () => {
  const s = build([
    { id: 'a', title: 'x', period: 'fajr', done: true },
    { id: 'b', title: 'y', period: 'dhuhr', done: false },
    { id: 'c', title: 'z', period: 'asr', done: false },
    { id: 'd', title: 'w', period: 'maghrib', done: false },
  ]);
  assert.equal(s.next.id, 'b');
  assert.deepEqual(s.upcoming.map((t) => t.id), ['c', 'd']);
  assert.deepEqual(s.remainingPeriods, ['dhuhr', 'asr', 'maghrib']); // canonical order, only open periods
});

test('remainingPeriods are canonical-ordered and de-duplicated', () => {
  const s = build([
    { id: 'a', title: 'x', period: 'maghrib', done: false },
    { id: 'b', title: 'y', period: 'asr', done: false },
    { id: 'c', title: 'z', period: 'asr', done: false },
    { id: 'd', title: 'k', period: 'asr', done: true }, // done → does not keep asr open by itself, but b/c do
  ]);
  assert.deepEqual(s.remainingPeriods, ['asr', 'maghrib']);
});

test('free-text time is kept verbatim (never parsed to HH:MM)', () => {
  const s = build([{ id: 'a', title: 't', time: 'المغرب – العشاء', period: 'maghrib', done: false }]);
  assert.equal(s.next.time, 'المغرب – العشاء');
});

test('missing time and invalid period are normalized safely', () => {
  const s = build([{ id: 'a', title: 't', period: 'not-a-period', done: false }]);
  assert.equal(s.next.time, '');
  assert.equal(s.next.period, null);
  assert.deepEqual(s.remainingPeriods, []); // null period contributes no open period
});

test('very long Arabic title is passed through (no crash/truncation here)', () => {
  const long = 'مهمة '.repeat(80).trim();
  const s = build([{ id: 'a', title: long, done: false }]);
  assert.equal(s.next.title, long);
});

test('malformed task entries are dropped or coerced, never throw', () => {
  const s = W.buildSnapshot({ tasks: [null, 42, {}, { id: 'ok', title: 'صالح', done: false }, { title: 'no-id' }], now: NOW });
  assert.equal(s.total, 2);          // the two with id/title kept
  assert.equal(s.next.title, 'صالح');
});

test('maxTasks caps the upcoming array but not done/total', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, title: 'م' + i, done: i < 4 }));
  const s = build(many, { maxTasks: 3 });
  assert.equal(s.total, 10);
  assert.equal(s.done, 4);
  assert.equal(s.next.id, 't4');     // first incomplete
  assert.equal(s.upcoming.length, 3); // t5,t6,t7 (rest capped)
});

test('date falls back to now-local when the given date is malformed', () => {
  const s = W.buildSnapshot({ date: 'not-a-date', tasks: [], now: NOW });
  assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('privacy mode: NO title/time in the snapshot at all (periods+counts remain)', () => {
  const s = build([
    { id: 'a', title: 'سِرّي', time: 'الظهر', period: 'dhuhr', done: false },
    { id: 'b', title: 'آخر', period: 'asr', done: false },
    { id: 'c', title: 'ثالث', period: 'maghrib', done: true },
  ], { privacy: true });
  assert.equal(s.privacy, true);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('سِرّي'), 'titles must not appear under privacy');
  assert.ok(!json.includes('الظهر'), 'times must not appear under privacy');
  assert.equal(s.next.title, undefined);
  assert.equal(s.next.period, 'dhuhr');          // period is not secret → drives cues
  assert.equal(s.upcoming[0].title, undefined);
  assert.deepEqual(s.remainingPeriods, ['dhuhr', 'asr']);
  assert.equal(s.done, 1);
  assert.equal(s.total, 3);
  assert.equal(s.remaining, 2);
});

test('snapshot carries NO secret-shaped fields', () => {
  const s = build([{ id: 'a', title: 't', done: false }]);
  const keys = Object.keys(s);
  for (const bad of ['key', 'deviceKey', 'revision', 'epoch', 'outbox', 'recovery', 'location', 'data', 'reg', 'tomb']) {
    assert.ok(!keys.includes(bad), `snapshot must not expose "${bad}"`);
  }
});
