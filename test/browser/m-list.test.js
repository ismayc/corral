// The phone page's home list: cards, status pills, groups, the jump chips, notices, and polling.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, overview, settle, unloadPage, fire, listLayout } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const MIN = 60000;

test('each card shows the window name, a status pill, and its folder under the home folder', async () => {
  const p = await phone([
    win('shell', { cwd: '/opt/tools' }),
    win('idle', { claude: claude('idle') }),
    win('busy', { claude: claude('busy') }),
    win('perm', { claude: claude('waiting', { waitingFor: 'permission prompt' }) }),
    win('dialog', { claude: claude('waiting', { waitingFor: 'a dialog' }) }),
    win('odd', { claude: claude('starting'), cwd: undefined }),
  ]);
  const pill = (id) => p.card(id).querySelector('.pill');
  assert.equal(pill('shell').textContent, 'Shell');
  assert.equal(pill('idle').textContent, 'Your turn');
  assert.equal(pill('idle').className, 'pill idle');
  assert.equal(pill('busy').textContent, 'Working');
  assert.equal(pill('perm').textContent, 'Needs permission');
  assert.equal(pill('dialog').textContent, 'Waiting on a prompt');
  assert.equal(pill('odd').textContent, 'Claude');
  assert.ok(p.card('perm').classList.contains('need'));
  assert.ok(!p.card('idle').classList.contains('need'));
  assert.equal(p.card('idle').querySelector('.where').textContent, '~/repos/idle');
  assert.equal(p.card('shell').querySelector('.where').textContent, '/opt/tools');
  assert.equal(p.card('odd').querySelector('.where').textContent, '');
  assert.equal(p.text('#machine'), 'on Test Mac');
});

test('a card says how long ago the window was last active', async () => {
  const now = Date.now();
  const p = await phone([
    win('a', { activity: now - 10000 }),
    win('b', { activity: now - 5 * MIN }),
    win('c', { activity: now - 3 * 60 * MIN }),
    win('d', { activity: now - 2 * 24 * 60 * MIN }),
    win('e', { activity: now + MIN }),
  ]);
  const where = (id) => p.card(id).querySelector('.where').textContent;
  assert.equal(where('a'), '~/repos/a · just now');
  assert.equal(where('b'), '~/repos/b · 5m ago');
  assert.equal(where('c'), '~/repos/c · 3h ago');
  assert.equal(where('d'), '~/repos/d · 2d ago');
  assert.equal(where('e'), '~/repos/e · just now');
});

test('a working card says how long Claude has been at it', async () => {
  const now = Date.now();
  const p = await phone([
    win('new', { claude: claude('busy', { since: now - 10000 }) }),
    win('mins', { claude: claude('busy', { since: now - 12 * MIN }) }),
    win('hours', { claude: claude('busy', { since: now - 125 * MIN }) }),
    win('future', { claude: claude('busy', { since: now + 5 * MIN }) }),
  ]);
  const pill = (id) => p.card(id).querySelector('.pill').textContent;
  assert.equal(pill('new'), 'Working · just started');
  assert.equal(pill('mins'), 'Working · 12m');
  assert.equal(pill('hours'), 'Working · 2h 5m');
  assert.equal(pill('future'), 'Working · just started');
});

test('tags show Stop on a working window, its mode, and Muted', async () => {
  const p = await phone([
    win('busy', { claude: claude('busy', { mode: 'auto' }) }),
    win('edits', { claude: claude('idle', { mode: 'accept edits' }), muted: true }),
    win('plan', { claude: claude('idle', { mode: 'plan mode' }) }),
    win('plain'),
  ]);
  const tags = (id) => [...p.card(id).querySelectorAll('.tags > *')].map((t) => t.textContent);
  assert.deepEqual(tags('busy'), ['Stop', 'Auto mode']);
  assert.deepEqual(tags('edits'), ['Accept edits', 'Muted']);
  assert.deepEqual(tags('plan'), ['Plan mode']);
  assert.equal(p.card('plain').querySelector('.tags'), null);
});

