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

test("a space's dot in the sidebar takes its open window's color, and herdr's status without one", async () => {
  const p = await two({ routes: { 'GET /api/herdr': { available: true, spaces: [
    space('a', { cwd: '/Users/me/repos/a', status: 'unknown' }), space('z', { cwd: '/Users/me/repos/z', status: 'working' })] } } });
  const dot = (id) => p.$(`#spaces .space[data-id="${id}"] .dot`).className;
  assert.equal(dot('z'), 'dot working', 'no window: herdr says');
  p.set('a', { claude: { status: 'busy' } });
  await p.poll();
  assert.equal(dot('a'), 'dot working');
  p.set('a', { claude: { status: 'idle' } });
  await p.poll();
  assert.equal(dot('a'), 'dot idle');
  p.sockets[0].open();
  p.sockets[0].drop();
  assert.equal(dot('a'), 'dot blocked');
  p.set('a', { claude: null });
  p.tick(1500);
  p.sockets.at(-1).open();
  await p.poll();
  assert.equal(dot('a'), 'dot unknown', 'a plain shell falls back to herdr');
  // The 10-second herdr check keeps the window's color.
  p.set('a', { claude: { status: 'busy' } });
  await p.poll();
  p.tick(10000);
  await flush();
  assert.equal(dot('a'), 'dot working');
  // Closing the window hands the dot back to herdr.
  p.slotOf('a').querySelector('.close').click();
  await flush();
  assert.equal(dot('a'), 'dot unknown');
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
  p.set('b', { prompt: PROMPT, claude: { status: 'waiting', waitingFor: 'permission prompt' } });
  await p.poll();
  assert.deepEqual(p.chips(), ['b']);
  assert.equal(p.$('#tray .chip').className, 'chip min asking');
  assert.equal(p.$('#tray .chip .dot').className, 'dot idle');
});

