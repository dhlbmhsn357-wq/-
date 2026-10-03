import { test, expect } from '@playwright/test';
import { prepare, resetBackend, taskRow, waitSynced } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

// One continuous session proving R1→I1 compose: migration → recurrence add/edit/delete → done →
// historical immutability → calendar → insights, without cross-feature interference.
test('full journey: recurrence + edit/delete scope + calendar + insights compose', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-28T09:00:00' }); // Monday
  await page.goto('/');
  // migration ran once and the app renders the (now routine-backed) schedule
  await expect(page.locator('.task').first()).toBeVisible();

  // add each recurrence type from the day view
  const add = async (title, recLabel) => {
    await page.locator('#fabAdd').click();
    await page.locator('#taskTitle').fill(title);
    await page.locator('#recPick .rec-chip', { hasText: recLabel }).click();
    await page.locator('#saveAdd').click();
    await expect(page.locator('.task-title', { hasText: title })).toBeVisible();
  };
  await add('مرة الأسبوع', 'هذا الأسبوع فقط');
  await add('يومي', 'كل يوم');
  await add('أسبوعي', 'كل أسبوع');

  // edit a routine "this day only" → today changes, next week keeps the original
  await taskRow(page, 'يومي').locator('.task-main').click();
  await page.locator('#taskTitle').fill('يومي معدّل اليوم');
  await page.locator('#saveAdd').click();
  await page.locator('#scopeToday').click();
  await expect(page.locator('.task-title', { hasText: 'يومي معدّل اليوم' })).toBeVisible();

  // complete then uncomplete an occurrence
  const chk = taskRow(page, 'أسبوعي').locator('.check');
  await chk.click(); await expect(chk).toHaveClass(/checked/);
  await chk.click(); await expect(chk).not.toHaveClass(/checked/);

  // historical immutability: a past Monday does NOT show today's new routines
  for (let i = 0; i < 7; i++) await page.locator('#prevDay').click();
  await expect(page.locator('#dayName')).toHaveText('الاثنين');
  await expect(page.locator('.task-title', { hasText: 'يومي' })).toHaveCount(0);
  // back to today
  for (let i = 0; i < 7; i++) await page.locator('#nextDay').click();

  // delete a routine "this and future"
  await taskRow(page, 'أسبوعي').locator('.task-del').click();
  await page.locator('#scopeFuture').click();
  await expect(page.locator('.task-title', { hasText: 'أسبوعي' })).toHaveCount(0);

  // calendar opens on the current month with today highlighted; day overview opens
  await page.locator('#bottomNav .bnav-item[data-screen="calendar"]').click();
  await expect(page.locator('#calTitle')).toContainText('سبتمبر');
  await expect(page.locator('#calGrid .cal-cell.today')).toHaveCount(1);
  await page.locator('#calGrid .cal-cell.today').click();
  await expect(page.locator('#dayOverlay')).toHaveClass(/show/);
  await page.locator('#dayClose').click();
  await page.locator('#closeCalendar').click();

  // insights opens (sparse — only today recorded)
  await page.locator('#bottomNav .bnav-item[data-screen="progress"]').click();
  await expect(page.locator('#reportsView .brand-strong')).toHaveText('تحليل الأداء');
  await expect(page.locator('#insBody')).toContainText('لسه بنكوّن صورتك');
});
