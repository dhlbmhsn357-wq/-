import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding, taskRow, waitSynced } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

// Sign up a brand-new account (fresh device: no key, empty server). Leaves the onboarding tour showing.
async function signupToTour(page, email) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });   // the P5 tour starts automatically
}

async function advanceToEnd(page) {
  for (let i = 0; i < 8; i++) {
    const n = page.locator('#onbNext');
    if (await n.isVisible().catch(() => false)) await n.click(); else break;
  }
}

test('a new account starts the onboarding tour with a working step counter and prev/next', async ({ page }) => {
  await signupToTour(page, 'onb@t.test');
  await expect(page.locator('.onb-count')).toContainText('٨');       // 8-step tour
  await expect(page.locator('.onb-title')).toContainText('أهلًا بك');
  await page.locator('#onbNext').click();
  await expect(page.locator('.onb-title')).toContainText('صفحة اليوم');
  await page.locator('#onbPrev').click();
  await expect(page.locator('.onb-title')).toContainText('أهلًا بك');  // prev returns to step 1
});

test('skip completes onboarding server-side — it never shows again on restart', async ({ page }) => {
  await signupToTour(page, 'skip@t.test');
  await page.locator('#onbSkip').click();
  await expect(page.locator('#onbView')).toBeHidden();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });   // empty account, nothing auto-added
  await page.reload();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('#onbView')).toBeHidden();                          // completion persisted
});

test('resume: the tour continues from the saved step after a restart', async ({ page }) => {
  await signupToTour(page, 'resume@t.test');
  await page.locator('#onbNext').click();   // → step 2
  await page.locator('#onbNext').click();   // → step 3
  await expect(page.locator('.onb-count')).toContainText('٣');
  await page.waitForTimeout(900);            // let the fire-and-forget progress RPC persist server-side
  await page.reload();
  // resumes mid-tour (not back at step 1, not gone)
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('.onb-count')).not.toContainText('١ /');
  await skipOnboarding(page);
});

test('finishing offers the optional starter, and ONLY ticked suggestions are added', async ({ page }) => {
  await signupToTour(page, 'starter@t.test');
  await advanceToEnd(page);
  // the optional starter appears after a genuine finish
  await expect(page.locator('.starter-card')).toBeVisible({ timeout: 10000 });
  // nothing is added until the user ticks something (apply disabled)
  await expect(page.locator('#starterApply')).toBeDisabled();
  await page.locator('.starter-item input').nth(0).check();   // ركعتا الفجر
  await page.locator('.starter-item input').nth(1).check();   // أذكار الصباح
  await page.locator('#starterApply').click();
  await expect(page.locator('#onbView')).toBeHidden();
  await expect(taskRow(page, 'ركعتا الفجر')).toBeVisible({ timeout: 10000 });
  await expect(taskRow(page, 'أذكار الصباح')).toBeVisible();
});

test('starter skip adds NOTHING (no worship auto-added)', async ({ page }) => {
  await signupToTour(page, 'nostart@t.test');
  await advanceToEnd(page);
  await expect(page.locator('.starter-card')).toBeVisible({ timeout: 10000 });
  await page.locator('#starterSkip').click();
  await expect(page.locator('#onbView')).toBeHidden();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });   // still empty — nothing added
  expect(await page.locator('.task').count()).toBe(0);
});

test('the tour can be replayed from Settings', async ({ page }) => {
  await signupToTour(page, 'replay@t.test');
  await skipOnboarding(page);
  await page.locator('#openSettings').click();
  await expect(page.locator('#replayOnb')).toBeVisible({ timeout: 10000 });
  await page.locator('#replayOnb').click();
  await expect(page.locator('#onbView')).toBeVisible();
  await expect(page.locator('.onb-title')).toContainText('أهلًا بك');
});

test('the Today empty state opens the add sheet', async ({ page }) => {
  await signupToTour(page, 'empty@t.test');
  await skipOnboarding(page);
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });
  await page.locator('#emptyAddTask').click();
  await expect(page.locator('#taskTitle')).toBeVisible();
});
