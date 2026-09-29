// Overdue-tasks helper for the TODAY view — pure, no I/O. Classic script: sets globalThis.AyyamOverdue.
// Depends on globalThis.AyyamRoutines (materialization) + globalThis.AyyamTime (canonical day math) and,
// when available, globalThis.adhan (prayer-time boundaries). Everything is injectable for unit tests.
//
// WHY this exists: the old "missing" banner listed EVERY not-done task of the day, including tasks whose
// period has not arrived yet — visually noisy and wrong. "Overdue" means: a task whose period has already
// ENDED (the next prayer has begun) and is still not done. Periods are ordered fajr→dhuhr→asr→maghrib→isha;
// a period P is overdue once the NEXT period has started, so at any moment only the fully-elapsed periods
// count. Isha is never overdue within the same calendar day (it is the current period until day rollover).
//
// This is a TODAY UX helper ONLY. It changes NOTHING in the widget, calendar or analytics semantics.
(function (global) {
  'use strict';
  const R = () => global.AyyamRoutines;
  const T = () => global.AyyamTime;
  const PERIOD_ORDER = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const DEFAULT_LOC = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' }; // Cairo (mirrors notif-plan)

  function cleanLoc(l) {
    if (!isObj(l)) return { ...DEFAULT_LOC };
    const lat = Number(l.lat), lng = Number(l.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ...DEFAULT_LOC };
    return { lat, lng, tz: typeof l.tz === 'string' && l.tz ? l.tz : DEFAULT_LOC.tz };
  }
  // Today's prayer instants (ms) at a location. Mirrors notif-plan.prayerTimes (same adhan config).
  function prayerInstants(adhan, loc, y, m, d) {
    const params = adhan.CalculationMethod.Egyptian();
    const date = new Date(y, m - 1, d, 12);
    const pt = new adhan.PrayerTimes(new adhan.Coordinates(loc.lat, loc.lng), date, params);
    const out = {};
    PERIOD_ORDER.forEach((p) => { const t = pt[p]; out[p] = (t instanceof Date && !isNaN(t)) ? t.getTime() : null; });
    return out;
  }
  // "HH:MM" wall-clock in a timezone for an instant (for exact-time overdue on timed tasks).
  function wallHHMM(nowMs, tz) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
      const hh = parts.hour === '24' ? '00' : parts.hour; // en-GB can emit 24 at midnight
      return `${hh}:${parts.minute}`;
    } catch (e) { return null; }
  }

  // Index of the CURRENT period: the last period whose instant is <= now. -1 before today's fajr.
  function currentPeriodIndex(times, nowMs) {
    let idx = -1;
    for (let i = 0; i < PERIOD_ORDER.length; i++) {
      const t = times[PERIOD_ORDER[i]];
      if (t != null && nowMs >= t) idx = i; else if (t == null) { /* skip unknown boundary */ }
    }
    return idx;
  }

  // overdueForNow(bundle, opts) → { available, count, currentPeriod, periodsElapsed:[..], tasks:[{id,title,period,timeValue}] }
  // opts: { now(ms), adhan, location, tz, today(key) } — all optional (injected in tests).
  function overdueForNow(bundle, opts) {
    opts = opts || {};
    const b = isObj(bundle) ? bundle : {};
    const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
    const tz = opts.tz || (T() ? T().resolveDayTimezone(b.prefs) : DEFAULT_LOC.tz);
    const today = (typeof opts.today === 'string' && opts.today) ? opts.today : (T() ? T().todayKey(tz, nowMs) : null);
    const empty = { available: false, count: 0, currentPeriod: null, periodsElapsed: [], tasks: [] };
    if (!today || !R()) return empty;

    const adhan = opts.adhan || global.adhan;
    const loc = cleanLoc(opts.location || (isObj(b.prefs) ? b.prefs.location : null));
    if (!adhan) return empty;                                  // no boundary source → hide the card (never guess)
    let times;
    try { times = prayerInstants(adhan, loc, Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10))); }
    catch (e) { return empty; }

    const curIdx = currentPeriodIndex(times, nowMs);
    // Periods that have fully ended = strictly before the current one (isha never overdue same day).
    const elapsed = curIdx > 0 ? PERIOD_ORDER.slice(0, curIdx) : [];
    const elapsedSet = new Set(elapsed);
    const nowHHMM = wallHHMM(nowMs, tz);

    const tasks = R().tasksForDate(b, today);                  // routine-aware, single source; excludes hidden, applies done
    const overdue = [];
    tasks.forEach((t) => {
      if (!t || t.done) return;                                // completed → never overdue
      const period = PERIOD_ORDER.includes(t.period) ? t.period : null;
      const timed = typeof t.timeValue === 'string' && TIME_RE.test(t.timeValue);
      let isOverdue = false;
      if (period && elapsedSet.has(period)) isOverdue = true;   // its period has ended
      // Exact-time enhancement (secondary): a task with a real HH:MM whose time has passed today is late,
      // even inside the current period. Never makes a FUTURE-period task overdue (its time hasn't passed).
      else if (timed && nowHHMM && t.timeValue < nowHHMM) {
        // only if the task's period is the current one or unset — a later-period timed task is future.
        const pIdx = period ? PERIOD_ORDER.indexOf(period) : -1;
        if (pIdx <= curIdx) isOverdue = true;
      }
      // Free tasks (no period) with no time are intentionally NOT overdue during the day (documented).
      if (isOverdue) overdue.push({ id: t.id, title: String(t.title || ''), period, timeValue: timed ? t.timeValue : null });
    });
    // Stable order: by period order, then by time, then title.
    overdue.sort((a, b2) => {
      const pa = a.period ? PERIOD_ORDER.indexOf(a.period) : 99, pb = b2.period ? PERIOD_ORDER.indexOf(b2.period) : 99;
      if (pa !== pb) return pa - pb;
      if (a.timeValue && b2.timeValue && a.timeValue !== b2.timeValue) return a.timeValue < b2.timeValue ? -1 : 1;
      return a.title < b2.title ? -1 : (a.title > b2.title ? 1 : 0);
    });
    return { available: true, count: overdue.length, currentPeriod: curIdx >= 0 ? PERIOD_ORDER[curIdx] : null, periodsElapsed: elapsed, tasks: overdue };
  }

  global.AyyamOverdue = { overdueForNow, PERIOD_ORDER };
})(typeof globalThis !== 'undefined' ? globalThis : window);
