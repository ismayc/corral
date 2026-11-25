// public/pop.js: one window in a browser window of its own, with its project's files and a tab per file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { loadPage, unloadPage, fire } = require('../helpers/browser');
const { settle } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const win = (extra = {}) => ({ id: 'w1', label: 'alpha', cwd: '/Users/me/repos/alpha', space: 'sp1', exited: false, ...extra });
const TREE = {
  '': { entries: [{ name: 'docs', type: 'dir' }, { name: 'link', type: 'dir', link: true }, { name: 'README.md', type: 'file' }, { name: 'app.js', type: 'file' }], truncated: false },
  docs: { entries: [{ name: 'plot.png', type: 'file' }, { name: 'paper.pdf', type: 'file' }, { name: 'notes.md', type: 'file' }], truncated: true },
  link: { entries: [], truncated: false },
};
const MD = '# Title\n\nSee [the notes](docs/notes.md#part-two), [the code](app.js), and [a plot](docs/plot.png).\n';
let files; // set fresh for each page, so a test that changes a file leaves the next test alone
const serve = (req) => files[req.query.path] || { __reply: true, status: 404, body: { error: 'no such file in this project' } };

async function pop(opts = {}) {
  files = {
    'README.md': { name: 'README.md', text: MD, modified: 1 },
    'docs/notes.md': { name: 'notes.md', text: '# Notes\n\n## Part two\n', modified: 1 },
    'app.js': { name: 'app.js', text: 'const a = 1;\n', modified: 1 },
  };
  // A second page in one test: unload the first before the mock timers start, or unloading puts the real ones back.
  unloadPage();
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const p = loadPage('pop', {
    url: '/pop?id=w1',
    ...opts,
    routes: {
      'GET /api/sessions': { sessions: [win()] },
      'GET /api/files': (req) => TREE[req.query.path],
      'GET /api/view': serve,
      'GET /api/text': serve,
      ...opts.routes,
    },
    setup(w) {
      const Base = w.Terminal;
      w.Terminal = class extends Base {
        constructor(o) { super(o); this.osc = {}; this.parser = { registerOscHandler: (n, cb) => { this.osc[n] = cb; } }; }
        write(d, cb) { super.write(d); if (cb) this.writeCb = cb; }
      };
      w.Element.prototype.setPointerCapture = function setPointerCapture(id) { this.captured = id; };
      opts.setup?.(w);
    },
  });
  await settle();
  p.doc = p.window.document;
  p.$ = (s) => p.doc.querySelector(s);
  p.$$ = (s) => [...p.doc.querySelectorAll(s)];
  p.node = (path) => p.$(`#tree .node[data-path="${path}"]`) || p.$$('#tree .node').find((n) => n.textContent.startsWith(path));
  p.tabs = () => p.$$('#tabs .tab').map((t) => `${t.getAttribute('aria-selected') === 'true' ? '*' : ''}${t.querySelector('.tn').textContent}`);
  p.toast = () => (p.$('#toast').hidden ? null : p.$('#toast').textContent);
  p.term = p.terms[0];
  p.ws = () => p.sockets.at(-1);
  p.stored = (k) => JSON.parse(p.window.localStorage.getItem(k));
  p.tick = async (ms) => { mock.timers.tick(ms); await settle(); };
  return p;
}

test('the page shows the window: its name, folder, files, and terminal on its own connection', async () => {
  const p = await pop();
  assert.equal(p.$('#label').textContent, 'alpha');
  assert.equal(p.$('#cwd').textContent, '~/repos/alpha');
  assert.equal(p.doc.title, 'alpha');
  assert.deepEqual(p.api.called('GET', '/api/files')[0].query, { window: 'w1', path: '', hidden: '0' });
  assert.deepEqual(p.$$('#tree > .node').map((n) => n.textContent), ['▸docs', '▸link↪', 'README.md', 'app.js']);
  assert.equal(p.$('#tabpane').hidden, true);
  assert.equal(p.$('#split').hidden, true);
  assert.equal(p.ws().url, 'ws://127.0.0.1:18777/ws?id=w1');
  assert.equal(p.term.focused, true);
  p.ws().open();
  assert.equal(p.term.resets, 1);
  assert.deepEqual(JSON.parse(p.ws().sent[0]), { t: 'resize', cols: 80, rows: 24 });
});

test('folders open and close, hidden files and a reload read the folder again', async () => {
  const p = await pop();
  p.node('docs').click();
  await settle();
  assert.equal(p.node('docs').querySelector('.ic').textContent, '▾');
  assert.deepEqual(p.$$('#tree .node[data-path^="docs/"]').map((n) => n.dataset.path), ['docs/plot.png', 'docs/paper.pdf', 'docs/notes.md']);
  assert.match(p.$('#tree').textContent, /List cut off at 1000 entries\./);
  p.node('docs').click();
  assert.equal(p.node('docs').querySelector('.ic').textContent, '▸');
  assert.equal(p.$$('#tree .node[data-path^="docs/"]').length, 0);
  p.node('link').click();
  await settle();
  assert.match(p.$('#tree').textContent, /\(empty\)/);

  p.$('#hidden').checked = true;
  fire(p.$('#hidden'), 'change');
  await settle();
  assert.equal(p.api.called('GET', '/api/files').at(-1).query.hidden, '1');
  p.$('#reload').click();
  await settle();
  assert.equal(p.api.called('GET', '/api/files').length, 5);
});

test('a folder that cannot be read, or a Mac that does not answer, says so in the tree', async () => {
  let p = await pop({ routes: { 'GET /api/files': { __reply: true, status: 404, body: { error: 'unknown space' } } } });
  assert.equal(p.$('#tree').textContent, 'unknown space');
  p = await pop({ routes: { 'GET /api/files': new Error('offline') } });
  assert.equal(p.$('#tree').textContent, 'Could not load files.');
});

