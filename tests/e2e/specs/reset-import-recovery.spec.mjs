import { test, expect } from '@playwright/test';
import { prepare, resetBackend, ctlDb, addTask, taskRow, waitSynced, expectServerContains, expectSnapshot } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

test('export produces a backup; import restores it and takes a snapshot first', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addTask(page, 'مهمة قبل التصدير');
  await waitSynced(page);

  // export → capture the downloaded backup JSON
  await page.locator('#openSettings').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportData').click()]);
  const stream = await download.createReadStream();
  let backup = ''; for await (const chunk of stream) backup += chunk;
  expect(backup).toContain('مهمة قبل التصدير');
  expect(backup).toContain('exportedAt');

  // change data, then import the old backup (confirm dialog auto-accepted)
  await page.locator('#closeSettings').click();
  await addTask(page, 'مهمة بعد التصدير');
  await waitSynced(page);
  page.on('dialog', (d) => d.accept());
  await page.locator('#openSettings').click();
  await page.locator('#importFile').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await page.waitForTimeout(500);
  await page.locator('#closeSettings').click();
  await expect(page.locator('.task-title', { hasText: 'مهمة قبل التصدير' })).toBeVisible();

  // a snapshot of the pre-import state exists on the server (before:import), and epoch advanced
  await expectServerContains(request, 'مهمة قبل التصدير');
  const db = await expectSnapshot(request, 'before:import');
  expect(db.main.epoch).toBeGreaterThan(0);
});

test('reset takes a snapshot before wiping; a stale device does not bring the old data back', async ({ page, browser, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addTask(page, 'بيانات مهمة');
  await waitSynced(page);

  // second device, then A goes offline holding the data
  const ctxB = await browser.newContext(); const B = await ctxB.newPage();
  await prepare(B, { key: true }); await B.goto('/'); await expect(B.locator('.task').first()).toBeVisible(); await waitSynced(B);
  await page.context().setOffline(true);

  // B resets everything
  B.on('dialog', (d) => d.accept());
  await B.locator('#openSettings').click();
  await B.locator('#resetData').click();
  await waitSynced(B);
  const db1 = await expectSnapshot(request, 'before:reset');   // pre-reset snapshot exists (recoverable)
  expect(db1.main.epoch).toBeGreaterThan(0);

  // A returns → must adopt the reset (new epoch), not restore its old data
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.task-title', { hasText: 'بيانات مهمة' })).toHaveCount(0, { timeout: 20000 });
  await ctxB.close();
});
