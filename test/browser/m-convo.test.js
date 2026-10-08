// The Conversation view: the default for a window running Claude, polled from its transcript over the terminal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, overview, settle, unloadPage, deferred, goBack } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const day1 = new Date(2026, 9, 5, 9, 30).getTime();
const day1b = new Date(2026, 9, 5, 10, 15).getTime();
const day2 = new Date(2026, 9, 6, 14, 5).getTime();
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const date = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

const CONVO = {
  cut: true, claude: 'busy',
  statusLines: ['    ✻ Thinking… (12s)', '      esc to interrupt'],
  items: [
    { who: 'you', text: 'Fix the tests', at: day1 },
    { who: 'claude', text: 'Fixed.', at: day1 + 1000 },
    { who: 'you', text: 'Now commit', at: day1b },
    { who: 'claude', text: 'Committed.' },
    { who: 'you', text: 'Next day', at: day2 },
    { who: 'you', text: 'No time' },
  ],
};
const bubbles = (p) => p.$$('#chat > div').map((d) => [d.className, d.textContent]);
const convoCalls = (p, id = 'a') => p.api.called('GET', `/api/sessions/${id}/conversation`).length;
const visible = (p) => p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
const A = () => win('a', { claude: claude('idle') });

test('a Claude window opens on the conversation, with a time over each of your prompts and the status lines below', async () => {
  const d = deferred();
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': () => d.promise } });
  const { ws } = await p.openWin('a');
  assert.equal(p.$('#convo').hidden, false);
  assert.equal(p.$('#viewbtn').hidden, false);
  assert.equal(p.text('#viewbtn'), 'Terminal');
  assert.deepEqual(bubbles(p), [['note', 'Loading…']]);
  assert.equal(p.$('#statusline').hidden, true);
  // The terminal stays connected underneath.
  assert.equal(ws.readyState, 1);
  d.resolve(CONVO);
  await settle();
  assert.deepEqual(bubbles(p), [
    ['note', 'Older messages are not shown.'],
    ['when', `${date(day1)}, ${time(day1)}`],
    ['msg you', 'Fix the tests'],
    ['msg claude', 'Fixed.'],
    ['when', time(day1b)],
    ['msg you', 'Now commit'],
    ['msg claude', 'Committed.'],
    ['when', `${date(day2)}, ${time(day2)}`],
    ['msg you', 'Next day'],
    ['msg you', 'No time'],
    ['working', 'Claude is working…'],
  ]);
  assert.equal(p.$('#statusline').hidden, false);
  assert.equal(p.text('#statusline'), '✻ Thinking… (12s)\n  esc to interrupt');
});

test('an empty conversation says nothing has been typed yet and shows no status lines', async () => {
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [], claude: 'idle', statusLines: [] } } });
  await p.openWin('a');
  await settle();
  assert.deepEqual(bubbles(p), [['note', 'Nothing typed in this conversation yet.']]);
  assert.equal(p.$('#statusline').hidden, true);
  assert.equal(p.text('#statusline'), '');
});

test('a reply without status lines leaves the status line hidden', async () => {
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [{ who: 'you', text: 'hi' }] } } });
  await p.openWin('a');
  await settle();
  assert.deepEqual(bubbles(p), [['msg you', 'hi']]);
  assert.equal(p.$('#statusline').hidden, true);
});

test('a conversation that cannot be read points to the terminal', async () => {
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { __reply: true, status: 500, body: { error: 'x' } } } });
  await p.openWin('a');
  await settle();
  assert.deepEqual(bubbles(p), [['note', 'Could not read the conversation. Tap Terminal to see the window.']]);
});

test('a shell opens on the terminal with no Chat button and no conversation', async () => {
  const p = await phone([win('sh')]);
  await p.openWin('sh');
  assert.equal(p.$('#viewbtn').hidden, true);
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(convoCalls(p, 'sh'), 0);
});

test('the conversation is read again every three seconds while the page is visible', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [{ who: 'you', text: 'one' }] } } });
  await p.openWin('a');
  await settle();
  assert.equal(convoCalls(p), 1);
  p.api.routes['GET /api/sessions/a/conversation'] = { items: [{ who: 'you', text: 'one' }, { who: 'claude', text: 'two' }] };
  mock.timers.tick(3000);
  await settle();
  assert.equal(convoCalls(p), 2);
  assert.deepEqual(bubbles(p), [['msg you', 'one'], ['msg claude', 'two']]);
  Object.defineProperty(p.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  mock.timers.tick(3000);
  await settle();
  assert.equal(convoCalls(p), 2);
});

test('a reply that has not changed leaves the conversation as it is', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [{ who: 'you', text: 'same' }] } } });
  await p.openWin('a');
  await settle();
  const first = p.$('#chat .msg');
  mock.timers.tick(3000);
  await settle();
  assert.equal(convoCalls(p), 2);
  assert.equal(p.$('#chat .msg'), first);
});

