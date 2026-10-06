import { test, expect } from '@playwright/test';
import { prepare, resetBackend, skipOnboarding } from '../helpers.mjs';

// Goals UI — Private Pilot (Stage B). Enablement is SERVER-authoritative: an account sees Goals only when it is
// on the server allowlist (ayyam_goals_pilot → ayyam_goals_enabled RPC). No localStorage/query path. These tests
// sign up a real account, authorize it via /__ctl/goals-pilot, reload, then drive the UI.
test.beforeEach(async ({ request }) => { await resetBackend(request); });
test.describe.configure({ retries: 2, timeout: 90000 });

async function signup(page, email) {
  await prepare(page, { key: false, now: '2026-09-28T09:00:00' });
  await page.goto('/');
  await expect(page.locator('#authView')).toBeVisible({ timeout: 15000 });
  await page.locator('#authName').fill('مالك');
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill('pass1234');
  await page.locator('#authSubmit').click();
  await expect(page.locator('#onbView')).toBeVisible({ timeout: 25000 });
  await skipOnboarding(page);
  await expect(page.locator('#mainView')).toBeVisible();
}

// After an account-mode reload, the onboarding tour can re-appear and overlay the nav; dismiss it, then go to Goals.
async function reloadToGoals(page) {
  await page.reload();
  await expect(page.locator('#mainView')).toBeVisible({ timeout: 15000 });
  await skipOnboarding(page);
  await expect(page.locator('#navGoals')).toBeVisible({ timeout: 15000 });
  await page.locator('#navGoals').click();
  await expect(page.locator('#goalsView')).toBeVisible();
}

async function openGoals(page, email = 'pilot@t.test') {
  await signup(page, email);
  await page.request.post('/__ctl/goals-pilot?email=' + encodeURIComponent(email)); // allowlist this account
  await reloadToGoals(page);                                                         // server flag now turns Goals on
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

test('a goal survives a reload (persisted in the account namespace + synced to the account row)', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف يبقى', measure: 'عدد مرات', target: 10 });
  // wait for the commit to land on the account row (so the local persist has flushed) before reloading
  await expect.poll(async () => {
    const r = await (await page.request.get('/__ctl/account-row')).json();
    return r.row ? JSON.stringify(r.row.data).includes('هدف يبقى') : false;
  }, { timeout: 15000 }).toBe(true);
  await reloadToGoals(page);
  await expect(page.locator('.goal-card', { hasText: 'هدف يبقى' })).toBeVisible();
});

