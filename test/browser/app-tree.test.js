const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const LISTING = {
  '': { entries: [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }, { name: 'docs', type: 'dir', link: true }] },
  src: { entries: [{ name: 'main.js', type: 'file' }], truncated: true },
  docs: { entries: [] },
};
const routes = (extra = {}) => ({
  'GET /api/herdr': { available: true, spaces: [space('alpha')] },
  'GET /api/files': (req) => LISTING[req.query.path] || { error: 'no such folder' },
  ...extra,
});
const tree = (p) => p.row('alpha').parentNode.querySelector('.tree');
const lines = (box) => [...box.children].map((n) => (n.classList.contains('node') ? `${n.className}: ${n.textContent}` : n.className === 'note' ? `note: ${n.textContent}` : `kids(${n.children.length})`));

test("the chevron shows a space's files in the order the server lists them, and remembers it", async () => {
  const p = await start({ routes: routes() });
  const chev = p.row('alpha').querySelector('.chev');
  assert.equal(chev.textContent, '▸');
  assert.equal(tree(p).hidden, true);
  chev.click();
  assert.equal(lines(tree(p))[0], 'note: Loading...');
  await flush();
  assert.equal(chev.textContent, '▾');
  assert.deepEqual(p.api.called('GET', '/api/files')[0].query, { space: 'alpha', path: '', hidden: '0' });
  assert.deepEqual(lines(tree(p)), ['node dir: ▸src', 'kids(0)', 'node file: README.md', 'node dir: ▸docs↪', 'kids(0)']);
  assert.equal(tree(p).querySelector('.node.file').title, 'Click to open. Right-click to choose the app.');
  assert.deepEqual(p.store('corral.expanded'), ['alpha']);
  assert.equal(p.api.called('POST', '/api/sessions').length, 0, 'the chevron does not open a window');
  chev.click();
  assert.equal(tree(p).hidden, true);
  assert.deepEqual(p.store('corral.expanded'), []);
});

test('a space left open shows its files on load', async () => {
  const p = await start({ storage: { 'corral.expanded': ['alpha'] }, routes: routes() });
  assert.equal(tree(p).hidden, false);
  assert.equal(tree(p).querySelectorAll('.node').length, 3);
});

test('folders open and close in place, and long lists say they were cut off', async () => {
  const p = await start({ storage: { 'corral.expanded': ['alpha'] }, routes: routes() });
  const [src, , docs] = tree(p).querySelectorAll(':scope > .node');
  src.click();
  await flush();
  assert.equal(src.querySelector('.ic').textContent, '▾');
  assert.equal(p.api.called('GET', '/api/files').at(-1).query.path, 'src');
  assert.deepEqual(lines(src.nextElementSibling), ['node file: main.js', 'note: List cut off at 1000 entries.']);
  assert.equal(src.nextElementSibling.style.paddingLeft, '14px');
  docs.click();
  await flush();
  assert.deepEqual(lines(docs.nextElementSibling), ['note: (empty)']);
  src.click();
  assert.equal(src.querySelector('.ic').textContent, '▸');
  assert.equal(src.nextElementSibling.children.length, 0);
});

test('a folder the server cannot list shows its error, and no answer says so', async () => {
  const p = await start({ routes: routes({ 'GET /api/files': { error: 'unknown space' } }) });
  p.row('alpha').querySelector('.chev').click();
  await flush();
  assert.deepEqual(lines(tree(p)), ['note: unknown space']);
  p.api.routes['GET /api/files'] = new Error('offline');
  p.row('alpha').querySelector('.chev').click();
  p.row('alpha').querySelector('.chev').click();
  await flush();
  assert.deepEqual(lines(tree(p)), ['note: Could not load files.']);
});

test('clicking a file opens it in the app saved for its type', async () => {
  const p = await start({ storage: { 'corral.expanded': ['alpha'] }, routes: routes({ 'POST /api/open': { ok: true, kind: 'js', app: 'Code', remembered: true } }) });
  const src = tree(p).querySelector('.node.dir');
  src.click();
  await flush();
  src.nextElementSibling.querySelector('.node.file').click();
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/open')[0].body, { space: 'alpha', path: 'src/main.js' });
  assert.equal(p.toast(), 'Opened main.js in Code.');
});

test('a file that will not open shows the reason, a plain message, or that Corral is unreachable', async () => {
  const p = await start({ storage: { 'corral.expanded': ['alpha'] }, routes: routes({ 'POST /api/open': { __reply: true, status: 502, body: { error: 'macOS could not open it' } } }) });
  const file = tree(p).querySelector('.node.file');
  file.click();
  await flush();
  assert.equal(p.toast(), 'macOS could not open it');
  p.api.routes['POST /api/open'] = { ok: false };
  file.click();
  await flush();
  assert.equal(p.toast(), 'Could not open it.');
  p.api.routes['POST /api/open'] = new Error('offline');
  file.click();
  await flush();
  assert.equal(p.toast(), 'Could not reach Corral.');
});

test('a file with no saved app asks which app to use, next to the file', async () => {
  const p = await start({
    storage: { 'corral.expanded': ['alpha'] },
    routes: routes({
      'POST /api/open': { needsChoice: true },
      'GET /api/open-with': { name: 'README.md', kind: 'md', saved: null, def: '/Applications/Typora.app', apps: [{ name: 'Typora', path: '/Applications/Typora.app' }], asText: false },
    }),
  });
  tree(p).querySelector('.node.file').click();
  await flush();
  const menu = p.$('.catmenu.openwith');
  assert.equal(menu.querySelector('.mhead').textContent, 'Open README.md with');
  assert.equal(menu.querySelector('.mnote'), null);
  assert.deepEqual(p.api.called('GET', '/api/open-with')[0].query, { space: 'alpha', path: 'README.md' });
  assert.equal(menu.style.left, '8px');
  assert.equal(menu.style.top, '8px');
});

test('right-clicking a file always asks, at the pointer', async () => {
  const p = await start({
    storage: { 'corral.expanded': ['alpha'] },
    routes: routes({ 'GET /api/open-with': { name: 'README.md', kind: 'md', saved: null, def: null, apps: [], asText: true } }),
  });
  const ev = fire(tree(p).querySelector('.node.file'), 'contextmenu', { clientX: 500, clientY: 300 });
  assert.ok(ev.defaultPrevented);
  await flush();
  const menu = p.$('.catmenu.openwith');
  assert.equal(menu.style.left, '500px');
  assert.equal(menu.style.top, '304px');
  assert.equal(p.api.called('POST', '/api/open').length, 0);
});
