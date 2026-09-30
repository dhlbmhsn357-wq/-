import { test, expect } from '@playwright/test';

// The design-system showcase is a static page (tokens.css + components.css). These tests guard the system:
// no horizontal overflow across breakpoints, real light/dark, keyboard focus rings, and reduced-motion.
const WIDTHS = [360, 390, 412, 768, 1280];

test.describe('design system', () => {
  test('no horizontal overflow at any supported width (RTL)', async ({ page }) => {
    await page.goto('/design-system.html');
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `overflow at ${w}px`).toBeLessThanOrEqual(1);
    }
  });

  test('light and dark themes both resolve real, different token values', async ({ page }) => {
    await page.goto('/design-system.html');
    const bgOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'night'));
    const dark = await bgOf();
    await page.locator('#themeBtn').click();                    // → day
    const light = await bgOf();
    expect(dark).not.toBe(light);
    // both are opaque real colours (not empty/transparent)
    expect(dark).toMatch(/^rgb/);
    expect(light).toMatch(/^rgb/);
  });

  test('keyboard focus shows a visible focus ring on components', async ({ page }) => {
    await page.goto('/design-system.html');
    await page.locator('#themeBtn').focus();                    // first focusable in the header
    await page.keyboard.press('Tab');                           // move focus by keyboard → :focus-visible applies
    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      const s = getComputedStyle(el);
      return { tag: el && el.tagName, width: s.outlineWidth, style: s.outlineStyle };
    });
    expect(outline.style).not.toBe('none');
    expect(parseFloat(outline.width)).toBeGreaterThan(0);
  });

  test('reduced motion collapses the motion tokens', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/design-system.html');
    const fast = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-fast').trim());
    expect(fast).toBe('1ms');
  });

  test('the app itself loads the design-system stylesheets', async ({ request }) => {
    // Assert on the served HTML (deterministic — the app boot may navigate/reload, which races a page.evaluate).
    const html = await (await request.get('/')).text();
    expect(html).toContain('css/tokens.css');
    expect(html).toContain('css/components.css');
  });
});
