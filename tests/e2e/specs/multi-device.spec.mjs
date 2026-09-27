import { test, expect } from '@playwright/test';
import { prepare, resetBackend, addTask, taskRow, waitSynced, expectServerContains, waitServer, serverDoneVals } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

// Open a second, independent device (context) sharing the same backend.
async function openDevice(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  return { ctx, page };
}

test('two devices add different tasks; both survive on the server', async ({ page, browser, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);

  const B = await openDevice(browser);
  await addTask(page, 'من الجهاز أ');
  await addTask(B.page, 'من الجهاز ب');
  await expectServerContains(request, 'من الجهاز أ');
  await expectServerContains(request, 'من الجهاز ب');
  // and each device eventually SEES both (pull on focus)
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(B.page.locator('.task-title', { hasText: 'من الجهاز أ' })).toBeVisible({ timeout: 20000 });
  await B.ctx.close();
});

test('delete on one device is not revived by a stale device (tombstone wins)', async ({ page, browser, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addTask(page, 'هدف مشترك');
  await expectServerContains(request, 'هدف مشترك');          // A's task is on the server before B opens

  const B = await openDevice(browser);                       // B pulls the shared task
  await expect(B.page.locator('.task-title', { hasText: 'هدف مشترك' })).toBeVisible();

  // A goes offline (stale), B deletes the task and syncs
  await page.context().setOffline(true);
  await taskRow(B.page, 'هدف مشترك').locator('.task-del').click();
  await expect(B.page.locator('.task-title', { hasText: 'هدف مشترك' })).toHaveCount(0);
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitServer(request, (db) => Object.keys((db.main.data.tomb) || {}).length > 0);

  // A returns — it still holds the task locally, but must NOT resurrect it after syncing
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.task-title', { hasText: 'هدف مشترك' })).toHaveCount(0, { timeout: 20000 });
  await B.ctx.close();
});

test('done on one device, undone on another: the later action wins deterministically', async ({ page, browser, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addTask(page, 'مهمة الإكمال');
  const check = taskRow(page, 'مهمة الإكمال').locator('.check');
  await check.click();                                       // A marks done
  await expect(check).toHaveClass(/checked/);
  await waitServer(request, (db) => JSON.stringify(db.main && db.main.data || {}).includes('مهمة الإكمال') && serverDoneVals(db).includes(true));

  const B = await openDevice(browser);
  await expect(taskRow(B.page, 'مهمة الإكمال').locator('.check')).toHaveClass(/checked/); // B sees done
  await taskRow(B.page, 'مهمة الإكمال').locator('.check').click(); // B undoes (later)
  await waitServer(request, (db) => serverDoneVals(db).every((v) => v === false) && serverDoneVals(db).length >= 0 && !serverDoneVals(db).includes(true));

  // A pulls → reflects B's later "undone"
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(taskRow(page, 'مهمة الإكمال').locator('.check')).not.toHaveClass(/checked/, { timeout: 20000 });
  await B.ctx.close();
});
