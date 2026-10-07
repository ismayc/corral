const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, start, stop, session, flush } = require('../helpers/app');

test.afterEach(stop);

test('a phone-sized touch screen is sent to the phone page', async () => {
  const p = boot({ media: { '(pointer: coarse) and (max-width: 760px)': true } });
  await flush(5);
  assert.ok(p.jsdomErrors.some((m) => /navigation/.test(m)), 'the page tried to navigate to /m');
});

test('a phone that asks for ?desktop stays on the desktop page', async () => {
  const p = boot({ url: '/?desktop', media: { '(pointer: coarse) and (max-width: 760px)': true } });
  await flush(5);
  assert.deepEqual(p.jsdomErrors, []);
});

test('with nothing running the grid shows one empty zone with a hint', async () => {
  const p = await start();
  assert.equal(p.$$('#grid .zone-empty').length, 1);
  assert.equal(p.$('#grid .zone-empty').textContent, 'Pick a space on the left to open it here.');
  assert.equal(p.$('#count').textContent, '0 windows');
  assert.equal(p.$('#laybtn').textContent, 'Layout: Auto ▾');
  assert.equal(p.$('#tray').hidden, true);
  assert.equal(p.$('#tray').style.getPropertyValue('--th'), '44px');
});

test('every live window gets a window, remembered ones first, and exited ones are skipped', async () => {
  const p = await start({
    storage: { 'corral.open': ['b', 'gone', 'x'] },
    routes: { 'GET /api/sessions': { sessions: [session('a'), session('b'), session('x', { exited: true }), session('y', { exited: true })] } },
  });
  assert.deepEqual(p.wins(), ['b', 'a']);
  assert.equal(p.$('#count').textContent, '2 windows');
  assert.deepEqual(p.store('corral.open'), ['b', 'a']);
});

test('the saved arrangement puts each window back in its zone and the bottom bar', async () => {
  const p = await start({
    storage: {
      'corral.layout': '"thirds"',
      'corral.slots': { slots: ['c', 'gone', 'a'], tray: ['b', 'gone'] },
      'corral.minimized': ['b', 'gone'],
    },
    routes: { 'GET /api/sessions': { sessions: [session('a'), session('b'), session('c')] } },
  });
  assert.equal(p.box('c'), '0% 0% 33.33333333333333% 100%');
  assert.equal(p.box('a'), '66.66666666666666% 0% 33.33333333333333% 100%');
  assert.equal(p.slotOf('b').hidden, true);
  assert.deepEqual(p.chips(), ['b']);
  assert.equal(p.$('#tray .lbl').textContent, 'Minimized:');
  assert.equal(p.$('#count').textContent, '3 windows (1 minimized)');
  assert.deepEqual(p.store('corral.minimized'), ['b']);
  assert.equal(p.$('#grid .zone-empty').textContent, 'Empty zone');
});

test('a saved arrangement with no lists is treated as empty', async () => {
  const p = await start({
    storage: { 'corral.slots': {} },
    routes: { 'GET /api/sessions': { sessions: [session('a')] } },
  });
  assert.deepEqual(p.visible(), ['a']);
  assert.deepEqual(p.store('corral.slots'), { slots: ['a'], tray: [] });
});

test('a window started on another device while the page was closed waits in the bottom bar', async () => {
  const p = await start({
    storage: { 'corral.open': ['a'] },
    routes: { 'GET /api/sessions': { sessions: [session('a', { remote: true }), session('r', { remote: true }), session('l')] } },
  });
  assert.deepEqual(p.visible(), ['a', 'l']);
  assert.deepEqual(p.chips(), ['r']);
  assert.equal(p.$('#tray').hidden, false);
});

test('settings saved under the old webterm names still apply', async () => {
  const p = await start({ storage: { 'webterm.layout': '"halves"', 'webterm.agent': '"claude-continue"' } });
  assert.equal(p.$('#laybtn').textContent, 'Layout: Halves ▾');
  assert.equal(p.$('#agent').value, 'claude-continue');
});

test('an unknown, null, or unreadable saved setting falls back to the default', async () => {
  const p = await start({ storage: { 'corral.layout': '"spiral"', 'corral.agent': 'null', 'corral.cols': '{bad json' } });
  assert.equal(p.$('#laybtn').textContent, 'Layout: Auto ▾');
  assert.equal(p.$('#agent').value, 'claude');
  assert.equal(p.$('#cols').value, '2');
});

test('a browser that refuses to save settings still works', async () => {
  const p = await start({
    setup(w) { w.Storage.prototype.setItem = () => { throw new Error('quota'); }; },
  });
  p.$('#agent').value = 'claude-continue';
  p.$('#agent').onchange();
  assert.equal(p.window.localStorage.getItem('corral.agent'), null);
  assert.equal(p.$('#agent').value, 'claude-continue');
});
