import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const f of ['js/time-model.js', 'js/routines-model.js', 'js/analytics-model.js'])
  vm.runInThisContext(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), { filename: f });
const A = globalThis.AyyamAnalytics;
const log = (o) => Object.assign({ done: {}, extra: [], hidden: {}, overrides: {} }, o);

// ---------------- Fixture 1: semantics & edges (today = Monday 2026-09-28) ----------------
const TODAY1 = '2026-09-28';
const OPT1 = { today: TODAY1 };
function fixture1() {
  const wk = (id, days, extra) => ({ id, seriesId: id, title: id, time: '', timeValue: null, period: null, order: 0, rec: Object.assign({ freq: 'weekly', days, from: '2026-09-08', to: null }, extra || {}) });
  return {
    prefs: { dayTimezone: 'Africa/Cairo' },
    migrationDate: '2026-09-08',
    template: { sat: [], sun: [], mon: [{ id: 'leg1', title: 'قديم', time: '', timeValue: null, period: 'fajr' }], tue: [], wed: [], thu: [], fri: [] },
    tplArchive: { since: '0000-00-00', versions: [] },
    routines: {
      daily1: { id: 'daily1', seriesId: 'daily1', title: 'ورد يومي', time: '', timeValue: '05:30', period: 'fajr', order: 0, rec: { freq: 'daily', from: '2026-09-08', to: null } },
      mon1: Object.assign(wk('mon1', ['mon']), { title: 'مجلس', period: 'dhuhr', order: 1 }),
      selSatMon: Object.assign(wk('selSatMon', ['sat', 'mon']), { title: 'محدد', period: 'asr', order: 2 }),
      gymA: { id: 'gymA', seriesId: 'gym', title: 'الجيم', time: '', timeValue: null, period: 'maghrib', order: 3, rec: { freq: 'weekly', days: ['mon'], from: '2026-09-08', to: '2026-09-20' } },
      gymB: { id: 'gymB', seriesId: 'gym', title: 'تمرين', time: '', timeValue: null, period: 'maghrib', order: 3, rec: { freq: 'weekly', days: ['mon'], from: '2026-09-21', to: null } },
    },
    logs: {
      '2026-09-07': log({ done: { leg1: true } }),                                              // legacy Monday, recorded
      '2026-09-14': log({ done: { daily1: true, mon1: true, selSatMon: true, gymA: true }, overrides: { mon1: { title: 'مجلس معدّل', period: 'dhuhr' } } }), // strong 100%
      // 2026-09-19 (Sat): NO log → unrecorded
      '2026-09-21': log({ done: { daily1: true }, extra: [{ id: 'x1', title: 'إضافي', period: 'isha', timeValue: null }] }), // weak
      '2026-09-26': log({ done: { daily1: true }, hidden: { selSatMon: true } }),                // hidden exception
      '2026-09-28': log({ done: { daily1: true } }),                                             // today (in-progress)
    },
  };
}

test('day states: recorded / unrecorded / no_expected', () => {
  const b = fixture1();
  assert.equal(A.daySummary(b, '2026-09-14', OPT1).state, 'recorded');
  assert.equal(A.daySummary(b, '2026-09-19', OPT1).state, 'unrecorded'); // expected>0, no activity
  assert.equal(A.daySummary(b, '2026-09-03', OPT1).state, 'no_expected'); // legacy Thu, empty template
  assert.equal(A.daySummary(b, '2026-09-19', OPT1).expected, 2);          // daily1 + selSatMon(Sat)
});

test('day rate is completed/expected on a recorded day', () => {
  const s = A.daySummary(fixture1(), '2026-09-14', OPT1);
  assert.equal(s.expected, 4); assert.equal(s.completed, 4); assert.equal(s.rate, 1); assert.equal(s.ratePct, 100);
  assert.equal(s.missed, 0);
});

test('hidden occurrence is excluded from expected', () => {
  const s = A.daySummary(fixture1(), '2026-09-26', OPT1);
  assert.equal(s.expected, 1); // selSatMon hidden → only daily1
  assert.ok(!s.tasks.some((t) => t.id === 'selSatMon'));
});

test('override keeps the occurrence (count unchanged) and applies the new title', () => {
  const s = A.daySummary(fixture1(), '2026-09-14', OPT1);
  assert.equal(s.expected, 4);
  assert.equal(s.tasks.find((t) => t.id === 'mon1').title, 'مجلس معدّل');
});