test('the file panel hides and shows, and the choice is kept for the space', async () => {
  let p = await pop();
  assert.equal(p.$('#files').hidden, false);
  assert.equal(p.$('#filesbtn').getAttribute('aria-pressed'), 'true');
  p.$('#filesbtn').click();
  assert.equal(p.$('#files').hidden, true);
  assert.equal(p.$('#filesbtn').getAttribute('aria-pressed'), 'false');
  assert.equal(p.$('#filesbtn').title, 'Show the file panel for this space');
  assert.equal(p.stored('corral.pop.files.sp1'), false);
  p.$('#filesbtn').click();
  assert.equal(p.$('#files').hidden, false);
  assert.equal(p.stored('corral.pop.files.sp1'), true);

  p = await pop({ storage: { 'corral.pop.files.sp1': false } });
  assert.equal(p.$('#files').hidden, true);
  // A window with no space keeps the choice for its folder.
  p = await pop({ routes: { 'GET /api/sessions': { sessions: [win({ space: null })] } } });
  p.$('#filesbtn').click();
  assert.equal(p.stored('corral.pop.files./Users/me/repos/alpha'), false);
});

test('a markdown file opens in a tab, drawn, beside the terminal, and its links open more tabs', async () => {
  const p = await pop();
  p.node('README.md').click();
  await settle();
  assert.deepEqual(p.tabs(), ['*README.md']);
  assert.equal(p.$('#tabpane').hidden, false);
  assert.equal(p.$('#split').hidden, false);
  assert.equal(p.doc.title, 'README.md · alpha');
  assert.equal(p.$('#tabpath').textContent, 'README.md');
  assert.equal(p.$('#mdmode').hidden, false);
  assert.equal(p.$('#pane .md h1').textContent, 'Title');
  assert.ok(p.node('README.md').classList.contains('on'));
  assert.deepEqual(p.api.called('GET', '/api/view')[0].query, { window: 'w1', path: 'README.md' });
  assert.deepEqual(p.stored('corral.pop.tabs.w1'), { open: ['README.md'], active: 'README.md' });

  const links = p.$$('#pane .md a');
  assert.equal(links[1].title, 'Open app.js in a tab');
  links[0].click(); // another markdown file, at a heading
  await settle();
  assert.deepEqual(p.tabs(), ['README.md', '*notes.md']);
  assert.equal(p.$('#pane h2').scrolledIntoView, true);
  p.$$('#tabs .tab')[0].click();
  await settle();
  p.$$('#pane .md a')[1].click(); // a code file
  await settle();
  assert.deepEqual(p.tabs(), ['README.md', 'notes.md', '*app.js']);
  assert.equal(p.$('#pane pre.raw').textContent, 'const a = 1;\n');
  assert.equal(p.$('#mdmode').hidden, true);
  assert.deepEqual(p.api.called('GET', '/api/text')[0].query, { window: 'w1', path: 'app.js' });
  // A file already open goes to its tab.
  p.node('README.md').click();
  await settle();
  assert.deepEqual(p.tabs(), ['*README.md', 'notes.md', 'app.js']);
});

test('images and PDFs open in tabs from Corral, and an image reads again on reload', async () => {
  const p = await pop();
  p.node('docs').click();
  await settle();
  p.node('docs/plot.png').click();
  assert.equal(p.$('#pane img').getAttribute('src'), '/api/image?window=w1&path=docs%2Fplot.png');
  assert.equal(p.$('#tabreload').hidden, false);
  p.$('#tabreload').click();
  assert.match(p.$('#pane img').getAttribute('src'), /&v=\d+$/);
  p.node('docs/paper.pdf').click();
  assert.equal(p.$('#pane iframe').getAttribute('src'), '/api/pdf?window=w1&path=docs%2Fpaper.pdf');
  assert.equal(p.$('#tabreload').hidden, true);
  assert.equal(p.api.called('GET', '/api/text').length, 0);
});

test('Raw and Rendered switch a markdown tab, and the choice is shared with the viewer', async () => {
  const p = await pop();
  p.node('README.md').click();
  await settle();
  p.$('#raw').click();
  assert.equal(p.$('#pane pre.raw').textContent, MD);
  assert.equal(p.$('#raw').getAttribute('aria-pressed'), 'true');
  assert.equal(p.stored('corral.view.mode'), 'raw');
  p.$('#rendered').click();
  assert.equal(p.$('#pane .md h1').textContent, 'Title');
  assert.equal(p.stored('corral.view.mode'), 'rendered');
  // A page that loads with Raw chosen starts in Raw.
  const q = await pop({ storage: { 'corral.view.mode': '"raw"', 'corral.pop.tabs.w1': { open: ['README.md'], active: 'README.md' } } });
  await settle();
  assert.equal(q.$('#pane pre.raw').textContent, MD);
});

test('closing tabs moves to a neighbor, and the last one hides the tab area', async () => {
  const p = await pop();
  for (const f of ['README.md', 'app.js']) { p.node(f).click(); await settle(); }
  p.$$('#tabs .tab')[0].click();
  await settle();
  // Closing a tab that is not shown leaves the shown one.
  p.$$('#tabs .tab .tx')[1].click();
  assert.deepEqual(p.tabs(), ['*README.md']);
  p.node('app.js').click();
  await settle();
  fire(p.$$('#tabs .tab')[0], 'auxclick', { button: 2 }); // not the middle button
  assert.deepEqual(p.tabs(), ['README.md', '*app.js']);
  fire(p.$$('#tabs .tab')[1], 'auxclick', { button: 1 });
  await settle();
  assert.deepEqual(p.tabs(), ['*README.md']);
  p.$$('#tabs .tab .tx')[0].click();
  assert.deepEqual(p.tabs(), []);
  assert.equal(p.$('#tabpane').hidden, true);
  assert.equal(p.$('#pane').childNodes.length, 0);
  assert.equal(p.doc.title, 'alpha');
  assert.deepEqual(p.stored('corral.pop.tabs.w1'), { open: [], active: null });
});

