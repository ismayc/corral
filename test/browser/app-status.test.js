const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, status, flush, fire } = require('../helpers/app');

test.afterEach(stop);

const PROMPT = { key: 'k1', text: 'Run ls?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: "Yes, and don't ask again" }, { n: 3, label: 'No, and tell Claude what to do' }] };
// Two windows, a and b, with the overview answering whatever `now` holds.
async function two(extra = {}) {
  const now = { sessions: [status('a'), status('b')] };
  const p = await start({
    ...extra,
    routes: {
      'GET /api/sessions': { sessions: [session('a'), session('b')] },
      'GET /api/overview': () => now,
      ...extra.routes,
    },
  });
  p.now = now;
  p.set = (id, fields) => { const i = now.sessions.findIndex((s) => s.id === id); now.sessions[i] = { ...now.sessions[i], ...fields }; };
  p.poll = async () => { p.tick(3000); await flush(); };
  return p;
}

test('a status poll with no answer, or no window list, changes nothing', async () => {
  const p = await two();
  p.api.routes['GET /api/overview'] = new Error('offline');
  await p.poll();
  p.api.routes['GET /api/overview'] = {};
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'b']);
});

test('a window closed on another device disappears here', async () => {
  const p = await two({ routes: { 'GET /api/herdr': { available: true, spaces: [space('a', { cwd: '/Users/me/repos/a' })] } } });
  assert.deepEqual(p.secs(), ['Open windows (1)']);
  p.sockets[0].open();
  p.now.sessions = [status('b')];
  await p.poll();
  assert.deepEqual(p.wins(), ['b']);
  assert.ok(p.terms[0].disposed);
  assert.equal(p.sockets[0].readyState, 3);
  assert.equal(p.tick(1500), 0, 'no reconnect');
  assert.deepEqual(p.store('corral.open'), ['b']);
  assert.deepEqual(p.secs(), []);
});

test('a window whose shell exited stays until it is closed here', async () => {
  const p = await two();
  p.set('a', { exited: true });
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'b']);
});

test('a window renamed on another device shows its new name', async () => {
  const p = await two({ storage: { 'corral.layout': '"full"' } });
  p.set('b', { label: 'renamed' });
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'renamed']);
  assert.deepEqual(p.chips(), ['renamed']);
});

test('a permission prompt shows Allow and Deny buttons, and goes away once answered elsewhere', async () => {
  const p = await two();
  p.set('a', { prompt: PROMPT, claude: { status: 'waiting' } });
  await p.poll();
  const win = p.slotOf('a').querySelector('.win');
  assert.ok(win.classList.contains('asking'));
  const bar = win.querySelector('.ask');
  assert.equal(bar.previousElementSibling, win.querySelector('.title'));
  assert.equal(bar.querySelector('b').textContent, 'Claude is asking for permission:');
  assert.deepEqual([...bar.querySelectorAll('button')].map((b) => [b.textContent, b.className, b.title]), [
    ['Yes', 'allow', 'Answer 1'], ["Yes, and don't ask again", '', 'Answer 2'], ['Deny', 'deny', 'Esc'],
  ]);
  // The same prompt on the next poll keeps the same bar.
  await p.poll();
  assert.equal(win.querySelector('.ask'), bar);
  await p.frame();
  p.set('a', { prompt: null, claude: { status: 'busy' } });
  await p.poll();
  assert.equal(win.querySelector('.ask'), null);
  assert.ok(!win.classList.contains('asking'));
});

test('a minimized window that is asking shows a marked chip', async () => {
  const p = await two();
  p.slotOf('b').querySelector('.min').click();
  p.set('b', { prompt: PROMPT });
  await p.poll();
  assert.deepEqual(p.chips(), ['● b']);
  assert.equal(p.$('#tray .chip').className, 'chip min asking');
});

test('Allow sends the option number with the prompt key and checks again soon after', async () => {
  const p = await two({ routes: { 'POST /api/sessions/*/answer': { ok: true } } });
  p.set('a', { prompt: PROMPT });
  await p.poll();
  const buttons = [...p.slotOf('a').querySelectorAll('.ask button')];
  buttons[0].click();
  assert.ok(buttons.every((b) => b.disabled));
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/answer')[0].body, { choice: 1, key: 'k1' });
  assert.equal(p.toast(), 'Answered: Yes');
  const polls = p.api.called('GET', '/api/overview').length;
  p.set('a', { prompt: null });
  assert.equal(p.tick(600), 1);
  await flush();
  assert.equal(p.api.called('GET', '/api/overview').length, polls + 1);
  assert.equal(p.slotOf('a').querySelector('.ask'), null);
});

