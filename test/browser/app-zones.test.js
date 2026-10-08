const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, session, dt, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const sessions = (...ids) => ({ 'GET /api/sessions': { sessions: ids.map((id) => session(id)) } });
// Gives #grid a width (jsdom does no layout; height stays 0, so the aspect ratio equals the width) and relays out.
function setAspect(p, w) {
  Object.defineProperty(p.$('#grid'), 'clientWidth', { value: w, configurable: true });
  p.observers.find((o) => o.els.includes(p.$('#grid'))).fire();
}
const boxes = (p) => p.visible().map((l) => `${l}: ${p.box(l)}`);
function pickLayout(p, name) {
  p.$('#laybtn').click();
  p.$$('#laymenu button').find((b) => b.textContent === name).click();
}

test('Auto stacks two windows on a tall area and puts them side by side on a wide one', async () => {
  const p = await start({ routes: sessions('a', 'b') });
  assert.deepEqual(boxes(p), ['a: 0% 0% 100% 50%', 'b: 0% 50% 100% 50%']);
  setAspect(p, 2);
  assert.deepEqual(boxes(p), ['a: 0% 0% 50% 100%', 'b: 50% 0% 50% 100%']);
});

test('Auto puts one window across the whole area', async () => {
  const p = await start({ routes: sessions('a') });
  assert.deepEqual(boxes(p), ['a: 0% 0% 100% 100%']);
  assert.equal(p.$('#count').textContent, '1 window');
});

test('Auto puts three windows in a row on a very wide area, else two over one', async () => {
  const p = await start({ routes: sessions('a', 'b', 'c') });
  assert.deepEqual(boxes(p), ['a: 0% 0% 50% 50%', 'b: 50% 0% 50% 50%', 'c: 0% 50% 100% 50%']);
  setAspect(p, 2.5);
  assert.deepEqual(boxes(p).map((b) => b.split(' ').slice(1, 3).join(' ')), ['0% 0%', '33.33333333333333% 0%', '66.66666666666666% 0%']);
});

test('Auto puts four windows in a row only on an extra wide area', async () => {
  const p = await start({ routes: sessions('a', 'b', 'c', 'd') });
  assert.deepEqual(boxes(p).map((b) => b.split(' ').slice(3).join(' ')), ['50% 50%', '50% 50%', '50% 50%', '50% 50%']);
  setAspect(p, 3);
  assert.deepEqual(boxes(p).map((b) => b.split(' ').slice(3).join(' ')), ['25% 100%', '25% 100%', '25% 100%', '25% 100%']);
});

test('Auto fits more than nine windows into rows of a square-ish grid', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `w${i}`);
  const p = await start({ routes: sessions(...ids) });
  assert.equal(p.visible().length, 10);
  // Ten windows: rows of 4, 4, and 2.
  assert.equal(p.box('w0'), '0% 0% 25% 33.33333333333333%');
  assert.equal(p.box('w9'), '50% 66.66666666666666% 50% 33.33333333333333%');
});

test('the layout menu lists every layout, marks the current one, and saves a pick', async () => {
  const p = await start({ routes: sessions('a', 'b') });
  p.$('#laybtn').click();
  assert.equal(p.$('#laymenu').hidden, false);
  const names = p.$$('#laymenu button').map((b) => b.textContent);
  assert.deepEqual(names, ['Auto', 'Grid', 'Maximize', 'Halves', 'Stacked', 'Thirds', 'Quarters', 'Main + 2', '2 + Main', 'Main over 2', '2 over 1', '1 over 2', 'Main + 3', '3 x 2', '3 x 3']);
  assert.equal(p.$('#laymenu .on').textContent, 'Auto');
  assert.match(p.$$('#laymenu button')[0].title, /window count/);
  assert.match(p.$$('#laymenu button')[1].title, /Columns by rows/);
  assert.equal(p.$$('#laymenu button')[3].title, 'Halves');
  assert.equal(p.$$('#laymenu .thumb')[6].children.length, 4);
  p.$$('#laymenu button').find((b) => b.textContent === 'Main + 2').click();
  assert.equal(p.$('#laymenu').hidden, true);
  assert.equal(p.$('#laybtn').textContent, 'Layout: Main + 2 ▾');
  assert.equal(p.store('corral.layout'), 'mainright');
  assert.deepEqual(boxes(p), ['a: 0% 0% 66.66666666666666% 100%', 'b: 66.66666666666666% 0% 33.33333333333333% 50%']);
  assert.equal(p.$$('#grid .zone-empty').length, 1);
  p.$('#laybtn').click();
  assert.equal(p.$('#laymenu .on').textContent, 'Main + 2');
  p.$('#laybtn').click();
  assert.equal(p.$('#laymenu').hidden, true);
});

