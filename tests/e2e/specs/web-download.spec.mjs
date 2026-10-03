import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding, waitSWControls } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function signupAndLand(page, email) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مستخدم');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });
  await skipOnboarding(page);
  await expect(page.locator('#mainView')).toBeVisible();
}

// ---------------- /download page (static page + download.js) ----------------
test('the /download page offers a same-domain APK download (never a GitHub link) + web option', async ({ page }) => {
  await page.goto('/download.html');
  await expect(page.locator('#dlBtn')).toBeVisible({ timeout: 10000 });
  // the download CTA points at the same-domain endpoint, NOT github
  await expect(page.locator('#dlBtn')).toHaveAttribute('href', '/download/android');
  const href = await page.locator('#dlBtn').getAttribute('href');
  expect(href.includes('github')).toBe(false);
  // no element on the page links to a GitHub release/download UI
  const ghLinks = await page.locator('a[href*="github.com"]').count();
  expect(ghLinks, 'no github.com links on the download page').toBe(0);
  // a "use the web version" option exists
  await expect(page.locator('a.btn.ghost[href="/"]')).toBeVisible();
  // version chip renders (even if metadata is unavailable it falls back to "أحدث إصدار", never blank/crash)
  await expect(page.locator('#verChip')).toContainText('إصدار');
});

test('the /download page shows the web-only state on iOS (no APK button)', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: IOS_UA });
  const page = await ctx.newPage();
  await page.goto('/download.html');
  await expect(page.locator('#iosBlock')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#dlBlock')).toBeHidden();
  await expect(page.locator('#iosBlock')).toContainText('غير متاحة على هذا الجهاز');
  await ctx.close();
});

test('the service worker does NOT hijack /download — it serves the real page, not the app shell', async ({ page }) => {
  // load the app so the service worker installs and takes control
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await waitSWControls(page);
  // with the SW controlling, navigating to the download page must still serve download.html (not index.html)
  await page.goto('/download.html');
  await expect(page.locator('#dlBtn')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#authView')).toHaveCount(0); // proves it is NOT the SPA app shell
});

// ---------------- header "download Android app" icon (replaces the big card) ----------------
test('a small header download icon is shown to web users and opens /download (never a PWA install)', async ({ page }) => {
  await signupAndLand(page, 'icon@t.test');
  const btn = page.locator('#getAppBtn');
  await expect(btn).toBeVisible({ timeout: 10000 });
  await expect(btn).toHaveAttribute('aria-label', 'تحميل تطبيق أندرويد');
  // the big promo card no longer exists anywhere
  await expect(page.locator('#getAppCard')).toHaveCount(0);
  // clicking navigates to /download (NOT a beforeinstallprompt / add-to-home-screen)
  await btn.click();
  await expect(page).toHaveURL(/\/download(\.html)?$/, { timeout: 10000 });
  await expect(page.locator('#dlBtn')).toBeVisible({ timeout: 10000 }); // the real download page
});

test('on iOS the header icon opens /download, which shows the web-only state', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: IOS_UA });
  const page = await ctx.newPage();
  await signupAndLand(page, 'iconios@t.test');
  const btn = page.locator('#getAppBtn');
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page).toHaveURL(/\/download(\.html)?$/, { timeout: 10000 });
  await expect(page.locator('#iosBlock')).toBeVisible({ timeout: 10000 }); // iOS → web-only, no APK button
  await expect(page.locator('#dlBlock')).toBeHidden();
  await ctx.close();
});