test('Deny sends deny and says Claude will ask what to do instead', async () => {
  const p = await two({ routes: { 'POST /api/sessions/*/answer': { ok: true } } });
  p.set('a', { prompt: PROMPT });
  await p.poll();
  p.slotOf('a').querySelector('.ask .deny').click();
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/answer')[0].body, { choice: 'deny', key: 'k1' });
  assert.equal(p.toast(), 'Denied. a will ask what to do instead.');
});

test('an answer the server refuses shows its error, and no answer says Corral is unreachable', async () => {
  const p = await two({ routes: { 'POST /api/sessions/*/answer': { __reply: true, status: 409, body: { error: 'the prompt changed' } } } });
  p.set('a', { prompt: PROMPT });
  await p.poll();
  p.slotOf('a').querySelector('.ask .allow').click();
  await flush();
  assert.equal(p.toast(), 'the prompt changed');
  // Each try gets a fresh prompt, since answering disables the buttons.
  p.set('a', { prompt: { ...PROMPT, key: 'k2' } });
  await p.poll();
  p.api.routes['POST /api/sessions/*/answer'] = { __reply: true, status: 502, body: 'Bad gateway', type: 'text/plain' };
  p.slotOf('a').querySelector('.ask .allow').click();
  await flush();
  assert.equal(p.toast(), 'Could not reach Corral.');
  p.set('a', { prompt: { ...PROMPT, key: 'k3' } });
  await p.poll();
  p.api.routes['POST /api/sessions/*/answer'] = new Error('offline');
  p.slotOf('a').querySelector('.ask .deny').click();
  await flush();
  assert.equal(p.toast(), 'Could not reach Corral.');
});

const alertsOn = { storage: { 'corral.alerts': true }, notificationPermission: 'granted' };

test('with alerts on, a minimized window that starts waiting raises a notification', async () => {
  const p = await two(alertsOn);
  assert.equal(p.$('#alerts').textContent, 'Alerts: on');
  p.slotOf('a').querySelector('.min').click();
  p.set('a', { claude: { status: 'waiting' }, prompt: PROMPT });
  await p.poll();
  assert.equal(p.Notification.shown.length, 1);
  const n = p.Notification.shown[0];
  assert.equal(n.title, 'a needs you');
  assert.deepEqual(n.opts, { body: 'Claude is asking for permission.', tag: 'a', icon: '/apple-touch-icon.png' });
  // Clicking it brings the window back and focuses it.
  n.onclick();
  assert.ok(n.closed);
  assert.deepEqual(p.chips(), []);
  assert.ok(p.slotOf('a').querySelector('.win').classList.contains('focus'));
});

test('with alerts on, a window waiting without a prompt, or finishing a turn, notifies while the page is hidden', async () => {
  const p = await two(alertsOn);
  Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true });
  p.set('a', { claude: { status: 'waiting' } });
  p.set('b', { claude: { status: 'busy' } });
  await p.poll();
  p.set('b', { claude: { status: 'idle' } });
  await p.poll();
  assert.deepEqual(p.Notification.shown.map((n) => [n.title, n.opts.body]), [
    ['a needs you', 'Claude is waiting on a prompt.'],
    ['b: your turn', 'Claude finished and is waiting for you.'],
  ]);
  // A notification for a window in a zone just focuses it.
  p.Notification.shown[1].onclick();
  assert.ok(p.slotOf('b').querySelector('.win').classList.contains('focus'));
});

test('a window waiting for a free zone counts as unseen', async () => {
  const p = await two({ ...alertsOn, storage: { ...alertsOn.storage, 'corral.layout': '"full"' } });
  p.set('b', { claude: { status: 'waiting' } });
  await p.poll();
  assert.equal(p.Notification.shown.length, 1);
  p.Notification.shown[0].onclick();
  assert.deepEqual(p.visible(), ['b']);
});

test('no notification for a visible window, a muted one, a change to busy, or with alerts off', async () => {
  const p = await two(alertsOn);
  p.set('a', { claude: { status: 'waiting' } });
  await p.poll();
  Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true });
  p.set('a', { claude: { status: 'busy' } });
  p.set('b', { claude: { status: 'waiting' }, muted: true });
  await p.poll();
  assert.equal(p.Notification.shown.length, 0);
  p.$('#alerts').click();
  await flush();
  assert.equal(p.$('#alerts').textContent, 'Alerts: off');
  p.set('a', { claude: { status: 'idle' } });
  await p.poll();
  assert.equal(p.Notification.shown.length, 0);
});

