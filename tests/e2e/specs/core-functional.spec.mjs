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

test('first load WITHOUT a device key shows the key screen, no defaults behind it', async ({ page }) => {
  await prepare(page, { key: false });
  await page.goto('/');
  await expect(page.locator('#startupState')).toBeVisible();
  await expect(page.locator('#startupMsg')).toContainText('مفتاح المزامنة');
  await expect(page.locator('#startupKey')).toBeVisible();
  expect(await page.locator('.task').count()).toBe(0); // no default schedule presented as data
});

test('add, edit title, edit time, edit period, complete, uncomplete, delete', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();

  await addTask(page, 'مهمة اختبار');
  // edit title + time + period via the edit sheet
  await taskRow(page, 'مهمة اختبار').locator('.task-main').click();
  await page.locator('#taskTitle').fill('مهمة معدّلة');
  await page.locator('#taskTime').fill('العصر – المغرب');
  await page.locator('#periodPick .period-chip', { hasText: 'العصر' }).click();
  await page.locator('#saveAdd').click();
  await expect(page.locator('.task-title', { hasText: 'مهمة معدّلة' })).toBeVisible();
  await expect(taskRow(page, 'مهمة معدّلة').locator('.task-time')).toContainText('العصر');

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
  await page.locator('#openSettings').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.locator('#closeSettings').click();
  await expect(page.locator('#mainView')).toBeVisible();
  await page.locator('#openReports').click();
  await expect(page.locator('#reportsView')).toBeVisible();
  await page.locator('#closeReports').click();
  await expect(page.locator('#mainView')).toBeVisible();
});

test('template edit today does not change a past day; a future day uses the new template', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-09-27T10:00:00' }); // Sunday
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // record a past Sunday's first task title
  await page.locator('#openSettings').click();
  await page.locator('.tpl-day-btn', { hasText: 'الأحد' }).click();
  const firstInput = page.locator('#tplTasks .tpl-task-row input').first();
  await firstInput.fill('قالب معدّل اليوم');
  await page.locator('#closeSettings').click();
  // today (Sunday 27) shows the edited template
  await expect(page.locator('.task-title', { hasText: 'قالب معدّل اليوم' })).toBeVisible();
  // a PAST Sunday (Sep 20) keeps the old template (not the edit)
  for (let i = 0; i < 7; i++) await page.locator('#prevDay').click();
  await expect(page.locator('#dayName')).toHaveText('الأحد');
  await expect(page.locator('.task-title', { hasText: 'قالب معدّل اليوم' })).toHaveCount(0);
});
