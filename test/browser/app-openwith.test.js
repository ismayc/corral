const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const CODE = { name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app' };
const TEXTEDIT = { name: 'TextEdit', path: '/System/Applications/TextEdit.app' };
const XCODE = { name: 'Xcode', path: '/Applications/Xcode.app' };
const info = (extra = {}) => ({ name: 'app.js', kind: 'js', saved: null, def: TEXTEDIT.path, apps: [CODE, TEXTEDIT, XCODE], asText: false, ...extra });

// Opens the Open with menu for app.js in space alpha by right-clicking it in the tree.
async function menuFor(withInfo, extra = {}) {
  const p = await start({
    storage: { 'corral.expanded': ['alpha'] },
    routes: {
      'GET /api/herdr': { available: true, spaces: [space('alpha')] },
      'GET /api/files': { entries: [{ name: 'app.js', type: 'file' }] },
      'GET /api/open-with': withInfo,
      ...extra,
    },
  });
  fire(p.$('.tree .node.file'), 'contextmenu', { clientX: 100, clientY: 100 });
  await flush();
  p.menu = () => p.$('.catmenu.openwith');
  p.items = () => [...p.menu().querySelectorAll('button')].map((b) => b.textContent);
  p.pick = (text) => [...p.menu().querySelectorAll('button')].find((b) => b.textContent === text).click();
  return p;
}

test('the menu lists the macOS default first, then the other apps, then Show in Finder', async () => {
  const p = await menuFor(info());
  assert.deepEqual(p.items(), ['TextEdit (macOS default)', 'Visual Studio Code', 'Xcode', 'Show in Finder']);
  assert.equal(p.menu().querySelector('label.always').textContent, 'Always open js files this way');
  assert.equal(p.menu().querySelector('label.always input').checked, false);
  assert.equal(p.menu().querySelectorAll('.msep').length, 2);
  assert.equal(p.menu().querySelector('.forget'), null);
  assert.equal(p.doc.activeElement, p.menu().querySelector('button'));
});

test('a saved app comes first with a check, and can be forgotten', async () => {
  const p = await menuFor(info({ saved: XCODE.path }), { 'POST /api/open-with/forget': { ok: true } });
  assert.deepEqual(p.items(), ['✓ Xcode', 'TextEdit (macOS default)', 'Visual Studio Code', 'Show in Finder', 'Forget Xcode for js files']);
  p.menu().querySelector('.forget').click();
  assert.equal(p.menu(), null);
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/open-with/forget')[0].body, { kind: 'js' });
  assert.equal(p.toast(), 'Corral will ask again for js files.');
});

test('a saved app that is also the default is listed once', async () => {
  const p = await menuFor(info({ saved: TEXTEDIT.path }));
  assert.deepEqual(p.items(), ['✓ TextEdit (macOS default)', 'Visual Studio Code', 'Xcode', 'Show in Finder', 'Forget TextEdit for js files']);
});

test('a saved macOS default, or a saved app no longer offered, is named in Forget', async () => {
  let p = await menuFor(info({ saved: 'system' }));
  assert.equal(p.menu().querySelector('.forget').textContent, 'Forget the macOS default for js files');
  p = await menuFor(info({ saved: '/Applications/Gone.app' }));
  assert.equal(p.menu().querySelector('.forget').textContent, 'Forget Gone.app for js files');
  assert.deepEqual(p.items().slice(0, 1), ['TextEdit (macOS default)']);
});

test('a file macOS has no app for offers plain-text editors and says why', async () => {
  const p = await menuFor(info({ def: null, apps: [TEXTEDIT], asText: true }));
  assert.deepEqual([...p.menu().querySelectorAll('.mnote')].map((n) => n.textContent), ['macOS has no app for this type of file. These open plain text.']);
  assert.deepEqual(p.items(), ['TextEdit', 'Show in Finder']);
});

test('with no apps at all the menu says so and still offers Finder', async () => {
  const p = await menuFor(info({ def: null, apps: [] }));
  assert.equal(p.menu().querySelector('.mnote').textContent, 'No app on this Mac offers to open it.');
  assert.deepEqual(p.items(), ['Show in Finder']);
});

test('picking an app with Always checked opens the file and remembers the app', async () => {
  const p = await menuFor(info(), { 'POST /api/open': { ok: true, kind: 'js', app: 'Visual Studio Code', remembered: true } });
  p.menu().querySelector('label.always input').checked = true;
  p.pick('Visual Studio Code');
  assert.equal(p.menu(), null);
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/open')[0].body, { space: 'alpha', path: 'app.js', app: CODE.path, remember: true });
  assert.equal(p.toast(), 'Opened app.js in Visual Studio Code. js files will open there from now on.');
});

test('picking an app without Always opens it once', async () => {
  const p = await menuFor(info({ saved: CODE.path }), { 'POST /api/open': { ok: true, kind: 'js', app: 'Finder', remembered: true } });
  p.pick('Show in Finder');
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/open')[0].body, { space: 'alpha', path: 'app.js', app: 'finder', remember: false });
  assert.equal(p.toast(), 'Opened app.js in Finder.');
});

test('an app that fails to open the file shows why, or a plain message', async () => {
  const p = await menuFor(info(), { 'POST /api/open': { __reply: true, status: 400, body: { error: 'that app does not open this file' } } });
  p.pick('Xcode');
  await flush();
  assert.equal(p.toast(), 'that app does not open this file');
  p.api.routes['POST /api/open'] = new Error('offline');
  fire(p.$('.tree .node.file'), 'contextmenu', { clientX: 100, clientY: 100 });
  await flush();
  p.pick('Xcode');
  await flush();
  assert.equal(p.toast(), 'Could not open it.');
});

test('when the saved app could not open the file, the menu says so', async () => {
  const p = await menuFor(info({ saved: XCODE.path }), { 'POST /api/open': { needsChoice: true, error: 'macOS could not open it' } });
  p.menu().remove();
  p.$('.tree .node.file').click();
  await flush();
  assert.equal(p.menu().querySelector('.mnote').textContent, 'The saved app could not open it (macOS could not open it).');
});

test('a file the server cannot find, or no answer, shows a toast instead of a menu', async () => {
  const p = await menuFor({ __reply: true, status: 404, body: { error: 'no such file in this space' } });
  assert.equal(p.menu(), null);
  assert.equal(p.toast(), 'no such file in this space');
  p.api.routes['GET /api/open-with'] = new Error('offline');
  fire(p.$('.tree .node.file'), 'contextmenu', { clientX: 1, clientY: 1 });
  await flush();
  assert.equal(p.toast(), 'Could not reach Corral.');
});

test('opening the menu closes any other menu first', async () => {
  const p = await menuFor(info());
  fire(p.$('.tree .node.file'), 'contextmenu', { clientX: 100, clientY: 100 });
  await flush();
  assert.equal(p.$$('.catmenu').length, 1);
});
