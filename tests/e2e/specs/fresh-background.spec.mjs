import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

// A brand-new account must start on the clean themed background — no bg.jpg image loaded or rendered.
test('a fresh account starts with NO background image (clean themed background)', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مستخدم نظيف');
  await page.locator('#authEmail').fill('cleanbg@t.test');
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });
  await skipOnboarding(page);

  // body must NOT carry the background-image state, and no bg.jpg must be used as the body background.
  const bg = await page.evaluate(() => ({
    hasBgClass: document.body.classList.contains('has-bg'),
    inlineImage: document.body.style.backgroundImage || '',
    computedImage: getComputedStyle(document.body).backgroundImage || '',
  }));
  expect(bg.hasBgClass, 'body should not have .has-bg on a fresh account').toBe(false);
  expect(bg.inlineImage, 'no inline background-image on a fresh account').toBe('');
  expect(bg.computedImage.includes('bg.jpg'), 'bg.jpg must not be rendered').toBe(false);

  // and bg.jpg must not have been requested over the network for this fresh session
  const requestedBg = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((e) => (e.name || '').includes('bg.jpg')));
  expect(requestedBg, 'bg.jpg should never be fetched when the background is off').toBe(false);
});
