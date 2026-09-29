import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as adhan from 'adhan';

for (const f of ['js/time-model.js', 'js/routines-model.js', 'js/analytics-model.js', 'js/sync-model.js', 'js/overdue-model.js'])
  vm.runInThisContext(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), { filename: f });
vm.runInThisContext(readFileSync(new URL('../../native-web/widget-model.js', import.meta.url), 'utf8'), { filename: 'widget-model.js' });
vm.runInThisContext(readFileSync(new URL('../../native-web/notif-plan.js', import.meta.url), 'utf8'), { filename: 'notif-plan.js' });
const R = globalThis.AyyamRoutines, A = globalThis.AyyamAnalytics, M = globalThis.AyyamModel;
const W = globalThis.AyyamWidget, N = globalThis.AyyamNotif, O = globalThis.AyyamOverdue;

const log = (o) => Object.assign({ done: {}, extra: [], hidden: {}, overrides: {}, excused: {}, replacements: {} }, o);
const daily = (id, period) => ({ id, seriesId: id, title: id, time: '', timeValue: null, period, order: 0, rec: { freq: 'daily', from: '2026-09-01', to: null } });

// ---------- §5 analytics denominator: the explicit spec equation ----------
test('daySummary: 10 original — 6 done, 2 excused, 1 replaced(→replacement done), 1 missed → 7/8, never 7/10', () => {
  const routines = {}; for (let i = 1; i <= 10; i++) routines['r' + i] = daily('r' + i, 'dhuhr');
  const b = {
    prefs: { dayTimezone: 'Africa/Cairo' }, migrationDate: '2026-09-01',
    template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] }, tplArchive: { since: '0000-00-00', versions: [] },
    routines,
    logs: { '2026-10-01': log({
      done: { r1: true, r2: true, r3: true, r4: true, r5: true, r6: true, 'r9#repl': true },
      excused: { r7: { reason: 'illness' }, r8: {} },
      replacements: { r9: { task: { title: 'بديل', period: 'asr' } } },
    }) },
  };
  const s = A.daySummary(b, '2026-10-01', { today: '2026-10-05' });
  assert.equal(s.originalExpected, 10);
  assert.equal(s.excusedCount, 2);
  assert.equal(s.replacedCount, 1);
  assert.equal(s.replacementCount, 1);
  assert.equal(s.actionable, 8);      // 10 - 2 excused - 1 replaced + 1 replacement
  assert.equal(s.completed, 7);       // 6 originals + the replacement
  assert.equal(s.missed, 1);          // r10
  assert.equal(s.expected, 8);        // denominator = actionable, NOT 10
  assert.equal(s.ratePct, 88);        // round(7/8) — NOT 70 (7/10)
  assert.equal(s.state, 'recorded');
});

// ---------- struggling miss-rate uses completed+missed, not excused ----------
test('routineStats: a series 4 done / 4 excused / 2 missed over 10 recorded days → missRate 2/6, not 6/10', () => {
  const routines = { sx: daily('sx', 'fajr'), sy: daily('sy', 'dhuhr') };
  const logs = {};
  const days = []; for (let d = 10; d <= 19; d++) days.push('2026-09-' + d);
  days.forEach((k, i) => {
    const done = { sy: true };                 // sy done every day → the day is always recorded
    const l = { done };
    if (i < 4) done.sx = true;                  // 4 done
    else if (i < 8) l.excused = { sx: {} };     // 4 excused
    // else (i 8,9): sx missed
    logs[k] = log(l);
  });
  const b = { prefs: { dayTimezone: 'Africa/Cairo' }, migrationDate: '2026-09-01', template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] }, tplArchive: { since: '0000-00-00', versions: [] }, routines, logs };
  const rs = A.routineStats(b, { today: '2026-10-05' });
  const sx = rs.find((r) => r.seriesId === 'sx');
  assert.equal(sx.expected, 6);       // 4 done + 2 missed (4 excused excluded)
  assert.equal(sx.completed, 4);
  assert.equal(sx.missed, 2);
  assert.ok(Math.abs(sx.missRate - 2 / 6) < 1e-9);
});

// ---------- materialization: replacement injected, original marked replaced ----------
test('tasksForDate: replaced original is marked, a replacement occurrence is injected with its own id', () => {
  const b = { prefs: { dayTimezone: 'Africa/Cairo' }, migrationDate: '2026-09-01', template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] }, tplArchive: { since: '0000-00-00', versions: [] },
    routines: { gym: daily('gym', 'maghrib') },
    logs: { '2026-10-01': log({ replacements: { gym: { task: { title: 'تمارين في البيت', period: 'maghrib' } } } }) } };
  const tasks = R.tasksForDate(b, '2026-10-01');
  const orig = tasks.find((t) => t.id === 'gym');
  const rep = tasks.find((t) => t.isReplacement);
  assert.equal(orig.status, 'replaced');
  assert.ok(rep && rep.id === 'gym#repl' && rep.title === 'تمارين في البيت' && rep.replacesId === 'gym');
});

