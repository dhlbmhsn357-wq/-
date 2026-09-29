import { test, expect } from '@playwright/test';
import { prepare, resetBackend, addTask, waitSynced, waitSWControls, expectServerContains } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); await request.post('/__ctl/sw-version?v='); });
test.afterEach(async ({ request }) => { await request.post('/__ctl/sw-version?v='); }); // reset SW override

test('the app is installable: manifest is valid with icons and start_url', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  // The SW calls clients.claim() on activate and the app reloads once on controllerchange (app.js).
  // Reading the manifest via page.evaluate races that one-time reload ("execution context destroyed").
  // Fetch it through the API request context instead — it is independent of the page, so a navigation
  // cannot destroy it. We still assert the <link rel=manifest> is present in the document.
  await expect(page.locator('head link[rel="manifest"]')).toHaveCount(1);
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBeTruthy();
  expect(manifest.start_url).toBeTruthy();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
});

test('a new SW waits, shows the banner, and updating reloads onto a coherent version without losing a pending edit', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSynced(page);
  await waitSWControls(page);

  // an unsynced local edit exists...
  await addTask(page, 'قبل التحديث');

  // publish a new SW version → the app detects it, installs, WAITS, and shows the banner
  await request.post('/__ctl/sw-version?v=9.9.9');
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
  await expect(page.locator('#updateBanner')).toBeVisible({ timeout: 15000 });
  // current session still works (not broken by the waiting worker)
  await expect(page.locator('.task-title', { hasText: 'قبل التحديث' })).toBeVisible();

  // tap "تحديث الآن" → activates the new version and reloads; the new app cache replaces the old
  await page.locator('#updateNow').click();
  await expect.poll(async () => {
    try { return await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('ayyam-app-'))); }
    catch (e) { return ['(reloading)']; } // the mid-reload context is destroyed → keep polling
  }, { timeout: 15000 }).toEqual(['ayyam-app-9.9.9']); // exactly the new version, old cleaned
  // no blank screen, the pending edit is preserved and still syncs
  await expect(page.locator('.task-title', { hasText: 'قبل التحديث' })).toBeVisible();
  await expectServerContains(request, 'قبل التحديث');
});

test('a failed SW install (missing asset) leaves the old version working', async ({ page, request }) => {
  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSWControls(page);
  const before = await page.evaluate(() => new Promise((res) => {
    const ch = new MessageChannel(); const t = setTimeout(() => res('?'), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data.version); };
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  }));

  // publish a broken new version (precache references a missing asset → install fails)
  await request.post('/__ctl/sw-version?v=8.8.8&break=1');
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); try { await r.update(); } catch (e) {} });
  await page.waitForTimeout(2000);

  // no waiting worker, no banner, old version still active and app usable
  const waiting = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r.waiting; });
  expect(waiting).toBe(false);
  await expect(page.locator('#updateBanner')).toBeHidden();
  await expect(page.locator('.task').first()).toBeVisible();
  const after = await page.evaluate(() => new Promise((res) => {
    const ch = new MessageChannel(); const t = setTimeout(() => res('?'), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); res(e.data.version); };
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  }));
  expect(after).toBe(before); // unchanged
});
