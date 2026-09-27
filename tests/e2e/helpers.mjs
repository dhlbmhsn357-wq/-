import { expect } from '@playwright/test';

export const DEVICE_KEY = 'e2e-device-key-0123456789abcdef';

// Prepare a page: optionally preset the device key, stub prompt/alert, optionally freeze the clock.
// Must run before any app script → use addInitScript.
export async function prepare(page, { key = true, now = null } = {}) {
  await page.addInitScript(({ key, deviceKey, now }) => {
    try { if (key) localStorage.setItem('ayyam_device_key_v1', deviceKey); } catch (e) {}
    window.__alerts = []; window.alert = (m) => window.__alerts.push(m);
    window.__prompt = deviceKey; window.prompt = () => window.__prompt; // key-entry returns the test key
    if (now) {
      const R = Date, base = new R(now).getTime(), start = R.now();
      class F extends R { constructor(...a) { a.length ? super(...a) : super(base + (R.now() - start)); } static now() { return base + (R.now() - start); } }
      window.Date = F;
    }
  }, { key, deviceKey: DEVICE_KEY, now });
}

export async function resetBackend(request) { await request.post('/__ctl/reset'); }
export async function ctlDb(request) { return (await request.get('/__ctl/db')).json(); }
export async function outage(request, mode) { await request.post(`/__ctl/outage?mode=${mode || ''}`); }

// Wait until the app has finished its first load (loading overlay gone).
export async function waitLoaded(page) {
  await page.waitForFunction(() => { const l = document.getElementById('loadingOverlay'); return l && l.classList.contains('hidden'); }, null, { timeout: 15000 });
}

// Wait until the service worker actually controls the page (so an offline reload is served from cache).
export async function waitSWControls(page) {
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller != null, null, { timeout: 15000 });
}

export async function addTask(page, title, { time, period } = {}) {
  await page.locator('#fabAdd').click();
  await page.locator('#taskTitle').fill(title);
  if (time) await page.locator('#taskTime').fill(time);
  if (period) await page.locator('#periodPick .period-chip', { hasText: period }).click();
  await page.locator('#saveAdd').click();
  await expect(page.locator('.task-title', { hasText: title })).toBeVisible();
}

export function taskRow(page, title) { return page.locator('.task', { has: page.locator('.task-title', { hasText: title }) }); }

// Wait until there are no unsynced changes (outbox empty) — the badge clears or shows synced.
export async function waitSynced(page) {
  await page.waitForFunction(async () => {
    const c = await new Promise((res) => { const o = indexedDB.open('ayyam'); o.onsuccess = () => { try { const t = o.result.transaction('outbox').objectStore('outbox').count(); t.onsuccess = () => res(t.result); t.onerror = () => res(-1); } catch (e) { res(-1); } }; o.onerror = () => res(-1); });
    return c === 0;
  }, null, { timeout: 15000 });
}

// Poll the server until its data contains `needle` (robust against sync timing). Fails after `timeout`.
export async function expectServerContains(request, needle, timeout = 12000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    const db = await (await request.get('/__ctl/db')).json();
    last = db.main ? JSON.stringify(db.main.data) : '(no row)';
    if (last.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server never contained "${needle}" within ${timeout}ms; last had it: ${last.includes(needle)}`);
}

// Poll the server DB until predicate(db) is truthy (authoritative — avoids racing the async client outbox).
export async function waitServer(request, predicate, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const db = await (await request.get('/__ctl/db')).json();
    try { if (predicate(db)) return db; } catch (e) { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('waitServer: predicate not met in time');
}
const doneRegs = (db) => Object.keys((db.main && db.main.data.reg) || {}).filter((k) => k.includes(':done:'));
export const serverDoneVals = (db) => doneRegs(db).map((k) => db.main.data.reg[k].val);

// Poll until a snapshot with the given reason exists on the server.
export async function expectSnapshot(request, reason, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const db = await (await request.get('/__ctl/db')).json();
    if (db.snaps && db.snaps.includes(reason)) return db;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no snapshot "${reason}" within ${timeout}ms`);
}

export async function outboxCount(page) {
  return page.evaluate(() => new Promise((res) => { const o = indexedDB.open('ayyam'); o.onsuccess = () => { const t = o.result.transaction('outbox').objectStore('outbox').count(); t.onsuccess = () => res(t.result); }; }));
}
