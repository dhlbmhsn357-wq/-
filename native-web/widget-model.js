// Pure widget snapshot builder. Native-only (injected into the APK by build-webdir); NEVER on web.
// Sets globalThis.AyyamWidget. No I/O. Heavily unit-tested (tests/unit/widget-model.test.mjs).
//
// The app passes the SAME task array it already computes (tasksForDate order) — this module does NOT
// re-implement tasksForDate. It produces the minimal view model the widget draws. It carries NO secret:
// no device key, revision, epoch, Supabase info, recovery, outbox, coordinates or raw bundle.
(function (global) {
  'use strict';
  const SCHEMA = 1;
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
    const maxTasks = Number.isFinite(opts.maxTasks) ? Math.max(0, opts.maxTasks) : 5;
    const src = Array.isArray(opts.tasks) ? opts.tasks : [];
    const tasks = src.map(normTask).filter((t) => t.id || t.title); // drop junk entries
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const nextTask = tasks.find((t) => !t.done) || null;

    // Under privacy, titles/times are NEVER put into the snapshot (not stored, then hidden — omitted).
    const projectTask = (t) => privacy
      ? { id: t.id, done: t.done, period: t.period }
      : { id: t.id, title: t.title, time: t.time, period: t.period, done: t.done };
    const projectNext = (t) => !t ? null : (privacy
      ? { id: t.id, period: t.period }
      : { id: t.id, title: t.title, time: t.time, period: t.period });

    return {
      schema: SCHEMA,
      generatedAt: now.toISOString(),
      date: (typeof opts.date === 'string' && DATE_RE.test(opts.date)) ? opts.date : localDateKey(now),
      dayLabel: typeof opts.dayLabel === 'string' ? opts.dayLabel : '',
      done,
      total,
      remaining: total - done,
      next: projectNext(nextTask),
      tasks: tasks.slice(0, maxTasks).map(projectTask),
      allDone: total > 0 && done === total,
      empty: total === 0,
      privacy,
    };
  }

  global.AyyamWidget = { SCHEMA, buildSnapshot };
})(typeof globalThis !== 'undefined' ? globalThis : window);