test('a file that cannot be shown says why and offers the Mac', async () => {
  const p = await pop({ routes: {
    'GET /api/text': { __reply: true, status: 415, body: { error: 'This is not a text file' } },
    'POST /api/open': (req) => (req.body.app ? { ok: true, app: 'Preview' } : { needsChoice: true }),
  } });
  p.node('app.js').click();
  await settle();
  assert.match(p.$('#pane .note').textContent, /^This is not a text file/);
  p.$('#pane .note button').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/open').map((c) => c.body), [{ window: 'w1', path: 'app.js' }, { window: 'w1', path: 'app.js', app: 'system' }]);
  assert.equal(p.toast(), 'Opened app.js in Preview.');
  await p.tick(4000);
  assert.equal(p.toast(), null);
  p.$('#tabmac').click();
  await settle();
  assert.equal(p.api.called('POST', '/api/open').length, 4);
});

test('right-click on a file offers a tab, the Mac, and Finder; Escape or a click elsewhere closes the menu', async () => {
  const p = await pop({ routes: { 'POST /api/open': (req) => (req.body.app === 'finder' ? { ok: true, app: 'Finder' } : { __reply: true, status: 502, body: { error: 'macOS could not open it' } }) } });
  const menu = () => p.$$('.menu button').map((b) => b.textContent);
  fire(p.node('app.js'), 'contextmenu', { clientX: 5000, clientY: 20 });
  assert.equal(p.$('.menu .mhead').textContent, 'app.js');
  assert.deepEqual(menu(), ['Open in a tab', 'Open on the Mac', 'Show in Finder']);
  p.$$('.menu button')[2].click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/open')[0].body, { window: 'w1', path: 'app.js', app: 'finder' });
  assert.equal(p.toast(), 'Opened app.js in Finder.');
  assert.equal(p.$('.menu'), null);

  fire(p.node('app.js'), 'contextmenu', { clientX: 10, clientY: 20 });
  p.$$('.menu button')[1].click();
  await settle();
  assert.equal(p.toast(), 'Could not open app.js: macOS could not open it');
  fire(p.node('app.js'), 'contextmenu', { clientX: 10, clientY: 20 });
  p.$$('.menu button')[0].click();
  await settle();
  assert.deepEqual(p.tabs(), ['*app.js']);

  fire(p.node('app.js'), 'contextmenu', { clientX: 10, clientY: 20 });
  fire(p.$('.menu'), 'mousedown');
  assert.notEqual(p.$('.menu'), null);
  fire(p.$('#tree'), 'mousedown');
  assert.equal(p.$('.menu'), null);
  fire(p.doc.body, 'mousedown'); // no menu: nothing to close
  fire(p.node('app.js'), 'contextmenu', { clientX: 10, clientY: 20 });
  fire(p.doc.body, 'keydown', { key: 'a' });
  assert.notEqual(p.$('.menu'), null);
  fire(p.doc.body, 'keydown', { key: 'Escape' });
  assert.equal(p.$('.menu'), null);
});

test('a markdown file saved to open in Corral opens in a tab from the Mac button, and a lost Mac says so', async () => {
  let p = await pop({ routes: { 'POST /api/open': { ok: true, view: true } } });
  fire(p.node('README.md'), 'contextmenu', { clientX: 10, clientY: 20 });
  p.$$('.menu button')[1].click();
  await settle();
  assert.deepEqual(p.tabs(), ['*README.md']);
  p = await pop({ routes: { 'POST /api/open': new Error('offline') } });
  fire(p.node('README.md'), 'contextmenu', { clientX: 10, clientY: 20 });
  p.$$('.menu button')[1].click();
  await settle();
  assert.equal(p.toast(), 'Could not open README.md: Could not reach Corral.');
});

test('the shown tab reads its file every 2 seconds while the page shows, and keeps the place', async () => {
  const p = await pop();
  let state = 'visible';
  Object.defineProperty(p.doc, 'visibilityState', { get: () => state, configurable: true });
  const calls = () => p.api.called('GET', '/api/view');
  await p.tick(2000); // no tab yet
  assert.equal(calls().length, 0);
  p.node('README.md').click();
  await settle();
  p.$('#pane').scrollTop = 120;

  p.api.routes['GET /api/view'] = { unchanged: true };
  await p.tick(2000);
  assert.equal(calls().at(-1).query.since, '1');
  files['README.md'] = { name: 'README.md', text: '# Second\n', modified: 2 };
  p.api.routes['GET /api/view'] = serve;
  await p.tick(2000);
  assert.equal(p.$('#pane .md h1').textContent, 'Second');
  assert.equal(p.$('#pane').scrollTop, 120);

  // A read that fails leaves the last version and says so; the next good read clears it.
  p.api.routes['GET /api/view'] = { __reply: true, status: 404, body: { error: 'gone' } };
  await p.tick(2000);
  assert.equal(p.$('#state').textContent, 'Could not read README.md again: gone');
  assert.equal(p.$('#pane .md h1').textContent, 'Second');
  p.api.routes['GET /api/view'] = new Error('offline');
  await p.tick(2000);
  assert.equal(p.$('#state').textContent, 'Could not read README.md again: Could not reach Corral.');
  p.api.routes['GET /api/view'] = { unchanged: true };
  await p.tick(2000);
  assert.equal(p.$('#state').textContent, '');

  state = 'hidden';
  const n = calls().length;
  await p.tick(2000);
  assert.equal(calls().length, n);
  // An image tab is not read again on its own.
  state = 'visible';
  p.node('docs').click();
  await settle();
  p.node('docs/plot.png').click();
  await p.tick(2000);
  assert.equal(calls().length, n);
});

