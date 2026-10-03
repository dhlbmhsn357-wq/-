import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding } from '../helpers.mjs';

// The auth flows reload the page on session transitions, so these are slow by nature.
test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

// A genuinely new device: no device key, empty server → the premium account gate must appear (never the key).
async function freshGate(page) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
}

test('a new user is taken to the account screen (not the device key) and can create an account', async ({ page }) => {
  await freshGate(page);
  await expect(page.locator('#authName')).toBeVisible();               // gate defaults to sign-up
  await expect(page.locator('#authSubmit')).toHaveText(/إنشاء/);
  await expect(page.locator('#startupState')).toBeHidden();            // the legacy device-key startup is NOT shown
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill('new@t.test');
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  // migration/prep runs, then a controlled reload lands in the (empty) account — the gate is gone
  await expect(page.locator('#authView')).toBeHidden({ timeout: 25000 });
  await skipOnboarding(page);                                          // a new account starts the P5 tour
  // the empty account shows the welcoming empty state (no auto-added worship), and we are signed in
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });
  await page.locator('#bottomNav .bnav-item[data-screen="settings"]').click();
  await expect(page.locator('#acctSignOut')).toBeVisible({ timeout: 10000 });   // signed in
});

test('invalid credentials show a calm Arabic message, never a raw Supabase error', async ({ page }) => {
  await freshGate(page);
  await page.locator('#authSwitch').click();                          // sign-up → sign-in
  await expect(page.locator('#authSubmit')).toHaveText(/تسجيل الدخول/);
  await page.locator('#authEmail').fill('nobody@t.test');
  await page.locator('#authPass').fill('wrongpass');
  await page.locator('#authSubmit').click();
  const msg = page.locator('#authMsg');
  await expect(msg).toContainText('غير صحيحة', { timeout: 10000 });
  await expect(msg).not.toContainText(/invalid/i);
});

test('forgot-password shows a neutral, non-enumerating success message', async ({ page }) => {
  await freshGate(page);
  await page.locator('#authSwitch').click();                          // → sign-in
  await page.locator('#authForgot').click();                          // → forgot
  await expect(page.locator('#authSubmit')).toHaveText(/إرسال/);
  await page.locator('#authEmail').fill('someone@t.test');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authMsg')).toContainText('رابط', { timeout: 10000 });
});

test('the session is restored after a restart (no auth gate on reload)', async ({ page }) => {
  await freshGate(page);
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill('restore@t.test');
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();                          // sign up
  await expect(page.locator('#authView')).toBeHidden({ timeout: 25000 });
  await skipOnboarding(page);
  await page.reload();
  // restored into the account (no auth gate, no tour again — completion is server-side)
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('#authView')).toBeHidden();
  await expect(page.locator('#onbView')).toBeHidden();
  await page.locator('#bottomNav .bnav-item[data-screen="settings"]').click();
  await expect(page.locator('#acctSignOut')).toBeVisible({ timeout: 10000 });   // still signed in
});

test('the account gate can be escaped to continue without an account', async ({ page }) => {
  await freshGate(page);
  await page.locator('#authOffline').click();
  await expect(page.locator('#authView')).toBeHidden();
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 15000 });  // app usable, local-only
});

test('a password-recovery link opens the reset screen and updates the password', async ({ page }) => {
  await freshGate(page);
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill('recover@t.test');
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();                          // sign up
  await expect(page.locator('#authView')).toBeHidden({ timeout: 25000 });
  await skipOnboarding(page);
  // simulate arriving via the recovery link (supabase-js fires PASSWORD_RECOVERY with a short session)
  const sess = await page.evaluate(() => JSON.parse(localStorage.getItem('ayyam_e2e_session_v1')));
  await page.evaluate((s) => window.supabase.__fireRecovery(s), sess);
  await expect(page.locator('#authView')).toBeVisible();
  await expect(page.locator('#authSubmit')).toHaveText(/حفظ/);
  await page.locator('#authPass').fill('newpass456');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authMsg')).toContainText('تم', { timeout: 10000 });
});