test('extra adds one expected occurrence on its day', () => {
  const s = A.daySummary(fixture1(), '2026-09-21', OPT1);
  assert.equal(s.expected, 5);       // 4 routines + 1 extra
  assert.equal(s.completed, 1);      // only daily1 done
  assert.equal(s.missed, 4);
  assert.ok(s.tasks.some((t) => t.id === 'x1' && t.seriesId === null)); // extra is not a recurring series
});

test('legacy pre-migration day uses the template, not routines', () => {
  const s = A.daySummary(fixture1(), '2026-09-07', OPT1);
  assert.equal(s.expected, 1);
  assert.equal(s.tasks[0].title, 'قديم');
  assert.equal(s.tasks[0].seriesId, 'leg1');
});

test('historical correctness: a split series shows the OLD segment before the edit, NEW after', () => {
  const b = fixture1();
  assert.equal(A.daySummary(b, '2026-09-14', OPT1).tasks.find((t) => t.seriesId === 'gym').title, 'الجيم'); // segment A
  assert.equal(A.daySummary(b, '2026-09-21', OPT1).tasks.find((t) => t.seriesId === 'gym').title, 'تمرين'); // segment B
});

test('routine stats aggregate segments by seriesId (one entry for the split series)', () => {
  const rs = A.routineStats(fixture1(), OPT1);
  const gym = rs.filter((r) => r.seriesId === 'gym');
  assert.equal(gym.length, 1);           // A and B collapse into ONE logical series
  assert.equal(gym[0].expected, 2);      // 09-14 (A) + 09-21 (B); today 09-28 excluded (in-progress)
  assert.equal(gym[0].title, 'تمرين');   // latest-seen label
  assert.ok(!rs.some((r) => r.seriesId === null)); // extras excluded
});

test('current (in-progress) day: live progress, excluded from historical aggregates', () => {
  const b = fixture1();
  const s = A.daySummary(b, TODAY1, OPT1);
  assert.equal(s.isInProgress, true);
  assert.equal(s.state, 'recorded');
  assert.equal(s.completed, 1); assert.equal(s.expected, 4); // shown live
  // today's incompletes do NOT inflate daily1's misses in routine stats
  const daily1 = A.routineStats(b, OPT1).find((r) => r.seriesId === 'daily1');
  assert.equal(daily1.expected, 3); // 09-14, 09-21, 09-26 — NOT today
});

test('sparse period sample → best/weakest period is insufficient_data', () => {
  assert.equal(A.bestWorstPeriod(fixture1(), OPT1).status, 'insufficient_data');
});

test('month summary: today is not classified low before it ends', () => {
  const m = A.monthSummary(fixture1(), 2026, 9, OPT1);
  assert.ok(m.recordedDays >= 4);
  assert.equal(A.classify(A.daySummary(fixture1(), '2026-09-14', OPT1)), 'high');
  assert.equal(A.classify(A.daySummary(fixture1(), '2026-09-21', OPT1)), 'low');
  assert.equal(m.bestDay.rate, 1);
  assert.equal(m.worstDay.date, '2026-09-21');       // the weak day, NOT today
  assert.notEqual(m.worstDay.date, TODAY1);
});

test('month summary treats days after `today` as future (not classified)', () => {
  const m = A.monthSummary(fixture1(), 2026, 9, { today: '2026-09-14' });
  // 09-21 is after this today → must not appear as the worst day
  assert.notEqual(m.worstDay && m.worstDay.date, '2026-09-21');
});

test('confidence helper is the single source of thresholds', () => {
  assert.equal(A.confidence(0), 'low');
  assert.equal(A.confidence(4), 'low');
  assert.equal(A.confidence(5), 'medium');
  assert.equal(A.confidence(11), 'medium');
  assert.equal(A.confidence(12), 'high');
});

test('no fake precision: rates round to whole percents', () => {
  const s = A.daySummary(fixture1(), '2026-09-21', OPT1); // 1/5 = 0.2
  assert.equal(s.rate, 0.2); assert.equal(s.ratePct, 20);
});

