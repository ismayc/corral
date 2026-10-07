// The terminal view: opening a window, its socket and reconnects, going back, the askbar, and sizing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, overview, settle, unloadPage, goBack, popstate, fire } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const visible = (p) => p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));

test('opening a card shows its terminal with the status, mode, and folder, and connects', async () => {
  const p = await phone([win('a', { claude: claude('idle', { mode: 'auto' }) })]);
  p.card('a').click();
  assert.equal(p.$('#home').hidden, true);
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'a');
  assert.equal(p.text('#tsub'), 'Your turn · Auto mode · ~/repos/a');
  const ws = p.sockets[0];
  assert.equal(ws.url, 'ws://127.0.0.1:18777/ws?id=a&own=1&cols=80&rows=24');
  const term = p.terms[0];
  assert.equal(term.options.fontSize, 12);
  assert.equal(term.textarea.getAttribute('inputmode'), 'none');
  assert.deepEqual(p.window.history.state, { term: 'a' });
  ws.open();
  assert.equal(term.resets, 1);
  assert.equal(p.$('#conn').hidden, true);
  assert.deepEqual(p.sent(ws), [{ t: 'resize', cols: 80, rows: 24 }]);
  ws.message('hello');
  assert.deepEqual(term.written, ['hello']);
});

test('over https the terminal connects with wss', async () => {
  const p = await phone([win('a')]);
  p.dom.reconfigure({ url: 'https://mac.example.ts.net/m' });
  p.card('a').click();
  assert.equal(p.sockets[0].url, 'wss://mac.example.ts.net/ws?id=a&own=1&cols=80&rows=24');
});

test('typing in the terminal goes to the Mac only while connected', async () => {
  const p = await phone([win('a')]);
  p.card('a').click();
  const ws = p.sockets[0];
  const term = p.terms[0];
  term.type('x');
  assert.deepEqual(ws.sent, []);
  ws.open();
  term.type('ls\r');
  assert.deepEqual(p.typed(ws), ['ls\r']);
});

test('a resize of the terminal is sent while connected', async () => {
  const p = await phone([win('a')]);
  p.card('a').click();
  const ws = p.sockets[0];
  const term = p.terms[0];
  term.resize(100, 30);
  assert.deepEqual(ws.sent, []);
  ws.open();
  term.resize(90, 20);
  assert.deepEqual(p.sent(ws).at(-1), { t: 'resize', cols: 90, rows: 20 });
  await goBack(p);
  const count = ws.sent.length;
  term.resize(70, 20);
  assert.equal(ws.sent.length, count);
});

test('a dropped connection shows Reconnecting and tries again after a second and a half', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a')]);
  p.card('a').click();
  p.sockets[0].open();
  p.sockets[0].drop();
  assert.equal(p.$('#conn').hidden, false);
  mock.timers.tick(1499);
  assert.equal(p.sockets.length, 1);
  mock.timers.tick(1);
  assert.equal(p.sockets.length, 2);
  p.sockets[1].open();
  assert.equal(p.$('#conn').hidden, true);
});

test('a retry is skipped when a newer connection or another window took over', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a'), win('b')]);
  p.card('a').click();
  p.sockets[0].drop();
  // Coming back to the page reconnects at once, so the pending retry finds a newer socket.
  visible(p);
  await settle();
  assert.equal(p.sockets.length, 2);
  mock.timers.tick(1500);
  assert.equal(p.sockets.length, 2);
  // A drop of the second socket, then another window opens before the retry.
  p.sockets[1].drop();
  p.sw.emit('message', { open: 'b' });
  await settle();
  assert.equal(p.sockets.length, 3);
  mock.timers.tick(1500);
  assert.equal(p.sockets.length, 3);
  assert.equal(p.sockets[2].url.includes('id=b'), true);
});

test('a late close from a window that is no longer open changes nothing', async () => {
  const p = await phone([win('a'), win('b')]);
  p.card('a').click();
  const old = p.sockets[0];
  p.sw.emit('message', { open: 'b' });
  await settle();
  p.sockets[1].open();
  old.drop();
  assert.equal(p.$('#conn').hidden, true);
});

test('Back closes the terminal and its socket and shows the list again', async () => {
  const p = await phone([win('a')]);
  const { ws, term } = await p.openWin('a');
  const polls = p.api.called('GET', '/api/overview').length;
  const popped = popstate(p);
  p.$('#back').click();
  await popped;
  assert.equal(p.$('#home').hidden, false);
  assert.equal(p.$('#termview').hidden, true);
  assert.equal(ws.readyState, 3);
  assert.equal(term.disposed, true);
  assert.equal(p.$('#term').children.length, 0);
  assert.ok(p.api.called('GET', '/api/overview').length > polls);
  // The closed socket does not try to reconnect.
  assert.equal(p.$('#conn').hidden, true);
});

test('a popstate with nothing open does nothing', async () => {
  const p = await phone([win('a')]);
  p.window.dispatchEvent(new p.window.PopStateEvent('popstate', { state: null }));
  assert.equal(p.$('#home').hidden, false);
});

