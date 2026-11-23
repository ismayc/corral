// Past conversations: the Mac page's space menu panel and the phone's sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../helpers/app');
const m = require('../helpers/m');

test.afterEach(async () => { await m.settle(); app.stop(); });

const ID = '11111111-2222-4333-8444-555555555555';
const CONV = [{ id: ID, title: 'Build it', first: 'Build the thing', updated: Date.now() - 60000, size: 4096 }];

async function mac(routes = {}, sessions = []) {
  return app.start({ routes: {
    'GET /api/herdr': { available: true, spaces: [app.space('a'), app.space('b')] },
    'GET /api/categories': { version: 1, categories: [], uncatCollapsed: false, assign: {} },
    'GET /api/sessions': { sessions },
    'GET /api/history': { root: '/Users/me/repos/a', conversations: CONV, more: false },
    ...routes,
  } });
}
const openPast = async (p, name = 'a') => {
  p.row(name).querySelector('.more').click();
  p.$$('.catmenu button').find((b) => b.textContent === 'Past conversations…').click();
  await app.flush();
};

test('Past conversations lists the space\'s conversations with Resume and two save links', async () => {
  const p = await mac();
  await openPast(p);
  assert.equal(p.$('.catmenu .mhead').textContent, 'Past conversations in a');
  assert.deepEqual(p.api.called('GET', '/api/history').map((c) => c.query), [{ space: 'a' }]);
  assert.equal(p.$('.hrow .htitle').textContent, 'Build it');
  assert.equal(p.$('.hrow .htitle').title, 'Build the thing');
  assert.match(p.$('.hrow .hwhen').textContent, / · 4 KB$/);
  const links = p.$$('.hrow a.hsave');
  assert.deepEqual(links.map((a) => [a.textContent, a.getAttribute('href')]), [
    ['Markdown', `/api/history/export?space=a&id=${ID}&format=md`],
    ['HTML', `/api/history/export?space=a&id=${ID}&format=html`],
  ]);
  assert.equal(p.$('.hrow button').disabled, false);
});

test('Resume opens the new window, and a failed resume says why', async () => {
  const p = await mac({ 'POST /api/history/resume': () => app.session('r1', { label: 'a', space: 'a' }) });
  await openPast(p);
  p.$('.hrow button').click();
  await app.flush();
  assert.deepEqual(p.api.called('POST', '/api/history/resume')[0].body, { space: 'a', id: ID });
  assert.equal(p.$('.catmenu'), null);
  assert.ok(p.wins().includes('a'));
  assert.equal(p.toast(), 'Resumed "Build it" in a.');
  p.api.routes['POST /api/history/resume'] = { error: 'nope' };
  await openPast(p, 'b');
  p.$('.hrow button').click();
  await app.flush();
  assert.equal(p.toast(), 'Could not resume it: nope');
  p.api.routes['POST /api/history/resume'] = new Error('offline');
  await openPast(p, 'b');
  p.$('.hrow button').click();
  await app.flush();
  assert.equal(p.toast(), 'Could not resume it: Could not reach Corral.');
});

test('Resume is off while the space has a window open', async () => {
  const p = await mac({}, [app.session('w1', { label: 'a', space: 'a' })]);
  await openPast(p);
  const b = p.$('.hrow button');
  assert.equal(b.disabled, true);
  assert.match(b.title, /Close it first/);
});

test('the panel says when there is nothing, more than it shows, or an error', async () => {
  const p = await mac({ 'GET /api/history': { conversations: [], more: false } });
  await openPast(p);
  assert.equal(p.$('.catmenu .murl').textContent, 'No Claude Code conversations were started in this folder.');
  p.api.routes['GET /api/history'] = { conversations: [{ ...CONV[0], first: null }], more: true };
  await openPast(p);
  assert.equal(p.$('.hrow .htitle').title, ''); // no first prompt to show on hover
  assert.equal(p.$$('.catmenu .murl').at(-1).textContent, 'Only the 200 most recent are listed.');
  p.api.routes['GET /api/history'] = { error: 'no such space' };
  await openPast(p);
  assert.equal(p.$('.catmenu .murl').textContent, 'Could not list them: no such space.');
  p.api.routes['GET /api/history'] = new Error('offline');
  await openPast(p);
  assert.equal(p.$('.catmenu .murl').textContent, 'Could not list them.');
});

test('the phone menu lists past conversations with Markdown and HTML links', async () => {
  const p = await m.phone([m.win('a', { claude: m.claude('idle'), cwd: '/Users/me/repos/a' })], { routes: { 'GET /api/history': { conversations: CONV, more: false } } });
  p.card('a').querySelector('.more').click();
  p.button('Past conversations').click();
  await m.settle();
  assert.equal(p.sheetTitle(), 'a: past conversations');
  assert.equal(p.$('#gen .ptitle').textContent, 'Build it');
  assert.deepEqual([...p.$('#gen').querySelectorAll('a.save')].map((a) => a.getAttribute('href')), [
    `/api/history/export?window=a&id=${ID}&format=md`, `/api/history/export?window=a&id=${ID}&format=html`,
  ]);
});

test('the phone sheet says when there are none or the list fails, and a window without a folder has no item', async () => {
  const p = await m.phone([m.win('a', { cwd: '/Users/me/repos/a' }), m.win('b', { cwd: null })], { routes: { 'GET /api/history': { conversations: [] } } });
  p.card('a').querySelector('.more').click();
  p.button('Past conversations').click();
  await m.settle();
  assert.match(p.$('#gen').textContent, /No Claude Code conversations/);
  p.api.routes['GET /api/history'] = new Error('offline');
  p.card('a').querySelector('.more').click();
  p.button('Past conversations').click();
  await m.settle();
  assert.match(p.$('#gen').textContent, /Could not list them/);
  p.card('b').querySelector('.more').click();
  assert.ok(![...p.$('#gen').querySelectorAll('button')].some((b) => b.textContent === 'Past conversations'));
});
