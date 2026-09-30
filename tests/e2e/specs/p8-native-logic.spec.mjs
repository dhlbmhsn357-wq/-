import { test, expect } from '@playwright/test';
import { prepare, resetBackend } from '../helpers.mjs';

// P8 exercises the shared JS that the Android back-button + deep-link handlers call. The native delivery
// (appUrlOpen / hardware Back / secure storage / widget+notif plugins) can only be validated on a device;
// here we verify the browser-runnable logic those handlers rely on.
test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

test('auth Back: a sub-screen returns to sign-in; the gate consumes Back (never exits)', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });   // sign-up gate (dismissible:false)
  await expect(page.locator('#authName')).toBeVisible();
  await page.evaluate(() => window.AyyamAuthUI.handleBack());                 // signup → signin
  await expect(page.locator('#authSubmit')).toHaveText(/تسجيل الدخول/);
  await expect(page.locator('#authName')).toHaveCount(0);
  await page.evaluate(() => window.AyyamAuthUI.handleBack());                 // gate base mode → consumed, stays open
  await expect(page.locator('#authView')).toBeVisible();
  await page.locator('#authForgot').click();                                 // → forgot
  await expect(page.locator('#authSubmit')).toHaveText(/إرسال/);
  await page.evaluate(() => window.AyyamAuthUI.handleBack());                 // forgot → signin
  await expect(page.locator('#authSubmit')).toHaveText(/تسجيل الدخول/);
});

test('onboarding Back: steps back through the tour, then exits at the first step', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authEmail').fill('back@t.test');
  await page.locator('#authPass').fill('pass123');
  await page.locator('#authSubmit').click();                                 // sign up → onboarding tour
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });
  await page.locator('#onbNext').click();                                    // → step 2
  await expect(page.locator('.onb-count')).toContainText('٢');
  await page.evaluate(() => window.AyyamOnboarding.back());                   // ← step 1
  await expect(page.locator('.onb-count')).toContainText('١');
  await page.evaluate(() => window.AyyamOnboarding.back());                   // ← exit (skip)
  await expect(page.locator('#onbView')).toBeHidden();
});

test('deep link: setSessionFromUrl establishes a session from recovery tokens and a PKCE code', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  // implicit flow: tokens in the fragment (access_token IS the uid in the mock)
  const recovery = await page.evaluate(async () => {
    const sb = window.supabase.createClient('u', 'k');
    const r = await window.AyyamAccount.setSessionFromUrl(sb, 'ayyam://reset#access_token=uid-1111&refresh_token=rtok&type=recovery');
    const s = await window.AyyamAccount.getSession(sb);
    return { r, uid: window.AyyamAccount.userIdOf(s) };
  });
  expect(recovery.r.ok).toBe(true);
  expect(recovery.r.type).toBe('recovery');
  expect(recovery.uid).toBe('uid-1111');
  // PKCE flow: ?code=...
  const pkce = await page.evaluate(async () => {
    const sb = window.supabase.createClient('u', 'k');
    return window.AyyamAccount.setSessionFromUrl(sb, 'ayyam://auth?code=uid-2222&type=signup');
  });
  expect(pkce.ok).toBe(true);
  // a broken/empty link fails cleanly (no throw), so the handler shows "link expired"
  const bad = await page.evaluate(async () => {
    const sb = window.supabase.createClient('u', 'k');
    return window.AyyamAccount.setSessionFromUrl(sb, 'ayyam://reset');
  });
  expect(bad.ok).toBe(false);
});
