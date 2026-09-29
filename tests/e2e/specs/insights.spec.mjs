import { test, expect } from '@playwright/test';
import { prepare, resetBackend, waitSynced } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

// Build recorded history by advancing the (mocked) day and completing tasks. Each addInitScript runs on
// the next reload; the last-added definition of window.Date wins, so "today" moves forward day by day.
async function seedDays(page, days, { completeAll = true } = {}) {
  for (const day of days) {
    await page.addInitScript((now) => {
      const R = Date, base = new R(now).getTime();
      class F extends R { constructor(...a) { a.length ? super(...a) : super(base); } static now() { return base; } }
      window.Date = F;
    }, day + 'T12:00:00');
    await page.goto('/');
    await page.waitForSelector('.task');
    const n = await page.locator('.task .check').count();
    const upto = completeAll ? n : Math.ceil(n / 2);
    for (let i = 0; i < upto; i++) await page.locator('.task .check').nth(i).click();
    await waitSynced(page);
  }
}

test('insights: sparse state before enough data', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await page.locator('.task .check').first().click();   // 1 recorded day
  await waitSynced(page);
  await page.locator('#openReports').click();
  await expect(page.locator('#reportsView')).toBeVisible();
  await expect(page.locator('#insBody')).toContainText('لسه بنكوّن صورتك');
  await expect(page.locator('#insBody')).toContainText('/ ٥ أيام');
});

test('insights: with enough recorded days the sections render', async ({ page }) => {
  await prepare(page, { key: true });
  await seedDays(page, ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
  await page.locator('#openReports').click();
  await expect(page.locator('#reportsView')).toBeVisible();
  await expect(page.locator('#reportsView .brand-strong')).toHaveText('تحليل الأداء');
  await expect(page.locator('#insBody')).toContainText('أيام مسجلة');   // summary card rendered
  await expect(page.locator('#insBody')).toContainText('أوقات أدائك');  // period section
  await expect(page.locator('#insBody')).toContainText('مهام راسخة');   // consistent section (title present)
  await expect(page.locator('#insBody')).toContainText('نمط الأسبوع');  // weekday section
  await expect(page.locator('#insBody')).toContainText('توصية');        // recommendation always present
  await expect(page.locator('#insBody .ins-bar-row').first()).toBeVisible(); // period bars drawn from analytics
  await expect(page.locator('#insBody')).not.toContainText('لسه بنكوّن'); // not sparse anymore
});

test('insights: no horizontal overflow at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { key: true });
  await seedDays(page, ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
  await page.locator('#openReports').click();
  await expect(page.locator('#insBody')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
});