test('coming back to the page refreshes and reconnects a dropped terminal only', async () => {
  const p = await phone([win('a')]);
  const polls = () => p.api.called('GET', '/api/overview').length;
  let n = polls();
  visible(p);
  await settle();
  assert.equal(polls(), n + 1);
  const { ws } = await p.openWin('a');
  visible(p);
  await settle();
  assert.equal(p.sockets.length, 1);
  ws.drop();
  visible(p);
  await settle();
  assert.equal(p.sockets.length, 2);
  Object.defineProperty(p.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  n = polls();
  visible(p);
  await settle();
  assert.equal(polls(), n);
});

test('the subtitle follows the window and the bar hides when the window goes away', async () => {
  const PROMPT = { key: 'k', text: 'Edit file', options: [{ n: '1', label: 'Yes' }] };
  const p = await phone([win('a', { claude: claude('waiting', { waitingFor: 'permission prompt' }), prompt: PROMPT })]);
  await p.openWin('a');
  assert.equal(p.text('#tsub'), 'Needs permission · ~/repos/a');
  assert.equal(p.$('#askbar').hidden, false);
  assert.equal(p.text('#askbar .head'), 'Claude is asking for permission. Answer:');
  assert.equal(p.$('#askbar pre'), null);
  assert.deepEqual([...p.$$('#askbar button')].map((b) => b.textContent), ['Yes', 'Deny']);
  // The same prompt again leaves the bar as it is.
  const bar = p.$('#askbar .ask');
  visible(p);
  await settle();
  assert.equal(p.$('#askbar .ask'), bar);
  p.api.routes['GET /api/overview'] = overview(win('a', { claude: claude('busy') }));
  visible(p);
  await settle();
  assert.equal(p.text('#tsub'), 'Working · ~/repos/a');
  assert.equal(p.$('#askbar').hidden, true);
  p.api.routes['GET /api/overview'] = overview();
  visible(p);
  await settle();
  assert.equal(p.text('#tsub'), 'Working · ~/repos/a');
  assert.equal(p.$('#askbar').hidden, true);
  // The list is not redrawn behind the terminal.
  assert.ok(p.card('a'));
});

test('A+ and A− change the text size within 8 to 20 and remember it', async () => {
  const p = await phone([win('a')], { storage: { 'corral.m.font': 19 } });
  const { term } = await p.openWin('a');
  assert.equal(term.options.fontSize, 19);
  const key = (label) => p.$$('#keys button').find((b) => b.textContent === label);
  key('A+').click();
  key('A+').click();
  assert.equal(term.options.fontSize, 20);
  assert.equal(p.window.localStorage.getItem('corral.m.font'), '20');
  for (let i = 0; i < 15; i++) key('A−').click();
  assert.equal(term.options.fontSize, 8);
  assert.equal(p.window.localStorage.getItem('corral.m.font'), '8');
});

test('the text size can be set with no terminal open and applies to the next one', async () => {
  const p = await phone([win('a')]);
  p.$$('#keys button').find((b) => b.textContent === 'A+').click();
  assert.equal(p.window.localStorage.getItem('corral.m.font'), '13');
  p.card('a').click();
  assert.equal(p.terms[0].options.fontSize, 13);
});

test('the terminal refits when its area changes size', async () => {
  const p = await phone([win('a')]);
  const ro = p.observers.find((o) => o.els.includes(p.$('#termwrap')));
  ro.fire();
  const { term } = await p.openWin('a');
  const fit = term.addons[0];
  const before = fit.fits;
  ro.fire();
  assert.equal(fit.fits, before + 1);
});

test('the page follows the visible viewport when the keyboard opens', async () => {
  const p = await phone([win('a')]);
  const vv = p.window.visualViewport;
  assert.equal(p.doc.documentElement.style.getPropertyValue('--vh'), '844px');
  vv.height = 500;
  vv.dispatchEvent(new p.window.Event('resize'));
  assert.equal(p.doc.documentElement.style.getPropertyValue('--vh'), '500px');
  const { term } = await p.openWin('a');
  const fit = term.addons[0];
  const before = fit.fits;
  vv.height = 400;
  vv.dispatchEvent(new p.window.Event('resize'));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(p.doc.documentElement.style.getPropertyValue('--vh'), '400px');
  assert.ok(fit.fits > before);
});

test('without a visual viewport the page keeps its CSS height', async () => {
  const p = await phone([], { visualViewport: null });
  assert.equal(p.doc.documentElement.style.getPropertyValue('--vh'), '');
});

test('a tap in the terminal area does not start a swipe from the key rows', async () => {
  const p = await phone([win('a'), win('b')]);
  await p.openWin('a');
  fire(p.$('#keys'), 'touchstart', { touches: [{ clientX: 300, clientY: 10 }] });
  fire(p.$('#term'), 'touchend', { changedTouches: [{ clientX: 10, clientY: 10 }] });
  assert.equal(p.text('#ttitle'), 'a');
});
