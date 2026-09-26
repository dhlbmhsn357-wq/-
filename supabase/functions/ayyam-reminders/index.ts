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
import { localParts, locationFrom, tasksForDay, prayerTimes, duePeriods, buildMessage } from './logic.js';

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