test('the list puts windows waiting on you first, then working ones, then shells, newest first', async () => {
  const p = await phone([
    win('shell-old', { activity: 1 }),
    win('shell-new', { activity: 5 }),
    win('busy'),
    win('idle-new', { claude: claude('idle'), activity: 9 }),
    win('idle-old', { claude: claude('idle') }),
    win('waiting', { claude: claude('waiting'), activity: 2 }),
    win('gone', { exited: true }),
  ].map((w) => (w.id === 'busy' ? { ...w, claude: claude('busy') } : w)));
  assert.deepEqual(p.$$('.card').map((c) => c.dataset.id), ['waiting', 'idle-new', 'idle-old', 'busy', 'shell-new', 'shell-old']);
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['Waiting for you3', 'Working1', 'Shells2']);
  assert.equal(p.window.document.title, '(3) Corral');
  assert.deepEqual(p.$$('#jump button').map((b) => [b.textContent, [...b.classList].filter((c) => c !== 'on').join(' ')]), [['Your turn 3', 'need'], ['Working 1', 'busy'], ['Shells 2', '']]);
  assert.equal(p.$('#jump').hidden, false);
});

test('the Your turn chip is green when nothing is asking for permission', async () => {
  const p = await phone([win('a', { claude: claude('idle') })]);
  assert.deepEqual(p.$$('#jump button').map((b) => b.className), ['idle on']);
  assert.equal(p.window.document.title, '(1) Corral');
});

test('with nothing running the list says so and hides the chips', async () => {
  const p = await phone([]);
  assert.equal(p.text('#list .empty'), 'Nothing is running on the Mac. Start something below.');
  assert.equal(p.$('#jump').hidden, true);
  assert.equal(p.window.document.title, 'Corral');
});

test('the list keeps room after the last group and a chip jumps to its group', async () => {
  const p = await phone([win('a', { claude: claude('idle') }), win('b', { claude: claude('busy') }), win('c')], { setup: listLayout });
  const list = p.$('#list');
  assert.equal(list.lastElementChild.style.height, '362px');
  p.$('#jump [data-rank="1"]').click();
  assert.equal(list.scrollTop, 122);
  list.scrollTop = 135;
  fire(list, 'scroll');
  assert.deepEqual(p.$$('#jump button').map((b) => b.classList.contains('on')), [false, true, false]);
  // The list redraws without moving the reader.
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(list.scrollTop, 135);
  list.scrollTop = 0;
  fire(list, 'scroll');
  assert.deepEqual(p.$$('#jump button').map((b) => b.classList.contains('on')), [true, false, false]);
});

test('when the first group sits below the restore banner its chip is still lit', async () => {
  const p = await phone([win('a', { claude: claude('idle') }), win('b')], {
    setup: listLayout, routes: { 'GET /api/restore': { savedAt: 1, windows: [{ label: 'x' }] } },
  });
  assert.ok(p.$('#list .banner'));
  assert.deepEqual(p.$$('#jump button').map((b) => b.classList.contains('on')), [true, false]);
});

test('a long list with little after the last group needs no extra room', async () => {
  const many = Array.from({ length: 8 }, (_, i) => win(`s${i}`));
  const p = await phone([win('a', { claude: claude('idle') }), ...many], { setup: listLayout });
  assert.equal(p.$('#list').lastElementChild.style.height, '0px');
});

test('the restore banner counts the windows and Restore reopens them', async () => {
  const p = await phone([], { routes: {
    'GET /api/restore': { savedAt: 1, windows: [{ label: 'a' }, { label: 'b' }] },
    'POST /api/restore': { sessions: [{ id: 'a' }, { id: 'b' }] },
  } });
  assert.equal(p.text('.banner .grow'), '2 windows from before the restart can be reopened.');
  p.button('Restore').click();
  await settle();
  assert.equal(p.api.called('POST', '/api/restore').length, 1);
  assert.equal(p.toast(), 'Reopened 2 windows.');
  assert.equal(p.$('.banner'), null);
});