test('reload reads a text tab from the start', async () => {
  const p = await pop();
  p.node('app.js').click();
  await settle();
  files['app.js'] = { name: 'app.js', text: 'const b = 2;\n', modified: 1 };
  p.$('#tabreload').click();
  assert.equal(p.$('#pane .note').textContent, 'Loading...');
  await settle();
  assert.equal(p.$('#pane pre.raw').textContent, 'const b = 2;\n');
  assert.equal(p.api.called('GET', '/api/text').at(-1).query.since, undefined);
});

test('the open tabs come back when the page loads again; the ones not shown are read too', async () => {
  let p = await pop({ storage: { 'corral.pop.tabs.w1': { open: ['README.md', 'app.js', 'docs/plot.png'], active: 'README.md' } } });
  assert.deepEqual(p.tabs(), ['*README.md', 'app.js', 'plot.png']);
  assert.deepEqual(p.api.called('GET', '/api/text').map((c) => c.query.path), ['app.js']);
  p.$$('#tabs .tab')[1].click();
  await settle();
  assert.equal(p.$('#pane pre.raw').textContent, 'const a = 1;\n');
  // With no tab named as shown, the last one is shown.
  p = await pop({ storage: { 'corral.pop.tabs.w1': { open: ['README.md', 'docs/notes.md'] } } });
  assert.deepEqual(p.tabs(), ['README.md', '*notes.md']);
  p = await pop({ storage: { 'corral.pop.tabs.w1': {} } });
  assert.deepEqual(p.tabs(), []);
});

test('a tab not shown that fails its first read shows why when it is picked', async () => {
  const p = await pop({ storage: { 'corral.pop.tabs.w1': { open: ['missing.txt', 'README.md'], active: 'README.md' } } });
  p.$$('#tabs .tab')[0].click();
  await settle();
  assert.match(p.$('#pane .note').textContent, /^no such file in this project/);
});

test('a link clicked in the terminal asks first, then opens in a new browser tab', async () => {
  const p = await pop();
  const opened = [];
  p.window.open = (...a) => opened.push(a);
  p.term.options.linkHandler.activate({ clientX: 10, clientY: 20 }, 'https://example.com/');
  await p.tick(0);
  assert.equal(p.$('.menu .mhead').textContent, 'Open this link? https://example.com/');
  p.$$('.menu button')[1].click(); // Cancel
  assert.deepEqual(opened, []);
  p.term.addons.find((a) => a.handler).handler({ clientX: 10, clientY: 20 }, 'https://example.com/');
  await p.tick(0);
  p.$$('.menu button')[0].click();
  assert.deepEqual(opened, [['https://example.com/', '_blank', 'noopener']]);
});

test('typing, resizing, and replayed output go to the window the way the Mac page sends them', async () => {
  const p = await pop();
  p.term.type('x'); // not connected yet
  p.ws().open();
  p.ws().message('saved output');
  p.term.type('y'); // muted while the replay draws
  p.term.writeCb();
  p.term.type('z');
  p.ws().message('live');
  assert.deepEqual(p.term.written, ['saved output', 'live']);
  p.term.resize(100, 30);
  p.observers[0].fire();
  assert.deepEqual(p.ws().sent.slice(1).map((s) => JSON.parse(s)), [{ t: 'in', d: 'z' }, { t: 'resize', cols: 100, rows: 30 }]);
  // Cmd-Backspace erases to the start of the line; other keys pass.
  const key = (o) => { const e = { preventDefault() { e.prevented = true; }, ...o }; return [p.term.keyHandler(e), Boolean(e.prevented)]; };
  assert.deepEqual(key({ key: 'Backspace', metaKey: true, type: 'keydown' }), [false, true]);
  assert.deepEqual(key({ key: 'Backspace', metaKey: true, type: 'keyup' }), [false, true]);
  assert.deepEqual(key({ key: 'Backspace', metaKey: false, type: 'keydown' }), [true, false]);
  assert.deepEqual(key({ key: 'a', metaKey: true, type: 'keydown' }), [true, false]);
  assert.deepEqual(key({ key: 'Backspace', metaKey: true, altKey: true, type: 'keydown' }), [true, false]);
  assert.deepEqual(key({ key: 'Backspace', metaKey: true, ctrlKey: true, type: 'keydown' }), [true, false]);
  assert.equal(JSON.parse(p.ws().sent.at(-1)).d, '\x15');
  p.ws().readyState = 3;
  p.term.resize(90, 30);
  assert.equal(JSON.parse(p.ws().sent.at(-1)).d, '\x15');
});

test('a tmux drag copy goes to the clipboard, but not a replay, a read request, or bad data', async () => {
  const p = await pop();
  const osc = p.term.osc[52];
  const b64 = (t) => `c;${Buffer.from(t).toString('base64')}`;
  p.ws().open();
  p.ws().message('replay');
  osc(b64('during replay'));
  p.term.writeCb();
  osc('c;');
  osc('c;?');
  osc('c;%%%'); // not base64
  await settle();
  assert.equal(p.clipboard.text, null);
  osc(b64('short'));
  await settle();
  assert.equal(p.toast(), 'Copied: short');
  osc(b64('two\nlines'));
  await settle();
  assert.equal(p.toast(), 'Copied 9 characters.');
  p.clipboard.fail = true;
  osc(b64('x'));
  await settle();
  assert.equal(p.toast(), 'Could not copy. Option-drag to select it, then press Cmd-C.');
});