test('new messages scroll into view for a reader at the bottom, but not for one who scrolled up', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let n = 0;
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': () => ({ items: [{ who: 'you', text: `m${++n}` }] }) } });
  const chat = p.$('#chat');
  let height = 1000;
  Object.defineProperty(chat, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(chat, 'clientHeight', { configurable: true, get: () => 400 });
  await p.openWin('a');
  await settle();
  assert.equal(chat.scrollTop, 1000);
  chat.scrollTop = 100;
  height = 1100;
  mock.timers.tick(3000);
  await settle();
  assert.equal(p.text('#chat .msg'), 'm2');
  assert.equal(chat.scrollTop, 100);
  chat.scrollTop = 660; // 1100 - 660 - 400 = 40 px from the end
  mock.timers.tick(3000);
  await settle();
  assert.equal(p.text('#chat .msg'), 'm3');
  assert.equal(chat.scrollTop, 1100);
});

test('Terminal hides the conversation, stops reading it, and is remembered; Chat brings it back', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [] } } });
  await p.openWin('a');
  await settle();
  p.$('#viewbtn').click();
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(p.text('#viewbtn'), 'Chat');
  assert.equal(p.window.localStorage.getItem('corral.m.view'), '"term"');
  mock.timers.tick(9000);
  await settle();
  assert.equal(convoCalls(p), 1);
  p.$('#viewbtn').click();
  assert.equal(p.$('#convo').hidden, false);
  assert.equal(p.text('#viewbtn'), 'Terminal');
  assert.equal(p.window.localStorage.getItem('corral.m.view'), '"chat"');
  await settle();
  assert.equal(convoCalls(p), 2);
});

test('in Chat the Mac terminal is kept at least 100 columns wide, so Claude Code does not cut its status lines', async () => {
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [] } } });
  const { ws, term } = await p.openWin('a');
  assert.equal(ws.url, 'ws://127.0.0.1:18777/ws?id=a&own=1&cols=100&rows=24');
  assert.deepEqual(p.sent(ws), [{ t: 'resize', cols: 100, rows: 24 }]);
  // The phone's own width counts only when it is wider.
  term.resize(120, 30);
  assert.deepEqual(p.sent(ws).at(-1), { t: 'resize', cols: 120, rows: 30 });
  term.resize(48, 30);
  assert.deepEqual(p.sent(ws).at(-1), { t: 'resize', cols: 100, rows: 30 });
  // Terminal shows the terminal, so it takes the phone's width; Chat widens it again.
  p.$('#viewbtn').click();
  assert.deepEqual(p.sent(ws).at(-1), { t: 'resize', cols: 48, rows: 30 });
  p.$('#viewbtn').click();
  assert.deepEqual(p.sent(ws).at(-1), { t: 'resize', cols: 100, rows: 30 });
});

test('a remembered Terminal choice opens Claude windows on the terminal', async () => {
  const p = await phone([A()], { storage: { 'corral.m.view': '"term"' } });
  await p.openWin('a');
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(p.$('#viewbtn').hidden, false);
  assert.equal(p.text('#viewbtn'), 'Chat');
  assert.equal(convoCalls(p), 0);
});

test('a refresh that finds the conversation already showing does not reload it', async () => {
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [] } } });
  await p.openWin('a');
  await settle();
  visible(p);
  await settle();
  assert.equal(convoCalls(p), 1);
});

test('Claude starting or stopping in the open window switches the view', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/conversation': { items: [{ who: 'you', text: 'hi' }] } } });
  await p.openWin('a');
  assert.equal(p.$('#convo').hidden, true);
  p.api.routes['GET /api/overview'] = overview(A());
  visible(p);
  await settle();
  assert.equal(p.$('#convo').hidden, false);
  assert.equal(p.$('#viewbtn').hidden, false);
  assert.deepEqual(bubbles(p), [['msg you', 'hi']]);
  p.api.routes['GET /api/overview'] = overview(win('a'));
  visible(p);
  await settle();
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(p.$('#viewbtn').hidden, true);
});

test('a reply that arrives after another window opened is dropped', async () => {
  const d = deferred();
  const p = await phone([A(), win('b')], { routes: { 'GET /api/sessions/a/conversation': () => d.promise } });
  await p.openWin('a');
  p.sw.emit('message', { open: 'b' });
  await settle();
  d.resolve(CONVO);
  await settle();
  assert.equal(p.$('#convo').hidden, true);
  assert.deepEqual(bubbles(p), [['note', 'Loading…']]);
  assert.equal(p.$('#statusline').hidden, true);
});

test('going back to the list stops reading the conversation', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [] } } });
  await p.openWin('a');
  await settle();
  await goBack(p, () => mock.timers.tick(1));
  assert.equal(p.$('#home').hidden, false);
  assert.equal(p.$('#convo').hidden, true);
  mock.timers.tick(9000);
  await settle();
  assert.equal(convoCalls(p), 1);
});

test('the view button with no terminal open only changes the remembered choice', async () => {
  const p = await phone([A()], { routes: { 'GET /api/sessions/a/conversation': { items: [] } } });
  p.$('#viewbtn').click();
  assert.equal(p.window.localStorage.getItem('corral.m.view'), '"term"');
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(convoCalls(p), 0);
  await p.openWin('a');
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(p.text('#viewbtn'), 'Chat');
});