// ---------------- Fixture 2: dense data for verdicts (today = 2026-10-01) ----------------
const TODAY2 = '2026-10-01';
const OPT2 = { today: TODAY2 };
function fixture2() {
  const logs = {};
  for (let d = 1; d <= 30; d++) {
    const key = `2026-09-${String(d).padStart(2, '0')}`;
    const activeS = d <= 15 ? 'S_a' : 'S_b';
    logs[key] = log({ done: { good: true, [activeS]: true } }); // good + split done; bad never done
  }
  return {
    prefs: { dayTimezone: 'Africa/Cairo' },
    migrationDate: '2026-09-01',
    template: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] },
    tplArchive: { since: '0000-00-00', versions: [] },
    routines: {
      good: { id: 'good', seriesId: 'good', title: 'ورد', time: '', timeValue: '05:30', period: 'fajr', order: 0, rec: { freq: 'daily', from: '2026-09-01', to: null } },
      bad: { id: 'bad', seriesId: 'bad', title: 'العصر', time: '', timeValue: null, period: 'asr', order: 1, rec: { freq: 'daily', from: '2026-09-01', to: null } },
      S_a: { id: 'S_a', seriesId: 'S', title: 'قديم', time: '', timeValue: null, period: 'dhuhr', order: 2, rec: { freq: 'daily', from: '2026-09-01', to: '2026-09-15' } },
      S_b: { id: 'S_b', seriesId: 'S', title: 'جديد', time: '', timeValue: null, period: 'dhuhr', order: 2, rec: { freq: 'daily', from: '2026-09-16', to: null } },
    },
    logs,
  };
}

test('period stats + best/weakest with a large sample', () => {
  const st = A.periodStats(fixture2(), OPT2);
  assert.equal(st.fajr.expected, 30); assert.equal(st.fajr.completed, 30); assert.equal(st.fajr.rate, 1); assert.equal(st.fajr.confidence, 'high');
  assert.equal(st.asr.expected, 30); assert.equal(st.asr.completed, 0); assert.equal(st.asr.rate, 0);
  const bw = A.bestWorstPeriod(fixture2(), OPT2);
  assert.equal(bw.status, 'ok');
  assert.equal(bw.best.rate, 1);
  assert.equal(bw.weakest.period, 'asr');
});

test('routine series aggregation across a split (sample counts both segments)', () => {
  const rs = A.routineStats(fixture2(), OPT2);
  const s = rs.find((r) => r.seriesId === 'S');
  assert.equal(s.expected, 30);      // 15 days segA + 15 days segB
  assert.equal(s.rate, 1);
  assert.equal(s.title, 'جديد');
});

test('consistent tasks: high completion, adequate sample', () => {
  const c = A.consistentTasks(fixture2(), OPT2);
  const ids = c.map((r) => r.seriesId);
  assert.ok(ids.includes('good')); assert.ok(ids.includes('S'));
  assert.ok(!ids.includes('bad'));
  c.forEach((r) => { assert.ok(r.sampleSize >= 5 && r.rate >= 0.8); });
});

test('struggling tasks: high miss rate, adequate sample, non-negative framing data', () => {
  const s = A.strugglingTasks(fixture2(), OPT2);
  const bad = s.find((r) => r.seriesId === 'bad');
  assert.ok(bad); assert.equal(bad.missRate, 1); assert.equal(bad.completed, 0); assert.equal(bad.expected, 30);
  assert.ok(!s.some((r) => r.seriesId === 'good'));
});

test('weekday stats cover all recorded days; best/weakest available with sample', () => {
  const w = A.weekdayStats(fixture2(), OPT2);
  const total = A.DAY_CODES.reduce((n, c) => n + w[c].daysRecorded, 0);
  assert.equal(total, 30);
  assert.equal(A.bestWorstWeekday(fixture2(), OPT2).status, 'ok');
});

test('weekly trend compares rolling 7-day windows (rate = completed/expected)', () => {
  const t = A.weekTrend(fixture2(), OPT2);
  assert.equal(t.status, 'ok');
  assert.equal(t.currentRatePct, 67);   // 2 of 3 done each day
  assert.equal(t.previousRatePct, 67);
  assert.equal(t.delta, 0);
  assert.ok(t.currentSample >= 5 && t.previousSample >= 5);
});

test('weekly trend with too little data → insufficient_data', () => {
  const t = A.weekTrend(fixture1(), OPT1); // sparse
  assert.equal(t.status, 'insufficient_data');
});

test('hourly extraction uses only structured timeValue', () => {
  const h = A.hourlyStats(fixture2(), OPT2);
  const five = h.find((x) => x.hour === 5); // good is 05:30, done every recorded day
  assert.ok(five); assert.equal(five.expected, 30); assert.equal(five.completed, 30);
});
