// Canonical "Ayyam day" time model for "أيام" — pure, no I/O. Classic script: sets globalThis.AyyamTime.
//
// The day boundary of the app is a SINGLE canonical timezone (prefs.dayTimezone), NOT the raw device
// timezone. This is what stops two devices in different timezones from disagreeing on "today". Only ONE
// function here depends on the timezone: todayKey() (instant -> calendar date in that zone, via Intl).
// Everything else is pure calendar-string arithmetic on 'YYYY-MM-DD' keys, which is timezone- and
// DST-independent (a given calendar date always falls on the same weekday, everywhere).
//
// dayTimezone is resolved once and stored in prefs; it is NEVER changed automatically on travel.
(function (global) {
  'use strict';

  const DAY_CODES = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
  // JS getUTCDay(): 0=Sun..6=Sat -> our codes
  const JSDAY_TO_CODE = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };
  const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isKey = (k) => typeof k === 'string' && DATE_KEY_RE.test(k);

  function isValidTz(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  function deviceTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }

  // The one and only timezone-dependent step: which calendar date is it, right now, in `tz`.
  function todayKey(tz, nowMs) {
    const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
    const zone = isValidTz(tz) ? tz : 'Africa/Cairo';
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const g = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : ''; };
      const y = g('year'), m = g('month'), day = g('day');
      if (/^\d{4}$/.test(y) && /^\d{2}$/.test(m) && /^\d{2}$/.test(day)) return `${y}-${m}-${day}`;
    } catch (e) { /* fall through */ }
    return d.toISOString().slice(0, 10); // last-resort UTC date
  }

  // Weekday code of a calendar date — timezone-INDEPENDENT (uses UTC math on the date components).
  function dayCode(key) {
    if (!isKey(key)) return null;
    const [y, m, d] = key.split('-').map(Number);
    return JSDAY_TO_CODE[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  // Pure calendar arithmetic on date keys (DST-safe: operates on UTC midnight anchors, no local offset).
  function addDays(key, n) {
    if (!isKey(key)) return key;
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d) + (Number.isFinite(n) ? n : 0) * 86400000);
    const yy = dt.getUTCFullYear(), mm = String(dt.getUTCMonth() + 1).padStart(2, '0'), dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  function diffDays(a, b) {
    if (!isKey(a) || !isKey(b)) return 0;
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
  }
  // Date keys are zero-padded, so lexicographic order == chronological order.
  function cmpKey(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // Week starts Saturday (matches DAY_CODES order and the existing weekly UI).
  function startOfWeekKey(key) {
    const idx = DAY_CODES.indexOf(dayCode(key));
    return idx < 0 ? key : addDays(key, -idx);
  }

  // dayTimezone precedence: explicit prefs.dayTimezone -> saved location tz -> device tz -> Cairo.
  function resolveDayTimezone(prefs) {
    const p = prefs || {};
    if (isValidTz(p.dayTimezone)) return p.dayTimezone;
    if (p.location && isValidTz(p.location.tz)) return p.location.tz;
    const dev = deviceTz();
    if (isValidTz(dev)) return dev;
    return 'Africa/Cairo';
  }

  global.AyyamTime = {
    DAY_CODES, DATE_KEY_RE, isKey, isValidTz, deviceTz,
    todayKey, dayCode, addDays, diffDays, cmpKey, startOfWeekKey, resolveDayTimezone,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