test('a single window to restore is counted in the singular', async () => {
  const p = await phone([], { routes: {
    'GET /api/restore': { savedAt: 1, windows: [{ label: 'a' }] },
    'POST /api/restore': { sessions: [{ id: 'a' }] },
  } });
  assert.equal(p.text('.banner .grow'), '1 window from before the restart can be reopened.');
  p.button('Restore').click();
  await settle();
  assert.equal(p.toast(), 'Reopened 1 window.');
});

test('a failed restore keeps the banner and says so', async () => {
  const p = await phone([], { routes: {
    'GET /api/restore': { savedAt: 1, windows: [{ label: 'a' }] },
    'POST /api/restore': (req) => ({ __reply: true, status: 500, body: { error: 'no' } }),
  } });
  p.button('Restore').click();
  await settle();
  assert.equal(p.toast(), 'Could not restore the windows.');
  assert.ok(p.$('.banner'));
});

test('no banner shows when the restore list is missing or cannot be read', async () => {
  let p = await phone([], { routes: { 'GET /api/restore': { savedAt: null } } });
  assert.equal(p.$('.banner'), null);
  p = await phone([], { routes: { 'GET /api/restore': new Error('offline') } });
  assert.equal(p.$('.banner'), null);
  assert.equal(p.text('#list .empty'), 'Nothing is running on the Mac. Start something below.');
});

test('when the Mac cannot be reached the list stays as it was', async () => {
  const p = await phone([], { routes: { 'GET /api/overview': new Error('offline') } });
  assert.equal(p.text('#machine'), '');
});

test('a window that finishes or starts asking while you look elsewhere gets a notice', async () => {
  const p = await phone([win('a', { claude: claude('busy') }), win('b', { claude: claude('idle') }), win('c', { claude: claude('idle') })]);
  p.api.routes['GET /api/overview'] = overview(win('a', { claude: claude('idle') }), win('b', { claude: claude('busy') }), win('c', { claude: claude('idle') }));
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.toast(), 'a is waiting for you');
  p.api.routes['GET /api/overview'] = overview(win('a', { claude: claude('idle') }), win('b', { claude: claude('waiting') }), win('c', { claude: claude('idle') }));
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.toast(), 'b needs you to answer a prompt');
  p.$('#toast').hidden = true;
  p.api.routes['GET /api/overview'] = overview(win('a', { claude: claude('idle') }), win('b', { claude: claude('waiting') }), win('c', { claude: claude('busy') }));
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.toast(), null);
});

test('the open window gets no notice about itself', async () => {
  const p = await phone([win('a', { claude: claude('busy') })]);
  await p.openWin('a');
  p.api.routes['GET /api/overview'] = overview(win('a', { claude: claude('idle') }));
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.toast(), null);
  assert.equal(p.text('#tsub'), 'Your turn · ~/repos/a');
});

test('a tap on a notice hides it, and a notice hides itself after four seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await phone([win('a', { claude: claude('busy') })], { routes: { 'POST /api/sessions/a/key': { ok: true } } });
  p.button('Stop', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Stopped a. It will ask what to do instead.');
  p.$('#toast').click();
  assert.equal(p.toast(), null);
  p.button('Stop', p.card('a')).click();
  await settle();
  assert.ok(p.toast());
  mock.timers.tick(3999);
  assert.ok(p.toast());
  mock.timers.tick(1);
  assert.equal(p.toast(), null);
  await settle();
});

test('the list checks the Mac every four seconds, but only while the page is visible', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = await phone([win('a')]);
  const polls = () => p.api.called('GET', '/api/overview').length;
  const before = polls();
  mock.timers.tick(4000);
  await settle();
  assert.equal(polls(), before + 1);
  Object.defineProperty(p.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  mock.timers.tick(4000);
  await settle();
  assert.equal(polls(), before + 1);
});

