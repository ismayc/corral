// Notifications: the Alerts sheet, turning Web Push on and off, its settings, and tapped notifications.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, win, settle, unloadPage } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const ps = (p) => p.$$('#notifybody p').map((x) => x.textContent);
const boxes = (p) => Object.fromEntries(p.$$('#notifybody label.row').map((l) => [l.querySelector('span').firstChild.textContent, l.querySelector('input').checked]));
async function alerts(p) {
  p.$('#bell').click();
  assert.equal(p.$('#notify').hidden, false);
  await settle();
}
function subscribed(p) {
  p.Notification.permission = 'granted';
  p.sw.subscription = { endpoint: 'https://web.push.apple.com/xyz', unsubscribe: async () => { p.sw.subscription = null; return true; } };
}

test('the Alerts sheet says Checking while it asks the Mac', async () => {
  const p = await phone([]);
  p.$('#bell').click();
  assert.equal(p.text('#notifybody'), 'Checking…');
});

test('Alerts says so when the Mac cannot be reached', async () => {
  const p = await phone([], { routes: { 'GET /api/push': new Error('offline') } });
  await alerts(p);
  assert.deepEqual(ps(p), ['Could not reach the Mac.']);
});

test('on an iPhone outside the Home Screen app, Alerts explains how to add it', async () => {
  const p = await phone([], { userAgent: IPHONE, noPush: true });
  await alerts(p);
  assert.equal(ps(p)[0], 'On an iPhone, notifications work only for Corral opened from the Home Screen.');
  assert.deepEqual(p.$$('#notifybody ol li').map((li) => li.textContent), [
    'Tap the Share button in Safari.', 'Choose Add to Home Screen, then Add.', 'Open Corral from its new Home Screen icon and come back here.']);
  // The Mac's keep-awake setting is there either way.
  assert.deepEqual(boxes(p), { 'Keep the Mac awake while Claude works': true });
});

test('a browser without push, or a page that is not secure, cannot get notifications', async () => {
  for (const opts of [{ noPush: true }, { noNotification: true }, { noServiceWorker: true }, { secure: false }, { userAgent: IPHONE, standalone: true, noPush: true }, { userAgent: IPHONE, media: { '(display-mode: standalone)': true }, noPush: true }]) {
    const p = await phone([], opts);
    await alerts(p);
    assert.equal(ps(p)[0], 'This browser cannot get notifications from Corral.', JSON.stringify(opts));
    assert.equal(p.$('#notifybody ol'), null);
    unloadPage();
  }
});

test('blocked notifications point to the phone\'s Settings app', async () => {
  const p = await phone([], { notificationPermission: 'denied' });
  await alerts(p);
  assert.match(ps(p)[0], /^Notifications are blocked for Corral\./);
  assert.equal(p.button('Turn on notifications'), undefined);
});

test('Turn on notifications asks, subscribes with the Mac\'s key, and registers the phone', async () => {
  const p = await phone([], { routes: {
    'GET /api/push': { key: 'B-_A', devices: 0, prefs: { turn: true, permission: false, away: true, awake: false } },
    'POST /api/push/subscribe': { ok: true, devices: 1 },
  } });
  await alerts(p);
  assert.equal(ps(p)[0], 'Get a notification on this phone when a window needs you, even when Corral is closed.');
  p.button('Turn on notifications').click();
  await settle();
  assert.deepEqual([...p.sw.subscription.options.applicationServerKey], [7, 239, 192]);
  assert.equal(p.sw.subscription.options.userVisibleOnly, true);
  assert.deepEqual(p.api.called('POST', '/api/push/subscribe')[0].body, { subscription: { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } } });
  assert.equal(p.toast(), 'Notifications are on.');
  assert.equal(ps(p)[0], 'Notifications are on for this device.');
  assert.deepEqual(boxes(p), {
    'A permission prompt opens': false, 'Claude finishes its turn': true, 'Only when I am away from the Mac': true, 'Keep the Mac awake while Claude works': false,
  });
});

test('declining the permission leaves notifications off without a notice', async () => {
  const p = await phone([]);
  p.Notification.answer = 'denied';
  await alerts(p);
  p.button('Turn on notifications').click();
  await settle();
  assert.equal(p.sw.subscription, null);
  assert.equal(p.toast(), null);
  assert.match(ps(p)[0], /blocked/);
});

test('a subscription that fails says why', async () => {
  const p = await phone([]);
  p.sw.subscribeError = new Error('push service unavailable');
  await alerts(p);
  p.button('Turn on notifications').click();
  await settle();
  assert.equal(p.toast(), 'Could not turn on notifications (push service unavailable).');
  assert.equal(p.button('Turn on notifications').textContent, 'Turn on notifications');
});

test('on an iPhone with notifications on, the sheet names the iPhone', async () => {
  const p = await phone([], { userAgent: IPHONE, standalone: true });
  subscribed(p);
  await alerts(p);
  assert.equal(ps(p)[0], 'Notifications are on for this iPhone.');
});

