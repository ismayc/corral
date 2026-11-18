// Markdown files on the phone: the list from the terminal's ⋯ menu, and one file drawn or as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, settle, unloadPage, goBack, popstate, deferred } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const DOC = '---\nname: notes\n---\n# Title\n\nSee [the plan](plan.md#Steps), [a script](../R/fit.R), [here](#title), and https://example.com.\n\n![plot](img/p.png)\n';
const file = (text = DOC, modified = 1000) => ({ name: 'notes.md', text, modified });
const FILES = ['README.md', 'docs/notes.md'];

// Opens window a with these routes, then the Markdown files list from the ⋯ menu.
async function list(files = FILES, routes = {}, opts = {}) {
  const p = await phone([win('a')], { ...opts, routes: { 'GET /api/sessions/a/markdown': { files, truncated: false }, 'GET /api/view': file(), ...routes } });
  await p.openWin('a');
  p.$('#morebtn').click();
  p.button('Markdown files').click();
  await settle();
  p.rows = () => p.$$('#genbody .mdfiles button').filter((b) => !b.hidden).map((b) => b.textContent);
  p.pressed = () => ['mdrendered', 'mdraw'].filter((id) => p.$(`#${id}`).getAttribute('aria-pressed') === 'true');
  p.views = () => p.api.called('GET', '/api/view').map((c) => c.query);
  return p;
}
// Opens docs/notes.md from the list.
async function notes(routes, opts) {
  const p = await list(FILES, routes, opts);
  p.$$('#genbody .mdfiles button')[1].click();
  await settle();
  return p;
}

test('Markdown files lists the project\'s files, each with its folder', async () => {
  const p = await list();
  assert.equal(p.sheetTitle(), '2 markdown files');
  assert.deepEqual(p.rows(), ['README.md', 'notes.mddocs']);
  assert.equal(p.$('#genbody .mdfiles button small').textContent, 'docs');
  assert.equal(p.$('#genbody .mdfilter'), null);
  assert.equal(p.$('#genbody').firstChild, p.$('#genbody .mdfiles'), 'nothing above the list');
});

test('a long list has a filter, and the title says when the list is cut', async () => {
  const many = Array.from({ length: 9 }, (_, i) => `docs/Note${i}.md`);
  const p = await list(many, { 'GET /api/sessions/a/markdown': { files: many, truncated: true } });
  assert.equal(p.sheetTitle(), '9 markdown files (the first found)');
  const filter = p.$('#genbody .mdfilter');
  filter.value = ' note3 ';
  filter.oninput();
  assert.deepEqual(p.rows(), ['Note3.mddocs']);
  filter.value = '';
  filter.oninput();
  assert.equal(p.rows().length, 9);
});

test('one file is counted as one, none says so, and a list that cannot load says so', async () => {
  let p = await list(['README.md']);
  assert.equal(p.sheetTitle(), '1 markdown file');
  p = await list([]);
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.toast(), 'This project has no markdown files.');
  p = await list(FILES, { 'GET /api/sessions/a/markdown': new Error('offline') });
  assert.equal(p.toast(), 'Could not list the files.');
});

test('a list that arrives after the window was left is dropped', async () => {
  const hold = deferred();
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/markdown': () => hold.promise } });
  await p.openWin('a');
  p.$('#morebtn').click();
  p.button('Markdown files').click();
  await goBack(p);
  hold.resolve({ files: FILES, truncated: false });
  await settle();
  assert.equal(p.sheetTitle(), null);
});

test('a tapped file opens drawn as a page, named in the header, with Back to the terminal', async () => {
  const p = await list();
  p.$$('#genbody .mdfiles button')[1].click();
  assert.equal(p.sheetTitle(), null);
  assert.deepEqual([p.$('#mdview').hidden, p.$('#termview').hidden], [false, true]);
  assert.equal(p.text('#mdbody .note'), 'Loading…');
  assert.deepEqual(p.window.history.state, { md: true });
  assert.deepEqual([p.text('#mdtitle'), p.text('#mdsub')], ['notes.md', 'a · docs/notes.md']);
  await settle();
  assert.deepEqual(p.views(), [{ window: 'a', path: 'docs/notes.md' }]);
  assert.deepEqual(p.pressed(), ['mdrendered']);
  assert.equal(p.text('#mdbody .md h1'), 'Title');
  assert.equal(p.text('#mdbody .md pre.front'), 'name: notes');
  assert.equal(p.$('#mdbody .md img').getAttribute('src'), '/api/image?window=a&path=docs%2Fimg%2Fp.png');

  const popped = popstate(p);
  p.$('#mdback').click();
  await popped;
  assert.deepEqual([p.$('#mdview').hidden, p.$('#termview').hidden], [true, false]);
});

