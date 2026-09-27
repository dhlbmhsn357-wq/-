// CSP smoke test (Phase 7): the deployed Content-Security-Policy and security headers must be
// self-consistent with what the app actually loads. Static — no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const vercel = JSON.parse(read('vercel.json'));
const globalRule = vercel.headers.find((h) => h.source === '/(.*)');
const headers = Object.fromEntries(globalRule.headers.map((h) => [h.key.toLowerCase(), h.value]));

const csp = headers['content-security-policy'];
// directive -> array of source tokens
const dir = Object.fromEntries(
  csp.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const [k, ...v] = s.split(/\s+/); return [k, v]; }),
);

test('CSP forbids the dangerous escapes everywhere', () => {
  assert.ok(!/unsafe-eval/.test(csp), "CSP must never allow 'unsafe-eval'");
  // script-src must be strict: no inline scripts allowed
  assert.ok(dir['script-src'], 'script-src must be set');
  assert.ok(!dir['script-src'].includes("'unsafe-inline'"), "script-src must not allow 'unsafe-inline'");
});

test('CSP sets the clickjacking / base / object protections', () => {
  assert.deepEqual(dir['frame-ancestors'], ["'none'"], "frame-ancestors must be 'none'");
  assert.deepEqual(dir['object-src'], ["'none'"], "object-src must be 'none'");
  assert.deepEqual(dir['base-uri'], ["'self'"], "base-uri must be 'self'");
  assert.deepEqual(dir['default-src'], ["'self'"], "default-src must be 'self'");
  assert.deepEqual(dir['form-action'], ["'self'"], "form-action must be 'self'");
  assert.deepEqual(dir['worker-src'], ["'self'"], "worker-src must be 'self'");
});

test('other hardening headers are present and correct', () => {
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.ok(headers['referrer-policy'], 'Referrer-Policy must be set');
  assert.ok(headers['strict-transport-security']?.includes('max-age='), 'HSTS must be set');
  // geolocation is used for prayer-time-by-location, so it must be allowed to self (not blocked)
  assert.match(headers['permissions-policy'], /geolocation=\(self\)/);
  assert.match(headers['permissions-policy'], /camera=\(\)/);
});

test('index.html has NO inline <script> (would need unsafe-inline)', () => {
  const html = read('index.html');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(inline.length, 0, 'no inline <script> blocks allowed under strict script-src');
});

test('every external origin the app loads is allowed by the matching directive', () => {
  const html = read('index.html');
  const app = read('js/app.js');
  const allows = (directive, origin) => (dir[directive] || []).some((s) => s === origin || s === "'self'");

  // <script src="https://cdn.jsdelivr.net/...">  -> script-src
  if (/<script[^>]+src="https:\/\/cdn\.jsdelivr\.net/.test(html)) {
    assert.ok(allows('script-src', 'https://cdn.jsdelivr.net'), 'jsdelivr script must be allowed by script-src');
  }
  // Google Fonts stylesheet -> style-src ; font files -> font-src
  if (/fonts\.googleapis\.com/.test(html)) {
    assert.ok(allows('style-src', 'https://fonts.googleapis.com'), 'Google Fonts CSS must be allowed by style-src');
    assert.ok(allows('font-src', 'https://fonts.gstatic.com'), 'Google font files must be allowed by font-src');
  }
  // Supabase endpoint used via fetch (supabase-js) -> connect-src
  const m = app.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  assert.ok(m, 'app.js must reference a Supabase URL');
  assert.ok((dir['connect-src'] || []).includes(`https://${m[1]}.supabase.co`), 'the Supabase origin must be in connect-src');

  // The service worker re-fetches font/CDN assets (SWR) -> those hosts must be in connect-src too
  const sw = read('sw.js');
  const hosts = (sw.match(/FONT_HOSTS = \[([^\]]*)\]/) || [,''])[1].match(/'([^']+)'/g) || [];
  for (const h of hosts.map((s) => s.replace(/'/g, ''))) {
    assert.ok((dir['connect-src'] || []).includes(`https://${h}`), `SW fetches ${h}; connect-src must allow it`);
  }
});
