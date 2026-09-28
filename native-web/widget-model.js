// Pure widget snapshot builder. Native-only (injected into the APK by build-webdir); NEVER on web.
// Sets globalThis.AyyamWidget. No I/O. Heavily unit-tested (tests/unit/widget-model.test.mjs).
//
// The app passes the SAME task array it already computes (tasksForDate order) — this module does NOT
// re-implement tasksForDate. It produces the minimal view model the widget draws. It carries NO secret:
// no device key, revision, epoch, Supabase info, recovery, outbox, coordinates or raw bundle.
//
// v2 (schema 2): the widget is a "daily execution assistant", not a counter. Beyond done/total it emits
// the NEXT task (first incomplete in the app's real order — NOT time-parsed), a curated list of UPCOMING
// incomplete tasks, and which prayer PERIODS still have open tasks — so the native layer can answer
// "what do I do now?" and "how much is left?" at a glance. Task SELECTION uses the real order only.
(function (global) {
  'use strict';
  const SCHEMA = 2;
  const PERIODS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const pad = (n) => String(n).padStart(2, '0');
  const localDateKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  function normTask(t) {
    const o = (t && typeof t === 'object') ? t : {};
    return {
      id: typeof o.id === 'string' ? o.id : '',
      title: typeof o.title === 'string' ? o.title : (o.title == null ? '' : String(o.title)),
      time: typeof o.time === 'string' ? o.time : '',           // keep the app's free-text time as-is
      period: PERIODS.indexOf(o.period) >= 0 ? o.period : null,
      done: !!o.done,
    };
  }

  // opts: { date:'YYYY-MM-DD', dayLabel, tasks:[{id,title,time,period,done}], now, maxTasks, privacy }
  function buildSnapshot(opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    const now = opts.now != null ? new Date(opts.now) : new Date();
    const privacy = !!opts.privacy;
    const maxTasks = Number.isFinite(opts.maxTasks) ? Math.max(0, opts.maxTasks) : 4;
    const src = Array.isArray(opts.tasks) ? opts.tasks : [];
    const tasks = src.map(normTask).filter((t) => t.id || t.title); // drop junk entries
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const remaining = total - done;
    const pct = total > 0 ? Math.round((done * 100) / total) : 0;

    // NEXT = the first INCOMPLETE task in the app's real order (no time parsing). Upcoming = the rest
    // of the incomplete tasks, in order, so the widget shows what's LEFT to do (not what's finished).
    const incomplete = tasks.filter((t) => !t.done);
    const nextTask = incomplete[0] || null;
    const upcomingSrc = incomplete.slice(1);

    // Which prayer periods still have an open task (canonical order) → "المتبقي: العصر والمغرب".
    const openPeriod = {};
    for (const t of incomplete) if (t.period) openPeriod[t.period] = true;
    const remainingPeriods = PERIODS.filter((p) => openPeriod[p]);

    // Under privacy, titles/times are NEVER put into the snapshot (not stored → cannot leak). Periods
    // and counts are not secret, so they still drive the "what now / how much left" cues.
    const projTask = (t) => privacy
      ? { id: t.id, period: t.period, done: t.done }
      : { id: t.id, title: t.title, time: t.time, period: t.period, done: t.done };
    const projNext = (t) => !t ? null : (privacy
      ? { id: t.id, period: t.period }
      : { id: t.id, title: t.title, time: t.time, period: t.period });

    return {
      schema: SCHEMA,
      generatedAt: now.toISOString(),
      date: (typeof opts.date === 'string' && DATE_RE.test(opts.date)) ? opts.date : localDateKey(now),
      dayLabel: typeof opts.dayLabel === 'string' ? opts.dayLabel : '',
      done,
      total,
      remaining,
      pct,
      next: projNext(nextTask),
      upcoming: upcomingSrc.slice(0, maxTasks).map(projTask),
      remainingPeriods,
      allDone: total > 0 && done === total,
      empty: total === 0,
      privacy,
    };
  }

  global.AyyamWidget = { SCHEMA, buildSnapshot };
})(typeof globalThis !== 'undefined' ? globalThis : window);