test('each window is colored by what it is doing: working, your turn, or cut off', async () => {
  const p = await two();
  const win = p.slotOf('a').querySelector('.win');
  const dot = win.querySelector('.title .dot');
  const seen = () => [win.dataset.state, dot.className, dot.title];
  p.set('a', { claude: null });
  await p.poll();
  assert.deepEqual(seen(), [undefined, 'dot ', ''], 'a plain shell has no color');
  p.set('a', { claude: { status: 'busy' } });
  await p.poll();
  assert.deepEqual(seen(), ['working', 'dot working', 'Claude is working.']);
  p.set('a', { claude: { status: 'idle' } });
  await p.poll();
  assert.deepEqual(seen(), ['idle', 'dot idle', 'Your turn: Claude finished.']);
  p.set('a', { claude: { status: 'waiting', waitingFor: 'permission prompt' } });
  await p.poll();
  assert.deepEqual(seen(), ['idle', 'dot idle', 'Claude is asking for permission.']);
  p.set('a', { claude: { status: 'waiting', waitingFor: 'input' } });
  await p.poll();
  assert.deepEqual(seen(), ['idle', 'dot idle', 'Claude is waiting on a prompt.']);
  // A dropped connection is red until it reconnects, minimized or not.
  p.slotOf('a').querySelector('.min').click();
  p.sockets[0].open();
  p.sockets[0].drop();
  assert.deepEqual(seen(), ['blocked', 'dot blocked', 'Disconnected from Corral. Reconnecting…']);
  assert.equal(p.$('#tray .chip .dot').className, 'dot blocked');
  p.tick(1500);
  p.sockets.at(-1).open();
  assert.deepEqual(seen(), ['idle', 'dot idle', 'Claude is waiting on a prompt.']);
  assert.equal(p.$('#tray .chip .dot').className, 'dot idle');
  p.set('a', { exited: true, claude: null });
  await p.poll();
  assert.deepEqual(seen(), ['blocked', 'dot blocked', 'The shell ended. Close this window.']);
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

test('a window started with a task from another app comes into view on the first poll that sees it, with the keyboard', async () => {
  const p = await two();
  p.api.routes['GET /api/sessions'].sessions.push(session('m', { label: 'mail job', summoned: 100 }));
  p.now.sessions.push(status('m', { label: 'mail job' }));
  await p.poll();
  assert.deepEqual(p.wins(), ['a', 'b', 'mail job']);
  assert.deepEqual(p.chips(), []);
  assert.equal(p.slotOf('mail job').hidden, false);
  assert.ok(p.terms[2].focused);
  assert.equal(p.toast(), 'mail job was started with a task from another app. Here it is.');
});

test('a minimized window given a new task comes out of the bottom bar, once per task', async () => {
  const p = await two();
  const list = p.api.routes['GET /api/sessions'].sessions;
  p.slotOf('a').querySelector('.min').click();
  assert.deepEqual(p.chips(), ['a']);
  list[0] = session('a', { summoned: 200 });
  await p.poll();
  assert.deepEqual(p.chips(), []);
  assert.ok(p.terms[0].focused);
  assert.equal(p.toast(), 'a was given a task from another app. Here it is.');
  // The same task does not pull it back out after it is minimized again; a new one does.
  p.slotOf('a').querySelector('.min').click();
  await p.poll();
  assert.deepEqual(p.chips(), ['a']);
  list[0] = session('a', { summoned: 300 });
  await p.poll();
  assert.deepEqual(p.chips(), []);
  // One already in a zone takes the keyboard.
  p.terms.forEach((t) => t.blur());
  list[1] = session('b', { summoned: 400 });
  await p.poll();
  assert.deepEqual(p.terms.map((t) => Boolean(t.focused)), [false, true]);
  assert.deepEqual(p.visible().sort(), ['a', 'b']);
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

test('Open windows lists the latest change first: a Claude status change, or a shell\'s last output', async () => {
  const now = { sessions: [status('a'), status('b'), status('c')] };
  const p = await start({ routes: {
    'GET /api/herdr': { available: true, spaces: [space('a'), space('b'), space('c'), space('d')] },
    'GET /api/sessions': { sessions: [session('a'), session('b'), session('c')] },
    'GET /api/overview': () => now,
  } });
  const set = (id, fields) => { const i = now.sessions.findIndex((s) => s.id === id); now.sessions[i] = { ...now.sessions[i], ...fields }; };
  const poll = async () => { p.tick(3000); await flush(); };
  await poll();
  assert.deepEqual(p.rowNames(), ['a', 'b', 'c', 'd'], 'no times yet: alphabetical');
  // An idle Claude's screen redraws keep tmux's time fresh, so a Claude window goes by its status change.
  set('a', { claude: { status: 'idle', since: 1000 }, activity: 9000 });
  set('b', { claude: { status: 'idle', since: 5000 }, activity: 2000 });
  set('c', { claude: null, activity: 3000 });
  await poll();
  assert.deepEqual(p.rowNames(), ['b', 'c', 'a', 'd']);
  let moved = 0;
  new p.window.MutationObserver((m) => { moved += m.length; }).observe(p.$('#spaces'), { childList: true });
  await poll();
  await flush();
  assert.equal(moved, 0, 'the same order is not redrawn');
  set('a', { claude: { status: 'busy', since: 8000 } });
  await poll();
  assert.deepEqual(p.rowNames(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(p.secs(), ['Open windows (3)', 'All spaces (1)']);
});

test('windows last cleared with /clear sit under Parked windows, below Open windows, and move back when used', async () => {
  const now = { sessions: [status('a', { claude: { status: 'idle', since: 9000, cleared: true } }), status('b', { claude: { status: 'idle', since: 1000 } }),
    status('c', { claude: { status: 'idle', since: 3000, cleared: true } })] };
  const p = await start({ routes: {
    'GET /api/herdr': { available: true, spaces: [space('a'), space('b'), space('c'), space('d')] },
    'GET /api/sessions': { sessions: [session('a'), session('b'), session('c')] },
    'GET /api/overview': () => now,
  } });
  const poll = async () => { p.tick(3000); await flush(); };
  await poll();
  assert.deepEqual(p.secs(), ['Open windows (1)', 'Parked windows (2)', 'All spaces (1)']);
  assert.deepEqual(p.rowNames(), ['b', 'a', 'c', 'd']);
  // Typing in a cleared window moves it back under Open windows, by its latest change.
  now.sessions[2] = status('c', { claude: { status: 'busy', since: 3000 } });
  await poll();
  assert.deepEqual(p.secs(), ['Open windows (2)', 'Parked windows (1)', 'All spaces (1)']);
  assert.deepEqual(p.rowNames(), ['c', 'b', 'a', 'd']);
  now.sessions[0] = status('a', { claude: { status: 'busy', since: 9500 } });
  await poll();
  assert.deepEqual(p.secs(), ['Open windows (3)', 'All spaces (1)']);
});

test('windows Claude Code compacted on its own sit under Auto-compacted windows, between Open and Parked, once idle', async () => {
  const now = { sessions: [status('a', { claude: { status: 'idle', since: 9000, cleared: true } }), status('b', { claude: { status: 'idle', since: 1000 } }),
    status('c', { claude: { status: 'idle', since: 3000, compacted: true } }), status('d', { claude: { status: 'busy', since: 2000, compacted: true } })] };
  const p = await start({ routes: {
    'GET /api/herdr': { available: true, spaces: [space('a'), space('b'), space('c'), space('d')] },
    'GET /api/sessions': { sessions: [session('a'), session('b'), session('c'), session('d')] },
    'GET /api/overview': () => now,
  } });
  const poll = async () => { p.tick(3000); await flush(); };
  await poll();
  assert.deepEqual(p.secs(), ['Open windows (2)', 'Auto-compacted windows (1)', 'Parked windows (1)']);
  assert.deepEqual(p.rowNames(), ['d', 'b', 'c', 'a']);
  // Typing in it moves it back under Open windows.
  now.sessions[2] = status('c', { claude: { status: 'busy', since: 9900 } });
  await poll();
  assert.deepEqual(p.secs(), ['Open windows (3)', 'Parked windows (1)']);
  assert.deepEqual(p.rowNames(), ['c', 'd', 'b', 'a']);
});

test('the last prompt sits under the title bar, above a permission prompt, and changes with the next one', async () => {
  const p = await two();
  assert.equal(p.$('#prompts').textContent, 'Prompts: on');
  p.set('a', { claude: { status: 'busy', lastPrompt: 'fix the scrolling' } });
  await p.poll();
  const win = p.slotOf('a').querySelector('.win');
  const bar = win.querySelector('.lastprompt');
  assert.equal(bar.previousElementSibling, win.querySelector('.title'));
  assert.equal(bar.querySelector('.pt').textContent, 'fix the scrolling');
  assert.equal(p.slotOf('b').querySelector('.lastprompt'), null, 'nothing typed in b');
  await p.poll();
  assert.equal(win.querySelector('.lastprompt'), bar, 'the same prompt keeps the same bar');
  p.set('a', { prompt: PROMPT, claude: { status: 'waiting', lastPrompt: 'and the tests' } });
  await p.poll();
  assert.equal(bar.querySelector('.pt').textContent, 'and the tests');
  assert.equal(win.querySelector('.ask').previousElementSibling, bar);
  bar.click();
  assert.ok(bar.classList.contains('full'));
  bar.click();
  assert.ok(!bar.classList.contains('full'));
  p.set('a', { prompt: null, claude: null });
  await p.poll();
  assert.equal(win.querySelector('.lastprompt'), null, 'Claude has exited');
});

test('the × or the Prompts button hides every last prompt, remembered, and Prompts shows them again', async () => {
  const p = await two();
  p.set('a', { claude: { status: 'idle', lastPrompt: 'one' } });
  p.set('b', { claude: { status: 'idle', lastPrompt: 'two' } });
  await p.poll();
  p.slotOf('a').querySelector('.lastprompt button').click();
  assert.equal(p.$$('.lastprompt').length, 0);
  assert.equal(p.$('#prompts').textContent, 'Prompts: off');
  assert.equal(p.store('corral.prompts'), false);
  assert.equal(p.toast(), 'Last prompts are hidden. Prompts in the toolbar shows them again.');
  await p.poll();
  assert.equal(p.$$('.lastprompt').length, 0, 'stays hidden');
  p.$('#prompts').click();
  assert.deepEqual(p.$$('.lastprompt .pt').map((e) => e.textContent), ['one', 'two']);
  assert.equal(p.store('corral.prompts'), true);
});

test('the last prompts start hidden when this browser hid them', async () => {
  const p = await two({ storage: { 'corral.prompts': false } });
  p.set('a', { claude: { status: 'idle', lastPrompt: 'one' } });
  await p.poll();
  assert.equal(p.$('#prompts').textContent, 'Prompts: off');
  assert.equal(p.$$('.lastprompt').length, 0);
});
