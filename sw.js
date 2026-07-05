// Service Worker لتطبيق "أيام" — يدعم:
// 1) تخزين مؤقت بسيط (offline caching)
// 2) استقبال إشعارات Push حقيقية من السيرفر
// 3) فتح التطبيق عند الضغط على الإشعار

const CACHE = 'ayyam-cache-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(e.request).then((resp) =>
        resp ||
        fetch(e.request)
          .then((networkResp) => {
            if (e.request.method === 'GET') {
              cache.put(e.request, networkResp.clone());
            }
            return networkResp;
          })
          .catch(() => resp)
      )
    )
  );
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
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    tag: data.tag || 'ayyam-reminder',
    renotify: true,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// عند الضغط على الإشعار: افتح التطبيق (أو ركّز عليه لو مفتوح بالفعل)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
