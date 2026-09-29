import { test, expect } from '@playwright/test';
import { prepare, resetBackend, taskRow, waitSynced, outage, expectServerContains } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

// Open the add sheet and create a task with the given recurrence chip label.
async function addRoutine(page, title, recLabel, { time } = {}) {
  await page.locator('#fabAdd').click();
  await expect(page.locator('#addOverlay')).toHaveClass(/show/);
  await page.locator('#taskTitle').fill(title);
  await page.locator('#recPick .rec-chip', { hasText: recLabel }).click();
  if (time) { await page.locator('#taskNoTime').uncheck().catch(() => {}); await page.locator('#taskTimeValue').fill(time); }
  await page.locator('#saveAdd').click();
  await expect(page.locator('.task-title', { hasText: title })).toBeVisible();
}

test('daily routine shows today AND the next day', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addRoutine(page, 'وِردي اليومي', 'كل يوم');
  await page.locator('#nextDay').click();
  await expect(page.locator('.task-title', { hasText: 'وِردي اليومي' })).toBeVisible();
});

test('this-week-only appears today but NOT the next day', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addRoutine(page, 'مهمة لمرة واحدة', 'هذا الأسبوع فقط');
  await page.locator('#nextDay').click();
  await expect(page.locator('.task-title', { hasText: 'مهمة لمرة واحدة' })).toHaveCount(0);
});

test('weekly routine shows today but not the next day', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addRoutine(page, 'روتين أسبوعي', 'كل أسبوع');
  await page.locator('#nextDay').click();
  await expect(page.locator('.task-title', { hasText: 'روتين أسبوعي' })).toHaveCount(0);
});

test('structured time picker shows Arabic 12h time', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addRoutine(page, 'مهمة موقوتة', 'كل يوم', { time: '09:00' });
  await expect(taskRow(page, 'مهمة موقوتة').locator('.task-time')).toContainText('٩:٠٠');
});

test('edit recurring: "this and future" scope updates the title', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addRoutine(page, 'قابل للتعديل', 'كل يوم');
  await taskRow(page, 'قابل للتعديل').locator('.task-main').click();
  await page.locator('#taskTitle').fill('عدّلته للمستقبل');
  await page.locator('#saveAdd').click();
  await expect(page.locator('#scopeFuture')).toBeVisible(); // scope chooser appears for a routine
  await page.locator('#scopeFuture').click();
  await expect(page.locator('.task-title', { hasText: 'عدّلته للمستقبل' })).toBeVisible();
});

test('delete recurring: "this and future" removes it', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addRoutine(page, 'قابل للحذف', 'كل يوم');
  await taskRow(page, 'قابل للحذف').locator('.task-del').click();
  await expect(page.locator('#scopeFuture')).toBeVisible();
  await page.locator('#scopeFuture').click();
  await expect(page.locator('.task-title', { hasText: 'قابل للحذف' })).toHaveCount(0);
});

test('offline: create a routine, reconnect, it syncs to the server', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await outage(request, 'all');
  await addRoutine(page, 'روتين بلا اتصال', 'كل يوم'); // added while the backend is unreachable
  await outage(request, '');
  await waitSynced(page);
  await expectServerContains(request, 'روتين بلا اتصال');
});
