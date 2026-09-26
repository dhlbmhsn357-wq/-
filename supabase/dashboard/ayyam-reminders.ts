// Single-file version of functions/ayyam-reminders for pasting into the Supabase Dashboard editor.
// Generated from logic.js + index.ts — edit those, not this file.

// Supabase Edge Function: prayer-time reminders for "أيام".
// Called every 5 minutes by pg_cron (see supabase/setup-reminders.sql). At each prayer time it sends
// a Web Push with the still-open tasks of that period to every subscription in push_subscriptions.
// Idempotent: push_log (day, period) guarantees one send per prayer, however often it is called,
// so it is safe to expose without a JWT.
//
// Secrets (supabase secrets set --env-file supabase/functions/.env):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, REMINDER_TEST_KEY
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import * as adhan from 'npm:adhan@4.4.3';

// ---------- logic.js ----------
// Pure reminder logic (no I/O) — shared by the edge function and the Node tests.
// Mirrors the app's tasksForDate()/templateFor() in index.html; keep the two in sync.

const PERIODS = [
  { key: 'fajr',    label: 'الفجر' },
  { key: 'dhuhr',   label: 'الظهر' },
  { key: 'asr',     label: 'العصر' },
  { key: 'maghrib', label: 'المغرب' },
  { key: 'isha',    label: 'العشاء' },
];
const PERIOD_KEYS = PERIODS.map((p) => p.key);
const WEEKDAY_TO_CODE = { Sat: 'sat', Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri' };
const EPOCH_KEY = '0000-00-00';

const DEFAULT_LOCATION = { lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' }; // Cairo

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function toArabicNum(n) {
  return String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
}

// Calendar date + weekday of `now` in the given IANA time zone.
function localParts(now, tz) {
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
function locationFrom(data, fallback = DEFAULT_LOCATION) {
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
function tasksForDay(data, key, dayCode) {
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
function prayerTimes(adhan, loc, y, m, d) {
  const params = adhan.CalculationMethod.Egyptian();
  // adhan reads the date's local Y/M/D components; build them explicitly so the runtime TZ doesn't matter.
  const date = new Date(y, m - 1, d, 12);
  const pt = new adhan.PrayerTimes(new adhan.Coordinates(loc.lat, loc.lng), date, params);
  return { fajr: pt.fajr, dhuhr: pt.dhuhr, asr: pt.asr, maghrib: pt.maghrib, isha: pt.isha };
}

// Periods whose prayer time has started within the last `windowMs` (cron runs every 5 min; the
// window tolerates a delayed run). Duplicate sends are prevented separately by the push_log table.
function duePeriods(times, now, windowMs) {
  return PERIOD_KEYS.filter((k) => {
    const t = times[k];
    return t instanceof Date && now >= t && now - t < windowMs;
  });
}

// Notification for one period, or null when nothing in that period is left to do.
function buildMessage(periodKey, tasks) {
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

// ---------- handler ----------
const WINDOW_MS = 20 * 60 * 1000; // a prayer is "due" for 20 min after its time (tolerates late cron runs)
const LOG_RETENTION_DAYS = 30;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const env = (k: string) => Deno.env.get(k) ?? '';
  if (!env('VAPID_PUBLIC_KEY') || !env('VAPID_PRIVATE_KEY')) return json({ error: 'VAPID keys not configured' }, 500);
  webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:ayyam@example.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const now = new Date();

  // Test mode (needs the private REMINDER_TEST_KEY): send one notification right away.
  const testKey = env('REMINDER_TEST_KEY');
  const isTest = !!testKey && req.headers.get('x-test-key') === testKey;

  const { data: row, error: rowErr } = await sb.from('ayyam_data').select('data').eq('id', 'main').maybeSingle();
  if (rowErr) return json({ error: 'read ayyam_data failed', detail: rowErr.message }, 500);
  const data = row?.data ?? {};
  const loc = locationFrom(data);
  const today = localParts(now, loc.tz);

  const messages: { title: string; body: string; tag: string }[] = [];
  if (isTest) {
    messages.push({ title: 'أيام', body: 'الإشعارات تعمل ✅ ستصلك تذكيرات مهامك مع كل صلاة.', tag: 'ayyam-test' });
  } else {
    const times = prayerTimes(adhan, loc, today.y, today.m, today.d);
    const tasks = tasksForDay(data, today.key, today.dayCode);
    for (const period of duePeriods(times, now, WINDOW_MS)) {
      // Claim this (day, period) first; only the invocation that inserts the row sends.
      const { data: claimed, error } = await sb.from('push_log')
        .upsert({ day: today.key, period }, { onConflict: 'day,period', ignoreDuplicates: true })
        .select();
      if (error) return json({ error: 'push_log failed', detail: error.message }, 500);
      if (!claimed || claimed.length === 0) continue; // already handled
      const msg = buildMessage(period, tasks);
      if (msg) messages.push(msg);
    }
    // housekeeping
    const cutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    await sb.from('push_log').delete().lt('day', cutoff);
  }

  if (messages.length === 0) return json({ sent: 0, day: today.key });

  const { data: subs, error: subErr } = await sb.from('push_subscriptions').select('endpoint, p256dh, auth');
  if (subErr) return json({ error: 'read push_subscriptions failed', detail: subErr.message }, 500);

  let sent = 0, removed = 0, failed = 0;
  for (const msg of messages) {
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(msg),
          { TTL: 60 * 60 }, // a reminder older than an hour is pointless
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // 404/410: subscription gone; 403: created with another VAPID key — both permanently invalid.
        if (code === 404 || code === 410 || code === 403) {
          await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          removed++;
        } else {
          failed++;
        }
      }
    }
  }
  return json({ day: today.key, messages: messages.map((m) => m.title), sent, removed, failed });
});
