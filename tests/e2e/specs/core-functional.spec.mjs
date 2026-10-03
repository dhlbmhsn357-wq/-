import { test, expect } from '@playwright/test';
import { prepare, resetBackend, ctlDb, addTask, taskRow, waitSynced } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

test('first load WITH a device key seeds the schedule and syncs', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  expect(await page.locator('.task').count()).toBeGreaterThan(0);
  await waitSynced(page);
  const db = await ctlDb(request);
  expect(db.main).not.toBeNull();
  expect(db.main.revision).toBeGreaterThan(0);
});

test('first load WITHOUT a device key shows the account screen — the Device Key concept is fully retired', async ({ page }) => {
  await prepare(page, { key: false });
  await page.goto('/');
  // Public-launch behaviour: a genuinely new device is taken to the premium account gate. The device-key /
  // sync-key concept is GONE from the public UI (only "continue offline" remains as an escape).
  await expect(page.locator('#authView')).toBeVisible();
  await expect(page.locator('#authSubmit')).toBeVisible();
  await expect(page.locator('#authOffline')).toBeVisible();
  await expect(page.locator('#authHaveKey')).toHaveCount(0);
  await expect(page.locator('#authView')).not.toContainText('مفتاح');
  await expect(page.locator('#startupState')).toBeHidden();
  expect(await page.locator('.task').count()).toBe(0); // no default schedule presented as data behind the gate
});

test('add, edit title, edit time, edit period, complete, uncomplete, delete', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();

  await addTask(page, 'مهمة اختبار');
  // edit title + time + period via the edit sheet
  await taskRow(page, 'مهمة اختبار').locator('.task-main').click();
  await page.locator('#taskTitle').fill('مهمة معدّلة');
  await page.locator('#taskNoTime').uncheck().catch(() => {});
  await page.locator('#taskTimeValue').fill('15:30');       // structured time picker (24h in, Arabic 12h out)
  await page.locator('#periodPick .period-chip', { hasText: 'العصر' }).click();
  await page.locator('#saveAdd').click();
  await expect(page.locator('.task-title', { hasText: 'مهمة معدّلة' })).toBeVisible();
  await expect(taskRow(page, 'مهمة معدّلة').locator('.task-time')).toContainText('٣:٣٠');

  // complete → checked; uncomplete → unchecked
  const check = taskRow(page, 'مهمة معدّلة').locator('.check');
  await check.click();
  await expect(check).toHaveClass(/checked/);
  await check.click();
  await expect(check).not.toHaveClass(/checked/);

  // delete
  await taskRow(page, 'مهمة معدّلة').locator('.task-del').click();
  await expect(page.locator('.task-title', { hasText: 'مهمة معدّلة' })).toHaveCount(0);
});

test('navigation: prev/next day, settings, reports, back', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  const day = await page.locator('#dayName').textContent();
  await page.locator('#nextDay').click();
  await expect(page.locator('#dayName')).not.toHaveText(day);
  await page.locator('#prevDay').click();
  await expect(page.locator('#dayName')).toHaveText(day);
  await page.locator('#bottomNav .bnav-item[data-screen="settings"]').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.locator('#closeSettings').click();
  await expect(page.locator('#mainView')).toBeVisible();
  await page.locator('#bottomNav .bnav-item[data-screen="progress"]').click();
  await expect(page.locator('#reportsView')).toBeVisible();
  await page.locator('#closeReports').click();
  await expect(page.locator('#mainView')).toBeVisible();
});

test('editing a routine changes today/future but not a past day (routine management)', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-27T10:00:00' }); // Sunday
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // edit the recurring routine via the Routine screen (now its own tab, moved out of Settings)
  await page.locator('#bottomNav .bnav-item[data-screen="routine"]').click();
  await expect(page.locator('#routineView')).toBeVisible();
  await page.locator('.tpl-day-btn', { hasText: 'الأحد' }).click();
  await page.locator('#tplTasks .tpl-routine-main').first().click();
  await page.locator('#taskTitle').fill('روتين معدّل اليوم');
  await page.locator('#saveAdd').click(); // template context → "this and future" (no scope prompt)
  await page.locator('#bottomNav .bnav-item[data-screen="today"]').click();
  // today (Sunday 27) shows the edited routine
  await expect(page.locator('.task-title', { hasText: 'روتين معدّل اليوم' })).toBeVisible();
  // a PAST Sunday (Sep 20, before migrationDate) keeps the old schedule (not the edit)
  for (let i = 0; i < 7; i++) await page.locator('#prevDay').click();
  await expect(page.locator('#dayName')).toHaveText('الأحد');
  await expect(page.locator('.task-title', { hasText: 'روتين معدّل اليوم' })).toHaveCount(0);
});
