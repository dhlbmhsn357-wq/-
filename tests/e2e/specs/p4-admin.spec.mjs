import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

// Create a fresh account through the P3 gate (a brand-new device: no key, empty server).
async function signupFresh(page, email, password) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill(password);
  await page.locator('#authSubmit').click();                 // gate defaults to sign-up
  await expect(page.locator('#authView')).toBeHidden({ timeout: 25000 });
  await skipOnboarding(page);                                // dismiss the P5 first-time tour
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 25000 });
}

test('a normal user has NO admin entry and cannot open the dashboard (backend-gated)', async ({ page }) => {
  await signupFresh(page, 'user@t.test', 'pass1234');
  await page.locator('#openSettings').click();
  await expect(page.locator('#acctSignOut')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#openAdmin')).toHaveCount(0);   // no admin entry is ever rendered
  // even forcing the hash does nothing for a non-admin
  await page.evaluate(() => { location.hash = '#admin'; });
  await expect(page.locator('#adminView')).toBeHidden();
});

test('an admin sees the dashboard: overview metrics + a server-paginated, searchable users table', async ({ page, request }) => {
  await signupFresh(page, 'admin@t.test', 'pass1234');
  await request.post('/__ctl/make-admin?email=admin@t.test');  // granted the only legit way (service_role)
  await page.reload();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 25000 });  // onboarding already done → no tour

  await page.locator('#openSettings').click();
  await expect(page.locator('#openAdmin')).toBeVisible({ timeout: 10000 });   // admin-only entry revealed
  await page.locator('#openAdmin').click();
  await expect(page.locator('#adminView')).toBeVisible();

  // overview cards render (aggregates only)
  await expect(page.locator('#admOverview .adm-card').first()).toBeVisible({ timeout: 10000 });
  // users table shows the admin's own identity/presence row (no task content)
  await expect(page.locator('.adm-table')).toBeVisible();
  await expect(page.locator('.adm-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.adm-email')).toContainText('admin@t.test');

  // server-side search filters
  await page.locator('#admSearch').fill('nobody-here');
  await expect(page.locator('td.adm-empty')).toContainText('لا مستخدمين', { timeout: 10000 });
});
