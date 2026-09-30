// Service Worker for "أيام" — versioned, coherent, update-on-demand.
//
// Versioning: bump SW_VERSION on every release. The app's own assets (HTML+JS+manifest+icons) are
// precached under one versioned cache and served CACHE-FIRST, so a page and its JS are always from the
// SAME version — never old HTML with new JS. A new worker installs and WAITS; it only takes over when
// the user taps "update" (postMessage SKIP_WAITING). Old caches are deleted only after the new version
// activates. If precache fails (a missing/asset error), install fails and the old version keeps working.
//
// Never cached: Supabase (API / RPC / auth / personal sync data). Fonts/CDN use a bounded
// stale-while-revalidate cache and never block the app.

const SW_VERSION = '5.2.1';
const APP_CACHE = `ayyam-app-${SW_VERSION}`;
const RUNTIME_CACHE = `ayyam-runtime-${SW_VERSION}`;
const RUNTIME_MAX = 60; // bounded so the runtime cache can't grow without limit

// The coherent asset set for this version. install is atomic: all or nothing.
const PRECACHE = [
  './', 'index.html',
  'css/tokens.css', 'css/components.css', 'css/app.css', 'css/screens.css',
  'js/app.js', 'js/storage.js', 'js/sync-model.js', 'js/account.js', 'js/auth-ui.js', 'js/admin.js', 'js/onboarding.js', 'js/pin-lock.js', 'js/time-model.js', 'js/routines-model.js', 'js/analytics-model.js',
  'js/adhan.umd.min.js', 'js/overdue-model.js', 'js/update-model.js',
  'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'bg.jpg',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  // Do NOT skipWaiting automatically — wait until the user opts in, so a running session never gets a
  // half-swapped version. Atomic precache: if any asset fails, the whole install rejects (old stays).
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clean old versions ONLY now that this version activated successfully.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== APP_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// The page asks us to activate the waiting version; the page reloads on controllerchange.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'GET_VERSION') {
    const reply = { type: 'VERSION', version: SW_VERSION };
    // The app asks via a MessageChannel port; reply on that port. Fall back to the client (event.source)
    // for callers that post without a port.
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) for (const req of keys.slice(0, keys.length - max)) await cache.delete(req);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never touch Supabase (API/RPC/auth/personal sync data) — pure passthrough, nothing cached.
  if (url.hostname.endsWith('.supabase.co')) return;

  const sameOrigin = url.origin === self.location.origin;
  const scope = self.registration.scope;
  const inPrecache = sameOrigin && PRECACHE.some((p) => new URL(p, scope).href === url.href);

  // Navigations → the precached app shell (cache-first) so HTML and JS are always the same version.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      return (await cache.match('index.html')) || (await cache.match('./')) || fetch(req).catch(() => Response.error());
    })());
    return;
  }

  // App's own versioned assets → cache-first from this version's cache (coherent, offline-ready).
  if (inPrecache) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const resp = await fetch(req); if (resp.ok) cache.put(req, resp.clone()); return resp; }
      catch (e) { return Response.error(); }
    })());
    return;
  }

  // Fonts / CDN → stale-while-revalidate in a bounded runtime cache; failure never blocks the app.
  if (!sameOrigin && FONT_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const hit = await cache.match(req);
      const network = fetch(req).then((resp) => {
        if (resp && (resp.ok || resp.type === 'opaque')) { cache.put(req, resp.clone()).then(() => trimCache(RUNTIME_CACHE, RUNTIME_MAX)); }
        return resp;
      }).catch(() => null);
      return hit || (await network) || Response.error();
    })());
    return;
  }

  // Other same-origin GETs → network-first, fall back to whatever was cached (bounded runtime).
  if (sameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      try {
        const resp = await fetch(req);
        if (resp.ok) { cache.put(req, resp.clone()).then(() => trimCache(RUNTIME_CACHE, RUNTIME_MAX)); }
        return resp;
      } catch (e) {
        const hit = await cache.match(req);
        return hit || Response.error();
      }
    })());
  }
  // anything else: default network passthrough
});

// ---------- Push notifications (unchanged) ----------
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'أيام', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'أيام';
  const options = {
    body: data.body || 'حان وقت مهامك',
    icon: data.icon || 'icon-192.png',
    badge: data.badge || undefined,
    tag: data.tag || 'ayyam-reminder',
    renotify: true,
    data: { url: data.url || self.registration.scope },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  let targetUrl = (event.notification.data && event.notification.data.url) || scope;
  try { targetUrl = new URL(targetUrl, scope).href; } catch (e) { targetUrl = scope; }
  if (!targetUrl.startsWith(scope)) targetUrl = scope;
  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appWindow = clientsArr.find((c) => c.url.startsWith(scope));
    if (appWindow) {
      if (appWindow.url !== targetUrl && 'navigate' in appWindow) { try { await appWindow.navigate(targetUrl); } catch (e) {} }
      return appWindow.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