test('a click outside the layout menu or Esc closes it, and a click inside does not', async () => {
  const p = await start();
  p.$('#laybtn').click();
  p.$('#laymenu').click();
  assert.equal(p.$('#laymenu').hidden, false);
  p.$('#count').click();
  assert.equal(p.$('#laymenu').hidden, true);
  p.$('#laybtn').click();
  fire(p.doc.body, 'keydown', { key: 'a' });
  assert.equal(p.$('#laymenu').hidden, false);
  fire(p.doc.body, 'keydown', { key: 'Escape' });
  assert.equal(p.$('#laymenu').hidden, true);
});

test('Grid shows columns and rows pickers and fills rows as windows open', async () => {
  const p = await start({ routes: sessions('a', 'b', 'c') });
  assert.equal(p.$('#colslab').hidden, true);
  pickLayout(p, 'Grid');
  assert.equal(p.$('#laybtn').textContent, 'Layout: Grid ▾');
  assert.equal(p.$('#colslab').hidden, false);
  assert.equal(p.$('#rowslab').hidden, false);
  // Two columns, rows on Auto: three windows need two rows.
  assert.deepEqual(boxes(p), ['a: 0% 0% 50% 50%', 'b: 50% 0% 50% 50%', 'c: 0% 50% 50% 50%']);
  p.$('#cols').value = '3';
  p.$('#cols').onchange();
  assert.equal(p.store('corral.cols'), '3');
  assert.deepEqual(boxes(p).map((b) => b.split(' ').slice(3).join(' ')), ['33.33333333333333% 100%', '33.33333333333333% 100%', '33.33333333333333% 100%']);
  p.$('#rows').value = '2';
  p.$('#rows').onchange();
  assert.equal(p.store('corral.rows'), '2');
  assert.equal(p.$$('#grid .zone-empty').length, 3);
});

test('Grid with no windows still shows one row', async () => {
  const p = await start({ storage: { 'corral.layout': '"grid"' } });
  assert.equal(p.$$('#grid .zone-empty').length, 2);
  assert.equal(p.$$('#grid .zone-empty')[0].textContent, 'Pick a space on the left to open it here.');
  assert.equal(p.$$('#grid .zone-empty')[1].textContent, 'Empty zone');
});

test('a window that does not fit waits in the bottom bar and can be swapped in', async () => {
  const p = await start({ storage: { 'corral.layout': '"halves"' }, routes: sessions('a', 'b', 'c') });
  assert.deepEqual(p.visible(), ['a', 'b']);
  assert.deepEqual(p.chips(), ['c']);
  assert.equal(p.$('#tray .lbl').textContent, 'No free zone:');
  assert.equal(p.$('#tray .chip').title, 'Swap this window into the focused zone');
  // c was opened last, so it has the focus; minimizing it clears the focus.
  p.slotOf('c').querySelector('.min').click();
  assert.deepEqual(p.$$('#tray .lbl').map((l) => l.textContent), ['Minimized:']);
  assert.equal(p.$('#tray .chip').className, 'chip min');
  // Restoring with nothing focused swaps it into the first zone.
  p.$('#tray .chip').click();
  assert.deepEqual(p.visible(), ['c', 'b']);
  assert.deepEqual(p.chips(), ['a']);
  assert.ok(p.slotOf('c').querySelector('.win').classList.contains('focus'));
  // Focus b, then restore a: it takes b's zone.
  fire(p.slotOf('b').querySelector('.win'), 'mousedown');
  assert.ok(p.terms[1].focused);
  p.$('#tray .chip').click();
  assert.deepEqual(p.visible(), ['c', 'a']);
  assert.deepEqual(p.chips(), ['b']);
  assert.deepEqual(p.store('corral.slots'), { slots: ['c', 'a'], tray: ['b'] });
});

