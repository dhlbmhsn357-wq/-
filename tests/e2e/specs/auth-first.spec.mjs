import { test, expect } from '@playwright/test';
import { prepare, resetBackend } from '../helpers.mjs';

// SECURITY (incident 2026-10-04): a visitor that is NOT authorised for any data — no account session AND no
// device-key secret — must land on the full-screen ACCOUNT gate (Login / Create account) and must NEVER render
// Today, a task, a routine, or any previous/legacy data, not even for one frame. There is NO guest mode, NO
// local-only mode, NO "continue without account", NO "skip", and NO device-key UI anywhere in the public app.
test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

test('an unauthenticated visitor (no key, no session) sees the account gate and ZERO task/Today data', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  // nothing personal is rendered behind the gate
  await expect(page.locator('.task')).toHaveCount(0);
  await expect(page.locator('.task-title')).toHaveCount(0);
  // the gate offers only Create account / sign-in (+ forgot) — real auth, not a bypass
  await expect(page.locator('#authSubmit')).toBeVisible();
});

test('NO guest / "continue without account" / offline-entry / device-key affordance exists anywhere', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  // the retired escape controls must not exist in the DOM
  await expect(page.locator('#authOffline')).toHaveCount(0);      // "المتابعة بدون حساب الآن"
  await expect(page.locator('#startupOffline')).toHaveCount(0);   // "العمل مؤقتًا بدون اتصال"
  await expect(page.locator('#onbSkip')).toHaveCount(0);          // onboarding skip never appears pre-account
  // no "continue/use without account" wording anywhere on the page
  await expect(page.getByText('بدون حساب', { exact: false })).toHaveCount(0);
  await expect(page.getByText('بدون اتصال', { exact: false })).toHaveCount(0);
  // and no device-key / sync-key entry surface
  await expect(page.getByText('مفتاح المزامنة', { exact: false })).toHaveCount(0);
});

test('offline first-run (no session) cannot enter the app and says sign-in needs a connection', async ({ page }) => {
  // Force the app to believe it is offline before any script runs.
  await page.addInitScript(() => { try { Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); } catch (e) {} });
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.task')).toHaveCount(0);                 // no app entry, no data
  await expect(page.getByText('تحتاج اتصالًا', { exact: false })).toBeVisible({ timeout: 10000 });
});
