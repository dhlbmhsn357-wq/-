// Service Worker لتطبيق "أيام" — يدعم:
// 1) تخزين مؤقت بسيط (offline caching)
// 2) استقبال إشعارات Push حقيقية من السيرفر
// 3) فتح التطبيق عند الضغط على الإشعار

// غيّر رقم الإصدار عند تغيير استراتيجية التخزين؛ الإصدارات القديمة تُحذف تلقائيًا عند التفعيل.
const CACHE = 'ayyam-cache-v3';

// ملفات التطبيق الأساسية تُخزَّن عند التثبيت حتى يفتح التطبيق دون إنترنت من أول مرة.
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'bg.jpg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // لا نُفشل التثبيت لو تعذّر ملف واحد؛ الباقي يُخزَّن عند أول طلب
  e.waitUntil(caches.open(CACHE).then((cache) =>
    Promise.all(CORE.map((u) => cache.add(u).catch(() => {})))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// الشبكة أولًا دائمًا، والنسخة المخزنة احتياطية فقط عند انقطاع الاتصال،
// حتى تصل التحديثات فورًا ولا تُعرض بيانات قديمة.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // بيانات Supabase حيّة: لا تُخزَّن أبدًا
  if (url.hostname.endsWith('.supabase.co')) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const resp = await fetch(req);
      // خزّن الردود الناجحة فقط (أو المعتمة من مواقع أخرى مثل الخطوط)، لا أخطاء 404/500
      if (resp.ok || resp.type === 'opaque') {
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    } catch (err) {
      const isNav = req.mode === 'navigate';
      const cached = await cache.match(req, { ignoreSearch: isNav });
      if (cached) return cached;
      if (isNav) {
        const scope = self.registration.scope;
        const shell = (await cache.match(scope)) || (await cache.match(scope + 'index.html'));
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});

// ---------- Push notifications ----------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'أيام', body: event.data ? event.data.text() : '' };
  }

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

// عند الضغط على الإشعار: افتح التطبيق (أو ركّز عليه لو مفتوح بالفعل)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  let targetUrl = (event.notification.data && event.notification.data.url) || scope;
  // افتح روابط التطبيق نفسه فقط
  try { targetUrl = new URL(targetUrl, scope).href; } catch (e) { targetUrl = scope; }
  if (!targetUrl.startsWith(scope)) targetUrl = scope;

  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appWindow = clientsArr.find((c) => c.url.startsWith(scope));
    if (appWindow) {
      // التطبيق مفتوح: ركّز عليه، وانتقل فقط لو الرابط المطلوب مختلف (navigate قد يفشل لنافذة غير خاضعة)
      if (appWindow.url !== targetUrl && 'navigate' in appWindow) {
        try { await appWindow.navigate(targetUrl); } catch (e) {}
      }
      return appWindow.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