// ---------------- Stage B: server-authoritative enablement + backend write-guard ----------------
test('an account NOT on the allowlist never sees Goals (no nav item, no screen)', async ({ page }) => {
  await signup(page, 'nopilot@t.test'); // signed in, but NOT authorized
  await expect(page.locator('#mainView')).toBeVisible();
  await expect(page.locator('#navGoals')).toBeHidden();                 // the nav item stays hidden
  await expect(page.locator('#bottomNav .bnav-item:visible')).toHaveCount(5);
  // even forcing the localStorage/query flag does NOT reveal it (server is the only authority)
  await page.evaluate(() => { try { localStorage.setItem('ayyam_ff_goals', '1'); } catch (e) {} });
  await page.goto('/?goals=1');
  await expect(page.locator('#mainView')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#navGoals')).toBeHidden();
});
// (the backend write-guard — a non-allowlisted account refused a direct goal:* write — is proven in
//  tests/db/goals-pilot.test.mjs, exercising ayyam_commit_v2 at the SQL/RLS layer.)

// ---------------- P1-D: period tabs ----------------
async function selectTab(page, label) {
  await page.locator('.goal-tab', { hasText: label }).click();
  await expect(page.locator('.goal-tab.on', { hasText: label })).toBeVisible();
}
async function makeThree(page) {
  await createGoal(page, { name: 'هدف الأسبوع', period: 'هذا الأسبوع', measure: 'عدد مرات', target: 5 });
  await createGoal(page, { name: 'هدف الشهر', period: 'هذا الشهر', measure: 'عدد مرات', target: 5 });
  await createGoal(page, { name: 'هدف الربع', period: 'هذا الربع', measure: 'عدد مرات', target: 5 });
}

test('each goal appears ONLY in its own period tab', async ({ page }) => {
  await openGoals(page);
  await makeThree(page);
  await selectTab(page, 'الأسبوع');
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الأسبوع' })).toBeVisible();
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الشهر' })).toHaveCount(0);
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الربع' })).toHaveCount(0);
  await selectTab(page, 'الشهر');
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الشهر' })).toBeVisible();
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الأسبوع' })).toHaveCount(0);
  await selectTab(page, 'الربع');
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الربع' })).toBeVisible();
  await expect(page.locator('.goals-wrap .goal-card', { hasText: 'هدف الشهر' })).toHaveCount(0);
});

test('period windows are correct (weekly Sat→Fri, monthly whole month, quarterly whole quarter)', async ({ page }) => {
  await openGoals(page);
  await makeThree(page);
  const win = await page.evaluate(() => {
    const T = window.AyyamTime, all = window.AyyamGoalsUI._peek();
    const by = (n) => Object.values(all).find((g) => g.title === n);
    const w = by('هدف الأسبوع'), m = by('هدف الشهر'), q = by('هدف الربع');
    return {
      wStartDay: T.dayCode(w.start_date), wLen: T.diffDays(w.end_date, w.start_date),
      mStart: m.start_date.slice(8), mEndMonth: m.end_date.slice(5, 7) === m.start_date.slice(5, 7),
      qStartMonth: Number(q.start_date.slice(5, 7)), qEnd: q.end_date.slice(5),
    };
  });
  expect(win.wStartDay).toBe('sat');
  expect(win.wLen).toBe(6);
  expect(win.mStart).toBe('01');
  expect(win.mEndMonth).toBe(true);
  expect([1, 4, 7, 10]).toContain(win.qStartMonth); // quarter start month
});

test('a completed goal stays visible in its period tab', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف مكتمل', period: 'هذا الأسبوع', measure: 'عدد مرات', target: 3 });
  await page.locator('.goal-card', { hasText: 'هدف مكتمل' }).click();
  await page.locator('.goal-act', { hasText: 'تحديد كمكتمل' }).click();
  await page.locator('#goalDetailOverlay .btn.ghost', { hasText: 'إغلاق' }).click();
  await selectTab(page, 'الأسبوع');
  const card = page.locator('.goals-wrap:not(.goals-wrap-past) .goal-card', { hasText: 'هدف مكتمل' });
  await expect(card).toBeVisible();
  await expect(card.locator('.goal-badge', { hasText: 'مكتمل' })).toBeVisible();
});

test('archived goals leave the main list and live under السابقة والمؤرشفة', async ({ page }) => {
  await openGoals(page);
  await createGoal(page, { name: 'هدف مؤرشف', period: 'هذا الأسبوع', measure: 'عدد مرات', target: 3 });
  await page.locator('.goal-card', { hasText: 'هدف مؤرشف' }).click();
  await page.locator('.goal-act', { hasText: 'أرشفة' }).click();
  await selectTab(page, 'الأسبوع');
  await expect(page.locator('.goals-wrap:not(.goals-wrap-past) .goal-card', { hasText: 'هدف مؤرشف' })).toHaveCount(0);
  await page.locator('.goals-past-toggle').click();
  await expect(page.locator('.goals-wrap-past .goal-card', { hasText: 'هدف مؤرشف' })).toBeVisible();
});

test('the selected tab persists across a reload', async ({ page }) => {
  await openGoals(page);
  await selectTab(page, 'الشهر');
  await reloadToGoals(page);
  await expect(page.locator('.goal-tab.on', { hasText: 'الشهر' })).toBeVisible();
});

test('each empty tab shows its own prompt', async ({ page }) => {
  await openGoals(page);
  await selectTab(page, 'الأسبوع');
  await expect(page.locator('.goals-empty-title')).toHaveText('حدّد ما تريد تحقيقه هذا الأسبوع');
  await selectTab(page, 'الشهر');
  await expect(page.locator('.goals-empty-title')).toHaveText('ما النتيجة التي تريد الوصول إليها هذا الشهر؟');
  await selectTab(page, 'الربع');
  await expect(page.locator('.goals-empty-title')).toContainText('٩٠ يومًا');
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
