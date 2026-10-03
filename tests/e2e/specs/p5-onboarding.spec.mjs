import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding, taskRow } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

// Sign up a brand-new account (fresh device: no key, empty server). Leaves the onboarding tour showing.
async function signupToTour(page, email) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مستخدم أيام');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });   // the P5 tour starts automatically
}

// Advance one step. The per-step prepare hook (navigate / open the add sheet) is async, so give it a beat.
async function next(page) {
  const before = (await page.locator('.onb-count').textContent().catch(() => '')) || '';
  await page.locator('#onbNext').click();
  // the per-step prepare is async (navigate / open sheet); wait for the step counter to actually change
  await expect(page.locator('.onb-count')).not.toHaveText(before, { timeout: 6000 });
}
async function advanceToEnd(page) {
  for (let i = 0; i < 8; i++) {
    const n = page.locator('#onbNext');
    if (await n.isVisible().catch(() => false)) { await n.click(); await page.waitForTimeout(260); } else break;
  }
}

async function assertCardInViewport(page, label) {
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const box = await page.locator('#onbCard').boundingBox();
  expect(box, `card has a box at ${label}`).not.toBeNull();
  expect(box.x, `left edge in view at ${label}`).toBeGreaterThanOrEqual(-1);
  expect(box.y, `top edge in view at ${label}`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `right edge in view at ${label}`).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height, `bottom edge in view at ${label}`).toBeLessThanOrEqual(vp.height + 1);
  const nextBtn = page.locator('#onbNext');
  await expect(nextBtn, `Next visible at ${label}`).toBeVisible();
  const nb = await nextBtn.boundingBox();
  expect(nb.y + nb.height, `Next fully on screen at ${label}`).toBeLessThanOrEqual(vp.height + 1);
}

test('the tour card stays inside the viewport with a clickable Next on EVERY step', async ({ page }) => {
  await signupToTour(page, 'viewport@t.test');
  for (let i = 0; i < 8; i++) {
    await expect(page.locator('.onb-count')).toContainText(['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨'][i]);
    await assertCardInViewport(page, `step ${i + 1}`);
    if (i < 7) await next(page);
  }
});

// The core request: a REAL guided tour — each step spotlights an actual element, navigates to the right
// screen, and the "add routine" step points at the real button on the Routine tab.
test('the guided tour spotlights real elements and navigates to the Routine screen', async ({ page }) => {
  await signupToTour(page, 'guided@t.test');
  // 1 — Today: the hero is spotlighted
  await expect(page.locator('.onb-title')).toContainText('صفحة اليوم');
  await expect(page.locator('#onbView .onb-hole')).toBeVisible();
  // 2 — the add-task FAB
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('إضافة مهمة');
  await expect(page.locator('#onbView .onb-hole')).toBeVisible();
  // 3 — repetition: the add sheet opens and the recurrence picker is spotlighted (real control)
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('التكرار');
  await expect(page.locator('#addOverlay')).toHaveClass(/show/);
  await expect(page.locator('#recPick')).toBeVisible();
  // 4 — flexibility: no element on an empty account → centered, and the sheet is closed again
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('المرونة');
  await expect(page.locator('#addOverlay')).not.toHaveClass(/show/);
  // 5 — the bottom navigation bar is spotlighted
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('شريط التنقّل');
  await expect(page.locator('#bottomNav')).toBeVisible();
  await expect(page.locator('#onbView .onb-hole')).toBeVisible();
  // 6 — Routine: the tour navigates to the Routine screen and spotlights its tab
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('الروتين');
  await expect(page.locator('#routineView')).toBeVisible();
  // 7 — add routine: the real add button on the Routine screen is spotlighted and clickable
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('إضافة روتين');
  await expect(page.locator('#routineView')).toBeVisible();
  await expect(page.locator('#tplAddTask')).toBeVisible();
  await expect(page.locator('#tplAddTask')).toBeEnabled();
  // 8 — end: finishing a fresh empty account offers the optional starter (still in #onbView); skipping it
  // hands back to Today — confirming the tour never left the user stranded on the Routine tab.
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('ابدأ يومك');
  await page.locator('#onbNext').click();
  await expect(page.locator('.starter-card')).toBeVisible({ timeout: 10000 });
  await page.locator('#starterSkip').click();
  await expect(page.locator('#onbView')).toBeHidden({ timeout: 10000 });
  await expect(page.locator('#mainView')).toBeVisible();
});