test('a dropped connection reconnects while the window is open, and stops when it has closed', async () => {
  const p = await pop();
  p.ws().open();
  p.ws().drop();
  await settle();
  assert.equal(p.$('#state').textContent, 'Reconnecting...');
  await p.tick(1500);
  assert.equal(p.sockets.length, 2);
  p.ws().open();
  assert.equal(p.$('#state').textContent, '');
  p.api.routes['GET /api/sessions'] = new Error('offline'); // cannot tell: try again
  p.ws().drop();
  await settle();
  await p.tick(1500);
  assert.equal(p.sockets.length, 3);
  p.api.routes['GET /api/sessions'] = { sessions: [win({ exited: true })] };
  p.ws().drop();
  await settle();
  assert.equal(p.$('#state').textContent, 'This window has closed.');
  await p.tick(1500);
  assert.equal(p.sockets.length, 3);
});

test('a markdown tab can be edited and saved, and the tab marks unsaved edits', async () => {
  const p = await pop({ routes: { 'POST /api/save': { ok: true, modified: 3 } } });
  p.node('README.md').click();
  await settle();
  p.$('#edit').click();
  const area = () => p.$('#pane textarea.edit');
  assert.equal(area().value, MD);
  assert.equal(p.$('#edit').getAttribute('aria-pressed'), 'true');
  assert.equal(p.$('#tabreload').hidden, true);
  area().value = '# Edited\n';
  fire(area(), 'input');
  assert.deepEqual(p.tabs(), ['*README.md •']);
  // A newer version on disk does not replace the edits or redraw the tab.
  files['README.md'] = { name: 'README.md', text: '# Disk\n', modified: 2 };
  await p.tick(2000);
  assert.equal(area().value, '# Edited\n');
  assert.equal(p.$('#pane .etake').hidden, false);
  p.$('#pane .eforce').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/save')[0].body, { window: 'w1', path: 'README.md', text: '# Edited\n', base: 1, force: true });
  assert.deepEqual(p.tabs(), ['*README.md']);
  p.$('#rendered').click();
  assert.equal(p.$('#pane .md h1').textContent, 'Edited');
  assert.equal(p.$('#tabreload').hidden, false);
});

test('closing a tab with unsaved edits asks for a second click, and leaving Edit keeps the edits', async () => {
  const p = await pop();
  p.node('README.md').click();
  await settle();
  p.$('#edit').click();
  const area = () => p.$('#pane textarea.edit');
  area().value = '# Draft\n';
  fire(area(), 'input');
  p.$('#raw').click(); // the edits stay for the next visit
  assert.equal(p.$('#pane pre.raw').textContent, MD);
  const leave = () => { const e = new p.window.Event('beforeunload', { cancelable: true }); p.window.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(leave(), true);
  p.$$('#tabs .tab .tx')[0].click();
  assert.equal(p.toast(), 'README.md has unsaved edits. Click × again to close it without saving.');
  assert.deepEqual(p.tabs(), ['*README.md •']);
  // Typing again takes the warning back.
  p.$('#edit').click();
  assert.equal(area().value, '# Draft\n');
  fire(area(), 'input');
  p.$$('#tabs .tab .tx')[0].click();
  assert.deepEqual(p.tabs(), ['*README.md •']);
  p.$$('#tabs .tab .tx')[0].click();
  assert.deepEqual(p.tabs(), []);
  assert.equal(leave(), false);
});

test('Edit does nothing on a tab whose file has not been read', async () => {
  const p = await pop({ routes: { 'GET /api/view': { __reply: true, status: 404, body: { error: 'gone' } } } });
  p.node('README.md').click();
  await settle();
  p.$('#edit').click();
  assert.equal(p.$('#pane textarea.edit'), null);
});

test('a tab in Edit mode that is not shown follows its file when it has no edits', async () => {
  const p = await pop({ storage: { 'corral.pop.tabs.w1': { open: ['README.md', 'app.js'], active: 'README.md' } } });
  p.$('#edit').click();
  p.$$('#tabs .tab')[1].click();
  await settle();
  files['README.md'] = { name: 'README.md', text: '# Newer\n', modified: 4 };
  p.$$('#tabs .tab')[0].click(); // activate reads it again
  await settle();
  assert.equal(p.$('#pane textarea.edit').value, '# Newer\n');
});

test('the theme button sets light or dark, and the terminal changes colors with it', async () => {
  const p = await pop();
  assert.equal(p.term.options.theme.background, '#100e15');
  p.$('#theme').click();
  assert.equal(p.doc.documentElement.dataset.theme, 'light');
  assert.equal(p.term.options.theme.background, '#fdfcff');
});

// The title bar's status, usage, Queue, and last prompt, read from /api/overview as on the Mac page.
const U = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 2.21, model: 'm', context: { used: 180, size: 1000, pct: 18 } };
async function barPop(first, opts = {}) {
  let now = first;
  const p = await pop({ ...opts, routes: { 'GET /api/overview': () => ({ sessions: [{ ...win(), ...now }] }), ...opts.routes } });
  p.set = async (s) => { now = s; await p.tick(3000); };
  return p;
}

