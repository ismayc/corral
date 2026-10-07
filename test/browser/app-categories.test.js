const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, dt, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const R = (id) => `/Users/me/repos/${id}`;
const herdr = (...ids) => ({ 'GET /api/herdr': { available: true, spaces: ids.map((s) => (typeof s === 'string' ? space(s) : s)) } });
const cats = (categories, assign = {}, uncatCollapsed = false) => ({ 'GET /api/categories': { version: 1, categories, uncatCollapsed, assign } });
const WP = [{ name: 'Work', collapsed: false }, { name: 'Play', collapsed: true }];
async function page(extra = {}) {
  return start({ routes: { ...herdr('a', 'b', 'c', 'd'), ...cats(WP, { [R('a')]: 'Work', [R('b')]: 'Play', '/elsewhere': 'Work' }), 'POST /api/categories': (req) => req.body, ...extra } });
}
const header = (p, name) => p.$$('#spaces .sec.cat').find((h) => h.querySelector('.cn').textContent === name);
const btn = (h, text) => [...h.querySelectorAll('.acts button')].find((b) => b.textContent === text);
const saved = async (p) => { p.tick(250); await flush(); return p.api.called('POST', '/api/categories').at(-1)?.body; };
const typeFilter = (p, text) => { p.$('#filter').value = text; fire(p.$('#filter'), 'input'); };

test('spaces are grouped under their categories, with collapsed groups closed', async () => {
  const p = await page();
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▾ Uncategorized 2']);
  assert.deepEqual(p.rowNames(), ['a', 'c', 'd']);
  const kids = [...p.$('#spaces').children].map((n) => (n.classList.contains('sec') ? n.querySelector('.cn').textContent : n.querySelector('.name').textContent));
  assert.deepEqual(kids, ['Work', 'a', 'Play', 'Uncategorized', 'c', 'd']);
});

test('categories that fail to load, or come back empty, leave plain lists', async () => {
  let p = await start({ routes: { ...herdr('a'), 'GET /api/categories': new Error('offline') } });
  assert.deepEqual(p.secs(), []);
  p = await start({ routes: { ...herdr('a'), 'GET /api/categories': {} } });
  assert.deepEqual(p.secs(), []);
  assert.deepEqual(p.rowNames(), ['a']);
});

test('clicking a group header opens or closes it and saves that', async () => {
  const p = await page();
  header(p, 'Play').click();
  assert.deepEqual(p.secs(), ['▾ Work 1', '▾ Play 1', '▾ Uncategorized 2']);
  header(p, 'Uncategorized').click();
  assert.deepEqual(p.secs(), ['▾ Work 1', '▾ Play 1', '▸ Uncategorized 2']);
  assert.deepEqual(p.rowNames(), ['a', 'b']);
  const body = await saved(p);
  assert.deepEqual(body.categories, [{ name: 'Work', collapsed: false }, { name: 'Play', collapsed: false }]);
  assert.equal(body.uncatCollapsed, true);
});

test('quick changes are saved once', async () => {
  const p = await page();
  header(p, 'Play').click();
  header(p, 'Play').click();
  p.tick(250);
  await flush();
  assert.equal(p.api.called('POST', '/api/categories').length, 1);
});

test('a save that fails is not an error', async () => {
  const p = await page({ 'POST /api/categories': new Error('offline') });
  header(p, 'Play').click();
  p.tick(250);
  await flush();
  assert.equal(p.api.called('POST', '/api/categories').length, 1);
});

test('a search opens every group with a match and hides groups without one', async () => {
  const p = await start({ routes: { ...herdr('apple', 'apricot', 'banana'), ...cats(WP, { [R('apple')]: 'Play', [R('banana')]: 'Work' }, true) } });
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▸ Uncategorized 1']);
  typeFilter(p, 'ap');
  assert.deepEqual(p.secs(), ['▾ Play 1', '▾ Uncategorized 1']);
  assert.deepEqual(p.rowNames(), ['apple', 'apricot']);
  typeFilter(p, 'apple');
  assert.deepEqual(p.secs(), ['▾ Play 1']);
});

