// public/editor.js: Edit mode for a markdown file, here through the viewer (public/view.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { loadPage, unloadPage, fire } = require('../helpers/browser');
const { settle } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

async function view(routes = {}) {
  unloadPage(); // a second page in one test: before the mock timers start, or unloading puts the real ones back
  mock.timers.reset();
  mock.timers.enable({ apis: ['setInterval'] });
  const p = loadPage('view', {
    url: '/view?space=alpha&path=notes.md',
    routes: { 'GET /api/view': { name: 'notes.md', text: '# One\n', modified: 1 }, ...routes },
  });
  await settle();
  p.doc = p.window.document;
  p.$ = (s) => p.doc.querySelector(s);
  p.area = () => p.$('#doc textarea.edit');
  p.state = () => p.$('#doc .estate').textContent;
  p.shown = (sel) => !p.$(`#doc ${sel}`).hidden;
  p.type = (text) => { p.area().value = text; fire(p.area(), 'input'); };
  p.tick = async () => { mock.timers.tick(2000); await settle(); };
  return p;
}
const saves = (p) => p.api.called('POST', '/api/save').map((c) => c.body);

test('Edit shows the text, Save writes it with the version it started from, and the bar marks unsaved edits', async () => {
  const p = await view({ 'POST /api/save': { ok: true, modified: 2 } });
  p.$('#edit').click();
  assert.equal(p.$('#edit').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('#rendered').getAttribute('aria-pressed'), 'false');
  assert.equal(p.area().value, '# One\n');
  assert.equal(p.shown('.eforce'), false);
  p.$('#doc .esave').click();
  assert.equal(p.state(), 'No changes to save.');
  p.type('# Two\n');
  assert.equal(p.$('#edit').textContent, 'Edit •');
  assert.equal(p.doc.title, '• notes.md · Corral');
  fire(p.area(), 'keydown', { key: 's', metaKey: true });
  await settle();
  assert.deepEqual(saves(p), [{ space: 'alpha', path: 'notes.md', text: '# Two\n', base: 1, force: false }]);
  assert.equal(p.state(), 'Saved.');
  assert.equal(p.$('#edit').textContent, 'Edit');
  // The saved version is the one the page has now, so the next read asks from it and the text stays.
  p.api.routes['GET /api/view'] = { unchanged: true };
  await p.tick();
  assert.equal(p.api.called('GET', '/api/view').at(-1).query.since, '2');
  // A read that crossed the save brings back the saved version itself: nothing changes.
  p.type('# Three\n');
  p.api.routes['GET /api/view'] = { name: 'notes.md', text: '# Two\n', modified: 2 };
  await p.tick();
  assert.deepEqual([p.area().value, p.shown('.eforce')], ['# Three\n', false]);
  p.api.routes['GET /api/view'] = { unchanged: true };
  assert.equal(p.state(), ''); // typing cleared "Saved."
  p.type('# Four\n'); // a second edit with nothing to clear
  fire(p.area(), 'keydown', { key: 's', ctrlKey: true });
  await settle();
  assert.equal(saves(p).at(-1).base, 2);
  fire(p.area(), 'keydown', { key: 'a', metaKey: true });
  fire(p.area(), 'keydown', { key: 's' });
  await settle();
  assert.equal(saves(p).length, 2);
  // Rendered shows what was saved.
  p.$('#rendered').click();
  assert.equal(p.$('#doc .md h1').textContent, 'Four');
});

test('a file changed on disk while there are no edits just follows the file', async () => {
  const p = await view();
  p.$('#edit').click();
  p.api.routes['GET /api/view'] = { name: 'notes.md', text: '# Claude wrote this\n', modified: 5 };
  await p.tick();
  assert.equal(p.area().value, '# Claude wrote this\n');
  assert.equal(p.shown('.eforce'), false);
});

test('a file changed on disk under unsaved edits keeps them and offers the disk version or Save anyway', async () => {
  const p = await view({ 'POST /api/save': (req) => (req.body.force ? { ok: true, modified: 9 } : { __reply: true, status: 409, body: { conflict: true, error: 'changed', text: '# Disk\n', modified: 5 } }) });
  p.$('#edit').click();
  p.type('# Mine\n');
  p.api.routes['GET /api/view'] = { name: 'notes.md', text: '# Disk\n', modified: 5 };
  await p.tick();
  assert.equal(p.area().value, '# Mine\n');
  assert.equal(p.state(), 'The file changed on disk. Save anyway replaces it, or use the version on disk.');
  assert.equal(p.shown('.eforce'), true);
  assert.equal(p.shown('.etake'), true);
  p.$('#doc .etake').click();
  assert.equal(p.area().value, '# Disk\n');
  assert.equal(p.state(), 'Showing the version on disk.');
  assert.equal(p.shown('.eforce'), false);
  assert.equal(p.$('#edit').textContent, 'Edit');

  // The server refuses a save made from an older version, and Save anyway goes through.
  p.type('# Mine again\n');
  p.api.routes['GET /api/view'] = { unchanged: true };
  p.$('#doc .esave').click();
  await settle();
  assert.equal(p.state(), 'The file changed on disk after you started editing.');
  assert.equal(saves(p).at(-1).force, false);
  p.$('#doc .eforce').click();
  await settle();
  assert.equal(saves(p).at(-1).force, true);
  assert.equal(p.state(), 'Saved.');
});

test('a save that fails says why and keeps the edits', async () => {
  let p = await view({ 'POST /api/save': { __reply: true, status: 413, body: { error: 'too large' } } });
  p.$('#edit').click();
  p.type('# Big\n');
  p.$('#doc .esave').click();
  await settle();
  assert.equal(p.state(), 'Could not save: too large');
  assert.equal(p.area().value, '# Big\n');
  p = await view({ 'POST /api/save': new Error('offline') });
  p.$('#edit').click();
  p.type('# Lost\n');
  p.$('#doc .esave').click();
  await settle();
  assert.equal(p.state(), 'Could not save: Could not reach Corral.');
});

test('leaving Edit keeps unsaved edits for the next visit, and a new version on disk reaches them', async () => {
  const p = await view();
  p.$('#edit').click();
  p.type('# Draft\n');
  p.$('#raw').click();
  assert.equal(p.$('#doc pre.raw').textContent, '# One\n');
  p.api.routes['GET /api/view'] = { name: 'notes.md', text: '# Disk\n', modified: 5 };
  await p.tick();
  assert.equal(p.$('#doc pre.raw').textContent, '# Disk\n');
  p.$('#edit').click();
  assert.equal(p.area().value, '# Draft\n');
  assert.equal(p.shown('.etake'), true);
  // Unsaved edits make the browser ask before the window goes; none, and it does not.
  const leave = () => { const e = new p.window.Event('beforeunload', { cancelable: true }); p.window.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(leave(), true);
  p.$('#doc .etake').click();
  assert.equal(leave(), false);
  // With no edits, leaving drops the editor: the next Edit starts from the file as it is then.
  p.$('#rendered').click();
  p.api.routes['GET /api/view'] = { name: 'notes.md', text: '# Later\n', modified: 7 };
  await p.tick();
  p.$('#edit').click();
  assert.equal(p.area().value, '# Later\n');
});

test('Edit does nothing before the file has been read', async () => {
  const p = await view({ 'GET /api/view': { __reply: true, status: 404, body: { error: 'gone' } } });
  p.$('#edit').click();
  assert.equal(p.$('#edit').getAttribute('aria-pressed'), 'false');
  assert.equal(p.area(), null);
});
