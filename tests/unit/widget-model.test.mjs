import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../../native-web/widget-model.js', import.meta.url), 'utf8'), { filename: 'native-web/widget-model.js' });
const W = globalThis.AyyamWidget;

const NOW = '2026-09-27T10:00:00.000Z';
const build = (tasks, extra = {}) => W.buildSnapshot({ date: '2026-09-27', dayLabel: 'الأحد ٢٧ سبتمبر', tasks, now: NOW, ...extra });

test('normal day: done/total/next reflect the app-ordered tasks', () => {
  const s = build([
    { id: 'a', title: 'الفجر', time: 'قبل الفجر', period: 'fajr', done: true },
    { id: 'b', title: 'ورد القرآن', time: 'الظهر – ٣:٣٠', period: 'dhuhr', done: true },
    { id: 'c', title: 'الجيم', time: 'المغرب – العشاء', period: 'maghrib', done: false },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.done, 2);
  assert.equal(s.remaining, 1);
  assert.equal(s.next.id, 'c');                 // first NOT-done in app order
  assert.equal(s.next.title, 'الجيم');
  assert.equal(s.allDone, false);
  assert.equal(s.empty, false);
  assert.equal(s.schema, 1);
  assert.equal(s.date, '2026-09-27');
});

test('no tasks → empty', () => {
  const s = build([]);
  assert.equal(s.total, 0);
  assert.equal(s.empty, true);
  assert.equal(s.allDone, false);
  assert.equal(s.next, null);
  assert.deepEqual(s.tasks, []);
});

test('all done → allDone, next null', () => {
  const s = build([{ id: 'a', title: 'x', done: true }, { id: 'b', title: 'y', done: true }]);
  assert.equal(s.allDone, true);
  assert.equal(s.next, null);
  assert.equal(s.remaining, 0);
});

test('mixed: next is the first incomplete regardless of position', () => {
  const s = build([
    { id: 'a', title: 'x', done: true },
    { id: 'b', title: 'y', done: false },
    { id: 'c', title: 'z', done: false },
  ]);
  assert.equal(s.next.id, 'b');
});

test('free-text time is kept verbatim (never parsed to HH:MM)', () => {
  const s = build([{ id: 'a', title: 't', time: 'المغرب – العشاء', period: 'maghrib', done: false }]);
  assert.equal(s.next.time, 'المغرب – العشاء');
  assert.equal(s.tasks[0].time, 'المغرب – العشاء');
});

test('missing time and invalid period are normalized safely', () => {
  const s = build([{ id: 'a', title: 't', period: 'not-a-period', done: false }]);
  assert.equal(s.tasks[0].time, '');
  assert.equal(s.tasks[0].period, null);
  assert.equal(s.next.time, '');
});

test('very long Arabic title is passed through (no crash/truncation here)', () => {
  const long = 'مهمة '.repeat(80).trim();
  const s = build([{ id: 'a', title: long, done: false }]);
  assert.equal(s.tasks[0].title, long);
});

test('malformed task entries are dropped or coerced, never throw', () => {
  const s = W.buildSnapshot({ tasks: [null, 42, {}, { id: 'ok', title: 'صالح', done: false }, { title: 'no-id' }], now: NOW });
  // null/42/{} dropped (no id, no title); the two with id/title kept
  assert.equal(s.total, 2);
  assert.equal(s.tasks.find((t) => t.id === 'ok').title, 'صالح');
});

test('maxTasks caps the tasks array but not done/total', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, title: 'م' + i, done: i < 4 }));
  const s = build(many, { maxTasks: 3 });
  assert.equal(s.total, 10);
  assert.equal(s.done, 4);
  assert.equal(s.tasks.length, 3);
});

test('date falls back to now-local when the given date is malformed', () => {
  const s = W.buildSnapshot({ date: 'not-a-date', tasks: [], now: NOW });
  assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('privacy mode: NO title/time in the snapshot at all', () => {
  const s = build([
    { id: 'a', title: 'سِرّي', time: 'الظهر', period: 'dhuhr', done: false },
    { id: 'b', title: 'آخر', done: true },
  ], { privacy: true });
  assert.equal(s.privacy, true);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('سِرّي'), 'titles must not appear under privacy');
  assert.ok(!json.includes('الظهر'), 'times must not appear under privacy');
  assert.equal(s.next.title, undefined);
  assert.equal(s.tasks[0].title, undefined);
  assert.equal(s.done, 1);        // counts still work
  assert.equal(s.total, 2);
  assert.equal(s.remaining, 1);
});

test('snapshot carries NO secret-shaped fields', () => {
  const s = build([{ id: 'a', title: 't', done: false }]);
  const keys = Object.keys(s);
  for (const bad of ['key', 'deviceKey', 'revision', 'epoch', 'outbox', 'recovery', 'location', 'data', 'reg', 'tomb']) {
    assert.ok(!keys.includes(bad), `snapshot must not expose "${bad}"`);
  }
});
