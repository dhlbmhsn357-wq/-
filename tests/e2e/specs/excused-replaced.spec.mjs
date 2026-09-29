import { test, expect } from '@playwright/test';
import { prepare, resetBackend, taskRow } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.use({ timezoneId: 'Africa/Cairo' });

// Thu 2026-10-01, 23:30 Cairo: dhuhr/asr/maghrib have ended → their tasks are overdue; isha is current.
// The default fasting-day template has a dhuhr task "ورد القرآن / الشغل" and a maghrib task "فطار".
const openMenu = async (page, title) => {
  await taskRow(page, title).locator('.task-menu').click();
  await expect(page.locator('#taskActionOverlay')).toHaveClass(/show/);
};

test('excuse: mark → calm state, excluded from overdue; undo → back to normal', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-10-01T23:30:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  const banner = page.locator('#missingBanner');
  await expect(banner).toContainText('ورد القرآن');           // dhuhr ended → overdue before excusing

  await openMenu(page, 'ورد القرآن');
  await page.locator('#taskActionList .action-item', { hasText: 'عندي عذر' }).click();
  await expect(page.locator('#excuseOverlay')).toHaveClass(/show/);
  await page.locator('#excuseReasonPick .rec-chip', { hasText: 'سفر' }).click();
  await page.locator('#excuseSave').click();

  const row = taskRow(page, 'ورد القرآن');
  await expect(row).toHaveClass(/excused/);
  await expect(row.locator('.task-sub')).toHaveText('معذور');
  await expect(row.locator('.check')).toHaveCount(0);          // no checkbox on an excused task
  await expect(banner).not.toContainText('ورد القرآن');        // excused → no longer overdue

  await openMenu(page, 'ورد القرآن');
  await page.locator('#taskActionList .action-item', { hasText: 'إلغاء العذر' }).click();
  await expect(taskRow(page, 'ورد القرآن')).not.toHaveClass(/excused/);
});

test('replace (recurring, today only): original hidden, replacement actionable; undo restores original', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-10-01T23:30:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();

  await openMenu(page, 'فطار');
  await page.locator('#taskActionList .action-item', { hasText: 'استبدال المهمة' }).click();
  await expect(page.locator('#addOverlay')).toHaveClass(/show/);
  await page.locator('#taskTitle').fill('تمارين في البيت');
  await page.locator('#saveAdd').click();
  await page.locator('#scopeToday').click();                  // recurring → scope modal → today only

  await expect(page.locator('.task-title', { hasText: 'تمارين في البيت' })).toBeVisible();
  await expect(taskRow(page, 'تمارين في البيت').locator('.task-sub')).toContainText('بدلًا من: فطار');
  await expect(page.locator('.task-title', { hasText: 'فطار' })).toHaveCount(0); // original not shown

  // complete the replacement
  await taskRow(page, 'تمارين في البيت').locator('.check').click();
  await expect(taskRow(page, 'تمارين في البيت')).toHaveClass(/done/);

  // undo the replacement (confirm because it is completed) → original returns
  page.once('dialog', (d) => d.accept());
  await openMenu(page, 'تمارين في البيت');
  await page.locator('#taskActionList .action-item', { hasText: 'إلغاء الاستبدال' }).click();
  await expect(page.locator('.task-title', { hasText: 'فطار' })).toBeVisible();
  await expect(page.locator('.task-title', { hasText: 'تمارين في البيت' })).toHaveCount(0);
});

test('daily overview surfaces excused + replaced sections (not hidden)', async ({ page }) => {
  await prepare(page, { key: true, now: '2026-10-01T23:30:00' });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  // excuse one, replace another
  await openMenu(page, 'ورد القرآن');
  await page.locator('#taskActionList .action-item', { hasText: 'عندي عذر' }).click();
  await page.locator('#excuseSave').click();
  await openMenu(page, 'فطار');
  await page.locator('#taskActionList .action-item', { hasText: 'استبدال المهمة' }).click();
  await page.locator('#taskTitle').fill('تمارين');
  await page.locator('#saveAdd').click();
  await page.locator('#scopeToday').click();
  // open today's overview from the calendar
  await page.locator('#openCalendar').click();
  await page.locator('#calGrid .cal-cell.today').click();
  const body = page.locator('#dayBody');
  await expect(body).toContainText('بعذر');
  await expect(body).toContainText('استُبدلت');
  await expect(body).toContainText('قابلة للتنفيذ'); // honest actionable count line
});
