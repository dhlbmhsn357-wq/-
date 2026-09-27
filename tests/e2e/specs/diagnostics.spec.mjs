import { test, expect } from '@playwright/test';
import { prepare, resetBackend, waitSWControls, DEVICE_KEY } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

test('diagnostics shows the safe fields and NEVER a secret', async ({ page }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSWControls(page); // so the SW version can be queried

  await page.locator('#openSettings').click();
  const diag = page.locator('#diagInfo');
  await expect(diag).toContainText('إصدار التطبيق');
  // the SW must actually answer GET_VERSION (regression guard: reply on the MessageChannel port)
  await expect(diag).toContainText(/عامل الخدمة: \d+\.\d+\.\d+/);
  const text = await diag.textContent();

  // required non-sensitive fields
  for (const label of ['عامل الخدمة', 'مخطط قاعدة البيانات', 'حالة المزامنة', 'آخر مزامنة ناجحة',
    'رقم المراجعة', 'رقم الجيل', 'تغييرات غير مرفوعة', 'عناصر الاسترجاع', 'الإشعارات', 'التخزين المحلي']) {
    expect(text, `diagnostics must show "${label}"`).toContain(label);
  }
  // key status is a boolean, never the value
  expect(text).toContain('مفتاح المزامنة: مُدخل');

  // NEVER leak the secret device key, its hash, endpoints, coordinates or raw data
  expect(text).not.toContain(DEVICE_KEY);
  expect(text).not.toMatch(/https?:\/\/[^ ]*supabase/);   // no endpoints
  expect(text).not.toMatch(/p256dh|"auth"|BDtsM|VAPID/);  // no push keys
});

test('the copy-diagnostics button copies the same safe text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await page.locator('#openSettings').click();
  await page.locator('#copyDiag').click();
  await expect(page.locator('#copyDiag')).toContainText('تم النسخ');

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('إصدار التطبيق');
  expect(clip).toContain('معرّف الجهاز');
  expect(clip).not.toContain(DEVICE_KEY);
});
