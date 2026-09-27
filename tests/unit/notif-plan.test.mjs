import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as adhan from 'adhan';

vm.runInThisContext(readFileSync(new URL('../../native-web/notif-plan.js', import.meta.url), 'utf8'), { filename: 'native-web/notif-plan.js' });
const N = globalThis.AyyamNotif;

// Cairo, 2026-10-01 just after midnight local (well before Fajr) so all of today's prayers are future.
const LOC = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' };
const NOW = new Date('2026-10-01T00:10:00+02:00').getTime();
const stateWith = (period, done = false) => ({
  template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
  logs: { '2026-10-01': { done: done ? { x: true } : {}, extra: [{ id: 'x', title: 'ورد القرآن', period, time: '' }], hidden: {}, overrides: {} } },
  prefs: { location: LOC }, tplArchive: { since: '0000-00-00', versions: [] },
});

test('builds a future item at the prayer instant with real message text', () => {
  const plan = N.buildPlan(stateWith('dhuhr'), { adhan, now: NOW, days: 1 });
  const it = plan.items.find((x) => x.period === 'dhuhr');
  assert.ok(it, 'a dhuhr item should exist');
  assert.equal(it.date, '2026-10-01');
  assert.ok(it.at > NOW, 'item must be in the future');
  assert.match(it.title, /الظهر/);
  assert.match(it.body, /ورد القرآن/);
  assert.equal(it.id, '2026-10-01:dhuhr');
});

test('a period with no open task produces no item', () => {
  const plan = N.buildPlan(stateWith('dhuhr'), { adhan, now: NOW, days: 1 });
  assert.equal(plan.items.filter((x) => x.period === 'asr').length, 0); // task is in dhuhr only
});

test('a done task produces no reminder', () => {
  const plan = N.buildPlan(stateWith('dhuhr', true), { adhan, now: NOW, days: 1 });
  assert.equal(plan.items.length, 0);
});

test('only FUTURE instants are scheduled (past prayers today are excluded)', () => {
  const afterAsr = new Date('2026-10-01T16:30:00+02:00').getTime(); // past fajr/dhuhr/asr
  const plan = N.buildPlan(stateWith('fajr'), { adhan, now: afterAsr, days: 1 });
  assert.equal(plan.items.length, 0, 'fajr already passed today → not scheduled');
  for (const it of plan.items) assert.ok(it.at > afterAsr);
});

test('multi-day plan schedules the template task on future days too', () => {
  const state = {
    template: { sat: [], sun: [{ id: 't1', title: 'الجيم', period: 'maghrib' }], mon: [], tue: [], wed: [], thu: [], fri: [] },
    logs: {}, prefs: { location: LOC }, tplArchive: { since: '0000-00-00', versions: [] },
  };
  const plan = N.buildPlan(state, { adhan, now: NOW, days: 7 });
  const maghribItems = plan.items.filter((x) => x.period === 'maghrib');
  // 2026-10-01 is a Thursday → template.sun applies on the Sundays within the next 7 days
  assert.ok(maghribItems.length >= 1, 'template task scheduled on its weekday within the window');
  for (const it of plan.items) assert.match(it.title, /المغرب/);
});

test('items are sorted by time and carry their date for the stale-guard', () => {
  const state = {
    template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [{ id: 'a', title: 'أ', period: 'fajr' }, { id: 'b', title: 'ب', period: 'isha' }], fri: [] },
    logs: {}, prefs: { location: LOC }, tplArchive: { since: '0000-00-00', versions: [] },
  };
  const plan = N.buildPlan(state, { adhan, now: NOW, days: 1 }); // 2026-10-01 is Thursday → 'thu'
  assert.ok(plan.items.length >= 2);
  for (let i = 1; i < plan.items.length; i++) assert.ok(plan.items[i].at >= plan.items[i - 1].at, 'sorted by at');
  for (const it of plan.items) assert.match(it.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('no location → falls back to default, still produces a plan', () => {
  const state = { template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [{ id: 'a', title: 'أ', period: 'dhuhr' }], fri: [] }, logs: {}, prefs: {}, tplArchive: {} };
  const plan = N.buildPlan(state, { adhan, now: NOW, days: 1 });
  assert.equal(plan.tz, 'Africa/Cairo');
  assert.ok(plan.items.length >= 1);
});
