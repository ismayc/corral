// Corral's service worker: shows the pushes the Mac sends (a window's turn, or a permission prompt) and,
// when one is tapped, opens the phone page on that window. It caches nothing; the page always comes live
// from the Mac.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Corral', {
    body: m.body || '',
    tag: m.tag || 'corral', // a newer notice for the same window replaces the older one
    renotify: true,
    icon: '/apple-touch-icon.png',
    badge: '/favicon-32.png',
    data: { url: m.url || '/m' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/m', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if (new URL(c.url).pathname === '/m' && 'focus' in c) {
        c.postMessage({ open: new URL(url).searchParams.get('w') });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