test('a notification for a window closed since then only focuses the page', async () => {
  const p = await two(alertsOn);
  p.slotOf('a').querySelector('.min').click();
  p.set('a', { claude: { status: 'waiting' } });
  await p.poll();
  p.now.sessions = [status('b')];
  await p.poll();
  const n = p.Notification.shown[0];
  n.onclick();
  assert.ok(n.closed);
  assert.deepEqual(p.wins(), ['b']);
});

test('Alerts asks for permission the first time and then turns on', async () => {
  const p = await start();
  assert.equal(p.$('#alerts').textContent, 'Alerts: off');
  p.$('#alerts').click();
  await flush();
  assert.equal(p.Notification.permission, 'granted');
  assert.equal(p.$('#alerts').textContent, 'Alerts: on');
  assert.equal(p.store('corral.alerts'), true);
  assert.match(p.toast(), /^A notification will appear/);
  p.$('#alerts').click();
  await flush();
  assert.equal(p.store('corral.alerts'), false);
  assert.equal(p.toast(), 'Desktop alerts are off.');
});

test('Alerts with permission already granted does not ask again', async () => {
  const p = await start({ notificationPermission: 'granted' });
  p.Notification.requestPermission = async () => { throw new Error('should not ask'); };
  p.$('#alerts').click();
  await flush();
  assert.equal(p.$('#alerts').textContent, 'Alerts: on');
});

test('Alerts says so when notifications are blocked', async () => {
  const p = await start({ storage: { 'corral.alerts': true }, notificationPermission: 'denied' });
  assert.equal(p.$('#alerts').textContent, 'Alerts: off');
  p.Notification.answer = 'denied';
  p.$('#alerts').click();
  await flush();
  assert.equal(p.toast(), 'Notifications are blocked for this page in the browser settings.');
  assert.equal(p.$('#alerts').textContent, 'Alerts: off');
});

test('Alerts says so when the browser has no notifications', async () => {
  const p = await start({ noNotification: true, storage: { 'corral.alerts': true } });
  assert.equal(p.$('#alerts').textContent, 'Alerts: off');
  p.$('#alerts').click();
  await flush();
  assert.equal(p.toast(), 'This browser cannot show notifications.');
});

test('a window started elsewhere is picked up on the second poll that sees it, into the bottom bar', async () => {
  const p = await two();
  const list = p.api.routes['GET /api/sessions'].sessions;
  list.push(session('x', { label: 'phone one', remote: true }), session('gone', { exited: true }));
  p.now.sessions.push(status('x', { label: 'phone one' }));
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'b']);
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'b', 'phone one']);
  assert.deepEqual(p.chips(), ['phone one']);
  assert.equal(p.slotOf('phone one').hidden, true);
  assert.ok(!p.terms[2].focused);
  assert.equal(p.toast(), 'phone one was started on another device. It is in the bottom bar.');
});

test('several windows started elsewhere are announced together, and local ones say elsewhere', async () => {
  const p = await two();
  const list = p.api.routes['GET /api/sessions'].sessions;
  list.push(session('x'));
  p.now.sessions.push(status('x'));
  await p.poll();
  await p.poll();
  assert.equal(p.toast(), 'x was started elsewhere. It is in the bottom bar.');
  list.push(session('y'), session('z'));
  p.now.sessions.push(status('y'), status('z'));
  // Coming back to the page checks right away.
  fire(p.doc.body, 'visibilitychange');
  await flush();
  fire(p.doc.body, 'visibilitychange');
  await flush();
  assert.equal(p.toast(), '2 windows were started elsewhere. They are in the bottom bar.');
  assert.deepEqual(p.chips().sort(), ['x', 'y', 'z']);
});

test('a hidden page does not check for new windows, and a failed check changes nothing', async () => {
  const p = await two();
  const calls = () => p.api.called('GET', '/api/sessions').length;
  const before = calls();
  Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true });
  fire(p.doc.body, 'visibilitychange');
  await flush();
  assert.equal(calls(), before);
  p.api.routes['GET /api/sessions'] = new Error('offline');
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'b']);
});
