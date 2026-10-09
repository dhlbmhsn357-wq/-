import { test, expect } from '@playwright/test';
import { prepare, resetBackend } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

const item = (page, screen) => page.locator(`#bottomNav .bnav-item[data-screen="${screen}"]`);

async function toToday(page) {
  await prepare(page, { key: true });   // device key → first load seeds the schedule, lands on Today (no gate)
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
}

test('the bottom nav shows on Today with exactly 5 items in the right order', async ({ page }) => {
  await toToday(page);
  await expect(page.locator('#bottomNav')).toBeVisible();
  // VISIBLE items only: the Goals nav item exists in the DOM but is revealed only for an authenticated account
  // (server-gated via ayyam_goals_enabled). This is device-key/legacy mode (no account), so it stays hidden and
  // a normal user still sees exactly these five in this order.
  const items = page.locator('#bottomNav .bnav-item:visible');
  await expect(items).toHaveCount(5);
  await expect(items.locator('.bnav-label')).toHaveText(['اليوم', 'التقويم', 'الروتين', 'التقدّم', 'الإعدادات']);
  // admin is NOT a nav item (item 13)
  await expect(page.locator('#bottomNav .bnav-item[data-screen="admin"]')).toHaveCount(0);
  // Today is active by default
  await expect(item(page, 'today')).toHaveClass(/active/);
  await expect(item(page, 'today')).toHaveAttribute('aria-current', 'page');
});

test('navigate today → calendar → routine → progress → settings; active state + nav stays visible', async ({ page }) => {
  await toToday(page);
  const steps = [
    ['calendar', '#calendarView'],
    ['routine', '#routineView'],
    ['progress', '#reportsView'],
    ['settings', '#settingsView'],
    ['today', '#mainView'],
  ];
  for (const [screen, view] of steps) {
    await item(page, screen).click();
    await expect(page.locator(view)).toBeVisible();
    await expect(item(page, screen)).toHaveClass(/active/);
    await expect(item(page, screen)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#bottomNav')).toBeVisible();      // stays fixed/visible on every base screen
  }
});

test('switching tabs does NOT reload the app (session/state preserved)', async ({ page }) => {
  await toToday(page);
  await page.evaluate(() => { window.__navProbe = 'alive'; });
  await item(page, 'calendar').click();
  await item(page, 'routine').click();
  await item(page, 'settings').click();
  await item(page, 'today').click();
  // a full reload would wipe this window-scoped flag; a tab switch must not
  expect(await page.evaluate(() => window.__navProbe)).toBe('alive');
});

test('the routine lives on its own screen, NOT inside Settings', async ({ page }) => {
  await toToday(page);
  // Settings has no routine/template UI
  await item(page, 'settings').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await expect(page.locator('#settingsView #tplDays')).toHaveCount(0);
  await expect(page.locator('#settingsView')).not.toContainText('القالب الأسبوعي');
  // the Routine screen has the day selector + list + add button, and shows the seeded routines
  await item(page, 'routine').click();
  await expect(page.locator('#routineView #tplDays')).toBeVisible();
  await expect(page.locator('#routineView #tplAddTask')).toBeVisible();
  await expect(page.locator('#routineView .tpl-routine-main').first()).toBeVisible();   // existing routine data shows
});

test('the FAB belongs to Today only (not on the other tabs)', async ({ page }) => {
  await toToday(page);
  await expect(page.locator('#fabAdd')).toBeVisible();
  await item(page, 'routine').click();
  await expect(page.locator('#fabAdd')).toBeHidden();
  await item(page, 'today').click();
  await expect(page.locator('#fabAdd')).toBeVisible();
});

test('navigation works offline (local-first; no forced fetch, no crash)', async ({ page, context }) => {
  await toToday(page);
  await context.setOffline(true);
  await item(page, 'calendar').click();
  await expect(page.locator('#calendarView')).toBeVisible();
  await item(page, 'routine').click();
  await expect(page.locator('#routineView #tplDays')).toBeVisible();   // routine from local DB
  await item(page, 'today').click();
  await expect(page.locator('.task').first()).toBeVisible();
  await context.setOffline(false);
});

test('the bottom nav is hidden on the auth gate', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });   // brand-new device → account gate
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#bottomNav')).toBeHidden();
});
