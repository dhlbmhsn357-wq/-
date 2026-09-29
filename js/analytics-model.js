// Deterministic analytics engine for "أيام" — pure, no I/O. Classic script: sets globalThis.AyyamAnalytics.
// Depends on globalThis.AyyamRoutines (materialization) and globalThis.AyyamTime (canonical day math).
//
// SINGLE SOURCE OF TRUTH for the calendar, the analytics page, and insights. It NEVER resolves recurrence
// itself — it reads what AyyamRoutines.tasksForDate(bundle, dateKey) already materialized (routine segments
// for dates >= migrationDate, legacy template before it), so history is automatically correct.
//
// Core rule — recorded / unrecorded / no_expected:
//   * no_expected : the day materializes to 0 tasks.
//   * recorded    : expected > 0 AND the day has real log activity (done/hidden/override/extra).
//   * unrecorded  : expected > 0 but no activity — EXCLUDED from every performance denominator (a day the
//                   user simply never tracked is not "all missed"); surfaced separately for the calendar.
// The current (in-progress) day shows live progress but is excluded from historical aggregates by default.
(function (global) {
  'use strict';

  const R = () => global.AyyamRoutines;
  const T = () => global.AyyamTime;
  const PERIODS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const DAY_CODES = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isKey = (k) => typeof k === 'string' && DATE_KEY_RE.test(k);

  // A day has "activity" if its log carries any real signal (mirrors app.js logHasActivity).
  function logHasActivity(l) {
    if (!isObj(l)) return false;
    return (isObj(l.done) && Object.keys(l.done).length > 0)
      || (Array.isArray(l.extra) && l.extra.length > 0)
      || (isObj(l.hidden) && Object.keys(l.hidden).length > 0)
      || (isObj(l.overrides) && Object.keys(l.overrides).length > 0)
      || (isObj(l.excused) && Object.keys(l.excused).length > 0)
      || (isObj(l.replacements) && Object.keys(l.replacements).length > 0);
  }
  // An occurrence that counts toward the day's ACTIONABLE denominator (excused + replaced originals are
  // neither completed nor missed; a replacement occurrence IS actionable).
  const isActionable = (t) => t.status !== 'excused' && t.status !== 'replaced';

  // ---------- confidence (ONE central rule — no per-insight thresholds) ----------
  // Sample = number of relevant occurrences (or recorded days, for weekday stats).
  function confidence(sampleSize) {
    const n = Number.isFinite(sampleSize) ? sampleSize : 0;
    if (n >= 12) return 'high';
    if (n >= 5) return 'medium';
    return 'low';
  }
  const MIN_VERDICT_SAMPLE = 5; // a ranked verdict (best/weak, consistent, struggling) needs >= this
  // raw ratio (0..1 or null) → rounded integer percent for display (no fake precision)
  function pct(rate) { return (rate == null || !Number.isFinite(rate)) ? null : Math.round(rate * 100); }
  const rate = (completed, expected) => (expected > 0 ? completed / expected : null);

  function resolveToday(bundle, options) {
    if (options && isKey(options.today)) return options.today;
    const tz = T() ? T().resolveDayTimezone(bundle ? bundle.prefs : null) : 'Africa/Cairo';
    return T() ? T().todayKey(tz) : '1970-01-01';
  }
  // The logical-series id an occurrence belongs to (links segments across a "this and future" split).
  function seriesIdOf(bundle, task) {
    if (!task || !task.fromTemplate) return null;                 // one-off extra → not a recurring series
    const r = isObj(bundle.routines) ? bundle.routines[task.origId] : null;
    return (r && r.seriesId) ? r.seriesId : task.origId;          // legacy occurrences fall back to their id
  }

  // ---------- per-day summary ----------
  function daySummary(bundle, dateKey, options) {
    options = options || {};
    const b = isObj(bundle) ? bundle : {};
    const today = resolveToday(b, options);
    const tasks = R() ? R().tasksForDate(b, dateKey) : [];        // already excludes hidden, applies overrides + extras
    // Actionable = pending/completed originals + replacement occurrences. Excused originals and replaced
    // originals are counted SEPARATELY and never enter the performance denominator (see spec §5).
    const actionableTasks = tasks.filter(isActionable);
    const baseTasks = tasks.filter((t) => !t.isReplacement);
    const originalExpected = baseTasks.length;
    const excusedCount = baseTasks.filter((t) => t.status === 'excused').length;
    const replacedCount = baseTasks.filter((t) => t.status === 'replaced').length;
    const replacementCount = tasks.filter((t) => t.isReplacement).length;
    const expected = actionableTasks.length;                       // the ACTIONABLE denominator
    const completed = actionableTasks.filter((t) => t.done).length;
    const log = (isObj(b.logs) && isObj(b.logs[dateKey])) ? b.logs[dateKey] : null;
    const isInProgress = dateKey === today;
    let state;
    if (tasks.length === 0) state = 'no_expected';
    else if (logHasActivity(log)) state = 'recorded';
    else state = 'unrecorded';

    const byPeriod = {};
    const buckets = PERIODS.concat(['none']);
    buckets.forEach((p) => {
      const seg = actionableTasks.filter((t) => (p === 'none' ? !t.period : t.period === p));
      if (!seg.length) return;
      const c = seg.filter((t) => t.done).length;
      byPeriod[p] = { expected: seg.length, completed: c, rate: rate(c, seg.length), ratePct: pct(rate(c, seg.length)) };
    });

    return {
      date: dateKey,
      state,
      isInProgress,
      expected,                                                    // = actionable (unchanged meaning when no excuse/replace)
      completed,
      missed: state === 'recorded' ? (expected - completed) : 0,   // only actionable-but-not-done counts as missed
      originalExpected,
      actionable: expected,
      excusedCount,
      replacedCount,
      replacementCount,
      rate: rate(completed, expected),
      ratePct: pct(rate(completed, expected)),
      byPeriod,
      tasks: tasks.map((t) => ({ id: t.id, seriesId: seriesIdOf(b, t), title: t.title, period: t.period || null, timeValue: t.timeValue || null, done: !!t.done, fromTemplate: !!t.fromTemplate, status: t.status || (t.done ? 'completed' : 'pending'), isReplacement: !!t.isReplacement, replacesId: t.replacesId || null, replacesTitle: t.replacesTitle || null })),
    };
  }

  // ---------- ranges + cached day summaries ----------
  function firstActiveKey(bundle) {
    const logs = isObj(bundle.logs) ? bundle.logs : {};
    let first = null;
    for (const k of Object.keys(logs)) if (isKey(k) && logHasActivity(logs[k])) { if (first === null || k < first) first = k; }
    return first;
  }
  // The days a historical aggregate scans (recorded, finished). options: {from,to} | {days:N} | default all.
  function rangeKeys(bundle, options, today) {
    let to = (options && isKey(options.to)) ? options.to : today;
    if (to > today) to = today;
    const fa = firstActiveKey(bundle);
    let from;
    if (options && isKey(options.from)) from = options.from;
    else if (options && Number.isFinite(options.days)) from = T().addDays(to, -(Math.max(1, options.days) - 1));
    else from = fa || to;
    if (fa && from < fa) from = fa;
    const keys = [];
    if (!isKey(from) || !isKey(to) || from > to) return keys;
    let k = from, guard = 0;
    while (k <= to && guard++ < 4000) { keys.push(k); k = T().addDays(k, 1); }
    return keys;
  }
  // Recorded, finished (not in-progress unless includeToday) day summaries over the range — computed once.
  function recordedSummaries(bundle, options, today) {
    const includeToday = !!(options && options.includeToday);
    return rangeKeys(bundle, options, today).map((k) => daySummary(bundle, k, { today }))
      .filter((s) => s.state === 'recorded' && (includeToday || !s.isInProgress));
  }

  // ---------- period performance ----------
  function periodStats(bundle, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    const sums = recordedSummaries(bundle, options, today);
    const acc = {}; PERIODS.forEach((p) => (acc[p] = { completed: 0, expected: 0 }));
    sums.forEach((s) => s.tasks.forEach((t) => { if (t.status === 'excused' || t.status === 'replaced') return; if (t.period && acc[t.period]) { acc[t.period].expected++; if (t.done) acc[t.period].completed++; } }));
    const out = {};
    PERIODS.forEach((p) => {
      const a = acc[p];
      out[p] = { period: p, completed: a.completed, expected: a.expected, rate: rate(a.completed, a.expected), ratePct: pct(rate(a.completed, a.expected)), sampleSize: a.expected, confidence: confidence(a.expected) };
    });
    return out;
  }
  function pickBestWorstPeriod(st) {
    const eligible = PERIODS.map((p) => st[p]).filter((x) => x.sampleSize >= MIN_VERDICT_SAMPLE && x.rate != null);
    if (!eligible.length) return { status: 'insufficient_data' };
    const sorted = eligible.slice().sort((a, b) => b.rate - a.rate || b.sampleSize - a.sampleSize);
    return { status: 'ok', best: sorted[0], weakest: sorted[sorted.length - 1] };
  }
  function bestWorstPeriod(bundle, options) { return pickBestWorstPeriod(periodStats(bundle, options)); }

  // ---------- routine (series) performance ----------
  function routineStats(bundle, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    const sums = recordedSummaries(bundle, options, today);
    const acc = {}; // seriesId -> {expected, completed, title}
    sums.forEach((s) => s.tasks.forEach((t) => {
      if (t.status === 'excused' || t.status === 'replaced') return; // excused/replaced originals: not a failure, not counted
      if (!t.seriesId) return;                              // one-off extras + today-only replacements are not series
      const a = acc[t.seriesId] || (acc[t.seriesId] = { seriesId: t.seriesId, expected: 0, completed: 0, title: t.title });
      a.expected++; if (t.done) a.completed++; a.title = t.title; // latest-seen title (occurrence order is chronological)
    }));
    return Object.keys(acc).map((id) => {
      const a = acc[id]; const r = rate(a.completed, a.expected);
      return { seriesId: id, title: a.title, expected: a.expected, completed: a.completed, missed: a.expected - a.completed,
        rate: r, ratePct: pct(r), missRate: a.expected ? (a.expected - a.completed) / a.expected : null, sampleSize: a.expected, confidence: confidence(a.expected) };
    }).sort((x, y) => (y.rate - x.rate) || (y.sampleSize - x.sampleSize));
  }
  function pickConsistent(routines, limit) {
    return routines.filter((r) => r.sampleSize >= MIN_VERDICT_SAMPLE && r.rate != null && r.rate >= 0.8)
      .sort((a, b) => (b.rate - a.rate) || (b.sampleSize - a.sampleSize)).slice(0, limit || 8);
  }
  function pickStruggling(routines, limit) {
    return routines.filter((r) => r.sampleSize >= MIN_VERDICT_SAMPLE && r.missRate != null && r.missRate >= 0.5)
      .sort((a, b) => (b.missRate - a.missRate) || (b.sampleSize - a.sampleSize)).slice(0, limit || 8);
  }
  function consistentTasks(bundle, options) { return pickConsistent(routineStats(bundle, options), options && options.limit); }
  function strugglingTasks(bundle, options) { return pickStruggling(routineStats(bundle, options), options && options.limit); }

  // ---------- weekday performance ----------
  function weekdayStats(bundle, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    const sums = recordedSummaries(bundle, options, today);
    const acc = {}; DAY_CODES.forEach((c) => (acc[c] = { daysRecorded: 0, expected: 0, completed: 0 }));
    sums.forEach((s) => { const code = T().dayCode(s.date); const a = acc[code]; if (!a) return; a.daysRecorded++; a.expected += s.expected; a.completed += s.completed; });
    const out = {};
    DAY_CODES.forEach((c) => { const a = acc[c]; out[c] = { code: c, daysRecorded: a.daysRecorded, expected: a.expected, completed: a.completed, rate: rate(a.completed, a.expected), ratePct: pct(rate(a.completed, a.expected)), confidence: confidence(a.daysRecorded) }; });
    return out;
  }
  function pickBestWorstWeekday(st) {
    const eligible = DAY_CODES.map((c) => st[c]).filter((x) => x.daysRecorded >= MIN_VERDICT_SAMPLE && x.rate != null);
    if (!eligible.length) return { status: 'insufficient_data' };
    const sorted = eligible.slice().sort((a, b) => b.rate - a.rate || b.daysRecorded - a.daysRecorded);
    return { status: 'ok', best: sorted[0], weakest: sorted[sorted.length - 1] };
  }
  function bestWorstWeekday(bundle, options) { return pickBestWorstWeekday(weekdayStats(bundle, options)); }

  // ---------- weekly trend (rolling 7-day windows ending yesterday; today excluded as in-progress) ----------
  function windowAgg(bundle, fromKey, toKey, today) {
    const sums = recordedSummaries(bundle, { from: fromKey, to: toKey }, today);
    let expected = 0, completed = 0; sums.forEach((s) => { expected += s.expected; completed += s.completed; });
    return { expected, completed, rate: rate(completed, expected), sampleSize: expected, days: sums.length };
  }
  function weekTrend(bundle, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    const curTo = T().addDays(today, -1), curFrom = T().addDays(today, -7);      // last 7 finished days
    const prevTo = T().addDays(today, -8), prevFrom = T().addDays(today, -14);   // the 7 before that
    const cur = windowAgg(bundle, curFrom, curTo, today);
    const prev = windowAgg(bundle, prevFrom, prevTo, today);
    if (cur.sampleSize < MIN_VERDICT_SAMPLE || prev.sampleSize < MIN_VERDICT_SAMPLE || cur.rate == null || prev.rate == null) {
      return { status: 'insufficient_data', currentSample: cur.sampleSize, previousSample: prev.sampleSize };
    }
    return { status: 'ok', currentRate: cur.rate, previousRate: prev.rate, currentRatePct: pct(cur.rate), previousRatePct: pct(prev.rate),
      delta: cur.rate - prev.rate, deltaPct: pct(cur.rate) - pct(prev.rate), currentSample: cur.sampleSize, previousSample: prev.sampleSize,
      confidence: confidence(Math.min(cur.sampleSize, prev.sampleSize)) };
  }

  // ---------- calendar classification + month summary ----------
  function classify(summary) {
    if (summary.state !== 'recorded' || summary.expected === 0 || summary.rate == null) return null;
    if (summary.rate >= 0.8) return 'high';
    if (summary.rate >= 0.5) return 'medium';
    return 'low';
  }
  // LIVE class for the CURRENT (in-progress) day only — a visual progress hint, NOT a historical verdict.
  // Same thresholds as classify(), but it INTENTIONALLY works on an in-progress day (which classify()
  // refuses). It is used purely for the calendar's live "today" dot; it is NEVER fed into any aggregate,
  // trend, or best/worst ranking, so the A1 rule "today is never judged historically" is preserved.
  function liveClass(summary) {
    if (!summary || summary.state !== 'recorded' || summary.rate == null) return null; // no activity yet → no dot
    if (summary.rate >= 0.8) return 'high';
    if (summary.rate >= 0.5) return 'medium';
    return 'low';
  }
  function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); } // month: 1..12
  function monthSummary(bundle, year, month, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    const n = daysInMonth(year, month);
    const daySummaries = [];
    let recordedDays = 0, unrecordedDays = 0, noExpectedDays = 0, high = 0, medium = 0, low = 0, expected = 0, completed = 0;
    let best = null, worst = null;
    for (let d = 1; d <= n; d++) {
      const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const s = daySummary(bundle, key, { today });
      daySummaries.push(s);
      if (key > today) continue;                    // future days in this month are not scored
      if (s.state === 'no_expected') { noExpectedDays++; continue; }
      if (s.state === 'unrecorded') { unrecordedDays++; continue; }
      recordedDays++;
      if (s.isInProgress) continue;                 // today counts as recorded but is not classified/ranked yet
      expected += s.expected; completed += s.completed;
      const cls = classify(s);
      if (cls === 'high') high++; else if (cls === 'medium') medium++; else if (cls === 'low') low++;
      if (s.rate != null) {
        if (!best || s.rate > best.rate) best = { date: key, rate: s.rate, ratePct: pct(s.rate) };
        if (!worst || s.rate < worst.rate) worst = { date: key, rate: s.rate, ratePct: pct(s.rate) };
      }
    }
    return { year, month, recordedDays, unrecordedDays, noExpectedDays, highDays: high, mediumDays: medium, lowDays: low,
      expected, completed, overallRate: rate(completed, expected), overallRatePct: pct(rate(completed, expected)),
      bestDay: best, worstDay: worst, daySummaries };
  }

  // ---------- hourly extraction (structured timeValue only; recommendations deferred to I1) ----------
  function hourlyStats(bundle, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    const sums = recordedSummaries(bundle, options, today);
    const acc = {};
    sums.forEach((s) => s.tasks.forEach((t) => {
      if (t.status === 'excused' || t.status === 'replaced') return;
      if (!t.timeValue || !TIME_RE.test(t.timeValue)) return;
      const h = parseInt(t.timeValue.slice(0, 2), 10);
      const a = acc[h] || (acc[h] = { hour: h, expected: 0, completed: 0 });
      a.expected++; if (t.done) a.completed++;
    }));
    return Object.keys(acc).map((h) => { const a = acc[h]; return Object.assign(a, { rate: rate(a.completed, a.expected), ratePct: pct(rate(a.completed, a.expected)) }); })
      .sort((x, y) => x.hour - y.hour);
  }

  // Range-level day-state tally + overall rate (for the analytics summary; last-30-days by default).
  function overview(bundle, options) {
    options = options || {};
    const today = resolveToday(bundle, options);
    let recordedDays = 0, unrecordedDays = 0, noExpectedDays = 0, expected = 0, completed = 0, excusedCount = 0, replacementCount = 0;
    rangeKeys(bundle, options, today).forEach((k) => {
      const s = daySummary(bundle, k, { today });
      if (s.state === 'no_expected') { noExpectedDays++; return; }
      if (s.state === 'unrecorded') { unrecordedDays++; return; }
      recordedDays++;
      excusedCount += s.excusedCount || 0; replacementCount += s.replacementCount || 0; // transparency (not hidden)
      if (s.isInProgress) return; // exclude today's live number from the range rate
      expected += s.expected; completed += s.completed;
    });
    return { recordedDays, unrecordedDays, noExpectedDays, expected, completed, excusedCount, replacementCount, overallRate: rate(completed, expected), overallRatePct: pct(rate(completed, expected)) };
  }

  // ---------- convenience: compute the insight base ONCE (each stat computed a single time) ----------
  function report(bundle, options) {
    const st = periodStats(bundle, options); const bw = pickBestWorstPeriod(st);
    const wst = weekdayStats(bundle, options); const bwd = pickBestWorstWeekday(wst);
    const routines = routineStats(bundle, options);
    return {
      periods: st, bestPeriod: bw.best || null, weakestPeriod: bw.weakest || null, periodStatus: bw.status,
      routines, consistent: pickConsistent(routines, options && options.limit), struggling: pickStruggling(routines, options && options.limit),
      weekdays: wst, bestWeekday: bwd.best || null, weakestWeekday: bwd.weakest || null, weekdayStatus: bwd.status,
      trend: weekTrend(bundle, options),
    };
  }

  // ---------- deterministic recommendations (NO AI, NO stat recompute) ----------
  // Pure: consumes a `report` (and optional context) and returns 1-2 structured recommendations, ranked
  // by actionability. The UI turns {kind, ...} into calm Arabic text; the gating/choice lives here.
  function recommendations(report, ctx) {
    const out = [];
    const s = (report.struggling || [])[0]; // already gated: sample>=5, missRate>=0.5
    if (s) out.push({ kind: 'struggling', seriesId: s.seriesId, title: s.title, completed: s.completed, expected: s.expected, missed: s.missed });
    if (report.periodStatus === 'ok' && report.bestPeriod && report.weakestPeriod) {
      const gap = report.bestPeriod.rate - report.weakestPeriod.rate; // clear, confident gap only
      if (gap >= 0.25 && report.bestPeriod.confidence !== 'low' && report.weakestPeriod.confidence !== 'low') {
        out.push({ kind: 'period_gap', bestPeriod: report.bestPeriod.period, bestRatePct: report.bestPeriod.ratePct, weakPeriod: report.weakestPeriod.period, weakRatePct: report.weakestPeriod.ratePct });
      }
    }
    if (!out.length) out.push({ kind: 'keep_logging' });
    return out.slice(0, 2);
  }

  global.AyyamAnalytics = {
    PERIODS, DAY_CODES, MIN_VERDICT_SAMPLE,
    logHasActivity, confidence, pct,
    daySummary, firstActiveKey,
    periodStats, bestWorstPeriod,
    routineStats, consistentTasks, strugglingTasks,
    weekdayStats, bestWorstWeekday,
    weekTrend, monthSummary, classify, liveClass, hourlyStats, overview, report, recommendations,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