test('the bar shows the status dot, usage, Queue, and last prompt, and follows the window', async () => {
  const p = await barPop({ claude: { status: 'busy', lastPrompt: 'fix it', usage: U }, queued: 2 });
  assert.equal(p.$('#dot').className, 'dot working');
  assert.equal(p.$('#dot').title, 'Claude is working.');
  assert.equal(p.$('#use').hidden, false);
  assert.equal(p.$('#use').textContent, '18% · $2.21');
  assert.match(p.$('#use').title, /Click to hide the dollar amount\.$/);
  assert.equal(p.$('#queue').hidden, false);
  assert.equal(p.$('#queue').textContent, 'Queue 2');
  assert.equal(p.$('#queue').classList.contains('has'), true);
  assert.equal(p.$('#lastprompt').hidden, false);
  assert.equal(p.$('#lastprompt .pt').textContent, 'fix it');
  const states = [
    [{ claude: { status: 'waiting', waitingFor: 'permission prompt' } }, 'idle', 'Claude is asking for permission.'],
    [{ claude: { status: 'waiting' } }, 'idle', 'Claude is waiting on a prompt.'],
    [{ claude: { status: 'idle', lastPrompt: '/wrap-up' } }, 'wrapped', 'Wrapped up: /wrap-up finished.'],
    [{ claude: { status: 'idle' } }, 'idle', 'Your turn: Claude finished.'],
    [{ exited: true }, 'blocked', 'The shell ended.'],
    [{}, '', ''],
  ];
  for (const [s, cls, says] of states) {
    await p.set(s);
    assert.equal(p.$('#dot').className, `dot ${cls}`);
    assert.equal(p.$('#dot').title, says);
  }
  // A plain shell: no usage, Queue, or prompt line.
  assert.equal(p.$('#use').hidden, true);
  assert.equal(p.$('#queue').hidden, true);
  assert.equal(p.$('#lastprompt').hidden, true);
  await p.set({ queued: 1 }); // prompts still waiting show Queue on any window
  assert.equal(p.$('#queue').hidden, false);
  // A rename on another device reaches the bar and the browser tab's title.
  await p.set({ label: 'beta' });
  assert.equal(p.$('#label').textContent, 'beta');
  assert.equal(p.doc.title, 'beta');
  // A failed read keeps the last state.
  p.api.routes['GET /api/overview'] = new Error('offline');
  await p.tick(3000);
  assert.equal(p.$('#label').textContent, 'beta');
});

test('the bar stays plain until the overview lists the window', async () => {
  const p = await pop();
  await p.tick(3000);
  assert.equal(p.$('#dot').className, 'dot');
  assert.equal(p.$('#queue').hidden, true);
  p.window.dispatchEvent(new p.window.StorageEvent('storage', { key: 'corral.cost' }));
  assert.equal(p.$('#use').hidden, true);
});

test('a click on the usage tag hides or shows dollar amounts, and other pages\' changes reach the bar', async () => {
  const p = await barPop({ claude: { status: 'idle', lastPrompt: 'hi', usage: U } });
  p.$('#use').click();
  assert.equal(p.stored('corral.cost'), false);
  assert.equal(p.$('#use').textContent, '18%');
  assert.equal(p.toast(), 'Dollar amounts are hidden. Click the usage tag to show them again.');
  p.$('#use').click();
  assert.equal(p.$('#use').textContent, '18% · $2.21');
  assert.equal(p.toast(), 'Dollar amounts are shown.');
  const ev = (key) => p.window.dispatchEvent(new p.window.StorageEvent('storage', { key }));
  p.window.localStorage.setItem('corral.cost', 'false');
  p.window.localStorage.setItem('corral.prompts', 'false');
  ev('other');
  assert.equal(p.$('#use').textContent, '18% · $2.21');
  ev('corral.cost');
  assert.equal(p.$('#use').textContent, '18%');
  ev('corral.prompts');
  assert.equal(p.$('#lastprompt').hidden, true);
});

test('the × on the last prompt hides it in every window, and a click lists the conversation\'s prompts', async () => {
  const PROMPTS = { prompts: [{ text: 'one', at: '2026-01-02T10:00:00Z' }, { text: 'two', at: new Date().toISOString() }, { text: 'three', at: 'nope' }] };
  const p = await barPop({ claude: { status: 'idle', lastPrompt: 'three' } }, { routes: { 'GET /api/sessions/w1/prompts': PROMPTS } });
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.$('.menu .mhead').textContent, '3 prompts in alpha');
  assert.deepEqual(p.$$('.menu .ptext').map((e) => e.textContent), ['one', 'two', 'three']);
  const when = p.$$('.menu .pwhen').map((e) => e.textContent);
  assert.match(when[0], /^Jan 2, /);
  assert.doesNotMatch(when[1], /,/);
  assert.equal(when[2], '');
  p.api.routes['GET /api/sessions/w1/prompts'] = { prompts: [{ text: 'one', at: null }], cut: true };
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.$('.menu .mhead').textContent, '1 prompt in alpha (the most recent)');
  p.api.routes['GET /api/sessions/w1/prompts'] = { error: 'no transcript yet' };
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.toast(), 'Could not list the prompts: no transcript yet.');
  p.api.routes['GET /api/sessions/w1/prompts'] = new Error('offline');
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.toast(), 'Could not list the prompts.');
  p.$('#lastprompt button').click();
  await settle();
  assert.equal(p.stored('corral.prompts'), false);
  assert.equal(p.$('#lastprompt').hidden, true);
  assert.equal(p.toast(), 'Last prompts are hidden. Prompts in the Mac page toolbar shows them again.');
  assert.equal(p.api.called('GET', '/api/sessions/w1/prompts').length, 4); // the × does not open the list
});

