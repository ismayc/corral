// public/theme.js: light or dark for the Mac pages, loaded here through the markdown viewer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, unloadPage } = require('../helpers/browser');
const { settle } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

// light: whether macOS is light. The page's matchMedia hands back one query whose change listener a test can call.
async function view(opts = {}) {
  const media = { matches: Boolean(opts.light), listeners: [], addEventListener(type, cb) { media.listeners.push(cb); } };
  const p = loadPage('view', {
    url: '/view?space=a&path=x.md',
    storage: opts.storage,
    routes: { 'GET /api/view': { name: 'x.md', text: '# X\n', modified: 1 } },
    setup(w) {
      w.matchMedia = (q) => (q === '(prefers-color-scheme: light)' ? media : { matches: false, addEventListener() {} });
      opts.setup?.(w);
    },
  });
  await settle();
  p.media = media;
  p.doc = p.window.document;
  p.theme = () => p.doc.documentElement.dataset.theme;
  p.btn = p.doc.querySelector('#theme');
  return p;
}

test('Auto follows macOS, and changes when macOS does', async () => {
  let p = await view();
  assert.deepEqual([globalThis.corralTheme.mode, p.theme(), p.btn.textContent], ['auto', 'dark', 'Theme: Auto']);
  assert.equal(p.btn.title, 'Follows macOS (now dark). Click for Light.');
  p = await view({ light: true });
  assert.equal(p.theme(), 'light');
  let changes = 0;
  globalThis.corralTheme.onChange(() => changes++);
  p.media.matches = false;
  p.media.listeners[0]();
  assert.deepEqual([p.theme(), changes], ['dark', 1]);
  // A fixed choice ignores macOS.
  globalThis.corralTheme.set('light');
  p.media.matches = false;
  p.media.listeners[0]();
  assert.deepEqual([p.theme(), changes], ['light', 2]);
});

test('the button goes Auto, Light, Dark, and Auto again, and the choice is kept', async () => {
  let p = await view();
  p.btn.click();
  assert.deepEqual([p.theme(), p.btn.textContent, p.btn.title], ['light', 'Theme: Light', 'Click for Dark.']);
  assert.equal(p.window.localStorage.getItem('corral.theme'), 'light');
  p.btn.click();
  assert.deepEqual([p.theme(), p.btn.textContent, p.btn.title], ['dark', 'Theme: Dark', 'Click for Auto.']);
  p.btn.click();
  assert.deepEqual([p.theme(), p.btn.textContent], ['dark', 'Theme: Auto']);
  p = await view({ storage: { 'corral.theme': 'light' } });
  assert.equal(p.theme(), 'light');
  p = await view({ storage: { 'corral.theme': 'purple' } });
  assert.equal(globalThis.corralTheme.mode, 'auto');
});

test('a choice made on another Corral page reaches this one', async () => {
  const p = await view();
  const Ev = p.window.StorageEvent;
  p.window.localStorage.setItem('corral.theme', 'light');
  p.window.dispatchEvent(new Ev('storage', { key: 'other' }));
  assert.equal(p.theme(), 'dark');
  p.window.dispatchEvent(new Ev('storage', { key: 'corral.theme' }));
  assert.deepEqual([p.theme(), p.btn.textContent], ['light', 'Theme: Light']);
});

test('terminal colors follow the theme', async () => {
  await view({ storage: { 'corral.theme': 'dark' } });
  assert.equal(globalThis.corralTheme.term().background, '#100e15');
  globalThis.corralTheme.set('light');
  assert.equal(globalThis.corralTheme.resolved, 'light');
  assert.deepEqual([globalThis.corralTheme.term().background, globalThis.corralTheme.term().yellow], ['#fdfcff', '#94650a']);
});

test('a browser that refuses storage gets Auto, and the button still works', async () => {
  const p = await view({ setup(w) {
    const refuse = () => { throw new Error('denied'); };
    Object.defineProperty(w, 'localStorage', { value: { getItem: refuse, setItem: refuse }, configurable: true });
  } });
  assert.equal(globalThis.corralTheme.mode, 'auto');
  p.btn.click();
  assert.equal(p.theme(), 'light');
});