test('setExcused / clearExcused and setReplacement / clearReplacement are pure and round-trip', () => {
  let logs = {};
  logs = R.setExcused(logs, '2026-10-01', 'gym', { reason: 'travel' });
  assert.equal(logs['2026-10-01'].excused.gym.reason, 'travel');
  logs = R.clearExcused(logs, '2026-10-01', 'gym');
  assert.equal(logs['2026-10-01'].excused.gym, undefined);
  logs = R.setReplacement(logs, '2026-10-01', 'gym', { title: 'بديل', period: 'asr' });
  assert.equal(logs['2026-10-01'].replacements.gym.task.title, 'بديل');
  logs = R.clearReplacement(logs, '2026-10-01', 'gym');
  assert.equal(logs['2026-10-01'].replacements.gym, undefined);
});

// ---------- sync: excused + replacements survive flatten→enrich→materialize, and undo tombstones ----------
test('sync round-trip carries excused + replacements; undo removes them deterministically', () => {
  const mat = { prefs: {}, template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] }, tplArchive: { since: '0000-00-00', versions: [] }, routines: {},
    logs: { '2026-10-01': log({ excused: { a: { reason: 'illness', note: 'حمى' } }, replacements: { b: { task: { title: 'بديل', period: 'asr' } } } }) } };
  const en = M.enrich(null, mat, 10, 'A');
  const round = M.materialize(en);
  assert.equal(round.logs['2026-10-01'].excused.a.reason, 'illness');
  assert.equal(round.logs['2026-10-01'].replacements.b.task.title, 'بديل');
  // undo the excuse (drop the key) → later stamp tombstones it → gone after merge/materialize
  const mat2 = M.materialize(en); delete mat2.logs['2026-10-01'].excused.a;
  const en2 = M.enrich(en, mat2, 20, 'A');
  assert.equal(M.materialize(en2).logs['2026-10-01'].excused.a, undefined);
  assert.equal(M.materialize(en2).logs['2026-10-01'].replacements.b.task.title, 'بديل'); // replacement untouched
});

// ---------- overdue / widget / notif exclusions ----------
const LOC = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' };
test('overdue: excused + replaced originals never overdue; the replacement flows through', () => {
  const b = { prefs: { dayTimezone: 'Africa/Cairo', location: LOC }, migrationDate: '2026-09-01', template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] }, tplArchive: { since: '0000-00-00', versions: [] },
    routines: { ex: daily('ex', 'fajr'), rp: daily('rp', 'fajr') },
    logs: { '2026-10-01': log({ excused: { ex: {} }, replacements: { rp: { task: { title: 'بديل الفجر', period: 'fajr' } } } }) } };
  // after dhuhr → fajr period has ended
  const pt = new adhan.PrayerTimes(new adhan.Coordinates(LOC.lat, LOC.lng), new Date(2026, 9, 1, 12), adhan.CalculationMethod.Egyptian());
  const res = O.overdueForNow(b, { adhan, now: pt.dhuhr.getTime() + 60000, today: '2026-10-01', location: LOC });
  const titles = res.tasks.map((t) => t.title);
  assert.ok(!titles.includes('ex'));             // excused original not overdue
  assert.ok(!titles.includes('rp'));             // replaced original not overdue
  assert.ok(titles.includes('بديل الفجر'));       // the replacement IS overdue (its fajr period ended)
});

test('widget: hides excused + replaced originals, shows the replacement', () => {
  const tasks = [
    { id: 'a', title: 'منجزة', period: 'fajr', done: true, status: 'completed' },
    { id: 'b', title: 'معذورة', period: 'dhuhr', done: false, status: 'excused' },
    { id: 'c', title: 'مستبدلة', period: 'asr', done: false, status: 'replaced' },
    { id: 'c#repl', title: 'البديلة', period: 'asr', done: false, status: 'pending' },
  ];
  const snap = W.buildSnapshot({ date: '2026-10-01', tasks, now: Date.parse('2026-10-01T10:00:00Z') });
  assert.equal(snap.total, 2);                   // a + replacement only
  assert.equal(snap.next.title, 'البديلة');       // the replacement is the actionable one
});

test('notifications: no reminder for excused/replaced original; replacement is reminded', () => {
  const state = { prefs: { location: LOC, dayTimezone: 'Africa/Cairo' }, migrationDate: '2026-09-01',
    template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] }, tplArchive: { since: '0000-00-00', versions: [] },
    routines: { g: daily('g', 'dhuhr') },
    logs: { '2026-10-01': log({ replacements: { g: { task: { title: 'بديل الظهر', period: 'dhuhr' } } } }) } };
  const plan = N.buildPlan(state, { adhan, now: new Date('2026-10-01T00:10:00+02:00').getTime(), days: 1 });
  const dhuhr = plan.items.find((x) => x.period === 'dhuhr');
  assert.ok(dhuhr && /بديل الظهر/.test(dhuhr.body)); // reminder is for the replacement
  assert.ok(!/(^|[^ي])g(\b)/.test(dhuhr.body));       // not the original 'g'
});
