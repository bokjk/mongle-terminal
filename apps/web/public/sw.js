/* Mongle Terminal notification worker. Shows Web Push messages from this PC and opens the matching screen.
   It has no fetch handler and caches nothing, so pages always load from the PC. */
const ORIGIN = self.location.origin;

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

function text(value, fallback, length) { return typeof value === 'string' && value ? value.slice(0, length) : fallback; }
function page(value) { return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'; }

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const tag = text(data.tag, 'mongle', 80);
  event.waitUntil(self.registration.showNotification(text(data.title, '몽글터미널', 80), {
    body: text(data.body, '확인할 알림이 있습니다.', 240),
    tag, renotify: true, icon: '/icon-192.png',
    timestamp: Number.isFinite(data.ts) ? data.ts : Date.now(),
    data: { url: page(data.url) },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(page(event.notification.data && event.notification.data.url), ORIGIN);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== ORIGIN) continue;
      try { await client.focus(); } catch { /* the page still receives the message */ }
      client.postMessage({ type: 'mongle.notification', url: url.pathname + url.search });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
