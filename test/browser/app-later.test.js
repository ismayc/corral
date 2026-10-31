// Later: spaces to look at another time, listed under Parked windows. A space is in TO-DO or Later, not both.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, status, dt, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const R = (id) => `/Users/me/repos/${id}`;
async function page({ todo = [], later = [R('c'), R('d')], overview = [status('a'), status('c', { claude: { status: 'busy', since: 5000 } })] } = {}) {
  const now = { sessions: overview };
  const p = await start({ routes: {
    'GET /api/herdr': { available: true, spaces: ['a', 'b', 'c', 'd'].map((id) => space(id)) },
    'GET /api/sessions': { sessions: overview.map((s) => session(s.id)) },
    'GET /api/overview': () => now,
    'GET /api/categories': { version: 1, categories: [], uncatCollapsed: false, assign: {}, todo, later },
    'POST /api/categories': (req) => req.body,
  } });
  p.now = now;
  p.poll = async () => { p.tick(3000); await flush(); };
  p.save = async () => { p.tick(250); await flush(); return p.api.called('POST', '/api/categories').at(-1)?.body; };
  return p;
}
const menu = (p, label) => p.$$('.catmenu button').find((b) => b.textContent.replace('✓ ', '') === label);

test('Later spaces sit under Parked windows, windows first, and leave the other sections', async () => {
  const p = await page({ overview: [status('a'), status('b', { claude: { status: 'idle', since: 1, cleared: true } }),
    status('c', { claude: { status: 'busy', since: 5000 } })] });
  assert.deepEqual(p.secs(), ['Open windows (1)', 'Parked windows (1)', 'Later (2)']);
  assert.deepEqual(p.rowNames(), ['a', 'b', 'c', 'd']);
});

test('the space menu moves a space between TO-DO and Later, with undo, and saves both lists', async () => {
  const p = await page({ todo: [R('b')], later: [] });
  p.row('b').querySelector('.more').click();
  assert.deepEqual([menu(p, 'TO-DO').textContent, menu(p, 'Later').textContent], ['✓ TO-DO', 'Later']);
  menu(p, 'Later').click();
  assert.equal(p.toast(), 'Added b to Later');
  assert.deepEqual(p.secs(), ['Open windows (2)', 'Later (1)', 'All spaces (1)']);
  assert.deepEqual(await p.save().then((d) => [d.todo, d.later]), [[], [R('b')]]);
  p.$('#toast button').click();
  assert.deepEqual(await p.save().then((d) => [d.todo, d.later]), [[R('b')], []]);
  p.row('b').querySelector('.more').click();
  menu(p, 'TO-DO').click();
  assert.equal(p.toast(), 'Removed b from TO-DO');
  p.row('d').querySelector('.more').click();
  menu(p, 'Later').click();
  p.row('d').querySelector('.more').click();
  assert.equal(menu(p, 'Later').textContent, '✓ Later');
  menu(p, 'Later').click();
  assert.equal(p.toast(), 'Removed d from Later');
});

test('dropping spaces on the Later header adds them', async () => {
  const p = await page();
  fire(p.$('#spaces .sec.later'), 'drop', { dataTransfer: dt({ 'text/x-corral-space': 'a\nb' }) });
  assert.equal(p.toast(), 'Added 2 spaces to Later');
  assert.deepEqual(p.secs(), ['Later (4)']);
});

test('a Later window cleared with /clear leaves Later and sits under Parked windows', async () => {
  const p = await page({ todo: [R('a')] });
  p.now.sessions = [status('a', { claude: { status: 'idle', since: 9000, cleared: true } }),
    status('c', { claude: { status: 'idle', since: 9000, cleared: true } })];
  await p.poll();
  assert.deepEqual(p.secs(), ['Parked windows (2)', 'Later (1)', 'All spaces (1)']);
  assert.deepEqual(await p.save().then((d) => [d.todo, d.later]), [[], [R('d')]]);
});

test('a file without a Later list shows no Later section', async () => {
  const p = await page({ later: null });
  assert.deepEqual(p.secs(), ['Open windows (2)', 'All spaces (2)']);
});