test('minimizing a window frees its zone, and restoring it in Auto brings it straight back', async () => {
  const p = await start({ routes: sessions('a', 'b') });
  p.slotOf('a').querySelector('.min').click();
  assert.deepEqual(p.visible(), ['b']);
  assert.deepEqual(p.chips(), ['a']);
  assert.equal(p.$('#count').textContent, '2 windows (1 minimized)');
  assert.deepEqual(p.store('corral.minimized'), ['a']);
  p.$('#tray .chip').click();
  assert.deepEqual(p.visible().sort(), ['a', 'b']);
  assert.equal(p.$('#tray').hidden, true);
  assert.deepEqual(p.store('corral.minimized'), []);
});

test('minimizing a window that is already waiting in the bottom bar keeps one chip for it', async () => {
  const p = await start({ storage: { 'corral.layout': '"full"' }, routes: sessions('a', 'b') });
  assert.deepEqual(p.chips(), ['b']);
  p.slotOf('b').querySelector('.min').click();
  assert.deepEqual(p.chips(), ['b']);
  assert.equal(p.$('#tray .chip').className, 'chip min');
});

test('dragging a title bar onto another window swaps the two', async () => {
  const p = await start({ storage: { 'corral.layout': '"halves"' }, routes: sessions('a', 'b') });
  const d = dt();
  const title = p.slotOf('b').querySelector('.title');
  assert.equal(title.draggable, true);
  fire(title, 'dragstart', { dataTransfer: d });
  assert.equal(d.data['text/x-corral'], 'b');
  assert.equal(d.effectAllowed, 'move');
  const target = p.slotOf('a');
  const over = fire(target, 'dragover', { dataTransfer: d });
  assert.ok(over.defaultPrevented);
  assert.ok(target.classList.contains('over'));
  fire(target, 'dragleave');
  assert.ok(!target.classList.contains('over'));
  fire(target, 'drop', { dataTransfer: d });
  assert.deepEqual(p.visible(), ['b', 'a']);
  assert.equal(p.box('b'), '0% 0% 50% 100%');
});

test('a drag that is not a window is ignored by the zones', async () => {
  const p = await start({ storage: { 'corral.layout': '"halves"' }, routes: sessions('a', 'b') });
  const target = p.slotOf('a');
  const files = dt({ Files: 'x' });
  // (The page itself catches a file drag, so the browser does not open the file; see app-drop.test.js.)
  fire(target, 'dragover', { dataTransfer: files });
  assert.ok(!target.classList.contains('over'));
  assert.ok(!fire(target, 'dragover').defaultPrevented);
  target.classList.add('over');
  fire(target, 'drop', { dataTransfer: files });
  assert.ok(!target.classList.contains('over'));
  assert.deepEqual(p.visible(), ['a', 'b']);
  // A window id that is no longer open changes nothing.
  fire(target, 'drop', { dataTransfer: dt({ 'text/x-corral': 'ghost' }) });
  assert.deepEqual(p.visible(), ['a', 'b']);
});