test('Raw shows the text as written, and the choice is kept', async () => {
  let p = await notes();
  p.$('#mdbody').scrollTop = 50;
  p.$('#mdraw').click();
  assert.deepEqual(p.pressed(), ['mdraw']);
  assert.equal(p.text('#mdbody pre.raw'), DOC);
  assert.equal(p.$('#mdbody').scrollTop, 0);
  assert.equal(p.window.localStorage.getItem('corral.m.mdmode'), '"raw"');
  p.$('#mdrendered').click();
  assert.equal(p.text('#mdbody .md h1'), 'Title');

  p = await notes({}, { storage: { 'corral.m.mdmode': '"raw"' } });
  assert.deepEqual(p.pressed(), ['mdraw']);
  assert.equal(p.text('#mdbody pre.raw'), DOC);
});

test('links: another markdown file opens here at its heading, a web link asks first, and other files do not open', async () => {
  const p = await notes();
  const [plan, script, here, web] = p.$$('#mdbody .md a');
  const click = (a) => { const e = new p.window.MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(e); return e; };

  assert.equal(click(here).defaultPrevented, true);
  assert.equal(p.$('#mdbody .md h1').scrolledIntoView, true);

  click(web);
  assert.equal(p.sheetTitle(), 'Open this link?');
  p.$('#genx').click();

  click(script);
  assert.equal(p.toast(), 'fit.R is not a markdown file, so it does not open here.');

  p.api.routes['GET /api/view'] = { name: 'plan.md', text: '# Plan\n\n## Steps\n', modified: 5 };
  const before = p.window.history.length;
  assert.equal(click(plan).defaultPrevented, true);
  await settle();
  assert.deepEqual(p.views().at(-1), { window: 'a', path: 'docs/plan.md' });
  assert.deepEqual([p.text('#mdtitle'), p.text('#mdsub')], ['plan.md', 'a · docs/plan.md']);
  assert.equal(p.$('#mdbody .md h2').scrolledIntoView, true);
  assert.equal(p.window.history.length, before, 'Back still goes to the terminal');
});

test('a file that cannot be read, or a Mac that does not answer, says why', async () => {
  let p = await notes({ 'GET /api/view': { __reply: true, status: 413, body: { error: 'This file is over 2 MB, too large to show' } } });
  assert.equal(p.text('#mdbody .note'), 'This file is over 2 MB, too large to show');
  p.$('#mdraw').click(); // nothing to draw yet
  assert.equal(p.text('#mdbody .note'), 'This file is over 2 MB, too large to show');
  p = await notes({ 'GET /api/view': new Error('offline') });
  assert.equal(p.text('#mdbody .note'), 'Could not reach the Mac.');
});

test('the file is read again every 2 seconds while it shows, and a new version keeps the place', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const p = await notes();
  let state = 'visible';
  Object.defineProperty(p.doc, 'visibilityState', { get: () => state, configurable: true });
  const tick = async () => { mock.timers.tick(2000); await settle(); };

  p.api.routes['GET /api/view'] = { unchanged: true };
  await tick();
  assert.deepEqual(p.views().at(-1), { window: 'a', path: 'docs/notes.md', since: '1000' });
  assert.equal(p.text('#mdbody .md h1'), 'Title');

  p.$('#mdbody').scrollTop = 120;
  p.api.routes['GET /api/view'] = file('# Second\n', 2000);
  await tick();
  assert.equal(p.text('#mdbody .md h1'), 'Second');
  assert.equal(p.$('#mdbody').scrollTop, 120);

  // A later read that fails leaves the last version up.
  p.api.routes['GET /api/view'] = { __reply: true, status: 404, body: { error: 'no such file in this project' } };
  await tick();
  assert.equal(p.text('#mdbody .md h1'), 'Second');

  state = 'hidden';
  const n = p.views().length;
  await tick();
  assert.equal(p.views().length, n);

  // Back to the terminal: nothing more is read, and a read still on its way is dropped.
  state = 'visible';
  const hold = deferred();
  p.api.routes['GET /api/view'] = () => hold.promise;
  mock.timers.tick(2000);
  await goBack(p);
  hold.resolve(file('# Late\n', 3000));
  await settle();
  assert.equal(p.text('#mdbody .md h1'), 'Second');
  const m = p.views().length;
  await tick();
  assert.equal(p.views().length, m);
});
