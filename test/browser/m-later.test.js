// The phone page's Later group: windows in the folders listed under "later" in categories.json, last in the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const R = (id) => `/Users/chester/repos/${id}`;
// The Mac keeps what the page saves, as the real server does.
const routes = (todo, later) => {
  let doc = { version: 1, categories: [], uncatCollapsed: false, assign: {}, todo, later };
  return { 'GET /api/categories': () => doc, 'POST /api/categories': (r) => { doc = r.body; return r.body; } };
};

test('windows in a Later folder form the last group, under Parked windows, and get a chip', async () => {
  const p = await phone([win('later1', { claude: claude('idle', { since: 2 }) }), win('turn', { claude: claude('idle', { since: 3 }) }),
    win('parked', { claude: claude('idle', { since: 4, cleared: true }) })], { routes: routes([], [R('later1')]) });
  assert.deepEqual(p.$$('.card').map((c) => c.dataset.id), ['turn', 'parked', 'later1']);
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['Waiting for you1', 'Parked windows1', 'Later1']);
  assert.deepEqual(p.$$('#jump button').map((b) => b.textContent), ['Your turn 1', 'Parked 1', 'Later 1']);
});

test('the card menu moves a window between TO-DO and Later, and takes it out of Later', async () => {
  const p = await phone([win('a'), win('b')], { routes: routes([R('a')], []) });
  p.card('a').querySelector('.more').click();
  p.button('Add to Later').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/categories')[0].body, { version: 1, categories: [], uncatCollapsed: false, assign: {}, todo: [], later: [R('a')] });
  assert.equal(p.toast(), 'a is in Later.');
  p.card('a').querySelector('.more').click();
  p.button('Remove from Later').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/categories')[1].body.later, []);
  assert.equal(p.toast(), 'a is out of Later.');
});

test('a Later window cleared with /clear leaves Later and goes under Parked windows', async () => {
  const p = await phone([win('a', { claude: claude('idle', { since: 9, cleared: true }) }), win('b')], { routes: routes([], [R('a'), R('b')]) });
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['Parked windows1', 'Later1']);
  assert.deepEqual(p.api.called('POST', '/api/categories')[0].body.later, [R('b')]);
});

test('a cleared window in neither list saves nothing', async () => {
  const p = await phone([win('a', { claude: claude('idle', { since: 9, cleared: true }) })], { routes: routes([], [R('b')]) });
  assert.deepEqual(p.api.called('POST', '/api/categories'), []);
});
