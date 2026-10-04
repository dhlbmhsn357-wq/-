import { test, expect } from '@playwright/test';
import { prepare, resetBackend } from '../helpers.mjs';

// SECURITY (incident 2026-10-04): a visitor that is NOT authorised for any data — no account session AND no
// device-key secret — must land on the full-screen auth gate and must NEVER render Today, a task, a routine, or
// any previous/legacy data, not even for one frame. A later signup must therefore start from an empty slate.
test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

test('an unauthenticated visitor (no key, no session) sees the auth gate and ZERO task/Today data', async ({ page }) => {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  // the premium auth gate is shown...
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  // ...and NOTHING personal is rendered behind it: no tasks, no routine content, no hero counters with data.
  await expect(page.locator('.task')).toHaveCount(0);
  await expect(page.locator('.task-title')).toHaveCount(0);
});
