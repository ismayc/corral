const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SW = path.join(__dirname, '..', '..', 'public', 'sw.js');
const ORIGIN = 'https://mac.example:8443';

// Loads sw.js against stand-in worker globals and returns the handlers it registered plus what it did.
function boot({ windows = [], fetchImpl } = {}) {
  const handlers = {};
  const rec = { shown: [], opened: [], skipped: 0, claimed: 0, fetches: [] };
  globalThis.self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => { rec.skipped++; return 'skipped'; },
    clients: {
      claim: () => { rec.claimed++; return 'claimed'; },
      matchAll: async (o) => { rec.matchOpts = o; return windows; },
      openWindow: async (u) => { rec.opened.push(u); return 'opened'; },
    },
    registration: { showNotification: async (t, o) => { rec.shown.push({ title: t, ...o }); return 'shown'; } },
    location: { origin: ORIGIN },
  };
  globalThis.fetch = async (u, o) => {
    rec.fetches.push({ url: u, ...o, body: JSON.parse(o.body) });
    return fetchImpl ? fetchImpl() : { ok: true, json: async () => ({}) };
  };
  delete require.cache[require.resolve(SW)];
  require(SW);
  return { handlers, rec };
}

function event(extra = {}) {
  const waits = [];
  return { waits, waitUntil: (p) => waits.push(p), ...extra };
}

async function settle(e) { return Promise.all(e.waits); }

const win = (url, extra = {}) => {
  const c = { url, posted: [], focused: 0, postMessage: (m) => c.posted.push(m), focus: async () => { c.focused++; return 'focused'; }, ...extra };
  return c;
};

test.afterEach(() => {
  delete globalThis.self;
  delete globalThis.fetch;
  delete require.cache[require.resolve(SW)];
});

test('registers exactly install, activate, push, and notificationclick', () => {
  const { handlers } = boot();
  assert.deepEqual(Object.keys(handlers).sort(), ['activate', 'install', 'notificationclick', 'push']);
});

test('install skips waiting; activate claims clients and waits on it', async () => {
  const { handlers, rec } = boot();
  handlers.install();
  assert.equal(rec.skipped, 1);
  const e = event();
  handlers.activate(e);
  assert.equal(rec.claimed, 1);
  assert.deepEqual(await settle(e), ['claimed']);
});

test('push with a full JSON payload shows that notification', async () => {
  const { handlers, rec } = boot();
  const actions = [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }];
  const answer = { id: 's1', key: 'k9' };
  const e = event({ data: { json: () => ({ title: 'Claude', body: 'Needs you', tag: 'w7', url: '/m?w=7', actions, answer }) } });
  handlers.push(e);
  await settle(e);
  assert.deepEqual(rec.shown, [{
    title: 'Claude', body: 'Needs you', tag: 'w7', renotify: true,
    icon: '/apple-touch-icon.png', badge: '/favicon-32.png', actions,
    data: { url: '/m?w=7', answer },
  }]);
});

test('push with an empty payload falls back to defaults', async () => {
  const { handlers, rec } = boot();
  const e = event({ data: { json: () => ({}) } });
  handlers.push(e);
  await settle(e);
  assert.equal(rec.shown[0].title, 'Corral');
  assert.equal(rec.shown[0].body, '');
  assert.equal(rec.shown[0].tag, 'corral');
  assert.deepEqual(rec.shown[0].actions, []);
  assert.deepEqual(rec.shown[0].data, { url: '/m', answer: null });
});

test('push with no data at all shows the default notification', async () => {
  const { handlers, rec } = boot();
  const e = event({ data: null });
  handlers.push(e);
  await settle(e);
  assert.equal(rec.shown.length, 1);
  assert.equal(rec.shown[0].title, 'Corral');
  assert.equal(rec.shown[0].body, '');
});

test('push whose payload is not JSON uses its text as the body', async () => {
  const { handlers, rec } = boot();
  const e = event({ data: { json: () => { throw new SyntaxError('bad'); }, text: () => 'plain words' } });
  handlers.push(e);
  await settle(e);
  assert.equal(rec.shown[0].title, 'Corral');
  assert.equal(rec.shown[0].body, 'plain words');
});

test('push ignores a non-array actions value', async () => {
  const { handlers, rec } = boot();
  const e = event({ data: { json: () => ({ actions: 'allow' }) } });
  handlers.push(e);
  await settle(e);
  assert.deepEqual(rec.shown[0].actions, []);
});

function click(action, data, extra = {}) {
  const n = { title: 'Claude', tag: 'w7', data, closed: 0, close() { n.closed++; }, ...extra };
  return { n, e: event({ notification: n, action }) };
}

