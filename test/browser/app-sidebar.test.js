const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, dt, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const herdr = (...list) => ({ 'GET /api/herdr': { available: true, spaces: list.map((s) => (typeof s === 'string' ? space(s) : s)) } });
const CATS = (extra = {}) => ({ 'GET /api/categories': { version: 1, categories: [{ name: 'Work', collapsed: false }], uncatCollapsed: false, assign: {}, ...extra } });
const typeFilter = (p, text) => { p.$('#filter').value = text; fire(p.$('#filter'), 'input'); };

test('the sidebar lists every space with its status and a tooltip', async () => {
  const p = await start({ routes: herdr(space('alpha', { status: 'working' }), space('beta', { root: null, cwd: '/tmp/beta' }), space('gamma', { root: null, cwd: null })) });
  assert.deepEqual(p.rowNames(), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(p.secs(), []);
  assert.ok(p.row('alpha').querySelector('.dot').classList.contains('working'));
  assert.match(p.row('alpha').title, /^\/Users\/me\/repos\/alpha\nClick to open/);
  assert.match(p.row('beta').title, /^\/tmp\/beta\n/);
  assert.match(p.row('gamma').title, /^\nClick to open/);
});

test('no spaces says so', async () => {
  const p = await start();
  assert.equal(p.$('#spaces .note').textContent, 'No spaces.');
});

test('spaces with an open window come first under their own heading', async () => {
  const p = await start({
    routes: {
      ...herdr('alpha', 'beta', space('gamma', { cwd: '/Users/me/repos/gamma/sub' }), 'delta'),
      'GET /api/sessions': { sessions: [
        session('w1', { label: 'beta', space: 'beta' }),
        // Older windows without a space match by folder: the space's cwd, or its root.
        session('w2', { label: 'g', cwd: '/Users/me/repos/gamma' }),
        session('w3', { label: 'shell', cwd: '' }),
      ] },
    },
  });
  assert.deepEqual(p.secs(), ['Open windows (2)', 'All spaces (2)']);
  assert.deepEqual(p.rowNames(), ['beta', 'gamma', 'alpha', 'delta']);
  assert.ok(p.row('beta').classList.contains('has-win'));
  assert.ok(!p.row('alpha').classList.contains('has-win'));
});

test('a window matched by the space folder counts as the space being open', async () => {
  const p = await start({
    routes: { ...herdr(space('alpha', { root: '/r/alpha', cwd: '/r/alpha/app' })), 'GET /api/sessions': { sessions: [session('w', { cwd: '/r/alpha/app' })] } },
  });
  assert.deepEqual(p.secs(), ['Open windows (1)']);
});

test('the search box filters spaces by name, ignoring case', async () => {
  const p = await start({ routes: herdr('Alpha', 'beta', 'alphabet') });
  typeFilter(p, '  ALPH ');
  assert.deepEqual(p.rowNames(), ['Alpha', 'alphabet']);
  typeFilter(p, 'zzz');
  assert.deepEqual(p.rowNames(), []);
  assert.equal(p.$('#spaces .note').textContent, 'No spaces.');
});

test('when herdr cannot be reached the sidebar says why', async () => {
  const p = await start({ routes: { 'GET /api/herdr': { available: false, spaces: [], error: 'connection refused' } } });
  assert.equal(p.$('#spaces').textContent, 'herdr not reachable: connection refused');
  assert.equal(p.api.called('GET', '/api/projects').length, 1);
});

test('the reload button asks herdr again and redraws the list', async () => {
  const p = await start({ routes: herdr('alpha') });
  p.api.routes['GET /api/herdr'] = herdr('alpha', 'beta')['GET /api/herdr'];
  p.$('#refresh').click();
  await flush();
  assert.deepEqual(p.rowNames(), ['alpha', 'beta']);
  assert.equal(p.api.called('GET', '/api/herdr').length, 2);
});

test('Cmd-click and Ctrl-click toggle a space in the selection', async () => {
  const p = await start({ routes: { ...herdr('a', 'b', 'c'), ...CATS() } });
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.row('c'), 'click', { ctrlKey: true });
  assert.deepEqual(p.$$('#spaces .space.sel').map((d) => d.dataset.id), ['a', 'c']);
  const sel = p.$('#bulk select');
  assert.equal(p.$('#bulk').hidden, false);
  assert.equal(sel.options[0].textContent, 'Move 2 selected to...');
  assert.deepEqual([...sel.options].map((o) => o.value), ['', 'c:Work', 'none']);
  fire(p.row('a'), 'click', { metaKey: true });
  assert.deepEqual(p.$$('#spaces .space.sel').map((d) => d.dataset.id), ['c']);
  assert.equal(p.api.called('POST', '/api/sessions').length, 0);
});

