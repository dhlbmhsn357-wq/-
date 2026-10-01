import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

test('the device-key / sync-key concept is GONE from the public UI (gate + settings)', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  // the gate offers "continue offline" but NEVER a sync-key option
  await expect(page.locator('#authOffline')).toBeVisible();
  await expect(page.locator('#authHaveKey')).toHaveCount(0);
  await expect(page.locator('#authView')).not.toContainText('مفتاح');
  // continue offline → settings has NO sync-key entry
  await page.locator('#authOffline').click();
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 15000 });
  await page.locator('#openSettings').click();
  await expect(page.locator('#enterKeyBtn')).toHaveCount(0);
  await expect(page.locator('#syncKeyCard')).toHaveCount(0);
  await expect(page.locator('#settingsView')).not.toContainText('مفتاح المزامنة');
});

test('signup requires a name (and a password of at least 6 chars)', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authName')).toBeVisible({ timeout: 15000 });   // signup gate
  // no name → blocked
  await page.locator('#authEmail').fill('noname@t.test');
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authMsg')).toContainText('اسمك');
  // name + short password → blocked on the password
  await page.locator('#authName').fill('سلمى');
  await page.locator('#authPass').fill('short');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authMsg')).toContainText('٦ أحرف');
  // valid → proceeds into the account (name shown in the greeting)
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authView')).toBeHidden({ timeout: 25000 });
  await skipOnboarding(page);
  await expect(page.locator('.hero .quote')).toContainText('سلمى');           // personalised greeting
  await page.locator('#openSettings').click();
  await expect(page.locator('#accountBox')).toContainText('سلمى');            // name in the account card
});

async function enterPin(page, pin) {
  for (const d of String(pin).split('')) await page.locator(`.pin-key[data-k="${d}"]`).click();
}

test('optional local PIN: set it, then it locks the app on restart and unlocks with the code', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // enable the PIN from Settings → privacy (click the visible toggle slider; the label toggles the checkbox)
  await page.locator('#openSettings').click();
  await page.locator('#pinCard .toggle-slider').click();
  await expect(page.locator('#pinView')).toBeVisible({ timeout: 10000 });
  await enterPin(page, '1234');                 // choose
  await expect(page.locator('.pin-title')).toContainText('أكّد');
  await enterPin(page, '1234');                 // confirm
  await expect(page.locator('#pinView')).toBeHidden();
  // simulate a real app restart (process death clears the per-session "unlocked" flag; a mere reload keeps it)
  await page.evaluate(() => { try { sessionStorage.clear(); } catch (e) {} });
  await page.reload();
  await expect(page.locator('#pinView')).toBeVisible({ timeout: 15000 });
  // wrong code → error, still locked
  await enterPin(page, '0000');
  await expect(page.locator('#pinMsg')).toContainText('غير صحيح');
  await expect(page.locator('#pinView')).toBeVisible();
  // correct code → unlocks
  await enterPin(page, '1234');
  await expect(page.locator('#pinView')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('.task').first()).toBeVisible();
});
