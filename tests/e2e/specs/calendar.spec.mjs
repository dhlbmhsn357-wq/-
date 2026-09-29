import { test, expect } from '@playwright/test';
import { prepare, resetBackend, taskRow, waitSynced } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

test('calendar: leap-year month renders the right cell count and offset, today highlighted', async ({ page }) => {
  await prepare(page, { key: true, now: '2028-02-15T10:00:00' }); // February 2028 = leap (29 days)
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await page.locator('#openCalendar').click();
  await expect(page.locator('#calendarView')).toBeVisible();
  await expect(page.locator('#calTitle')).toContainText('فبراير');
  await expect(page.locator('#calTitle')).toContainText('٢٠٢٨');
  // 29 day cells
  await expect(page.locator('#calGrid .cal-cell:not(.empty)')).toHaveCount(29);
  // leading empty cells == weekday index (Sat-based) of the 1st
  const offset = await page.evaluate(() => globalThis.AyyamTime.DAY_CODES.indexOf(globalThis.AyyamTime.dayCode('2028-02-01')));
  await expect(page.locator('#calGrid .cal-cell.empty')).toHaveCount(offset);
  // today (the 15th) is highlighted, exactly once
  await expect(page.locator('#calGrid .cal-cell.today')).toHaveCount(1);
  await expect(page.locator('#calGrid .cal-cell.today .cal-num')).toHaveText('١٥');
});

test('calendar: month navigation (prev/next) and back-to-today', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-15T10:00:00' });
  await page.goto('/');
  await page.locator('#openCalendar').click();
  await expect(page.locator('#calTitle')).toContainText('سبتمبر');
  await expect(page.locator('#calToday')).toBeHidden();          // already on current month
  await page.locator('#calPrev').click();
  await expect(page.locator('#calTitle')).toContainText('أغسطس');
  await expect(page.locator('#calToday')).toBeVisible();          // now off current month
  await page.locator('#calNext').click();
  await page.locator('#calNext').click();
  await expect(page.locator('#calTitle')).toContainText('أكتوبر');
  await page.locator('#calToday').click();                        // back to today's month
  await expect(page.locator('#calTitle')).toContainText('سبتمبر');
  await expect(page.locator('#calToday')).toBeHidden();
});

test('calendar: year boundary (Dec → Jan)', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-12-10T10:00:00' });
  await page.goto('/');
  await page.locator('#openCalendar').click();
  await expect(page.locator('#calTitle')).toContainText('ديسمبر');
  await page.locator('#calNext').click();
  await expect(page.locator('#calTitle')).toContainText('يناير');
  await expect(page.locator('#calTitle')).toContainText('٢٠٢٧');
});

test('calendar: click today → daily overview shows live progress and completed list', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await page.locator('.task .check').first().click();            // complete one task today
  await waitSynced(page);
  await page.locator('#openCalendar').click();
  await page.locator('#calGrid .cal-cell.today').click();
  await expect(page.locator('#dayOverlay')).toHaveClass(/show/);
  await expect(page.locator('#dayBody')).toContainText('أنجزت'); // completed section present
  await page.locator('#dayClose').click();
  await expect(page.locator('#dayOverlay')).not.toHaveClass(/show/);
});

test('calendar: an unrecorded past day shows the honest "not tracked" message, no misleading missed list', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-28T10:00:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await page.locator('#openCalendar').click();
  // an earlier day of the month with no log → unrecorded (default schedule expects tasks, but none tracked)
  await page.locator('#calGrid .cal-cell:not(.empty):not(.future)').first().click();
  await expect(page.locator('#dayOverlay')).toHaveClass(/show/);
  await expect(page.locator('#dayBody')).toContainText('لم يتم تسجيل');
});

test('calendar: no horizontal overflow at 390px (mobile RTL)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepare(page, { key: true });
  await page.goto('/');
  await page.locator('#openCalendar').click();
  await expect(page.locator('#calGrid')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
});
