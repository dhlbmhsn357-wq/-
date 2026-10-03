import { test, expect } from '@playwright/test';
import { prepare, resetBackend, addTask, waitSWControls } from '../helpers.mjs';

test.beforeEach(async ({ request }) => { await resetBackend(request); });

// The app is served under the production CSP (mirrored from vercel.json). Exercising the real UI
// must not trigger a single CSP violation — that would mean the policy blocks something the app needs.
test('normal use raises no Content-Security-Policy violations', async ({ page }) => {
  const violations = [];
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) violations.push(m.text()); });

  await prepare(page, { key: true });
  await page.goto('/');
  await expect(page.locator('.task').first()).toBeVisible();
  await waitSWControls(page);          // SW registration must be allowed by worker-src 'self'
  await addTask(page, 'مهمة CSP');      // exercise DOM writes + inline style attributes (style-src)
  await page.locator('#bottomNav .bnav-item[data-screen="progress"]').click(); // reports view renders dynamic inline width/background styles
  await expect(page.locator('#reportsView')).toBeVisible();
  await page.waitForTimeout(300);

  const domViolations = await page.evaluate(() => window.__csp || []);
  expect(domViolations, `DOM CSP violations: ${domViolations.join(' | ')}`).toEqual([]);
  expect(violations, `console CSP errors: ${violations.join(' | ')}`).toEqual([]);
});

test('the response actually carries the CSP header', async ({ request }) => {
  const res = await request.get('/');
  const csp = res.headers()['content-security-policy'];
  expect(csp).toBeTruthy();
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-eval');
});