test('the Queue menu lists, adds, removes, and clears prompts, and says when it cannot', async () => {
  let items = [{ id: 'q1', text: 'first' }];
  const p = await barPop({ claude: { status: 'busy' }, queued: 1 }, { routes: {
    'GET /api/sessions/w1/queue': () => ({ items }),
    'POST /api/sessions/w1/queue': (r) => {
      if (r.body.text === 'bad') return { error: 'too long' };
      if (r.body.text) items = [...items, { id: `q${items.length + 1}`, text: r.body.text }];
      if (r.body.remove) items = items.filter((i) => i.id !== r.body.remove);
      if (r.body.clear) items = [];
      return { items };
    },
  } });
  p.$('#queue').click();
  await settle();
  assert.equal(p.$('.menu .mhead').textContent, 'Waiting to go to alpha, in order');
  assert.deepEqual(p.$$('.menu .qtext').map((e) => e.textContent), ['first']);
  const input = () => p.$('.menu input');
  assert.equal(p.doc.activeElement, input());
  const key = (k) => input().dispatchEvent(new p.window.KeyboardEvent('keydown', { key: k }));
  input().value = '   ';
  key('Enter'); // blank: nothing sent
  input().value = 'second';
  key('a'); // not Enter: nothing sent
  assert.equal(p.api.called('POST', '/api/sessions/w1/queue').length, 0);
  key('Enter');
  await settle();
  assert.deepEqual(p.$$('.menu .qtext').map((e) => e.textContent), ['first', 'second']);
  assert.equal(p.$('#queue').textContent, 'Queue 2');
  input().value = 'bad';
  key('Enter');
  await settle();
  assert.equal(p.toast(), 'Could not queue it: too long.');
  p.$('.menu .qrow button').click();
  await settle();
  assert.deepEqual(p.$$('.menu .qtext').map((e) => e.textContent), ['second']);
  p.$$('.menu > button').find((b) => b.textContent === 'Clear the queue').click();
  await settle();
  assert.equal(p.$('.menu .mhead').textContent, 'Nothing is waiting for alpha');
  assert.equal(p.$$('.menu > button').length, 0);
  assert.equal(p.$('#queue').textContent, 'Queue');
  p.api.routes['POST /api/sessions/w1/queue'] = new Error('offline');
  input().value = 'x';
  key('Enter');
  await settle();
  assert.equal(p.toast(), 'Could not queue it.');
  p.api.routes['GET /api/sessions/w1/queue'] = new Error('offline');
  p.$('#queue').click();
  await settle();
  assert.equal(p.toast(), 'Could not read the queue.');
});

test('Send back tells the Mac page and closes the pop-out', async () => {
  const p = await pop();
  let closed = 0;
  p.window.close = () => { closed++; };
  globalThis.close = p.window.close;
  p.$('#sendback').click();
  assert.deepEqual(p.channels.find((c) => c.name === 'corral-pop').posted, [{ sendBack: 'w1' }]);
  assert.equal(closed, 1);
  assert.equal(p.$('#state').textContent, 'Sent back to Corral. Close this window.');
});

test('× ends the window, tells the Mac page, and closes the pop-out; a failure says so', async () => {
  const p = await pop({ routes: { 'DELETE /api/sessions/w1': { ok: true } } });
  let closed = 0;
  p.window.close = () => { closed++; };
  globalThis.close = p.window.close;
  const posted = () => p.channels.find((c) => c.name === 'corral-pop').posted;
  p.$('#close').click();
  assert.equal(p.$('#close').disabled, true);
  await settle();
  assert.equal(p.api.called('DELETE', '/api/sessions/w1').length, 1);
  assert.deepEqual(posted(), [{ closed: 'w1' }]);
  assert.equal(closed, 1);
  assert.equal(p.$('#state').textContent, 'Closed. Close this browser window.');
  // Already gone on the Mac: closed all the same. (The button stays off after a close; turned on here to try again.)
  p.api.routes['DELETE /api/sessions/w1'] = p.api.reply(404, { error: 'no such session' });
  p.$('#close').disabled = false;
  p.$('#close').click();
  await settle();
  assert.equal(closed, 2);
  // Another error, or no answer: the window stays, and the button works again.
  p.api.routes['DELETE /api/sessions/w1'] = p.api.reply(403, { error: 'bad origin' });
  p.$('#close').disabled = false;
  p.$('#close').click();
  await settle();
  assert.equal(p.toast(), 'Could not close the window: bad origin.');
  assert.equal(p.$('#close').disabled, false);
  p.api.routes['DELETE /api/sessions/w1'] = new Error('offline');
  p.$('#close').click();
  await settle();
  assert.equal(p.toast(), 'Could not close the window.');
  assert.equal(closed, 2);
  assert.equal(posted().length, 2);
});

test('a window that is not open, or a Mac that does not answer, says so instead', async () => {
  let p = await pop({ routes: { 'GET /api/sessions': { sessions: [win({ id: 'other' })] } } });
  assert.equal(p.$('#sendback').hidden, true);
  assert.equal(p.$('#close').hidden, true);
  assert.equal(p.$('#term .note').textContent, 'This window is not open any more. Open it again from Corral.');
  assert.equal(p.$('#files').hidden, true);
  assert.equal(p.$('#filesbtn').hidden, true);
  assert.equal(p.sockets.length, 0);
  p = await pop({ url: '/pop', routes: { 'GET /api/sessions': new Error('offline') } });
  assert.equal(p.$('#term .note').textContent, 'Could not reach Corral.');
});

test('the split between the terminal and the tabs drags, resets on double-click, and is kept', async () => {
  let p = await pop();
  const tw = () => p.doc.documentElement.style.getPropertyValue('--tw');
  assert.equal(tw(), '50.0%');
  p.node('README.md').click();
  await settle();
  const split = p.$('#split');
  p.$('#main').getBoundingClientRect = () => ({ right: 1260, width: 1260 });
  Object.defineProperty(p.$('#files'), 'offsetWidth', { value: 260 });
  fire(split, 'pointerdown', { button: 2 });
  assert.equal(split.classList.contains('drag'), false);
  fire(split, 'pointerdown', { button: 0, pointerId: 3 });
  assert.equal(split.captured, 3);
  fire(split, 'pointermove', { clientX: 960 }); // 300 of 1000
  assert.equal(tw(), '30.0%');
  fire(split, 'pointerup', { clientX: 1200 }); // 60 of 1000: held at the smallest
  assert.equal(tw(), '20.0%');
  assert.equal(p.stored('corral.pop.split'), 0.2);
  assert.equal(split.classList.contains('drag'), false);
  p.$('#filesbtn').click(); // the panel hidden: the whole width counts
  fire(split, 'pointerdown', { button: 0, pointerId: 3 });
  fire(split, 'pointerup', { clientX: 0 });
  assert.equal(tw(), '80.0%');
  fire(split, 'dblclick');
  assert.equal(tw(), '50.0%');
  assert.equal(p.stored('corral.pop.split'), 0.5);

  p = await pop({ storage: { 'corral.pop.split': '"wide"' } }); // the harness stores a string as it is
  assert.equal(p.doc.documentElement.style.getPropertyValue('--tw'), '50.0%');
});