test('the list redraws every thirty seconds so the times stay current, but not behind a terminal', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const p = await phone([win('a', { activity: 1_000_000 - 30000 })], { setup: (w) => Object.defineProperty(w.document, 'visibilityState', { value: 'hidden', configurable: true }) });
  const where = () => p.card('a').querySelector('.where').textContent;
  assert.equal(where(), '~/repos/a · just now');
  mock.timers.tick(30000);
  assert.equal(where(), '~/repos/a · 1m ago');
  await p.openWin('a');
  const card = p.card('a');
  mock.timers.tick(5 * 60000);
  assert.equal(p.card('a'), card);
  assert.equal(card.querySelector('.where').textContent, '~/repos/a · 1m ago');
});

test('Enter on a focused card opens its window, other keys and inner targets do not', async () => {
  const p = await phone([win('a')]);
  fire(p.card('a'), 'keydown', { key: ' ' });
  fire(p.card('a').querySelector('.name'), 'keydown', { key: 'Enter' });
  assert.equal(p.$('#termview').hidden, true);
  fire(p.card('a'), 'keydown', { key: 'Enter' });
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'a');
});

test('pressing and holding a Claude card shows its last reply instead of opening it', async () => {
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'GET /api/sessions/a/last': { text: 'All done.' } } });
  const card = p.card('a');
  fire(card, 'pointerdown', { clientX: 10, clientY: 10 });
  fire(card, 'pointermove', { clientX: 14, clientY: 13 });
  await new Promise((r) => setTimeout(r, 600));
  await settle();
  assert.equal(p.sheetTitle(), 'a: last reply');
  assert.equal(p.text('#genbody .reply'), 'All done.');
  fire(card, 'pointerup');
  card.click();
  assert.equal(p.$('#termview').hidden, true);
});

test('moving, lifting, or leaving cancels a press, and shells and buttons have no press', async () => {
  const p = await phone([win('a', { claude: claude('busy') }), win('sh')], { routes: { 'GET /api/sessions/a/last': { text: 'x' } } });
  const card = p.card('a');
  fire(card, 'pointerdown', { clientX: 10, clientY: 10 });
  fire(card, 'pointermove', { clientX: 30, clientY: 10 });
  fire(card.querySelector('.stop'), 'pointerdown', { clientX: 10, clientY: 10 });
  fire(p.$('#list'), 'pointerdown', { clientX: 1, clientY: 1 });
  fire(p.card('sh'), 'pointerdown', { clientX: 1, clientY: 1 });
  await new Promise((r) => setTimeout(r, 600));
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    fire(card, 'pointerdown', { clientX: 10, clientY: 10 });
    fire(card, ev);
  }
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(p.api.called('GET', '/api/sessions/a/last').length, 0);
  assert.equal(p.sheetTitle(), null);
});

test('a move before any press does nothing', async () => {
  const p = await phone([win('a')]);
  fire(p.$('#list'), 'pointermove', { clientX: 300, clientY: 300 });
  assert.equal(p.$('#termview').hidden, true);
});

test('the long-press menu of the browser is held back on cards only', async () => {
  const p = await phone([win('a')]);
  assert.equal(fire(p.card('a'), 'contextmenu').defaultPrevented, true);
  assert.equal(fire(p.$('#list'), 'contextmenu').defaultPrevented, false);
});

test('Desktop goes to the full desktop page', async () => {
  const p = await phone([]);
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    p.$('#todesk').click();
    await settle();
  } finally { console.error = orig; }
  assert.ok(errors.some((e) => /navigation/.test(e)), 'jsdom reports the navigation it does not perform');
});

test('a link with ?w= opens that window and tidies the address', async () => {
  const p = await phone([win('a', { claude: claude('idle') })], { url: '/m?w=a' });
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'a');
  assert.equal(p.window.location.search, '');
  assert.equal(p.window.location.pathname, '/m');
});

test('a link to a window that is gone says so', async () => {
  const p = await phone([], { url: '/m?w=zzz' });
  assert.equal(p.toast(), 'That window is no longer open.');
  assert.equal(p.$('#termview').hidden, true);
});