test('a new account starts the onboarding tour with a working step counter and prev/next', async ({ page }) => {
  await signupToTour(page, 'onb@t.test');
  await expect(page.locator('.onb-count')).toContainText('٨');       // 8-step tour
  await expect(page.locator('.onb-title')).toContainText('صفحة اليوم');
  await next(page);
  await expect(page.locator('.onb-title')).toContainText('إضافة مهمة');
  await page.locator('#onbPrev').click();
  await expect(page.locator('.onb-title')).toContainText('صفحة اليوم');  // prev returns to step 1
});

test('skip completes onboarding server-side — it never shows again on restart', async ({ page }) => {
  await signupToTour(page, 'skip@t.test');
  await page.locator('#onbSkip').click();
  await expect(page.locator('#onbView')).toBeHidden();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });   // empty account, nothing auto-added
  await page.reload();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('#onbView')).toBeHidden();                          // completion persisted
});

test('resume: the tour continues from the saved step after a restart', async ({ page }) => {
  await signupToTour(page, 'resume@t.test');
  await next(page);   // → step 2
  await next(page);   // → step 3
  await expect(page.locator('.onb-count')).toContainText('٣');
  await page.waitForTimeout(900);            // let the fire-and-forget progress RPC persist server-side
  await page.reload();
  // resumes mid-tour (not back at step 1, not gone)
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });
  await expect(page.locator('.onb-count')).not.toContainText('١ /');
  await skipOnboarding(page);
});

test('finishing offers the optional starter, and ONLY ticked suggestions are added', async ({ page }) => {
  await signupToTour(page, 'starter@t.test');
  await advanceToEnd(page);
  // the optional starter appears after a genuine finish
  await expect(page.locator('.starter-card')).toBeVisible({ timeout: 10000 });
  // nothing is added until the user ticks something (apply disabled)
  await expect(page.locator('#starterApply')).toBeDisabled();
  await page.locator('.starter-item input').nth(0).check();   // ركعتا الفجر
  await page.locator('.starter-item input').nth(1).check();   // أذكار الصباح
  await page.locator('#starterApply').click();
  await expect(page.locator('#onbView')).toBeHidden();
  await expect(taskRow(page, 'ركعتا الفجر')).toBeVisible({ timeout: 10000 });
  await expect(taskRow(page, 'أذكار الصباح')).toBeVisible();
});

test('starter skip adds NOTHING (no worship auto-added)', async ({ page }) => {
  await signupToTour(page, 'nostart@t.test');
  await advanceToEnd(page);
  await expect(page.locator('.starter-card')).toBeVisible({ timeout: 10000 });
  await page.locator('#starterSkip').click();
  await expect(page.locator('#onbView')).toBeHidden();
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });   // still empty — nothing added
  expect(await page.locator('.task').count()).toBe(0);
});

test('the tour can be replayed from Settings', async ({ page }) => {
  await signupToTour(page, 'replay@t.test');
  await skipOnboarding(page);
  await page.locator('#bottomNav .bnav-item[data-screen="settings"]').click();
  await expect(page.locator('#replayOnb')).toBeVisible({ timeout: 10000 });
  await page.locator('#replayOnb').click();
  await expect(page.locator('#onbView')).toBeVisible();
  await expect(page.locator('.onb-title')).toContainText('صفحة اليوم');
});

test('the Today empty state opens the add sheet', async ({ page }) => {
  await signupToTour(page, 'empty@t.test');
  await skipOnboarding(page);
  await expect(page.locator('#emptyToday')).toBeVisible({ timeout: 10000 });
  await page.locator('#emptyAddTask').click();
  await expect(page.locator('#taskTitle')).toBeVisible();
});
