// Cron/test orchestration for the reminders function — single source of truth shared by index.ts
// (real Supabase + web-push) and the Node integration test (PGlite-backed sb + a fake provider).
import { localParts, locationFrom, tasksForDay, prayerTimes, duePeriods, buildMessage, materialize } from './logic.js';
import { processBatch } from './delivery.js';

export const CFG = {
  WINDOW_MS: 20 * 60 * 1000, TTL_SECONDS: 3600, CONCURRENCY: 6,
  MAX_ATTEMPTS: 5, BACKOFF_BASE: 60, CLAIM_LIMIT: 50, LEASE_SECONDS: 120, TIME_BUDGET_MS: 40000,
};

// Test mode: send ONE test push to active devices without touching any reminder/delivery/prayer state.
export async function runTest(sb, sendPush) {
  const { data: subs } = await sb.from('push_subscriptions').select('id, endpoint, p256dh, auth').is('disabled_at', null);
  const items = (subs ?? []).map((s) => ({ delivery_id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth,
    title: 'أيام', body: 'الإشعارات تعمل ✅ ستصلك تذكيرات مهامك مع كل صلاة.', tag: 'ayyam-test' }));
  let sent = 0, gone = 0;
  await processBatch(items, {
    send: sendPush, markSent: async () => { sent++; }, markFailed: async () => {},
    disable: async (id) => { gone++; await sb.from('push_subscriptions').update({ disabled_at: new Date().toISOString() }).eq('id', id); },
  }, { concurrency: CFG.CONCURRENCY, maxAttempts: 1, backoffBase: CFG.BACKOFF_BASE });
  return { mode: 'test', sent, gone };
}

// Cron mode: enqueue due prayers (skip when no open tasks), then drain the delivery queue with leases.
export async function runCron(sb, adhan, sendPush, now) {
  const { data: row } = await sb.from('ayyam_data').select('data').eq('id', 'main').maybeSingle();
  const data = materialize(row?.data ?? {}); // the row stores the enriched shape → materialize for the reminder logic
  const loc = locationFrom(data);
  const today = localParts(now, loc.tz);
  const times = prayerTimes(adhan, loc, today.y, today.m, today.d);
  const tasks = tasksForDay(data, today.key, today.dayCode);

  const due = duePeriods(times, now, CFG.WINDOW_MS);
  const enqueued = {};
  for (const period of due) {
    const msg = buildMessage(period, tasks); // null → recorded 'skipped', not sent
    const { data: r } = await sb.rpc('push_enqueue', { p_day: today.key, p_period: period, p_title: msg?.title ?? null, p_body: msg?.body ?? null, p_tag: msg?.tag ?? null });
    enqueued[period] = r?.status ?? 'error';
  }

  const totals = { sent: 0, retryable: 0, terminal: 0, gone: 0 };
  const started = Date.now();
  while (Date.now() - started < CFG.TIME_BUDGET_MS) {
    const { data: batch } = await sb.rpc('push_claim', { p_limit: CFG.CLAIM_LIMIT, p_lease_seconds: CFG.LEASE_SECONDS });
    if (!batch || batch.length === 0) break;
    const counts = await processBatch(batch, {
      send: sendPush,
      markSent: (id) => sb.rpc('push_mark_sent', { p_id: id }),
      markFailed: (id, msg, retryable) => sb.rpc('push_mark_failed', { p_id: id, p_error: msg, p_retryable: retryable, p_max_attempts: CFG.MAX_ATTEMPTS, p_base_seconds: CFG.BACKOFF_BASE }),
      disable: (id, msg) => sb.rpc('push_disable_subscription', { p_id: id, p_error: msg }),
    }, { concurrency: CFG.CONCURRENCY, maxAttempts: CFG.MAX_ATTEMPTS, backoffBase: CFG.BACKOFF_BASE });
    for (const k of Object.keys(totals)) totals[k] += counts[k];
  }
  return { day: today.key, due, enqueued, totals };
}
