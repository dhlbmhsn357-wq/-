import { test, expect } from '@playwright/test';
import { prepare, resetBackend, addTask, taskRow, waitSynced } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
// The account flow reloads the page several times (auth transitions), so these are slow by nature.
test.describe.configure({ retries: 2, timeout: 90000 });

async function signUp(page, email, password) {
  await page.locator('#openSettings').click();
  await expect(page.locator('#accountBox')).toBeVisible();
  await page.locator('#acctEmail').fill(email);
  await page.locator('#acctPass').fill(password);
  await page.locator('#acctSignUp').click();
}

test('signup migrates the legacy device data into the new account (nothing lost), then account mode syncs', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addTask(page, 'مهمة-قبل-الحساب');       // distinctive legacy data on this device
  await waitSynced(page);                          // it reaches the legacy 'main' row

  await signUp(page, 'owner@t.test', 'pass123');
  // signup → migration (claim 'main' + merge local) → controlled reload into the account DB.
  await expect(page.locator('.task-title', { hasText: 'مهمة-قبل-الحساب' })).toBeVisible({ timeout: 25000 });
  // now in account mode: settings shows signed-in, and an edit syncs via the v2 path
  await page.locator('#openSettings').click();
  await expect(page.locator('#acctSignOut')).toBeVisible();
  await page.locator('#closeSettings').click();
  await addTask(page, 'مهمة-بعد-الحساب');
  await waitSynced(page);
  await expect(taskRow(page, 'مهمة-بعد-الحساب')).toBeVisible();
});

test('sign out returns to the legacy device (data retained, not deleted)', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await signUp(page, 'owner2@t.test', 'pass123');
  await page.locator('#openSettings').click();
  await expect(page.locator('#acctSignOut')).toBeVisible({ timeout: 25000 });
  await page.locator('#acctSignOut').click();
  // sign-out reloads into the legacy device: the schedule is still there (not deleted)
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 25000 });
  // re-open settings → the sign-in form is back (legacy mode)
  await page.locator('#openSettings').click();
  await expect(page.locator('#acctEmail')).toBeVisible();
});

test('two accounts on the same device are isolated: B never sees A private data', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await signUp(page, 'a@t.test', 'passA1');
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 25000 });
  await addTask(page, 'سرّ-حساب-أ');              // A-only data (lives in A's account)
  await waitSynced(page);
  await page.locator('#openSettings').click();
  await expect(page.locator('#acctSignOut')).toBeVisible();
  await page.locator('#acctSignOut').click();
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 25000 }); // reloaded into legacy
  // sign up B on the same device (re-open settings after the reload)
  await signUp(page, 'b@t.test', 'passB1');
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 25000 });
  // B must NOT see A's private task
  await expect(page.locator('.task-title', { hasText: 'سرّ-حساب-أ' })).toHaveCount(0);
});
