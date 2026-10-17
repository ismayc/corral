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
    actions: Array.isArray(m.actions) ? m.actions : [],
    data: { url: m.url || '/m', answer: m.answer || null },
  }));
});

// Allow or Deny pressed on the notification (phones and browsers that show its buttons; an iPhone does
// not). The answer names the prompt it was shown for, so the Mac refuses it if another prompt is open now.
async function answer(n, action) {
  const a = n.data?.answer;
  let msg;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(a.id)}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: action === 'allow' ? '1' : 'deny', key: a.key }),
    });
    const j = await r.json().catch(() => ({}));
    msg = r.ok ? (action === 'allow' ? 'Allowed.' : 'Denied. Claude will ask what to do instead.') : j.error || 'Could not answer.';
  } catch { msg = 'Could not reach the Mac.'; }
  return self.registration.showNotification(n.title, { body: msg, tag: n.tag, icon: '/apple-touch-icon.png', data: { url: n.data.url } });
}

// An iPhone can drop the message posted to a page that is still asleep, and the page then wakes on the
// window it showed last. So the tapped window is also left in Cache Storage, and the page takes it from
// there when it comes back (takeTap in m.js).
async function remember(id) {
  try { await (await caches.open('corral-tap')).put('/tap', new Response(JSON.stringify({ id, t: Date.now() }))); } catch {}
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if ((e.action === 'allow' || e.action === 'deny') && e.notification.data?.answer) return e.waitUntil(answer(e.notification, e.action));
  const url = new URL(e.notification.data?.url || '/m', self.location.origin).href;
  const w = new URL(url).searchParams.get('w');
  e.waitUntil((async () => {
    if (w) await remember(w);
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if (new URL(c.url).pathname === '/m' && 'focus' in c) {
        c.postMessage({ open: w });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
