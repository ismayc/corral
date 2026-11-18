// public/view.js: the markdown viewer, a page of its own that shows one file drawn or as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { loadPage, unloadPage } = require('../helpers/browser');
const { settle } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const DOC = '---\nname: notes\n---\n# Title\n\nSome **bold** text and https://example.com.\n\n- one\n- two\n';
const file = (text = DOC, extra = {}) => ({ name: 'notes.md', text, modified: 1000, ...extra });

async function view(route = file(), opts = {}) {
  const p = loadPage('view', { url: '/view?space=alpha&path=docs%2Fnotes.md', ...opts, routes: { 'GET /api/view': route, ...opts.routes } });
  await settle();
  p.doc = p.window.document;
  p.$ = (s) => p.doc.querySelector(s);
  p.pressed = () => ['rendered', 'raw'].filter((id) => p.$(`#${id}`).getAttribute('aria-pressed') === 'true');
  return p;
}

test('the file is drawn as a page, with its front matter above, and named in the bar and the title', async () => {
  const p = await view();
  assert.deepEqual(p.api.called('GET', '/api/view')[0].query, { space: 'alpha', path: 'docs/notes.md' });
  assert.equal(p.$('#name').textContent, 'notes.md');
  assert.equal(p.$('#path').textContent, 'docs/notes.md');
  assert.equal(p.doc.title, 'notes.md · Corral');
  assert.deepEqual(p.pressed(), ['rendered']);
  assert.equal(p.$('#doc .md pre.front').textContent, 'name: notes');
  assert.equal(p.$('#doc .md h1').textContent, 'Title');
  assert.equal(p.$('#doc .md strong').textContent, 'bold');
  assert.equal(p.$('#doc .md li').textContent, 'one');
  const a = p.$('#doc .md a');
  assert.deepEqual([a.href, a.target, a.onclick], ['https://example.com/', '_blank', null]);
});

test('Raw shows the text as written, Rendered goes back, and the choice is kept for the next file', async () => {
  let p = await view();
  p.$('#raw').click();
  assert.deepEqual(p.pressed(), ['raw']);
  assert.equal(p.$('#doc pre.raw').textContent, DOC);
  assert.equal(p.$('#doc .md'), null);
  assert.equal(p.window.localStorage.getItem('corral.view.mode'), 'raw');
  p.$('#rendered').click();
  assert.deepEqual(p.pressed(), ['rendered']);
  assert.equal(p.$('#doc .md h1').textContent, 'Title');

  p = await view(file(), { storage: { 'corral.view.mode': 'raw' } });
  assert.deepEqual(p.pressed(), ['raw']);
  assert.equal(p.$('#doc pre.raw').textContent, DOC);
});

test('a file with no front matter, or with Windows line ends, is drawn the same way', async () => {
  let p = await view(file('# Plain\n'));
  assert.equal(p.$('#doc .md pre.front'), null);
  assert.equal(p.$('#doc .md h1').textContent, 'Plain');
  p = await view(file('---\r\na: 1\r\n...\r\n# Windows\r\n\r\ntext\r\n'));
  assert.equal(p.$('#doc .md pre.front').textContent, 'a: 1');
  assert.equal(p.$('#doc .md h1').textContent, 'Windows');
  assert.equal(p.$('#doc .md p').textContent, 'text');
});

test('the page works when the browser refuses storage', async () => {
  const p = await view(file(), { setup(w) {
    const refuse = () => { throw new Error('denied'); };
    Object.defineProperty(w, 'localStorage', { value: { getItem: refuse, setItem: refuse }, configurable: true });
  } });
  assert.deepEqual(p.pressed(), ['rendered']);
  p.$('#raw').click();
  assert.deepEqual(p.pressed(), ['raw']);
});

test('a file that cannot be shown, or a Mac that does not answer, says why', async () => {
  let p = await view({ __reply: true, status: 415, body: { error: 'Corral shows only markdown files' } });
  assert.equal(p.$('#doc .note').textContent, 'Corral shows only markdown files');
  p.$('#raw').click(); // nothing to draw yet
  assert.equal(p.$('#doc .note').textContent, 'Corral shows only markdown files');
  p = await view(new Error('offline'));
  assert.equal(p.$('#doc .note').textContent, 'Could not reach Corral.');
});

test('the file is read again every 2 seconds while the window shows, and a new version keeps the place', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const p = await view();
  let state = 'visible';
  Object.defineProperty(p.doc, 'visibilityState', { get: () => state, configurable: true });
  const scrolls = [];
  p.window.scrollTo = (...a) => scrolls.push(a);
  globalThis.scrollTo = p.window.scrollTo;
  Object.defineProperty(p.window, 'scrollY', { value: 240, configurable: true });
  const calls = () => p.api.called('GET', '/api/view');

  p.api.routes['GET /api/view'] = { unchanged: true };
  mock.timers.tick(2000);
  await settle();
  assert.equal(calls().length, 2);
  assert.equal(calls()[1].query.since, '1000');
  assert.equal(p.$('#doc .md h1').textContent, 'Title');
  assert.deepEqual(scrolls, []);

  p.api.routes['GET /api/view'] = file('# Second\n', { modified: 2000 });
  mock.timers.tick(2000);
  await settle();
  assert.equal(p.$('#doc .md h1').textContent, 'Second');
  assert.deepEqual(scrolls, [[0, 240]]);

  // A read that fails leaves the last version up; the next good one clears the notice.
  p.api.routes['GET /api/view'] = { __reply: true, status: 404, body: { error: 'no such file in this space' } };
  mock.timers.tick(2000);
  await settle();
  assert.equal(p.$('#state').textContent, 'Could not read it again: no such file in this space');
  assert.equal(p.$('#doc .md h1').textContent, 'Second');
  p.api.routes['GET /api/view'] = { unchanged: true };
  mock.timers.tick(2000);
  await settle();
  assert.equal(p.$('#state').textContent, '');
  assert.equal(calls().at(-1).query.since, '2000');

  state = 'hidden';
  const before = calls().length;
  mock.timers.tick(2000);
  await settle();
  assert.equal(calls().length, before);
});

test('a page opened with no file named shows the error and keeps the plain title', async () => {
  const p = await view({ __reply: true, status: 404, body: { error: 'no such file in this space' } }, { url: '/view' });
  assert.deepEqual(p.api.called('GET', '/api/view')[0].query, { space: '', path: '' });
  assert.equal(p.doc.title, 'Corral');
  assert.equal(p.$('#doc .note').textContent, 'no such file in this space');
});
