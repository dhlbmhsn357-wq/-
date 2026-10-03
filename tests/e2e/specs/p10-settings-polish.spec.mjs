import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

// Fresh account through the P3 gate, tour skipped, Settings open.
async function toSettings(page, email) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#authView')).toBeHidden({ timeout: 25000 });
  await skipOnboarding(page);
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 25000 });
  await page.locator('#bottomNav .bnav-item[data-screen="settings"]').click();
  await expect(page.locator('#settingsView')).toBeVisible({ timeout: 10000 });
}

test('the Support / diagnostics section is GONE from the public Settings UI (item 2)', async ({ page }) => {
  await toSettings(page, 'polish1@t.test');
  await expect(page.locator('#diagInfo')).toHaveCount(0);
  await expect(page.locator('#copyDiag')).toHaveCount(0);
  await expect(page.locator('#settingsView')).not.toContainText('التشخيص');
  await expect(page.locator('#settingsView')).not.toContainText('نسخ معلومات');
});

test('the Data & sync controls are GONE from the public Settings UI (item 4)', async ({ page }) => {
  await toSettings(page, 'polish2@t.test');
  await expect(page.locator('#exportData')).toHaveCount(0);
  await expect(page.locator('#importData')).toHaveCount(0);
  await expect(page.locator('#resetData')).toHaveCount(0);           // "reset all" is no longer one tap away
  await expect(page.locator('#settingsView')).not.toContainText('البيانات والمزامنة');
  await expect(page.locator('#settingsView')).not.toContainText('إعادة ضبط الكل');
});

test('background customization is GONE from Appearance; a simple theme control remains (item 3)', async ({ page }) => {
  await toSettings(page, 'polish3@t.test');
  await expect(page.locator('#bgToggle')).toHaveCount(0);
  await expect(page.locator('#bgOpacity')).toHaveCount(0);
  await expect(page.locator('#bgBlur')).toHaveCount(0);
  await expect(page.locator('#settingsView')).not.toContainText('صورة الخلفية');
  await expect(page.locator('#settingsView')).not.toContainText('ضبابية الخلفية');
  await expect(page.locator('#themeToggleSettings')).toBeVisible();   // appearance keeps a clean theme switch
});

test('the Account section is the LAST section in Settings (item 6)', async ({ page }) => {
  await toSettings(page, 'polish4@t.test');
  await expect(page.locator('#accountCard')).toBeVisible();
  await expect(page.locator('#accountBox')).toBeVisible();            // name/email/sign-out live here
  await expect(page.locator('#settingsView .set-section').last()).toHaveAttribute('id', 'accountCard');
});

test('a normal user sees NO admin section/entry (item 7 — backend-gated reveal)', async ({ page }) => {
  await toSettings(page, 'polish5@t.test');
  await expect(page.locator('#adminSection')).toBeHidden();
  await expect(page.locator('#openAdmin')).toHaveCount(0);
});

test('the manual update-check feedback element exists in the App section (item 1)', async ({ page }) => {
  await toSettings(page, 'polish6@t.test');
  // the feedback line is present (hidden until a check runs); the row itself is Android-only, so on web it
  // stays hidden — but the message target must exist so checks are never silent on device.
  await expect(page.locator('#updateCheckMsg')).toHaveCount(1);
});
