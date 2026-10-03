import { test, expect } from '@playwright/test';
import { prepare, resetBackend, taskRow } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

// Prayer boundaries are computed at Cairo; pin the browser tz to Cairo so the mocked wall-clock lines up.
// Uses the DETERMINISTIC default schedule (Thu 2026-10-01 = fasting-day template) so no flaky period picking.
test.describe('overdue card (متأخرة)', () => {
  test.use({ timezoneId: 'Africa/Cairo' });

  test('shows only ELAPSED-period tasks; the current (isha) period is never overdue; hidden off-today', async ({ page }) => {
    // Cairo 23:30 on 2026-10-01: dhuhr/asr/maghrib have ended; isha (19:58) is the CURRENT period until rollover.
    await prepare(page, { key: true, now: '2026-10-01T23:30:00' });
    await page.goto('/');
    await expect(page.locator('.task').first()).toBeVisible();

    const banner = page.locator('#missingBanner');
    await expect(banner).toBeVisible();
    await expect(banner.locator('.missing-head')).toContainText('متأخرة');
    await expect(banner).toContainText('ورد القرآن');        // dhuhr task → its period ended → overdue
    await expect(banner).not.toContainText('خارطة الثغور');  // isha task → current period → NOT overdue

    // completing an overdue task drops it from the card
    await taskRow(page, 'ورد القرآن / الشغل').locator('.check').click();
    await expect(banner).not.toContainText('ورد القرآن');

    // the card is a TODAY concept — hidden on other days
    await page.locator('#nextDay').click();
    await expect(banner).toBeHidden();
  });

  test('before fajr: nothing overdue → card hidden', async ({ page }) => {
    await prepare(page, { key: true, now: '2026-10-01T02:00:00' }); // pre-dawn — no period has ended
    await page.goto('/');
    await expect(page.locator('.task').first()).toBeVisible();
    await expect(page.locator('#missingBanner')).toBeHidden();
  });
});

test('calendar: month % is labelled "أداء الأيام المسجلة" and today shows a live dot when it has activity', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-10-10T12:00:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // give today some activity so the live class resolves
  await page.locator('.task .check').first().click();
  await page.locator('#bottomNav .bnav-item[data-screen="calendar"]').click();
  await expect(page.locator('#calSummary')).toContainText('أداء الأيام المسجلة'); // renamed from "نسبة الشهر"
  await expect(page.locator('#calGrid .cal-cell.today')).toHaveCount(1);
  await expect(page.locator('#calGrid .cal-cell.today .cal-dot.live')).toHaveCount(1); // live progress dot
});
