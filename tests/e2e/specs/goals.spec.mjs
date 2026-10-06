import { test, expect } from '@playwright/test';
import { prepare, resetBackend, waitSynced } from '../helpers.mjs';

// P1-C — Goals UI (flag-gated). Create → update progress → complete → edit → archive → delete, plus a
// milestones goal and reload-persistence. Entered in legacy device-key mode (simplest harness); the UI is
// identical in account mode. The flag is turned on via localStorage before the app boots.
test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

async function openGoals(page) {
  await prepare(page, { key: true });
  await page.addInitScript(() => { try { localStorage.setItem('ayyam_ff_goals', '1'); } catch (e) {} });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#navGoals')).toBeVisible();
  await page.locator('#navGoals').click();
  await expect(page.locator('#goalsView')).toBeVisible();
}

async function createGoal(page, { name, period = null, measure = null, target = null }) {
  await page.locator('#goalNewBtn, .goals-empty .btn').first().click();
  await expect(page.locator('#goalSheetOverlay.show')).toBeVisible();
  await page.locator('#goalName').fill(name);
  if (period) await page.locator('.goal-seg-period .goal-seg-chip', { hasText: period }).click();
  if (measure) await page.locator('.goal-seg-measure .goal-seg-chip', { hasText: measure }).click();
  if (target != null) await page.locator('#goalTarget').fill(String(target));
  await page.locator('#goalSave').click();
  await expect(page.locator('#goalSheetOverlay.show')).toBeHidden();
}

test('empty state → create a weekly count goal → card shows 0% and the title', async ({ page }) => {
  await openGoals(page);
  await expect(page.locator('.goals-empty')).toBeVisible();
  await createGoal(page, { name: 'ختم جزء هذا الأسبوع', period: 'هذا الأسبوع', measure: 'عدد مرات', target: 12 });
  const card = page.locator('.goal-card', { hasText: 'ختم جزء هذا الأسبوع' });
  await expect(card).toBeVisible();
  await expect(card.locator('.goal-pct')).toHaveText('0%');
  await expect(card.locator('.goal-ct')).toContainText('0 / 12');
});

test('update progress from the detail sheet → 6/12 = 50%', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف العدّ', measure: 'عدد مرات', target: 12 });
  await page.locator('.goal-card', { hasText: 'هدف العدّ' }).click();
  await expect(page.locator('#goalDetailOverlay.show')).toBeVisible();
  await page.locator('#goalProgInput').fill('6');
  await page.locator('.goal-progress-row .btn.primary').click();
  await expect(page.locator('.goal-stat-v').first()).toHaveText('50%');
  await page.locator('#goalDetailOverlay .btn.ghost', { hasText: 'إغلاق' }).click();
  await expect(page.locator('.goal-card', { hasText: 'هدف العدّ' }).locator('.goal-pct')).toHaveText('50%');
});

test('complete → badge becomes مكتمل; edit changes the title', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف الإكمال', measure: 'عدد مرات', target: 5 });
  await page.locator('.goal-card', { hasText: 'هدف الإكمال' }).click();
  await page.locator('.goal-act', { hasText: 'تحديد كمكتمل' }).click();
  await expect(page.locator('#goalDetailOverlay .goal-badge', { hasText: 'مكتمل' })).toBeVisible();
  // edit the title
  await page.locator('.goal-act', { hasText: 'تعديل' }).click();
  await expect(page.locator('#goalSheetOverlay.show')).toBeVisible();
  await page.locator('#goalName').fill('هدف الإكمال (معدّل)');
  await page.locator('#goalSave').click();
  await expect(page.locator('.goal-card', { hasText: 'هدف الإكمال (معدّل)' })).toBeVisible();
});

test('archive removes it from the list; delete (confirmed) removes it too', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف الأرشفة', measure: 'عدد مرات', target: 3 });
  await createGoal(page, { name: 'هدف الحذف', measure: 'عدد مرات', target: 3 });

  await page.locator('.goal-card', { hasText: 'هدف الأرشفة' }).click();
  await page.locator('.goal-act', { hasText: 'أرشفة' }).click();
  await expect(page.locator('.goal-card', { hasText: 'هدف الأرشفة' })).toHaveCount(0);

  page.on('dialog', (d) => d.accept()); // confirm the delete
  await page.locator('.goal-card', { hasText: 'هدف الحذف' }).click();
  await page.locator('.goal-act.danger', { hasText: 'حذف' }).click();
  await expect(page.locator('.goal-card', { hasText: 'هدف الحذف' })).toHaveCount(0);
});

test('a goal survives a reload (persisted + synced)', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف يبقى', measure: 'عدد مرات', target: 10 });
  await waitSynced(page);
  await page.reload();
  await expect(page.locator('.task').first()).toBeVisible({ timeout: 15000 });
  await page.locator('#navGoals').click();
  await expect(page.locator('.goal-card', { hasText: 'هدف يبقى' })).toBeVisible();
});

test('milestones goal: add two milestones → checking one shows 50%', async ({ page }) => {
  await openGoals(page);
  await page.locator('#goalNewBtn, .goals-empty .btn').first().click();
  await page.locator('#goalName').fill('مشروع بمراحل');
  await page.locator('.goal-seg-measure .goal-seg-chip', { hasText: 'مراحل' }).click();
  await expect(page.locator('#goalMsField')).toBeVisible();
  const inputs = page.locator('#goalMsList .goal-ms-input');
  await page.locator('.goal-ms-add').click();
  await inputs.nth(0).fill('التحضير');
  await page.locator('.goal-ms-add').click();
  await inputs.nth(1).fill('التنفيذ');
  await page.locator('#goalSave').click();
  await page.locator('.goal-card', { hasText: 'مشروع بمراحل' }).click();
  await page.locator('.goal-ms-view-row', { hasText: 'التحضير' }).locator('input[type=checkbox]').check();
  await expect(page.locator('.goal-stat-v').first()).toHaveText('50%');
});
