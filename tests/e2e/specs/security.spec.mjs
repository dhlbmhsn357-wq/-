import { test, expect } from '@playwright/test';
import { prepare, resetBackend } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

test('the browser cannot read or write push tables directly (only RPCs are allowed)', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // direct table access via the client goes to /rest which the server denies
  const res = await page.evaluate(async () => {
    const sb = window.supabase.createClient();
    const sel = await sb.from('push_subscriptions').select('*');
    const ins = await sb.from('push_subscriptions').insert({ endpoint: 'x' });
    return { selErr: !!sel.error, insErr: !!ins.error };
  });
  expect(res.selErr).toBe(true);
  expect(res.insErr).toBe(true);
});

test('a wrong device key is unauthorized (not treated as offline, no write)', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  const r = await page.evaluate(async () => {
    const sb = window.supabase.createClient();
    return (await sb.rpc('ayyam_commit', { p_key: 'wrong-key-wrong-key-wrong', p_expected_revision: 0,
      p_data: { v: 2, epoch: 0, reg: {}, tomb: {} }, p_op_id: '99999999-9999-4999-8999-999999999999', p_reason: 'sync' })).data;
  });
  expect(r.status).toBe('unauthorized');
});

test('the reminder endpoint refuses a request without the cron secret', async ({ request }) => {
  const noSecret = await request.get('/__ctl/run-cron');            // no secret
  expect(noSecret.status()).toBe(401);
  const wrong = await request.get('/__ctl/run-cron?secret=nope');
  expect(wrong.status()).toBe(401);
  const ok = await request.get('/__ctl/run-cron?secret=e2e-cron-secret');
  expect(ok.status()).toBe(200);
});

test('internal tables (snapshots/ops) are not reachable from the browser', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  const res = await page.evaluate(async () => {
    const sb = window.supabase.createClient();
    const a = await sb.from('ayyam_snapshots').select('*');
    const b = await sb.from('ayyam_ops').select('*');
    return { snapErr: !!a.error, opsErr: !!b.error };
  });
  expect(res.snapErr).toBe(true);
  expect(res.opsErr).toBe(true);
});