test('a setting change is saved on the Mac, and a failed save says so', async () => {
  const p = await phone([], { routes: { 'POST /api/push/prefs': { prefs: {} } } });
  subscribed(p);
  await alerts(p);
  const box = (label) => p.$$('#notifybody label.row').find((l) => l.textContent.startsWith(label)).querySelector('input');
  box('A permission prompt opens').checked = false;
  box('A permission prompt opens').dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/push/prefs')[0].body, { permission: false });
  p.api.routes['POST /api/push/prefs'] = { __reply: true, status: 400, body: { error: 'bad json' } };
  box('Keep the Mac awake').dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/push/prefs')[1].body, { awake: true });
  assert.equal(p.toast(), 'Could not save that.');
});

test('Send a test asks the Mac to notify this phone and reports the result', async () => {
  const p = await phone([], { routes: { 'POST /api/push/test': { ok: true } } });
  subscribed(p);
  await alerts(p);
  p.button('Send a test').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/push/test')[0].body, { endpoint: 'https://web.push.apple.com/xyz' });
  assert.equal(p.toast(), 'Sent. It should arrive in a few seconds.');
  p.api.routes['POST /api/push/test'] = { __reply: true, status: 404, body: { error: 'this device is not subscribed' } };
  p.button('Send a test').click();
  await settle();
  assert.equal(p.toast(), 'The test did not go through.');
});

test('Turn off unsubscribes on the Mac and on the phone', async () => {
  const p = await phone([], { routes: { 'POST /api/push/unsubscribe': { ok: true, devices: 0 } } });
  subscribed(p);
  await alerts(p);
  p.button('Turn off on this device').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/push/unsubscribe')[0].body, { endpoint: 'https://web.push.apple.com/xyz' });
  assert.equal(p.sw.subscription, null);
  assert.equal(p.toast(), 'Notifications are off on this device.');
  assert.equal(p.button('Turn on notifications').textContent, 'Turn on notifications');
});

test('Turn off still finishes when the Mac or the phone fails to unsubscribe', async () => {
  const p = await phone([], { routes: { 'POST /api/push/unsubscribe': new Error('offline') } });
  subscribed(p);
  p.sw.subscription.unsubscribe = async () => { throw new Error('no'); };
  await alerts(p);
  p.button('Turn off on this device').click();
  await settle();
  assert.equal(p.toast(), 'Notifications are off on this device.');
});

test('Turn off with no subscription left just says notifications are off', async () => {
  const p = await phone([]);
  subscribed(p);
  await alerts(p);
  p.sw.subscription = null;
  p.button('Turn off on this device').click();
  await settle();
  assert.equal(p.api.called('POST', '/api/push/unsubscribe').length, 0);
  assert.equal(p.toast(), 'Notifications are off on this device.');
});

test('permission granted without a subscription still offers to turn notifications on', async () => {
  const p = await phone([], { notificationPermission: 'granted' });
  await alerts(p);
  assert.ok(p.button('Turn on notifications'));
});

test('the Alerts sheet closes with its × or a tap outside it', async () => {
  const p = await phone([]);
  await alerts(p);
  p.$('#notifybody').click();
  assert.equal(p.$('#notify').hidden, false);
  p.$('#notify').click();
  assert.equal(p.$('#notify').hidden, true);
  await alerts(p);
  p.$('#notifyx').click();
  assert.equal(p.$('#notify').hidden, true);
});

test('the page registers its service worker only in a secure context', async () => {
  let p = await phone([]);
  assert.deepEqual(p.sw.registrations.map((r) => r.url), ['/sw.js']);
  unloadPage();
  p = await phone([], { secure: false });
  assert.equal(p.sw.registrations.length, 0);
  p.sw.emit('message', { open: 'a' });
  await settle();
  assert.equal(p.$('#termview').hidden, true);
});

test('a service worker that fails to register leaves the page working', async () => {
  const p = await phone([win('a')], { setup: (w) => { w.navigator.serviceWorker.register = async () => { throw new Error('blocked'); }; } });
  await settle();
  assert.ok(p.card('a'));
});

test('a tapped notification opens its window, and other worker messages are ignored', async () => {
  const p = await phone([win('a')]);
  p.sw.emit('message', {});
  p.sw.emit('message', null);
  p.sw.emit('message', { open: '' });
  await settle();
  assert.equal(p.$('#termview').hidden, true);
  p.sw.emit('message', { open: 'a' });
  await settle();
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'a');
});

test('a tapped notification before the list has loaded waits for it', async () => {
  const p = await phone([], { routes: { 'GET /api/overview': { machine: 'M', sessions: [] } } });
  p.api.routes['GET /api/overview'] = { machine: 'M', sessions: [win('late')] };
  p.sw.emit('message', { open: 'late' });
  await settle();
  assert.equal(p.text('#ttitle'), 'late');
});