test('Expand all and Collapse all set every group', async () => {
  const p = await page();
  p.$('#colall').click();
  assert.deepEqual(p.secs(), ['▸ Work 1', '▸ Play 1', '▸ Uncategorized 2']);
  assert.deepEqual(p.rowNames(), []);
  p.$('#expall').click();
  assert.deepEqual(p.secs(), ['▾ Work 1', '▾ Play 1', '▾ Uncategorized 2']);
  assert.equal((await saved(p)).uncatCollapsed, false);
});

test('the arrows move a category up or down without toggling it', async () => {
  const p = await start({ routes: { ...herdr('a'), ...cats([{ name: 'One', collapsed: false }, { name: 'Two', collapsed: false }, { name: 'Three', collapsed: false }]) } });
  assert.equal(btn(header(p, 'One'), '↑'), undefined);
  assert.equal(btn(header(p, 'Three'), '↓'), undefined);
  assert.equal(btn(header(p, 'Two'), '↑').title, 'Move up');
  btn(header(p, 'One'), '↓').click();
  assert.deepEqual(p.secs().map((s) => s.split(' ')[1]), ['Two', 'One', 'Three', 'Uncategorized']);
  btn(header(p, 'Three'), '↑').click();
  assert.deepEqual(p.secs(), ['▾ Two 0', '▾ Three 0', '▾ One 0', '▾ Uncategorized 1']);
  assert.equal(header(p, 'Uncategorized').querySelector('.acts'), null);
});

test('renaming a category with Enter keeps its spaces in it', async () => {
  const p = await page();
  btn(header(p, 'Work'), '✎').click();
  const inp = p.$('#spaces input.catname');
  assert.equal(inp.value, 'Work');
  assert.equal(p.doc.activeElement, inp);
  inp.click();
  assert.equal(inp.parentNode.querySelector('.cc').textContent, '▾', 'a click in the box does not toggle the group');
  inp.value = '  Jobs  ';
  fire(inp, 'keydown', { key: 'x' });
  fire(inp, 'keydown', { key: 'Enter' });
  assert.deepEqual(p.secs(), ['▾ Jobs 1', '▸ Play 1', '▾ Uncategorized 2']);
  const body = await saved(p);
  assert.deepEqual(body.assign, { [R('a')]: 'Jobs', [R('b')]: 'Play', '/elsewhere': 'Jobs' });
});

test('renaming saves on blur, and Esc, a blank name, the same name, or a taken name change nothing', async () => {
  const p = await page();
  const rename = (from, to, how) => {
    btn(header(p, from), '✎').click();
    const inp = p.$('#spaces input.catname');
    inp.value = to;
    if (how === 'blur') inp.onblur(); else fire(inp, 'keydown', { key: how });
  };
  rename('Work', 'Other', 'Escape');
  rename('Work', '   ', 'Enter');
  rename('Work', 'Work', 'Enter');
  rename('Work', 'Play', 'Enter');
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▾ Uncategorized 2']);
  p.tick(250);
  await flush();
  assert.equal(p.api.called('POST', '/api/categories').length, 0);
  rename('Work', 'Desk', 'blur');
  assert.deepEqual(p.secs()[0], '▾ Desk 1');
});

test('deleting a category asks once, then moves its spaces to Uncategorized', async () => {
  const p = await page();
  const del = btn(header(p, 'Work'), '×');
  assert.match(del.title, /its spaces become Uncategorized/);
  del.click();
  assert.equal(del.textContent, 'Delete?');
  assert.deepEqual(p.secs()[0], '▾ Work 1', 'the click did not toggle the group');
  // The question times out.
  p.tick(3000);
  assert.equal(del.textContent, '×');
  del.click();
  del.click();
  assert.deepEqual(p.secs(), ['▸ Play 1', '▾ Uncategorized 3']);
  assert.deepEqual((await saved(p)).categories, [{ name: 'Play', collapsed: true }]);
});

test('a delete question whose header was redrawn is left alone when it times out', async () => {
  const p = await page();
  const del = btn(header(p, 'Work'), '×');
  del.click();
  header(p, 'Play').click();
  p.tick(3000);
  assert.equal(del.isConnected, false);
  assert.equal(del.textContent, 'Delete?');
  assert.equal(btn(header(p, 'Work'), '×').textContent, '×');
});

