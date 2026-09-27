// Pure reminder logic (no I/O) — shared by the edge function and the Node tests.
// Mirrors the app's tasksForDate()/templateFor() in index.html; keep the two in sync.

export const PERIODS = [
  { key: 'fajr',    label: 'الفجر' },
  { key: 'dhuhr',   label: 'الظهر' },
  { key: 'asr',     label: 'العصر' },
  { key: 'maghrib', label: 'المغرب' },
  { key: 'isha',    label: 'العشاء' },
];
const PERIOD_KEYS = PERIODS.map((p) => p.key);
const WEEKDAY_TO_CODE = { Sat: 'sat', Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri' };
const EPOCH_KEY = '0000-00-00';

export const DEFAULT_LOCATION = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' }; // Cairo

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DAY_CODES = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

// The client stores the CONFLICT-MODEL "enriched" shape ({v:2, reg, tomb, epoch}); the reminder logic
// works on the "materialized" bundle. Convert enriched → materialized here (mirrors AyyamModel.materialize
// in js/sync-model.js — keep the two in sync). A plain (v1/materialized) bundle passes through unchanged.
export function isEnriched(data) { return isObj(data) && data.v === 2 && isObj(data.reg); }
export function materialize(data) {
  if (!isEnriched(data)) return data;
  const live = (key) => { const r = data.reg[key], t = (data.tomb || {})[key];
    if (t && (!r || t.t >= r.t)) return undefined; return r ? r.val : undefined; };
  const mat = { template: Object.fromEntries(DAY_CODES.map((c) => [c, []])), logs: {}, prefs: {}, tplArchive: { since: '0000-00-00', versions: [] } };
  const day = (d) => (mat.logs[d] || (mat.logs[d] = { done: {}, extra: [], hidden: {}, overrides: {} }));
  const extras = {}, tpl = {};
  for (const key of Object.keys(data.reg)) {
    if (live(key) === undefined) continue;
    const val = data.reg[key].val;
    if (key.startsWith('p:')) { mat.prefs[key.slice(2)] = val; continue; }
    if (key === 'arch') { mat.tplArchive = val; continue; }
    const parts = key.split(':');
    if (parts[0] === 'g') {
      const [, d, kind, id] = parts; const L = day(d);
      if (kind === 'done') { if (val === true) L.done[id] = true; }
      else if (kind === 'hide') { if (val === true) L.hidden[id] = true; }
      else if (kind === 'ovr') L.overrides[id] = { title: val.title, time: val.time || '', period: val.period || null };
      else if (kind === 'ext') (extras[d] || (extras[d] = [])).push({ o: val.order || 0, t: { id, title: val.title, time: val.time || '', period: val.period || null } });
    } else if (parts[0] === 'm') {
      const [, dc, id] = parts; (tpl[dc] || (tpl[dc] = [])).push({ o: val.order || 0, t: { id, title: val.title, time: val.time || '', period: val.period || null } });
    }
  }
  for (const d of Object.keys(extras)) day(d).extra = extras[d].sort((a, b) => a.o - b.o).map((x) => x.t);
  for (const dc of DAY_CODES) if (tpl[dc]) mat.template[dc] = tpl[dc].sort((a, b) => a.o - b.o).map((x) => x.t);
  return mat;
}

export function toArabicNum(n) {
  return String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
}

// Calendar date + weekday of `now` in the given IANA time zone.
export function localParts(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    key: `${parts.year}-${parts.month}-${parts.day}`,
    dayCode: WEEKDAY_TO_CODE[parts.weekday],
  };
}

// Location saved by the app (prefs.location), validated; falls back to the default.
export function locationFrom(data, fallback = DEFAULT_LOCATION) {
  const loc = isObj(data) && isObj(data.prefs) ? data.prefs.location : null;
  if (!isObj(loc)) return fallback;
  const lat = Number(loc.lat), lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fallback;
  let tz = typeof loc.tz === 'string' ? loc.tz : fallback.tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = fallback.tz; }
  return { lat, lng, tz };
}

function templateFor(data, key) {
  const template = isObj(data.template) ? data.template : {};
  const arch = isObj(data.tplArchive) ? data.tplArchive : {};
  const since = typeof arch.since === 'string' ? arch.since : EPOCH_KEY;
  if (key >= since) return template;
  const versions = (Array.isArray(arch.versions) ? arch.versions : [])
    .filter((v) => isObj(v) && typeof v.id === 'string' && v.id < since && isObj(v.template))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!versions.length) return template;
  let pick = versions[0];
  versions.forEach((v) => { if (v.id <= key) pick = v; });
  return pick.template;
}

// Tasks of one day, same rules as the app: template (minus hidden, plus per-day overrides) + extra tasks.
export function tasksForDay(data, key, dayCode) {
  if (!isObj(data)) return [];
  const log = isObj(data.logs) && isObj(data.logs[key]) ? data.logs[key] : {};
  const done = isObj(log.done) ? log.done : {};
  const hidden = isObj(log.hidden) ? log.hidden : {};
  const overrides = isObj(log.overrides) ? log.overrides : {};
  const extra = Array.isArray(log.extra) ? log.extra : [];
  const list = templateFor(data, key)[dayCode];
  const base = (Array.isArray(list) ? list : [])
    .filter((t) => isObj(t) && typeof t.id === 'string' && !hidden[t.id])
    .map((t) => {
      const ov = isObj(overrides[t.id]) ? overrides[t.id] : null;
      return { title: String((ov && ov.title) || t.title || ''), period: ov ? ov.period : t.period, done: done[t.id] === true };
    });
  const ex = extra
    .filter((t) => isObj(t) && typeof t.id === 'string')
    .map((t) => ({ title: String(t.title || ''), period: t.period, done: done[t.id] === true }));
  return base.concat(ex).map((t) => ({ ...t, period: PERIOD_KEYS.includes(t.period) ? t.period : null }));
}

// Prayer times (as instants) for the local calendar day y-m-d at the location. `adhan` is the adhan library.
export function prayerTimes(adhan, loc, y, m, d) {
  const params = adhan.CalculationMethod.Egyptian();
  // adhan reads the date's local Y/M/D components; build them explicitly so the runtime TZ doesn't matter.
  const date = new Date(y, m - 1, d, 12);
  const pt = new adhan.PrayerTimes(new adhan.Coordinates(loc.lat, loc.lng), date, params);
  return { fajr: pt.fajr, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha };
}

// Periods whose prayer time has started within the last `windowMs` (cron runs every 5 min; the
// window tolerates a delayed run). Duplicate sends are prevented separately by the push_log table.
export function duePeriods(times, now, windowMs) {
  return PERIOD_KEYS.filter((k) => {
    const t = times[k];
    return t instanceof Date && now >= t && now - t < windowMs;
  });
}

// Notification for one period, or null when nothing in that period is left to do.
export function buildMessage(periodKey, tasks) {
  const period = PERIODS.find((p) => p.key === periodKey);
  const open = tasks.filter((t) => t.period === periodKey && !t.done && t.title);
  if (!period || open.length === 0) return null;
  const shown = open.slice(0, 3).map((t) => t.title);
  const rest = open.length - shown.length;
  const n = open.length;
  const count = n === 1 ? 'مهمة واحدة' : n === 2 ? 'مهمتان' : `${toArabicNum(n)} ${n <= 10 ? 'مهام' : 'مهمة'}`;
  return {
    title: `حان وقت ${period.label}`,
    body: `عليك ${count}: ${shown.join('، ')}${rest > 0 ? ` و${toArabicNum(rest)} غيرها` : ''}`,
    tag: `ayyam-${periodKey}`,
  };
}
