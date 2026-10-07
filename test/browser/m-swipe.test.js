// Swiping left or right in a terminal moves to the next or previous window in list order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage, fire, goBack } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const LIST = [win('a', { claude: claude('idle') }), win('b', { claude: claude('busy') }), win('c')];
function swipe(p, dx, dy = 0, { from = '#term', ms = 100 } = {}) {
  fire(p.$(from), 'touchstart', { touches: [{ clientX: 200, clientY: 300 }] });
  if (ms) mock.timers.tick(ms);
  fire(p.$('#term'), 'touchend', { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
}

test('a left swipe opens the next window in the list, without a new Back step', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = await phone(LIST);
  await p.openWin('a');
  const length = p.window.history.length;
  swipe(p, -120);
  assert.equal(p.text('#ttitle'), 'b');
  assert.equal(p.toast(), 'b (2 of 3)');
  assert.equal(p.window.history.length, length);
  assert.deepEqual(p.window.history.state, { term: 'b' });
  swipe(p, -120);
  swipe(p, -120);
  assert.equal(p.text('#ttitle'), 'a');
  assert.equal(p.toast(), 'a (1 of 3)');
});

test('a right swipe from the first window wraps to the last', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = await phone(LIST);
  await p.openWin('a');
  swipe(p, 120);
  assert.equal(p.text('#ttitle'), 'c');
  assert.equal(p.toast(), 'c (3 of 3)');
});

test('short, slow, mostly vertical, or two-finger swipes do nothing', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = await phone(LIST);
  await p.openWin('a');
  swipe(p, -60);
  swipe(p, -120, 80);
  swipe(p, -120, 0, { ms: 700 });
  fire(p.$('#term'), 'touchstart', { touches: [{ clientX: 1, clientY: 1 }, { clientX: 2, clientY: 2 }] });
  fire(p.$('#term'), 'touchend', { changedTouches: [{ clientX: 300, clientY: 1 }] });
  // A touchend with no touchstart before it.
  fire(p.$('#term'), 'touchend', { changedTouches: [{ clientX: 300, clientY: 1 }] });
  assert.equal(p.text('#ttitle'), 'a');
});

test('swipes that start on the keys, quick replies, message box, or askbar are theirs', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = await phone(LIST);
  await p.openWin('a');
  for (const from of ['#keys', '#quick', '#compose', '#askbar']) swipe(p, -120, 0, { from });
  assert.equal(p.text('#ttitle'), 'a');
});

test('a swipe in the only window, or in one no longer listed, stays put', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = await phone([win('a')], { routes: { 'POST /api/sessions': { __reply: true, status: 201, body: win('fresh') } } });
  await p.openWin('a');
  swipe(p, -120);
  assert.equal(p.text('#ttitle'), 'a');
  // A window just started is not in the list until the next refresh.
  await goBack(p);
  p.api.routes['GET /api/overview'] = { machine: 'M', sessions: [win('a'), win('b')] };
  p.$('#fab').click();
  await settle();
  p.button('Home folder~').click();
  await settle();
  assert.equal(p.text('#ttitle'), 'fresh');
  swipe(p, -120);
  assert.equal(p.text('#ttitle'), 'fresh');
});

test('a swipe that ends after the terminal closed does nothing', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = await phone(LIST);
  await p.openWin('a');
  fire(p.$('#term'), 'touchstart', { touches: [{ clientX: 200, clientY: 300 }] });
  await goBack(p);
  fire(p.$('#termview'), 'touchend', { changedTouches: [{ clientX: 10, clientY: 300 }] });
  assert.equal(p.$('#home').hidden, false);
  assert.equal(p.sockets.length, 1);
});