test('Shift-click selects a run from the last pick, or just the space with no pick yet', async () => {
  const p = await start({ routes: { ...herdr('a', 'b', 'c', 'd'), ...CATS() } });
  fire(p.row('b'), 'click', { shiftKey: true });
  assert.deepEqual(p.$$('#spaces .space.sel').map((d) => d.dataset.id), ['b']);
  fire(p.row('d'), 'click', { shiftKey: true });
  assert.deepEqual(p.$$('#spaces .space.sel').map((d) => d.dataset.id), ['b', 'c', 'd']);
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.row('c'), 'click', { shiftKey: true });
  assert.deepEqual(p.$$('#spaces .space.sel').map((d) => d.dataset.id), ['a', 'b', 'c', 'd']);
});

test('a plain click while spaces are selected only ends the selection', async () => {
  const p = await start({ routes: { ...herdr('a', 'b'), ...CATS() } });
  fire(p.row('a'), 'click', { metaKey: true });
  p.row('b').click();
  await flush();
  assert.equal(p.$$('#spaces .space.sel').length, 0);
  assert.equal(p.$('#bulk').hidden, true);
  assert.equal(p.api.called('POST', '/api/sessions').length, 0);
});

test('Esc ends the selection, and other keys do not', async () => {
  const p = await start({ routes: { ...herdr('a', 'b'), ...CATS() } });
  fire(p.doc.body, 'keydown', { key: 'Escape' });
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.doc.body, 'keydown', { key: 'Enter' });
  assert.equal(p.$$('#spaces .space.sel').length, 1);
  fire(p.doc.body, 'keydown', { key: 'Escape' });
  assert.equal(p.$$('#spaces .space.sel').length, 0);
});

test('the bulk bar moves the selection into a category, and Clear ends it', async () => {
  const p = await start({ routes: { ...herdr('a', 'b', 'c'), ...CATS(), 'POST /api/categories': (req) => req.body } });
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.row('b'), 'click', { metaKey: true });
  const sel = p.$('#bulk select');
  sel.value = '';
  fire(sel, 'change');
  assert.equal(p.$$('#spaces .space.sel').length, 2);
  sel.value = 'c:Work';
  fire(sel, 'change');
  assert.deepEqual(p.secs(), ['▾ Work 2', '▾ Uncategorized 1']);
  assert.equal(p.toast(), 'Moved 2 spaces to Work');
  assert.equal(p.$('#bulk').hidden, true);
  p.tick(250);
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/categories')[0].body.assign, { '/Users/me/repos/a': 'Work', '/Users/me/repos/b': 'Work' });
  fire(p.row('a'), 'click', { metaKey: true });
  const clr = p.$('#bulk button');
  assert.equal(clr.textContent, 'Clear');
  assert.equal(clr.title, 'Clear the selection (Esc)');
  clr.click();
  assert.equal(p.$$('#spaces .space.sel').length, 0);
});

test('with a search and no selection the bulk bar moves every match', async () => {
  const p = await start({ routes: { ...herdr('app-one', 'app-two', 'web'), ...CATS({ assign: { '/Users/me/repos/web': 'Work' } }) } });
  assert.equal(p.$('#bulk').hidden, true);
  typeFilter(p, 'web');
  assert.equal(p.$('#bulk select').options[0].textContent, 'Move 1 match to...');
  assert.equal(p.$('#bulk button'), null);
  typeFilter(p, 'app');
  assert.equal(p.$('#bulk select').options[0].textContent, 'Move 2 matches to...');
  p.$('#bulk select').value = 'none';
  fire(p.$('#bulk select'), 'change');
  assert.equal(p.toast(), 'Moved 2 spaces to Uncategorized');
});

test('the bulk bar stays hidden without categories', async () => {
  const p = await start({ routes: herdr('a') });
  fire(p.row('a'), 'click', { metaKey: true });
  assert.ok(p.row('a').classList.contains('sel'));
  assert.equal(p.$('#bulk').hidden, true);
});

test('Show hidden files is saved and reloads open file trees with hidden files', async () => {
  const p = await start({ storage: { 'corral.expanded': ['a'] }, routes: { ...herdr('a'), 'GET /api/files': { entries: [] } } });
  assert.equal(p.api.called('GET', '/api/files')[0].query.hidden, '0');
  p.$('#hidden').checked = true;
  fire(p.$('#hidden'), 'change');
  await flush();
  assert.equal(p.store('corral.hidden'), true);
  assert.equal(p.api.called('GET', '/api/files').at(-1).query.hidden, '1');
});

test('the saved Show hidden files setting is applied on load', async () => {
  const p = await start({ storage: { 'corral.hidden': true } });
  assert.equal(p.$('#hidden').checked, true);
});

test('dragging a space row carries its id, or the whole selection when it is selected', async () => {
  const p = await start({ routes: { ...herdr('a', 'b', 'c'), ...CATS() } });
  const d1 = dt();
  fire(p.row('a'), 'dragstart', { dataTransfer: d1 });
  assert.equal(d1.data['text/x-corral-space'], 'a');
  assert.equal(d1.effectAllowed, 'move');
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.row('c'), 'click', { metaKey: true });
  const d2 = dt();
  fire(p.row('c'), 'dragstart', { dataTransfer: d2 });
  assert.equal(d2.data['text/x-corral-space'], 'a\nc');
});
