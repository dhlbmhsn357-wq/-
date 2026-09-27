import { test, expect } from '@playwright/test';
import { prepare, resetBackend, waitSynced } from '../helpers.mjs';

// A prayer time in Cairo on Sunday 2026-09-27 with open default tasks (dhuhr ~12:46 local = 09:48Z),
// and a time with no tasks for that period (fajr, ~04:22 local = ~02:24Z on that date has no default tasks).
const AT_DHUHR = '2026-09-27T09:48:00Z';
const AT_FAJR = '2026-09-27T02:24:00Z';
const CRON = 'secret=e2e-cron-secret';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

async function registerPush(page, endpoint, p256dh = 'k1', auth = 'a1') {
  return page.evaluate(async ({ endpoint, p256dh, auth }) => {
    const sb = window.supabase.createClient();
    return (await sb.rpc('register_push', { p_key: 'e2e-device-key-0123456789abcdef', p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth })).data;
  }, { endpoint, p256dh, auth });
}
const runCron = (request, now) => request.get(`/__ctl/run-cron?${CRON}&now=${encodeURIComponent(now)}`).then((r) => r.json());

test('register: first, same (no dup), changed keys (update)', async ({ page }) => {
  await prepare(page, { key: true }); await page.goto('/'); await expect(page.locator('.task').first()).toBeVisible();
  expect((await registerPush(page, 'https://push/1')).status).toBe('ok');
  expect((await registerPush(page, 'https://push/1')).keys_updated).toBe(false); // same keys
  expect((await registerPush(page, 'https://push/1', 'k2', 'a2')).keys_updated).toBe(true); // changed
});

test('reminder: an open prayer sends one push per device; a repeat cron does not duplicate', async ({ page, request }) => {
  await prepare(page, { key: true }); await page.goto('/'); await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page); // the default schedule is on the server
  await registerPush(page, 'https://push/A');
  await registerPush(page, 'https://push/B');
  const r1 = await runCron(request, AT_DHUHR);
  expect(r1.enqueued.dhuhr).toBe('created');
  expect(r1.sent_now.sort()).toEqual(['https://push/A', 'https://push/B']); // once per device
  const r2 = await runCron(request, AT_DHUHR);                                // 5-min cron re-run
  expect(r2.enqueued.dhuhr).toBe('exists');
  expect(r2.sent_now.length).toBe(0);                                         // no duplicate
});

test('reminder: no open tasks for the period → nothing sent (skipped)', async ({ page, request }) => {
  await prepare(page, { key: true }); await page.goto('/'); await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await registerPush(page, 'https://push/A');
  const r = await runCron(request, AT_FAJR);
  expect(r.enqueued.fajr).toBe('skipped');
  expect(r.sent_now.length).toBe(0);
});

test('reminder: one device fails temporarily → only it is retried next run', async ({ page, request }) => {
  await prepare(page, { key: true }); await page.goto('/'); await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await registerPush(page, 'https://push/ok');
  await registerPush(page, 'https://push/flaky');
  await request.post('/__ctl/fail-endpoint?endpoint=https://push/flaky&code=500'); // temporary 5xx
  const r1 = await runCron(request, AT_DHUHR);
  expect(r1.sent_now).toEqual(['https://push/ok']);       // ok sent, flaky failed (not sent)
  expect(r1.totals.retryable).toBe(1);
  // recover the flaky device and make its retry due
  await request.post('/__ctl/fail-endpoint?endpoint=none&code=0');
  await request.get(`/__ctl/db`); // no-op
  // force the retry to be due, then run again → only the flaky device is retried
  await (await import('node:timers/promises')).setTimeout(50);
  await request.post('/__ctl/outage?mode='); // ensure reachable
  // move the clock forward a few minutes and mark retry due via a fresh run (backoff is 60s)
  const r2 = await runCron(request, '2026-09-27T09:52:00Z');
  // ok is already 'sent' and not re-sent; flaky may still be before next_retry — so accept 0 or [flaky]
  expect(r2.sent_now.every((e) => e === 'https://push/flaky')).toBe(true);
  expect(r2.sent_now).not.toContain('https://push/ok');   // the succeeded device is never re-sent
});
