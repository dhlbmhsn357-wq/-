import { test, expect } from '@playwright/test';
import { prepare, resetBackend, taskRow, waitSynced, outage, expectServerContains } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

async function addWithTime(page, title, hhmm) {
  await page.locator('#fabAdd').click();
  await page.locator('#taskTitle').fill(title);
  await page.locator('#taskNoTime').uncheck().catch(() => {});
  await page.locator('#taskTimeValue').fill(hhmm);
  await page.locator('#saveAdd').click();
  await expect(page.locator('.task-title', { hasText: title })).toBeVisible();
}

test('add: native time input (no text keyboard), stored HH:MM, shown Arabic 12h across boundaries', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await page.locator('#fabAdd').click();
  await expect(page.locator('#taskTimeValue')).toHaveAttribute('type', 'time'); // native picker, not text
  await page.locator('#cancelAdd').click();
  const cases = [['t00', '00:00', '١٢:٠٠ ص'], ['t06', '06:00', '٦:٠٠ ص'], ['t12', '12:00', '١٢:٠٠ م'], ['t1530', '15:30', '٣:٣٠ م'], ['t2345', '23:45', '١١:٤٥ م']];
  for (const [id, hhmm, disp] of cases) {
    await addWithTime(page, id, hhmm);
    await expect(taskRow(page, id).locator('.task-time')).toHaveText(disp);
  }
});

test('edit: picker opens on the current value; the new time reflects on the day and persists', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addWithTime(page, 'موعد', '15:30');
  await taskRow(page, 'موعد').locator('.task-main').click();
  await expect(page.locator('#taskTimeValue')).toHaveValue('15:30');   // opens on the task's current time
  await page.locator('#taskTimeValue').fill('06:00');
  await page.locator('#saveAdd').click();
  await expect(taskRow(page, 'موعد').locator('.task-time')).toHaveText('٦:٠٠ ص');
  await waitSynced(page);
  await page.reload();
  await expect(taskRow(page, 'موعد').locator('.task-time')).toHaveText('٦:٠٠ ص'); // survives reload/sync
});

test('clear: "بدون وقت محدد" removes the time with no stale value left', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addWithTime(page, 'بلا وقت', '06:00');
  await expect(taskRow(page, 'بلا وقت').locator('.task-time')).toBeVisible();
  await taskRow(page, 'بلا وقت').locator('.task-main').click();
  await page.locator('#taskNoTime').check();
  await page.locator('#saveAdd').click();
  await expect(taskRow(page, 'بلا وقت').locator('.task-time')).toHaveCount(0);      // no time shown
  await taskRow(page, 'بلا وقت').locator('.task-main').click();
  await expect(page.locator('#taskNoTime')).toBeChecked();                          // reopens as no-time
  await expect(page.locator('#taskTimeValue')).toHaveValue('');                     // no stale value
});

test('edit a recurring routine time "this and future" reflects on the day; offline then syncs', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // a daily routine with a time
  await page.locator('#fabAdd').click();
  await page.locator('#taskTitle').fill('روتين موقوت');
  await page.locator('#recPick .rec-chip', { hasText: 'كل يوم' }).click();
  await page.locator('#taskNoTime').uncheck().catch(() => {});
  await page.locator('#taskTimeValue').fill('12:00');
  await page.locator('#saveAdd').click();
  await expect(taskRow(page, 'روتين موقوت').locator('.task-time')).toHaveText('١٢:٠٠ م');
  await waitSynced(page);
  // edit the time offline, "this and future"
  await outage(request, 'all');
  await taskRow(page, 'روتين موقوت').locator('.task-main').click();
  await page.locator('#taskTimeValue').fill('23:45');
  await page.locator('#saveAdd').click();
  await page.locator('#scopeFuture').click();
  await expect(taskRow(page, 'روتين موقوت').locator('.task-time')).toHaveText('١١:٤٥ م');
  await outage(request, '');
  await waitSynced(page);
  await expectServerContains(request, 'روتين موقوت'); // change reached the server after reconnect
});