test('the page works when the browser refuses storage', async () => {
  const p = await pop({ setup(w) {
    const refuse = () => { throw new Error('denied'); };
    Object.defineProperty(w, 'localStorage', { value: { getItem: refuse, setItem: refuse }, configurable: true });
  } });
  assert.equal(p.$('#files').hidden, false);
  p.$('#filesbtn').click();
  assert.equal(p.$('#files').hidden, true);
});

// ---- Files dropped on the terminal, as on the Mac page (test/browser/app-drop.test.js).
const { dt } = require('../helpers/app');
const dropped = (list) => Object.assign(dt({ Files: '' }), { files: list });
const pngFile = (p, name, type = 'image/png') => new p.window.File(['png bytes'], name, { type });
const until = async (p, fn) => { for (let i = 0; i < 50 && !fn(); i++) await p.tick(10); };

test('a file dragged over the terminal marks it; one found on the Mac has its path pasted, escaped', async () => {
  const where = { 'notes.txt': '/Users/me/Downloads/my notes (1).txt', docs: '/Users/me/repos/alpha/docs' };
  const p = await pop({ routes: { 'GET /api/locate': (req) => (where[req.query.name] ? { path: where[req.query.name] } : { __reply: true, status: 404, body: { error: 'not found on this Mac' } }) } });
  const pane = p.$('#termpane');
  assert.ok(fire(pane, 'dragover', { dataTransfer: dropped([]) }).defaultPrevented);
  assert.ok(pane.classList.contains('filedrop'));
  fire(pane, 'dragleave');
  assert.ok(!pane.classList.contains('filedrop'));
  assert.ok(!fire(pane, 'dragover', { dataTransfer: dt({ 'text/plain': 'x' }) }).defaultPrevented);
  const f = pngFile(p, 'notes.txt', 'text/plain');
  p.term.focused = false;
  const ev = fire(pane, 'drop', { dataTransfer: dropped([f, pngFile(p, 'docs', '')]) });
  assert.ok(ev.defaultPrevented);
  await until(p, () => p.term.pasted.length === 2);
  assert.deepEqual(p.term.pasted, ['/Users/me/Downloads/my\\ notes\\ \\(1\\).txt ', '/Users/me/repos/alpha/docs ']);
  assert.deepEqual(p.api.called('GET', '/api/locate')[0].query, { name: 'notes.txt', size: String(f.size), modified: String(f.lastModified) });
  assert.equal(p.term.focused, true);
  assert.equal(p.toast(), null);
  // A drop that holds no files (text dragged from the page) is left alone.
  pane.classList.add('filedrop');
  assert.ok(!fire(pane, 'drop', { dataTransfer: dt({ 'text/plain': 'x' }) }).defaultPrevented);
  assert.ok(!pane.classList.contains('filedrop'));
});

test('an image the Mac cannot find is uploaded and its copy pasted; other misses and failures say so', async () => {
  let answer;
  const p = await pop({ routes: { 'POST /api/sessions/w1/upload': () => answer } });
  const pane = p.$('#termpane');
  answer = { path: '/data/uploads/1.png' };
  fire(pane, 'drop', { dataTransfer: dropped([pngFile(p, 'notes.txt', 'text/plain'), pngFile(p, 'Screenshot.png')]) });
  await until(p, () => p.term.pasted.length);
  assert.equal(p.toast(), 'Could not find notes.txt on this Mac. Paste its path instead.');
  assert.deepEqual(p.term.pasted, ['/data/uploads/1.png ']);
  assert.deepEqual(p.api.called('POST', '/api/sessions/w1/upload')[0].body, { type: 'image/png', data: Buffer.from('png bytes').toString('base64') });
  answer = { __reply: true, status: 413, body: { error: 'the photo is empty or too large' } };
  fire(pane, 'drop', { dataTransfer: dropped([pngFile(p, 'big.png')]) });
  await until(p, () => p.toast() === 'the photo is empty or too large');
  assert.equal(p.toast(), 'the photo is empty or too large');
  answer = { __reply: true, status: 500, body: {} };
  fire(pane, 'drop', { dataTransfer: dropped([pngFile(p, 'odd.png')]) });
  await until(p, () => p.toast() === 'Could not add odd.png.');
  assert.equal(p.toast(), 'Could not add odd.png.');
  answer = new Error('offline');
  p.api.routes['GET /api/locate'] = new Error('offline');
  fire(pane, 'drop', { dataTransfer: dropped([pngFile(p, 'far.png')]) });
  await until(p, () => p.toast() === 'Could not add far.png.');
  assert.equal(p.toast(), 'Could not add far.png.');
  assert.deepEqual(p.term.pasted, ['/data/uploads/1.png ']);
});

test('a file dropped outside the terminal is caught, so the browser does not open it in place of the pop-out', async () => {
  const p = await pop();
  const tree = p.$('#tree');
  assert.ok(fire(tree, 'dragover', { dataTransfer: dropped([]) }).defaultPrevented);
  assert.ok(fire(tree, 'drop', { dataTransfer: dropped([pngFile(p, 'x.png')]) }).defaultPrevented);
  assert.ok(!fire(tree, 'dragover').defaultPrevented);
  assert.ok(!fire(tree, 'drop').defaultPrevented);
  await p.tick(10);
  assert.equal(p.api.called('GET', '/api/locate').length, 0);
});