test('tapping a notification closes it and focuses the open phone page, telling it which window', async () => {
  const other = win(`${ORIGIN}/other`);
  const noFocus = win(`${ORIGIN}/m`);
  delete noFocus.focus; // `'focus' in c` is false
  const phone = win(`${ORIGIN}/m?x=1`);
  const { handlers, rec } = boot({ windows: [other, noFocus, phone] });
  const { n, e } = click('', { url: '/m?w=7' });
  handlers.notificationclick(e);
  const [res] = await settle(e);
  assert.equal(n.closed, 1);
  assert.equal(res, 'focused');
  assert.deepEqual(rec.matchOpts, { type: 'window', includeUncontrolled: true });
  assert.deepEqual(phone.posted, [{ open: '7' }]);
  assert.equal(phone.focused, 1);
  assert.deepEqual([other.posted, noFocus.posted], [[], []]);
  assert.deepEqual(rec.opened, []);
});

test('a page link without a w parameter posts open: null', async () => {
  const phone = win(`${ORIGIN}/m`);
  const { handlers } = boot({ windows: [phone] });
  const { e } = click('', { url: '/m' });
  handlers.notificationclick(e);
  await settle(e);
  assert.deepEqual(phone.posted, [{ open: null }]);
});

test('tapping with no phone page open opens the notification url on this origin', async () => {
  const { handlers, rec } = boot({ windows: [win(`${ORIGIN}/other`)] });
  const { e } = click('', { url: '/m?w=3' });
  handlers.notificationclick(e);
  assert.deepEqual(await settle(e), ['opened']);
  assert.deepEqual(rec.opened, [`${ORIGIN}/m?w=3`]);
});

test('a notification with no data opens /m', async () => {
  const { handlers, rec } = boot();
  const { e } = click('', undefined);
  handlers.notificationclick(e);
  await settle(e);
  assert.deepEqual(rec.opened, [`${ORIGIN}/m`]);
});

test('Allow or Deny without an answer in the data just opens the page', async () => {
  const { handlers, rec } = boot();
  const { e } = click('allow', { url: '/m?w=2', answer: null });
  handlers.notificationclick(e);
  await settle(e);
  assert.deepEqual(rec.fetches, []);
  assert.deepEqual(rec.opened, [`${ORIGIN}/m?w=2`]);
});

const ANSWER = { url: '/m?w=2', answer: { id: 'a b/1', key: 'K' } };

async function answered(action, fetchImpl) {
  const { handlers, rec } = boot({ fetchImpl });
  const { n, e } = click(action, ANSWER);
  handlers.notificationclick(e);
  await settle(e);
  assert.equal(n.closed, 1);
  assert.deepEqual(rec.opened, []);
  assert.equal(rec.shown.length, 1);
  return rec;
}

test('Allow posts choice 1 with the key to the encoded session path and confirms', async () => {
  const rec = await answered('allow');
  assert.deepEqual(rec.fetches, [{
    url: '/api/sessions/a%20b%2F1/answer', method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: { choice: '1', key: 'K' },
  }]);
  assert.deepEqual(rec.shown[0], {
    title: 'Claude', body: 'Allowed.', tag: 'w7', icon: '/apple-touch-icon.png', data: { url: '/m?w=2' },
  });
});

test('Deny posts choice deny and says Claude will ask what to do instead', async () => {
  const rec = await answered('deny');
  assert.deepEqual(rec.fetches[0].body, { choice: 'deny', key: 'K' });
  assert.equal(rec.shown[0].body, 'Denied. Claude will ask what to do instead.');
});

test('a refused answer shows the server error', async () => {
  const rec = await answered('allow', () => ({ ok: false, json: async () => ({ error: 'Another prompt is open.' }) }));
  assert.equal(rec.shown[0].body, 'Another prompt is open.');
});

test('a refused answer with no error text shows a generic message', async () => {
  const rec = await answered('deny', () => ({ ok: false, json: async () => ({}) }));
  assert.equal(rec.shown[0].body, 'Could not answer.');
});

test('an unreadable reply body counts as empty', async () => {
  const rec = await answered('allow', () => ({ ok: false, json: async () => { throw new Error('not json'); } }));
  assert.equal(rec.shown[0].body, 'Could not answer.');
});

test('a network failure says the Mac could not be reached', async () => {
  const rec = await answered('allow', () => { throw new TypeError('offline'); });
  assert.equal(rec.shown[0].body, 'Could not reach the Mac.');
});
