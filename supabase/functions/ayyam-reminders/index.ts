// Supabase Edge Function: prayer-time reminders for "أيام".
// Runs every 5 minutes via pg_cron (see supabase/setup-reminders.sql), authenticated with X-Cron-Secret.
//
// Cron mode: computes the prayers due now (adhan, Egyptian method, the user's saved location) and, for
// each, enqueues one reminder (or 'skipped' when no tasks are open) via push_enqueue. It then drains
// the delivery queue: push_claim leases a batch (so two concurrent runs never send the same delivery
// twice), each is sent with bounded concurrency, and every delivery ends in sent / retry-with-backoff /
// disabled(410) — a temporary failure is never marked sent. State lives in push_reminders/push_deliveries.
//
// Test mode: X-Test-Key === REMINDER_TEST_KEY sends ONE test push to the active devices WITHOUT touching
// any reminder/delivery/prayer state, so it can't corrupt the day's real reminders.
//
// Secrets (never in the repo): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET,
// REMINDER_TEST_KEY. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import * as adhan from 'npm:adhan@4.4.3';
import { runCron, runTest, CFG } from './orchestrate.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function pushError(e: unknown) { const x = e as { statusCode?: number; status?: number }; const err = new Error('push failed'); (err as any).statusCode = x?.statusCode ?? x?.status; return err; }

Deno.serve(async (req) => {
  const env = (k: string) => Deno.env.get(k) ?? '';
  if (!env('VAPID_PUBLIC_KEY') || !env('VAPID_PRIVATE_KEY')) return json({ error: 'VAPID keys not configured' }, 500);

  const cronSecret = env('CRON_SECRET');
  const testKey = env('REMINDER_TEST_KEY');
  const isCron = !!cronSecret && req.headers.get('x-cron-secret') === cronSecret;
  const isTest = !isCron && !!testKey && req.headers.get('x-test-key') === testKey;
  if (!isCron && !isTest) return json({ error: 'unauthorized' }, 401); // no secret in the frontend

  webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:ayyam@example.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const now = new Date();
  const sendPush = (item: any) =>
    webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
      JSON.stringify({ title: item.title, body: item.body, tag: item.tag, icon: 'icon-192.png' }), { TTL: CFG.TTL_SECONDS })
      .then(() => undefined, (e) => { throw pushError(e); });

  try {
    if (isTest) return json(await runTest(sb, sendPush));
    const result = await runCron(sb, adhan, sendPush, now);
    if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) await sb.rpc('push_cleanup'); // once a day
    return json(result);
  } catch (e) {
    return json({ error: 'reminders failed', detail: String((e as Error).message || e) }, 500);
  }
});
