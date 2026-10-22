const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, status, dt, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const R = (id) => `/Users/me/repos/${id}`;
const doc = (todo) => ({ version: 1, categories: [], uncatCollapsed: false, assign: {}, ...(todo ? { todo } : {}) });
async function page({ todo = [R('c'), R('d')], overview = [status('a'), status('c', { claude: { status: 'busy', since: 5000 } })] } = {}) {
  const now = { sessions: overview };
  const p = await start({ routes: {
    'GET /api/herdr': { available: true, spaces: ['a', 'b', 'c', 'd'].map((id) => space(id)) },
    'GET /api/sessions': { sessions: overview.map((s) => session(s.id)) },
    'GET /api/overview': () => now,
    'GET /api/categories': doc(todo),
    'POST /api/categories': (req) => req.body,
  } });
  p.now = now;
  p.poll = async () => { p.tick(3000); await flush(); };
  p.save = async () => { p.tick(250); await flush(); return p.api.called('POST', '/api/categories').at(-1)?.body; };
  return p;
}

test('TO-DO spaces sit above Open windows, windows first by latest change, and leave the other sections', async () => {
  const p = await page();
  assert.deepEqual(p.secs(), ['TO-DO (2)', 'Open windows (1)', 'All spaces (1)']);
  assert.deepEqual(p.rowNames(), ['c', 'd', 'a', 'b']);
});

test('a file without a TO-DO list, or one that fails to load, shows no TO-DO section', async () => {
  const p = await page({ todo: null });
  assert.deepEqual(p.secs(), ['Open windows (2)', 'All spaces (2)']);
});

test('the space menu adds spaces to TO-DO and takes them out, with undo, and saves the list', async () => {
  const p = await page({ todo: [] });
  p.row('b').querySelector('.more').click();
  const menu = () => p.$$('.catmenu button').find((b) => /TO-DO/.test(b.textContent));
  assert.equal(menu().textContent, 'TO-DO');
  menu().click();
  assert.equal(p.toast(), 'Added b to TO-DO');
  assert.deepEqual(p.secs(), ['TO-DO (1)', 'Open windows (2)', 'All spaces (1)']);
  assert.deepEqual((await p.save()).todo, [R('b')]);
  p.row('b').querySelector('.more').click();
  assert.equal(menu().textContent, '✓ TO-DO');
  menu().click();
  assert.equal(p.toast(), 'Removed b from TO-DO');
  p.$('#toast button').click();
  assert.deepEqual(p.secs()[0], 'TO-DO (1)');
  assert.deepEqual((await p.save()).todo, [R('b')]);
});

test('a space with no project folder cannot be added to TO-DO', async () => {
  const p = await start({ routes: { 'GET /api/herdr': { available: true, spaces: [space('a', { root: null })] }, 'GET /api/categories': doc([]), 'POST /api/categories': (r) => r.body } });
  p.row('a').querySelector('.more').click();
  p.$$('.catmenu button').find((b) => b.textContent === 'TO-DO').click();
  assert.equal(p.toast(), null);
  assert.deepEqual(p.secs(), []);
});

test('dropping spaces on the TO-DO header adds them', async () => {
  const p = await page();
  const head = p.$('#spaces .sec.todo');
  fire(head, 'drop', { dataTransfer: dt({ 'text/x-corral-space': 'b' }) });
  assert.equal(p.toast(), 'Added b to TO-DO');
  assert.deepEqual(p.secs()[0], 'TO-DO (3)');
  fire(p.$('#spaces .sec.todo'), 'drop', { dataTransfer: dt({ 'text/x-corral-space': 'a\nc\nd' }) });
  assert.equal(p.toast(), 'Added a to TO-DO', 'only spaces not yet listed count');
});

test('dropping several new spaces on the TO-DO header says how many were added', async () => {
  const p = await page({ todo: [R('d')] });
  fire(p.$('#spaces .sec.todo'), 'drop', { dataTransfer: dt({ 'text/x-corral-space': 'a\nb\nd' }) });
  assert.equal(p.toast(), 'Added 2 spaces to TO-DO');
});

test('a TO-DO window cleared with /clear leaves TO-DO and sits under Parked windows', async () => {
  const p = await page();
  p.now.sessions = [status('a'), status('c', { claude: { status: 'idle', since: 9000, cleared: true } })];
  await p.poll();
  assert.deepEqual(p.secs(), ['TO-DO (1)', 'Open windows (1)', 'Parked windows (1)', 'All spaces (1)']);
  assert.deepEqual((await p.save()).todo, [R('d')]);
});

test('a TO-DO window Claude Code compacted on its own stays under TO-DO', async () => {
  const p = await page();
  p.now.sessions = [status('a'), status('c', { claude: { status: 'idle', since: 9000, compacted: true } })];
  await p.poll();
  assert.deepEqual(p.secs(), ['TO-DO (2)', 'Open windows (1)', 'All spaces (1)']);
});
