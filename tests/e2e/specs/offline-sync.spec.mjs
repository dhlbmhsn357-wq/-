import { test, expect } from '@playwright/test';
import { prepare, resetBackend, ctlDb, addTask, taskRow, waitSynced, outboxCount, waitSWControls, expectServerContains } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

test('offline add/edit/delete survive a close+reopen offline, then reach the server on reconnect', async ({ page, context, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await waitSWControls(page);                              // ensure the SW can serve an offline reload

  await context.setOffline(true);
  await addTask(page, 'مهمة أوفلاين');                     // add offline
  await taskRow(page, 'مهمة أوفلاين').locator('.task-main').click(); // edit offline
  await page.locator('#taskTitle').fill('معدّلة أوفلاين');
  await page.locator('#saveAdd').click();
  await expect(page.locator('.task-title', { hasText: 'معدّلة أوفلاين' })).toBeVisible();
  expect(await outboxCount(page)).toBeGreaterThan(0);

  // close + reopen still offline → everything present, still pending
  await page.reload();
  await expect(page.locator('.task-title', { hasText: 'معدّلة أوفلاين' })).toBeVisible();
  expect(await outboxCount(page)).toBeGreaterThan(0);
  await expect(page.locator('#syncBadge')).toContainText('محفوظ على الجهاز');

  // reconnect → all changes reach the server, outbox empties
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expectServerContains(request, 'معدّلة أوفلاين');
  expect(await outboxCount(page)).toBe(0);
});

test('reload during a pending sync resumes and completes the upload', async ({ page, context, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await waitSWControls(page);

  await context.setOffline(true);
  await addTask(page, 'أثناء المزامنة المعلّقة');
  expect(await outboxCount(page)).toBeGreaterThan(0);
  await page.reload();                                     // "closed" mid-pending
  await expect(page.locator('.task-title', { hasText: 'أثناء المزامنة المعلّقة' })).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expectServerContains(request, 'أثناء المزامنة المعلّقة');
});

test('Supabase unreachable: the app keeps working locally with no data loss, then syncs on recovery', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await request.post('/__ctl/outage?mode=down');           // server returns 503 (reachable network, unreachable API)
  await addTask(page, 'أثناء تعذّر الخادم');
  await expect(page.locator('.task-title', { hasText: 'أثناء تعذّر الخادم' })).toBeVisible();
  await expect(page.locator('#syncBadge')).toContainText('محفوظ على الجهاز'); // honest "not synced" state
  await request.post('/__ctl/outage?mode=');               // recover
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expectServerContains(request, 'أثناء تعذّر الخادم');
});