test('dragging a chip onto a window swaps them, and onto an empty zone fills it', async () => {
  const p = await start({ storage: { 'corral.layout': '"halves"' }, routes: sessions('a', 'b', 'c') });
  const d = dt();
  fire(p.$('#tray .chip'), 'dragstart', { dataTransfer: d });
  assert.equal(d.data['text/x-corral'], 'c');
  assert.equal(d.effectAllowed, 'move');
  fire(p.slotOf('b'), 'drop', { dataTransfer: d });
  assert.deepEqual(p.visible(), ['a', 'c']);
  assert.deepEqual(p.chips(), ['b']);
  // Minimize a: its zone stays empty, and dropping the waiting b there fills it.
  p.slotOf('a').querySelector('.min').click();
  assert.deepEqual(p.visible(), ['b', 'c']);
  p.slotOf('b').querySelector('.min').click();
  const empty = p.$('#grid .zone-empty');
  assert.equal(empty.textContent, 'Empty zone');
  fire(empty, 'dragover', { dataTransfer: dt({ 'text/x-corral': 'a' }) });
  assert.ok(empty.classList.contains('over'));
  fire(empty, 'drop', { dataTransfer: dt({ 'text/x-corral': 'a' }) });
  assert.deepEqual(p.visible(), ['a', 'c']);
  assert.deepEqual(p.chips(), ['b']);
});

test('the bottom bar can be dragged taller or shorter within its limits, and a double-click resets it', async () => {
  const p = await start({ storage: { 'corral.layout': '"full"' }, routes: sessions('a', 'b') });
  const grip = p.$('#traygrip');
  assert.equal(grip.parentNode, p.$('#tray'));
  fire(grip, 'pointerdown', { button: 2, clientY: 500 });
  assert.ok(!grip.classList.contains('drag'));
  const down = fire(grip, 'pointerdown', { button: 0, clientY: 500, pointerId: 7 });
  assert.ok(down.defaultPrevented);
  assert.equal(grip.captured, 7);
  assert.ok(grip.classList.contains('drag'));
  fire(grip, 'pointermove', { clientY: 480 });
  assert.equal(p.$('#tray').style.getPropertyValue('--th'), '64px');
  // The bar stays put while windows relayout during the drag.
  p.$('#cols').onchange();
  assert.equal(grip.parentNode, p.$('#tray'));
  fire(grip, 'pointerup', { clientY: 300 });
  assert.equal(p.$('#tray').style.getPropertyValue('--th'), '96px');
  assert.equal(p.store('corral.trayH'), 96);
  assert.ok(!grip.classList.contains('drag'));
  // Moves after the release do nothing.
  fire(grip, 'pointermove', { clientY: 900 });
  assert.equal(p.$('#tray').style.getPropertyValue('--th'), '96px');
  fire(grip, 'pointerdown', { button: 0, clientY: 500 });
  fire(grip, 'pointerup', { clientY: 900 });
  assert.equal(p.store('corral.trayH'), 30);
  fire(grip, 'dblclick');
  assert.equal(p.store('corral.trayH'), 44);
  assert.equal(p.$('#tray').style.getPropertyValue('--th'), '44px');
});

test('a saved bar height that is not a number falls back to the default', async () => {
  const p = await start({ storage: { 'corral.trayH': '"tall"' } });
  assert.equal(p.$('#tray').style.getPropertyValue('--th'), '44px');
});

test('after a layout, each visible window refits to its zone', async () => {
  const p = await start({ storage: { 'corral.layout': '"full"' }, routes: sessions('a', 'b') });
  const fits = () => p.terms.map((t) => t.addons[0].fits || 0);
  const before = fits();
  p.$('#cols').onchange();
  await p.frame();
  await flush(2);
  const after = fits();
  assert.ok(after[0] > before[0], 'the visible window refit');
  assert.equal(after[1], before[1], 'the waiting window did not');
});

test('switching to a layout with fewer zones sends the extra windows to the bottom bar', async () => {
  const p = await start({ storage: { 'corral.layout': '"halves"' }, routes: sessions('a', 'b') });
  assert.deepEqual(p.visible(), ['a', 'b']);
  pickLayout(p, 'Maximize');
  assert.deepEqual(p.visible(), ['a']);
  assert.deepEqual(p.chips(), ['b']);
  assert.equal(p.$('#tray .lbl').textContent, 'No free zone:');
});
