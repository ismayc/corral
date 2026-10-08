// Spaces made in herdr after the page loaded: picked up every 10 seconds or on ↻, and announced when they
// land in Uncategorized while there are groups to file them in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, dt, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const R = (id) => `/Users/me/repos/${id}`;
const answer = (...list) => ({ available: true, spaces: list.map((s) => (typeof s === 'string' ? space(s) : s)) });
const WORK = (assign = {}) => ({ 'GET /api/categories': { version: 1, categories: [{ name: 'Work', collapsed: false }], uncatCollapsed: false, assign }, 'POST /api/categories': (req) => req.body });
const header = (p, name) => p.$$('#spaces .sec.cat').find((h) => h.querySelector('.cn').textContent === name);
const fresh = (p) => p.$$('#spaces .space.fresh').map((d) => d.dataset.id);
const poll = async (p) => { p.tick(10000); await flush(); };

test('a space made in herdr shows up on the next check, marked new, with a note to file it', async () => {
  const p = await start({ routes: { 'GET /api/herdr': answer('a', 'b'), ...WORK({ [R('a')]: 'Work' }) } });
  assert.deepEqual(fresh(p), [], 'the spaces already there at load are not new');
  p.api.routes['GET /api/herdr'] = answer('a', 'b', 'c');
  await poll(p);
  assert.deepEqual(p.secs(), ['▾ Work 1', '▾ Uncategorized 2']);
  assert.deepEqual(fresh(p), ['c']);
  assert.equal(p.toast(), 'New herdr space c is in Uncategorized. Drag it onto a group to file it.');
  // Filed in a group, it is no longer new.
  fire(header(p, 'Work'), 'drop', { dataTransfer: dt({ 'text/x-corral-space': 'c' }) });
  assert.deepEqual(fresh(p), []);
});

test('several new spaces are listed together; one that already has a group is not announced', async () => {
  const p = await start({ routes: { 'GET /api/herdr': answer('a'), ...WORK({ [R('d')]: 'Work' }) } });
  p.api.routes['GET /api/herdr'] = answer('a', 'b', 'c', 'd', 'e');
  p.$('#refresh').click();
  await flush();
  assert.deepEqual(fresh(p), ['b', 'c', 'e']);
  assert.equal(p.toast(), '3 new herdr spaces are in Uncategorized: b, c, and e. Drag them onto a group to file them.');
  p.api.routes['GET /api/herdr'] = answer('a', 'b', 'c', 'd', 'e', 'f', 'g');
  await poll(p);
  assert.equal(p.toast(), '2 new herdr spaces are in Uncategorized: f and g. Drag them onto a group to file them.');
  assert.deepEqual(fresh(p), ['b', 'c', 'e', 'f', 'g']);
});

test('with no groups, a new space just appears; nothing is announced', async () => {
  const p = await start({ routes: { 'GET /api/herdr': answer('a') } });
  p.api.routes['GET /api/herdr'] = answer('a', 'b');
  await poll(p);
  assert.deepEqual(p.rowNames(), ['a', 'b']);
  assert.deepEqual(fresh(p), []);
  assert.equal(p.toast(), null);
});

test('when herdr did not answer at load, its first answer sets what counts as new', async () => {
  const p = await start({ routes: { 'GET /api/herdr': { available: false, spaces: [], error: 'refused' }, ...WORK() } });
  p.api.routes['GET /api/herdr'] = answer('a', 'b');
  p.$('#refresh').click();
  await flush();
  assert.deepEqual(p.rowNames(), ['a', 'b']);
  assert.deepEqual(fresh(p), []);
  assert.equal(p.toast(), null);
});

test('a check with nothing new only updates the status dots, and a failed check changes nothing', async () => {
  const p = await start({ routes: { 'GET /api/herdr': answer('a', 'b') } });
  const row = p.row('a');
  p.api.routes['GET /api/herdr'] = answer(space('a', { status: 'working' }), 'b');
  await poll(p);
  assert.equal(p.row('a'), row, 'the row was kept, not rebuilt');
  assert.ok(row.querySelector('.dot').classList.contains('working'));
  p.api.routes['GET /api/herdr'] = { available: false, spaces: [], error: 'timed out' };
  await poll(p);
  assert.deepEqual(p.rowNames(), ['a', 'b']);
  p.api.routes['GET /api/herdr'] = new Error('offline');
  await poll(p);
  assert.deepEqual(p.rowNames(), ['a', 'b']);
});

test('a renamed or closed space redraws the list', async () => {
  const p = await start({ routes: { 'GET /api/herdr': answer('a', 'b') } });
  p.api.routes['GET /api/herdr'] = answer(space('a', { label: 'alpha' }));
  await poll(p);
  assert.deepEqual(p.rowNames(), ['alpha']);
});

test('the check waits while the page is hidden', async () => {
  const p = await start({ routes: { 'GET /api/herdr': answer('a') } });
  Object.defineProperty(p.doc, 'hidden', { configurable: true, value: true });
  await poll(p);
  assert.equal(p.api.called('GET', '/api/herdr').length, 1);
});
