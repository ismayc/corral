// The phone page's TO-DO group: windows in the folders listed in categories.json, first in the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const R = (id) => `/Users/chester/repos/${id}`;
const doc = (todo) => ({ version: 1, categories: [], uncatCollapsed: false, assign: {}, todo });
const routes = (todo) => ({ 'GET /api/categories': doc(todo), 'POST /api/categories': (r) => r.body });

test('windows in a TO-DO folder form the first group, above Waiting for you, and get a chip', async () => {
  const p = await phone([win('shell'), win('turn', { claude: claude('idle', { since: 2 }) }), win('todo2', { claude: claude('busy', { since: 5 }) }), win('todo1')],
    { routes: routes([R('todo1'), R('todo2')]) });
  assert.deepEqual(p.$$('.card').map((c) => c.dataset.id), ['todo2', 'todo1', 'turn', 'shell']);
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['TO-DO2', 'Waiting for you1', 'Shells1']);
  assert.deepEqual(p.$$('#jump button').map((b) => b.textContent), ['TO-DO 2', 'Your turn 1', 'Shells 1']);
  assert.match(p.$('.card[data-id="todo2"] .pill').textContent, /^Working/);
});

test('a list with no TO-DO, or one that does not load, changes nothing', async () => {
  let p = await phone([win('a')], { routes: { 'GET /api/categories': {} } });
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['Shells1']);
  unloadPage();
  p = await phone([win('a')], { routes: { 'GET /api/categories': new Error('offline') } });
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['Shells1']);
});

test('the card menu adds a window to TO-DO and removes it, saving the list on the Mac', async () => {
  const p = await phone([win('a'), win('b')], { routes: routes([R('b')]) });
  p.card('a').querySelector('.more').click();
  p.button('Add to TO-DO').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/categories')[0].body.todo, [R('b'), R('a')]);
  assert.equal(p.toast(), 'a is in TO-DO.');
  p.card('b').querySelector('.more').click();
  p.button('Remove from TO-DO').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/categories')[1].body.todo, []);
  assert.equal(p.toast(), 'b is out of TO-DO.');
});

test('a TO-DO change the Mac refuses says it could not change that', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/categories': doc([]), 'POST /api/categories': { __reply: true, status: 400, body: { error: 'bad categories' } } } });
  p.card('a').querySelector('.more').click();
  p.button('Add to TO-DO').click();
  await settle();
  assert.equal(p.toast(), 'Could not change that.');
});

test('a window with no folder has no TO-DO entry in its menu', async () => {
  const p = await phone([win('a', { cwd: undefined })], { routes: routes([]) });
  p.card('a').querySelector('.more').click();
  assert.equal(p.button('Add to TO-DO'), undefined);
});

test('a TO-DO window cleared with /clear leaves TO-DO, goes under Parked windows, and the Mac list is updated', async () => {
  const p = await phone([win('a', { claude: claude('idle', { since: 9, cleared: true }) }), win('b')], { routes: routes([R('a'), R('b')]) });
  assert.deepEqual(p.$$('#list .section').map((s) => s.textContent), ['TO-DO1', 'Parked windows1']);
  assert.deepEqual(p.api.called('POST', '/api/categories')[0].body.todo, [R('b')]);
});

test('a categories file with no TO-DO list takes the first window added', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/categories': { version: 1, categories: [], assign: {} }, 'POST /api/categories': (r) => r.body } });
  p.card('a').querySelector('.more').click();
  p.button('Add to TO-DO').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/categories')[0].body.todo, [R('a')]);
});

test('removing the only window from a list the Mac has not yet changed still saves an empty list', async () => {
  let todo = [R('a')];
  const p = await phone([win('a')], { routes: { 'GET /api/categories': () => doc(todo), 'POST /api/categories': (r) => { todo = r.body.todo; return r.body; } } });
  p.card('a').querySelector('.more').click();
  p.button('Remove from TO-DO').click();
  await settle();
  assert.deepEqual(todo, []);
});
