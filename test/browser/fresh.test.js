// public/fresh.js: the "Corral was updated" banner, loaded here through the markdown viewer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { loadPage, unloadPage } = require('../helpers/browser');
const { settle } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

async function view(version = { version: 'v1' }) {
  unloadPage(); // a second page in one test: before the mock timers start, or unloading puts the real ones back
  mock.timers.reset();
  mock.timers.enable({ apis: ['setInterval'] });
  const p = loadPage('view', { url: '/view?space=a&path=x.md', routes: { 'GET /api/view': { name: 'x.md', text: '# X\n', modified: 1 }, 'GET /api/version': version } });
  await settle();
  p.doc = p.window.document;
  p.banner = () => p.doc.querySelector('.corral-update');
  p.answer = (v) => { p.api.routes['GET /api/version'] = v; };
  p.minute = async () => { mock.timers.tick(60000); await settle(); };
  p.calls = () => p.api.called('GET', '/api/version').length;
  return p;
}

test('a page shows the banner once Corral\'s page files change, and only once', async () => {
  const p = await view();
  await p.minute();
  assert.equal(p.banner(), null);
  p.answer({ version: 'v2' });
  await p.minute();
  assert.equal(p.banner().textContent, 'Corral was updated. Reload this page to use the new version.Reload×');
  assert.equal(p.banner().getAttribute('role'), 'status');
  p.answer({ version: 'v3' });
  await p.minute();
  assert.equal(p.doc.querySelectorAll('.corral-update').length, 1);
  p.banner().querySelector('button').click(); // Reload (jsdom does not navigate)
});

test('closing the banner hides it until the next update', async () => {
  const p = await view();
  p.answer({ version: 'v2' });
  await p.minute();
  p.banner().querySelector('.x').click();
  assert.equal(p.banner(), null);
  await p.minute(); // still v2: the closed banner stays closed
  assert.equal(p.banner(), null);
  p.answer({ version: 'v3' });
  await p.minute();
  assert.notEqual(p.banner(), null);
});

test('a failed check changes nothing, and a page that loaded during one takes the next answer', async () => {
  let p = await view(new Error('restarting'));
  p.answer({ version: 'v1' });
  await p.minute();
  assert.equal(p.banner(), null);
  p.answer({ version: 'v2' });
  await p.minute();
  assert.notEqual(p.banner(), null);

  p = await view();
  p.answer({ __reply: true, status: 500, body: { error: 'down' } });
  await p.minute();
  p.answer(new Error('offline'));
  await p.minute();
  assert.equal(p.banner(), null);
});

test('coming back into view checks at once; going out of view does not', async () => {
  const p = await view();
  let state = 'hidden';
  Object.defineProperty(p.doc, 'visibilityState', { get: () => state, configurable: true });
  const n = p.calls();
  p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.calls(), n);
  state = 'visible';
  p.answer({ version: 'v2' });
  p.doc.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.calls(), n + 1);
  assert.notEqual(p.banner(), null);
});
