import { test, expect } from '@playwright/test';
import { prepare, resetBackend, addTask } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '412x915', width: 412, height: 915 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'desktop-1280x800', width: 1280, height: 800 },
];

for (const vp of VIEWPORTS) {
  test(`RTL layout at ${vp.name}: no horizontal overflow, FAB and controls on-screen`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await prepare(page, { key: true });
    await page.goto('/');
    await expect(page.locator('.task').first()).toBeVisible();

    // RTL direction
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    // no horizontal scrolling
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // FAB is visible and within the viewport
    const fab = page.locator('#fabAdd');
    await expect(fab).toBeVisible();
    const box = await fab.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    // the add sheet opens and its buttons are on-screen
    await fab.click();
    await expect(page.locator('#addOverlay')).toHaveClass(/show/);
    const save = await page.locator('#saveAdd').boundingBox();
    expect(save.x).toBeGreaterThanOrEqual(0);
    expect(save.x + save.width).toBeLessThanOrEqual(vp.width + 1);
    await page.locator('#cancelAdd').click();

    await testInfo.attach(`screenshot-${vp.name}`, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

test('a long task title does not cause horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await addTask(page, 'مهمة'.repeat(40));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
