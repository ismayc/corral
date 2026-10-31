// Corral's service worker: shows the pushes the Mac sends (a window's turn, or a permission prompt) and,
// when one is tapped, opens the phone page on that window. It caches nothing; the page always comes live
// from the Mac, and when the Mac cannot be reached a page load gets a page saying so.
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
  try { await (await caches.open('corral-tap')).put('/tap', new Response(JSON.stringify({ id, t: Date.now() }))); return true; } catch { return false; }
}
// Whether the tap is still waiting there; the page deletes it when it opens the window.
async function untaken() {
  try { return Boolean(await (await caches.open('corral-tap')).match('/tap')); } catch { return false; }
}
// If the page has not taken the tap after this long, neither the message nor its own look reached it,
// so it is loaded again at the window's link.
const TAP_WAIT = 2500;

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if ((e.action === 'allow' || e.action === 'deny') && e.notification.data?.answer) return e.waitUntil(answer(e.notification, e.action));
  const url = new URL(e.notification.data?.url || '/m', self.location.origin).href;
  const w = new URL(url).searchParams.get('w');
  e.waitUntil((async () => {
    const stored = w ? await remember(w) : false;
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if (new URL(c.url).pathname === '/m' && 'focus' in c) {
        c.postMessage({ open: w });
        const focused = await c.focus();
        if (stored && 'navigate' in c) {
          await new Promise((r) => setTimeout(r, TAP_WAIT));
          if (await untaken()) await c.navigate(url).catch(() => {});
        }
        return focused;
      }
    }
    return self.clients.openWindow(url);
  })());
});

// A page load that fails, or has no answer in NAV_WAIT (the Mac asleep, or its Tailscale off), gets a short
// page saying so instead of the browser's error, linking to the Corral watch page on another Mac when the
// phone page has left its address (rememberWatch in m.js).
const NAV_WAIT = 10000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function unreachable() {
  let watch = null;
  try { watch = await (await (await caches.open('corral-watch')).match('/watch'))?.text(); } catch {}
  const link = watch ? `<p><a class="b" href="${esc(watch)}">See why on the watching Mac</a></p>`
    : '<p>scripts/corral-watch.js on another Mac at home can find out why, and wake this one.</p>';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corral: the Mac does not answer</title><style>:root{color-scheme:light dark;--bg:#1b1823;--fg:#ecebf2;--muted:#a9a4b8}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,system-ui,sans-serif}main{max-width:32rem;padding:3rem 16px}
h1{font-size:1.3rem;line-height:1.3}p{color:var(--muted)}a{color:inherit}.b,button{display:inline-block;font:inherit;color:var(--bg);background:var(--fg);border:0;border-radius:10px;padding:.55rem .9rem;text-decoration:none}</style>
</head><body><main><h1>The Mac running Corral does not answer</h1><p>It may be asleep or away, or Tailscale on it may be off.</p>${link}
<p><button onclick="location.reload()">Try again</button></p></main></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function load(req) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NAV_WAIT);
  const r = await fetch(req, { signal: ctl.signal }).catch(() => null);
  clearTimeout(t);
  return r || unreachable();
}

self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') e.respondWith(load(e.request));
});