test('+ Category opens a name box that adds a category on Enter', async () => {
  const p = await start({ routes: { ...herdr('a'), 'POST /api/categories': (req) => req.body } });
  p.$('#newcat').click();
  assert.equal(p.$('#newcatrow').hidden, false);
  assert.equal(p.doc.activeElement, p.$('#newcatname'));
  const inp = p.$('#newcatname');
  inp.value = 'Work';
  fire(inp, 'keydown', { key: 'a' });
  assert.equal(p.$('#newcatrow').hidden, false);
  fire(inp, 'keydown', { key: 'Enter' });
  assert.equal(inp.value, '');
  assert.equal(p.$('#newcatrow').hidden, true);
  assert.deepEqual(p.secs(), ['▾ Work 0', '▾ Uncategorized 1']);
  // The same name again, or a blank one, adds nothing.
  for (const name of ['Work', '   ']) {
    p.$('#newcat').click();
    inp.value = name;
    fire(inp, 'keydown', { key: 'Enter' });
  }
  assert.deepEqual(p.secs(), ['▾ Work 0', '▾ Uncategorized 1']);
  assert.deepEqual((await saved(p)).categories, [{ name: 'Work', collapsed: false }]);
  p.$('#newcat').click();
  inp.value = 'draft';
  fire(inp, 'keydown', { key: 'Escape' });
  assert.equal(inp.value, '');
  assert.equal(p.$('#newcatrow').hidden, true);
  p.$('#newcat').click();
  p.$('#newcat').click();
  assert.equal(p.$('#newcatrow').hidden, true);
});

test('the ⋯ menu files a space, marks its current category, and offers Undo', async () => {
  const p = await page();
  const more = p.row('a').querySelector('.more');
  more.click();
  const menu = p.$('.catmenu');
  assert.equal(menu.style.left, '0px');
  assert.equal(menu.style.top, '4px');
  assert.deepEqual([...menu.querySelectorAll('button')].map((b) => b.textContent), ['✓ Work', 'Play', 'Uncategorized']);
  assert.equal(menu.querySelector('.mhead'), null);
  assert.equal(p.doc.activeElement, menu.querySelector('input'));
  [...menu.querySelectorAll('button')][1].click();
  assert.equal(p.$('.catmenu'), null);
  assert.equal(p.toast(), 'Moved a to Play');
  assert.deepEqual(p.secs(), ['▾ Work 0', '▸ Play 2', '▾ Uncategorized 2']);
  p.$('#toast button').click();
  assert.equal(p.$('#toast').hidden, true);
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▾ Uncategorized 2']);
  // Undo for a space that had no category takes it out again.
  p.row('c').querySelector('.more').click();
  assert.deepEqual([...p.$$('.catmenu button')].map((b) => b.textContent), ['Work', 'Play', '✓ Uncategorized']);
  p.$$('.catmenu button')[0].click();
  assert.deepEqual(p.secs(), ['▾ Work 2', '▸ Play 1', '▾ Uncategorized 1']);
  p.$('#toast button').click();
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▾ Uncategorized 2']);
  assert.deepEqual((await saved(p)).assign, { [R('a')]: 'Work', [R('b')]: 'Play', '/elsewhere': 'Work' });
});

test('right-clicking a selected space files the whole selection from a menu at the pointer', async () => {
  const p = await page();
  fire(p.row('c'), 'click', { metaKey: true });
  fire(p.row('d'), 'click', { metaKey: true });
  const ev = fire(p.row('d'), 'contextmenu', { clientX: 1300, clientY: 950 });
  assert.ok(ev.defaultPrevented);
  const menu = p.$('.catmenu');
  assert.equal(menu.style.left, '1180px');
  assert.equal(menu.style.top, '892px');
  assert.equal(menu.querySelector('.mhead').textContent, 'Move 2 spaces to');
  assert.deepEqual([...menu.querySelectorAll('button')].map((b) => b.textContent), ['Work', 'Play', 'Uncategorized']);
  menu.querySelector('button').click();
  assert.equal(p.toast(), 'Moved 2 spaces to Work');
  assert.equal(p.$$('#spaces .space.sel').length, 0);
});

