// Local-notification PLAN builder for the Android shell (no server, no FCM). Native-only (injected by
// build-webdir); sets globalThis.AyyamNotif. Pure: `adhan` and `now` are injected so it unit-tests in
// Node (tests/unit/notif-plan.test.mjs). Mirrors the reminders logic (prayer times + buildMessage) so
// the native scheduler only fires pre-built content at pre-computed instants — it never reads tasks.
(function (global) {
  'use strict';
  const PERIOD_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const PERIOD_LABEL = { fajr: 'الفجر', dhuhr: 'الظهر', asr: 'العصر', maghrib: 'المغرب', isha: 'العشاء' };
  const JSDAY_TO_CODE = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
  const WEEKDAY_TO_CODE = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  // Calendar day in the LOCATION timezone (NOT the runtime TZ) so the plan is correct on any host.
  function localParts(nowMs, tz) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      }).formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
      return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
        key: parts.year + '-' + parts.month + '-' + parts.day, dayCode: WEEKDAY_TO_CODE[parts.weekday] };
    } catch (e) {
      const d = new Date(nowMs);
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), key: dateKey(d), dayCode: JSDAY_TO_CODE[d.getDay()] };
    }
  }
  function addDays(parts, n) { // advance a Y/M/D by n days via a UTC anchor (DST-safe for date math)
    const t = Date.UTC(parts.y, parts.m - 1, parts.d) + n * 86400000;
    const d = new Date(t);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      key: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
      dayCode: JSDAY_TO_CODE[d.getUTCDay()] };
  }
  const DEFAULT_LOC = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const AR = { '0': '٠', '1': '١', '2': '٢', '3': '٣', '4': '٤', '5': '٥', '6': '٦', '7': '٧', '8': '٨', '9': '٩' };
  const toAr = (n) => String(n).replace(/[0-9]/g, (d) => AR[d]);
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  function cleanLoc(l) {
    if (!isObj(l)) return { ...DEFAULT_LOC };
    const lat = Number(l.lat), lng = Number(l.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ...DEFAULT_LOC };
    return { lat, lng, tz: typeof l.tz === 'string' && l.tz ? l.tz : DEFAULT_LOC.tz };
  }

  // Tasks for a date. Post-R2 the recurrence engine is the source of truth (routine-aware); the
  // scheduler stays dumb — it only consumes materialized tasks, it never resolves recurrence itself.
  // Falls back to the inline legacy template path only when the engine is not loaded.
  function tasksFor(state, key, code) {
    if (global.AyyamRoutines && typeof global.AyyamRoutines.tasksForDate === 'function') {
      return global.AyyamRoutines.tasksForDate(state, key)
        // Don't remind about an excused or replaced-original occurrence; a replacement occurrence (status
        // pending/completed) stays, so the reminder is for what the user actually intends to do.
        .filter((t) => t.status !== 'excused' && t.status !== 'replaced')
        .map((t) => ({ title: String(t.title || ''), period: PERIOD_KEYS.includes(t.period) ? t.period : null, done: t.done === true }));
    }
    const log = (isObj(state.logs) && isObj(state.logs[key])) ? state.logs[key] : {};
    const done = isObj(log.done) ? log.done : {}, hidden = isObj(log.hidden) ? log.hidden : {};
    const overrides = isObj(log.overrides) ? log.overrides : {}, extra = Array.isArray(log.extra) ? log.extra : [];
    const tpl = (isObj(state.template) && Array.isArray(state.template[code])) ? state.template[code] : [];
    const base = tpl.filter((t) => isObj(t) && typeof t.id === 'string' && !hidden[t.id]).map((t) => {
      const ov = isObj(overrides[t.id]) ? overrides[t.id] : null;
      return { title: String((ov && ov.title) || t.title || ''), period: ov ? ov.period : t.period, done: done[t.id] === true };
    });
    const ex = extra.filter((t) => isObj(t) && typeof t.id === 'string').map((t) => ({ title: String(t.title || ''), period: t.period, done: done[t.id] === true }));
    return base.concat(ex).map((t) => ({ ...t, period: PERIOD_KEYS.includes(t.period) ? t.period : null }));
  }

  function buildMessage(periodKey, tasks) {
    const open = tasks.filter((t) => t.period === periodKey && !t.done && t.title);
    if (!PERIOD_LABEL[periodKey] || open.length === 0) return null;
    const shown = open.slice(0, 3).map((t) => t.title);
    const rest = open.length - shown.length, n = open.length;
    const count = n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتان' : `${toAr(n)} ${n <= 10 ? 'مهام' : 'مهمة'}`;
    return { title: `حان وقت ${PERIOD_LABEL[periodKey]}`, body: `عليك ${count}: ${shown.join('، ')}${rest > 0 ? ` و${toAr(rest)} غيرها` : ''}` };
  }

  function prayerTimes(adhan, loc, y, m, d) {
    const params = adhan.CalculationMethod.Egyptian();
    const date = new Date(y, m - 1, d, 12);
    const pt = new adhan.PrayerTimes(new adhan.Coordinates(loc.lat, loc.lng), date, params);
    return { fajr: pt.fajr, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha };
  }

  // Build the forward-looking notification plan. opts: { adhan, now(ms), days=3, location }
  function buildPlan(state, opts) {
    opts = opts || {};
    const adhan = opts.adhan || global.adhan;
    if (!adhan || !isObj(state)) return { schema: 1, generatedAt: new Date(opts.now || Date.now()).toISOString(), tz: DEFAULT_LOC.tz, items: [] };
    const nowMs = opts.now || Date.now();
    const days = Number.isFinite(opts.days) ? Math.max(1, Math.min(opts.days, 14)) : 3;
    const loc = cleanLoc(opts.location || (isObj(state.prefs) ? state.prefs.location : null));
    const base = localParts(nowMs, loc.tz); // "today" in the user's timezone
    const items = [];
    for (let i = 0; i < days; i++) {
      const day = i === 0 ? base : addDays(base, i);
      const key = day.key, code = day.dayCode;
      let times; try { times = prayerTimes(adhan, loc, day.y, day.m, day.d); } catch (e) { continue; }
      const tasks = tasksFor(state, key, code);
      for (const period of PERIOD_KEYS) {
        const t = times[period];
        if (!(t instanceof Date)) continue;
        const at = t.getTime();
        if (at <= nowMs) continue;                 // only future instants
        const msg = buildMessage(period, tasks);
        if (!msg) continue;                          // nothing open in this period → no reminder
        items.push({ id: key + ':' + period, at, date: key, period, title: msg.title, body: msg.body });
      }
    }
    items.sort((a, b) => a.at - b.at);
    return { schema: 1, generatedAt: new Date(nowMs).toISOString(), tz: loc.tz, days, items };
  }

  global.AyyamNotif = { buildPlan, buildMessage };
})(typeof globalThis !== 'undefined' ? globalThis : window);