test('typing a new name in the menu creates the category and files the space there', async () => {
  const p = await page();
  p.row('c').querySelector('.more').click();
  const inp = p.$('.catmenu input');
  assert.equal(inp.placeholder, 'New category, then Enter');
  fire(inp, 'keydown', { key: 'Enter' });
  fire(inp, 'keydown', { key: 'z' });
  assert.ok(p.$('.catmenu'));
  inp.value = 'Side';
  fire(inp, 'keydown', { key: 'Enter' });
  assert.equal(p.$('.catmenu'), null);
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▾ Side 1', '▾ Uncategorized 1']);
  assert.equal(p.toast(), 'Moved c to Side');
});

test('Esc in the menu, Esc on the page, or a click outside closes it; a click inside does not', async () => {
  const p = await page();
  p.row('c').querySelector('.more').click();
  fire(p.$('.catmenu input'), 'keydown', { key: 'Escape' });
  assert.equal(p.$('.catmenu'), null);
  p.row('c').querySelector('.more').click();
  p.$('.catmenu').click();
  assert.ok(p.$('.catmenu'));
  p.$('#count').click();
  assert.equal(p.$('.catmenu'), null);
  p.row('c').querySelector('.more').click();
  p.row('d').querySelector('.more').click();
  assert.equal(p.$$('.catmenu').length, 1, 'a second menu replaces the first');
  fire(p.doc.body, 'keydown', { key: 'Escape' });
  assert.equal(p.$('.catmenu'), null);
});

test('a space with no project folder cannot be filed, so nothing is announced', async () => {
  const p = await start({ routes: { ...herdr(space('loose', { root: null })), ...cats(WP) } });
  p.row('loose').querySelector('.more').click();
  p.$$('.catmenu button')[0].click();
  assert.equal(p.toast(), null);
  assert.deepEqual(p.secs(), ['▾ Work 0', '▸ Play 0', '▾ Uncategorized 1']);
});

test('dropping dragged spaces on a group header or a row files them there', async () => {
  const p = await page();
  const drag = (ids) => dt({ 'text/x-corral-space': ids.join('\n') });
  const play = header(p, 'Play');
  const ev = fire(play, 'dragover', { dataTransfer: drag(['c']) });
  assert.ok(ev.defaultPrevented);
  assert.ok(play.classList.contains('over'));
  fire(play, 'dragleave');
  assert.ok(!play.classList.contains('over'));
  fire(play, 'drop', { dataTransfer: drag(['c', 'd']) });
  assert.equal(p.toast(), 'Moved 2 spaces to Play');
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 3', '▾ Uncategorized 0']);
  // Onto a row: the row's group. Onto Uncategorized: no group.
  header(p, 'Play').click();
  fire(p.row('a'), 'drop', { dataTransfer: drag(['c']) });
  assert.equal(p.toast(), 'Moved c to Work');
  fire(header(p, 'Uncategorized'), 'drop', { dataTransfer: drag(['a']) });
  assert.equal(p.toast(), 'Moved a to Uncategorized');
  assert.deepEqual(p.secs(), ['▾ Work 1', '▾ Play 2', '▾ Uncategorized 1']);
});

test('drops of other things, or of spaces no longer listed, are ignored', async () => {
  const p = await page();
  const play = header(p, 'Play');
  assert.ok(!fire(play, 'dragover', { dataTransfer: dt({ 'text/x-corral': 'w1' }) }).defaultPrevented);
  assert.ok(!fire(play, 'dragover').defaultPrevented);
  play.classList.add('over');
  fire(play, 'drop', { dataTransfer: dt({ 'text/plain': 'c' }) });
  assert.ok(!play.classList.contains('over'));
  fire(play, 'drop', { dataTransfer: dt({ 'text/x-corral-space': 'ghost' }) });
  assert.equal(p.toast(), null);
  assert.deepEqual(p.secs(), ['▾ Work 1', '▸ Play 1', '▾ Uncategorized 2']);
});
