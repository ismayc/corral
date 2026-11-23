// The Mac page's command palette (Cmd-K), find in a window (Cmd-F), text size, and saved layouts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, flush, fire } = require('../helpers/app');

test.afterEach(stop);

// Windows a and b open for spaces a and b; space c has no window.
async function page(extra = {}) {
  return start({
    ...extra,
    routes: {
      'GET /api/herdr': { available: true, spaces: [space('a'), space('b'), space('c')] },
      'GET /api/categories': { version: 1, categories: [], uncatCollapsed: false, assign: {} },
      'GET /api/sessions': { sessions: [session('a', { space: 'a' }), session('b', { space: 'b' })] },
      'POST /api/sessions': (req) => session(`n-${req.body.space}`, { label: req.body.label, space: req.body.space }),
      ...extra.routes,
    },
  });
}
const winOf = (p, id) => p.slotOf(id).querySelector('.win');
const termOf = (p, id) => p.terms.find((t) => t.element === winOf(p, id).querySelector('.term'));
const inWindow = (p, id) => termOf(p, id).textarea.focus();
const key = (p, k, o = {}) => fire(p.doc.activeElement || p.doc.body, 'keydown', { key: k, metaKey: true, bubbles: true, cancelable: true, ...o });
const labels = (p) => p.$$('#palette .plabel').map((n) => n.textContent);
const typeIn = (input, text) => { input.value = text; fire(input, 'input'); };

// ---- Text size

test('Cmd-= and Cmd-- in a window change only that window, within 9 to 24, and Cmd-0 puts it back', async () => {
  const p = await page();
  assert.equal(termOf(p, 'a').options.fontSize, 13);
  inWindow(p, 'a');
  key(p, '=');
  assert.equal(termOf(p, 'a').options.fontSize, 14);
  assert.equal(termOf(p, 'b').options.fontSize, 13);
  assert.equal(p.toast(), 'Text size 14 in a.');
  assert.deepEqual(p.store('corral.fontSizes'), { a: 14 });
  key(p, '+');
  key(p, '-');
  assert.equal(termOf(p, 'a').options.fontSize, 14);
  key(p, '0');
  assert.equal(termOf(p, 'a').options.fontSize, 13);
  assert.deepEqual(p.store('corral.fontSizes'), {});
  for (let i = 0; i < 20; i++) key(p, '-');
  assert.equal(termOf(p, 'a').options.fontSize, 9);
});

test('text size keys do nothing outside a window, or with another modifier, so the browser zoom still works', async () => {
  const p = await page();
  p.doc.body.focus();
  const e = key(p, '=');
  assert.equal(termOf(p, 'a').options.fontSize, 13);
  assert.equal(e?.defaultPrevented ?? false, false);
  inWindow(p, 'a');
  key(p, '=', { ctrlKey: true });
  key(p, '=', { metaKey: false });
  key(p, 'x');
  assert.equal(termOf(p, 'a').options.fontSize, 13);
});

test('a window\'s own size is kept across a reload, and a closed window forgets it', async () => {
  const p = await page({ storage: { 'corral.fontSize': '15', 'corral.fontSizes': '{"a":18,"gone":20}' } });
  assert.equal(termOf(p, 'a').options.fontSize, 18);
  assert.equal(termOf(p, 'b').options.fontSize, 15);
  winOf(p, 'a').querySelector('.close').click();
  await flush();
  assert.deepEqual(p.store('corral.fontSizes'), { gone: 20 });
  winOf(p, 'b').querySelector('.close').click(); // has no size of its own
  await flush();
  assert.deepEqual(p.store('corral.fontSizes'), { gone: 20 });
});

// ---- Find

test('Cmd-F in a window opens its find bar; typing and Enter search forward, Shift-Enter back', async () => {
  const p = await page();
  termOf(p, 'a').text = 'hello world';
  inWindow(p, 'a');
  key(p, 'f');
  const bar = winOf(p, 'a').querySelector('.find');
  const input = bar.querySelector('input');
  assert.equal(p.doc.activeElement, input);
  typeIn(input, 'world');
  const search = termOf(p, 'a').addons[2];
  assert.deepEqual(search.calls.at(-1), ['next', 'world']);
  assert.equal(bar.querySelector('.fnote').textContent, '');
  fire(input, 'keydown', { key: 'Enter', shiftKey: true });
  assert.deepEqual(search.calls.at(-1), ['previous', 'world']);
  typeIn(input, 'nope');
  assert.equal(bar.querySelector('.fnote').textContent, 'No match');
  bar.querySelector('.fprev').click();
  bar.querySelector('.fnext').click();
  assert.deepEqual(search.calls.slice(-2), [['previous', 'nope'], ['next', 'nope']]);
  typeIn(input, '');
  assert.equal(bar.querySelector('.fnote').textContent, '');
  fire(input, 'keydown', { key: 'Enter' });
  fire(input, 'keydown', { key: 'a' });
  assert.equal(search.calls.length, 5, 'an empty box searches for nothing');
});

test('Cmd-F again reuses the bar; Esc or × closes it, clears the selection, and gives the window the keyboard back', async () => {
  const p = await page();
  inWindow(p, 'a');
  key(p, 'f');
  key(p, 'f');
  assert.equal(winOf(p, 'a').querySelectorAll('.find').length, 1);
  fire(winOf(p, 'a').querySelector('.find input'), 'keydown', { key: 'Escape' });
  assert.equal(winOf(p, 'a').querySelector('.find'), null);
  assert.equal(termOf(p, 'a').selectionCleared, 1);
  assert.equal(termOf(p, 'a').focused, true);
  key(p, 'f', { shiftKey: true });
  assert.equal(winOf(p, 'a').querySelector('.find'), null, 'Cmd-Shift-F is left alone');
  inWindow(p, 'a');
  key(p, 'f');
  winOf(p, 'a').querySelector('.fclose').click();
  assert.equal(winOf(p, 'a').querySelector('.find'), null);
  const fits = p.slotOf('a') && termOf(p, 'a').addons[0].fits || 0;
  await new Promise((r) => setTimeout(r, 40)); // the refit waits for the next frame
  assert.ok(termOf(p, 'a').addons[0].fits > fits);
});

test('a bad stored size falls back to 13, and a size for every window replaces each window\'s own', async () => {
  const p = await page({ storage: { 'corral.fontSize': '"big"', 'corral.fontSizes': '{"a":20}' } });
  assert.equal(termOf(p, 'b').options.fontSize, 13);
  assert.equal(termOf(p, 'a').options.fontSize, 20);
  key(p, 'k');
  typeIn(p.$('#palette input'), 'larger text in every');
  fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  assert.equal(termOf(p, 'a').options.fontSize, 14);
  assert.deepEqual(p.store('corral.fontSizes'), {});
});

test('the find bar sits under the last prompt line when there is one', async () => {
  const p = await page({ routes: { 'GET /api/overview': { sessions: [{ id: 'a', label: 'a', exited: false, claude: { status: 'idle', lastPrompt: 'hi' } }, { id: 'b', label: 'b', exited: false }] } } });
  p.tick(3000);
  await flush();
  inWindow(p, 'a');
  key(p, 'f');
  assert.equal(winOf(p, 'a').querySelector('.lastprompt').nextElementSibling.className, 'find');
});

// ---- Palette

test('Cmd-K opens the palette with windows, spaces, and commands; typing narrows it; Esc closes it', async () => {
  const p = await page();
  p.doc.body.focus();
  key(p, 'k');
  const input = p.$('#palette input');
  assert.equal(p.doc.activeElement, input);
  const all = labels(p);
  assert.ok(all.includes('Go to a') && all.includes('Go to b') && all.includes('Open c'));
  assert.ok(!all.includes('Open a'), 'a space with a window is offered as Go to');
  assert.ok(all.includes('Layout: Halves') && all.includes('New shell') && all.includes('Save this layout…'));
  typeIn(input, 'go b');
  assert.deepEqual(labels(p), ['Go to b']);
  typeIn(input, 'zzz');
  assert.equal(p.$('#palette .pnone').textContent, 'Nothing matches.');
  fire(input, 'keydown', { key: 'ArrowDown' }); // nothing to move to
  fire(input, 'keydown', { key: 'Enter' }); // nothing to run
  fire(input, 'keydown', { key: 'Escape' });
  assert.equal(p.$('#palette'), null);
  key(p, 'k', { shiftKey: true });
  assert.equal(p.$('#palette'), null);
});

test('labels that start with what was typed come first, and the arrows move the choice around the list', async () => {
  const p = await page();
  key(p, 'k');
  const input = p.$('#palette input');
  typeIn(input, 'layout');
  assert.equal(labels(p)[0].startsWith('Layout'), true);
  assert.ok(labels(p).includes('Save this layout…'));
  const on = () => p.$('#palette .pitem.on .plabel').textContent;
  const first = on();
  fire(input, 'keydown', { key: 'ArrowUp' });
  assert.equal(on(), labels(p).at(-1));
  fire(input, 'keydown', { key: 'ArrowDown' });
  assert.equal(on(), first);
});

test('Enter runs the chosen command: Go to brings a minimized window back', async () => {
  const p = await page();
  winOf(p, 'b').querySelector('.min').click();
  key(p, 'k');
  const input = p.$('#palette input');
  typeIn(input, 'go to b');
  assert.equal(p.$('#palette .phint').textContent, 'window, in the bottom bar');
  fire(input, 'keydown', { key: 'Enter' });
  assert.equal(p.$('#palette'), null);
  assert.equal(p.slotOf('b').hidden, false);
  key(p, 'k');
  typeIn(p.$('#palette input'), 'go to a');
  assert.equal(p.$('#palette .phint').textContent, 'window');
  fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  assert.ok(winOf(p, 'a').classList.contains('focus'));
});

test('a click on a row runs it, and a click outside the box closes the palette', async () => {
  const p = await page();
  key(p, 'k');
  typeIn(p.$('#palette input'), 'open c');
  fire(p.$('#palette .pitem'), 'mousedown');
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body.space, 'c');
  key(p, 'k');
  fire(p.$('#palette .pbox'), 'mousedown');
  assert.ok(p.$('#palette'));
  fire(p.$('#palette'), 'mousedown');
  assert.equal(p.$('#palette'), null);
  key(p, 'k');
  key(p, 'k'); // Cmd-K again closes it
  assert.equal(p.$('#palette'), null);
});

test('with a window focused the palette offers find, its text size, and its past conversations', async () => {
  const p = await page({ routes: { 'GET /api/history': { conversations: [], more: false } } });
  inWindow(p, 'a');
  key(p, 'k');
  const all = labels(p);
  assert.ok(all.includes('Find in a') && all.includes('Larger text in a') && all.includes('Smaller text in a') && all.includes('Past conversations in a'));
  assert.ok(!all.includes('Usual text size in a'));
  const run = (label) => { typeIn(p.$('#palette input'), label); fire(p.$('#palette input'), 'keydown', { key: 'Enter' }); };
  run('Larger text in a');
  assert.equal(termOf(p, 'a').options.fontSize, 14);
  inWindow(p, 'a');
  key(p, 'k');
  run('Smaller text in a');
  assert.equal(termOf(p, 'a').options.fontSize, 13);
  inWindow(p, 'a');
  key(p, '=');
  key(p, 'k');
  run('Usual text size in a');
  assert.equal(termOf(p, 'a').options.fontSize, 13);
  inWindow(p, 'a');
  key(p, 'k');
  run('Find in a');
  assert.ok(winOf(p, 'a').querySelector('.find'));
  inWindow(p, 'a');
  key(p, 'k');
  run('Past conversations in a');
  await flush();
  assert.equal(p.$('.catmenu .mhead').textContent, 'Past conversations in a');
});

test('a window with no space has no Past conversations command, and the page commands work', async () => {
  const p = await page({ routes: { 'GET /api/sessions': { sessions: [session('a', { space: null })] } } });
  inWindow(p, 'a');
  key(p, 'k');
  assert.ok(!labels(p).includes('Past conversations in a'));
  const run = (label) => { key(p, 'k'); typeIn(p.$('#palette input'), label); fire(p.$('#palette input'), 'keydown', { key: 'Enter' }); };
  key(p, 'k'); // close it
  run('Larger text in every window');
  assert.equal(termOf(p, 'a').options.fontSize, 14);
  assert.equal(p.toast(), 'Text size 14 in every window.');
  run('Smaller text in every window');
  run('Larger text in every window');
  run('Usual text size in every window');
  assert.equal(termOf(p, 'a').options.fontSize, 13);
  run('Hide last prompts');
  assert.equal(p.$('#prompts').textContent, 'Prompts: off');
  run('Show last prompts');
  assert.equal(p.$('#prompts').textContent, 'Prompts: on');
  run('Shortcuts');
  assert.equal(p.$('#keysmenu').hidden, false);
  const theme = p.$('#theme').textContent;
  run('Theme:');
  assert.notEqual(p.$('#theme').textContent, theme);
  run('Layout: Thirds');
  assert.equal(p.store('corral.layout'), 'thirds');
  key(p, 'k');
  typeIn(p.$('#palette input'), 'Layout: Thirds');
  assert.equal(p.$('#palette .phint').textContent, 'in use');
  key(p, 'k');
  run('New project');
  assert.equal(p.$('#newprojname').hidden, false);
  run('New shell');
  await flush();
  assert.equal(p.api.called('POST', '/api/sessions').at(-1).body.label, 'shell');
});

// ---- Saved layouts

test('Save this layout keeps the layout and the spaces in its zones, under a name', async () => {
  const p = await page();
  p.$('#laybtn').click();
  const box = p.$('#laymenu .savedname');
  box.value = '   ';
  fire(box, 'keydown', { key: 'Enter' });
  assert.equal(p.store('corral.savedLayouts'), null);
  fire(box, 'keydown', { key: 'a' });
  box.value = 'Teaching day';
  fire(box, 'keydown', { key: 'Enter' });
  assert.equal(p.$('#laymenu').hidden, true);
  assert.deepEqual(p.store('corral.savedLayouts'), [{ name: 'Teaching day', kind: 'auto', cols: '2', rows: 'auto', spaces: ['a', 'b'] }]);
  assert.equal(p.toast(), 'Saved "Teaching day": Auto with 2 spaces.');
  winOf(p, 'b').querySelector('.min').click();
  p.$('#laybtn').click();
  p.$('#laymenu .savedname').value = 'Solo';
  fire(p.$('#laymenu .savedname'), 'keydown', { key: 'Enter' });
  assert.equal(p.toast(), 'Saved "Solo": Auto with 1 space.');
  p.$('#laybtn').click();
  assert.deepEqual(p.$$('#laymenu .saveduse').map((b) => [b.textContent, b.title]), [['Teaching day', 'Auto: a, b'], ['Solo', 'Auto: a']]);
});

test('using a saved layout opens missing spaces, puts each in its zone, and minimizes the rest', async () => {
  const saved = [{ name: 'Day', kind: 'halves', cols: '2', rows: 'auto', spaces: ['c', 'a'] }];
  const p = await page({ storage: { 'corral.savedLayouts': JSON.stringify(saved) } });
  p.$('#laybtn').click();
  p.$('#laymenu .saveduse').click();
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions').map((c) => c.body.space), ['c']);
  assert.equal(p.store('corral.layout'), 'halves');
  assert.deepEqual(p.store('corral.slots').slots, ['n-c', 'a']);
  assert.deepEqual(p.store('corral.minimized'), ['b']);
  assert.equal(p.toast(), 'Using "Day".');
});

test('a saved Grid layout sets the columns and rows; a gone space is counted; an empty zone stays empty', async () => {
  const saved = [{ name: 'G', kind: 'grid', cols: '3', rows: '1', spaces: ['a', null, 'zz'] }, { name: 'One gone', kind: 'mystery', cols: '2', rows: 'auto', spaces: ['zz', 'yy'] }];
  const p = await page({ storage: { 'corral.savedLayouts': JSON.stringify(saved) } });
  p.$('#laybtn').click();
  assert.match(p.$$('#laymenu .saveduse')[1].title, /^Auto: a closed space, a closed space$/);
  p.$('#laymenu .saveduse').click();
  await flush();
  assert.equal(p.$('#cols').value, '3');
  assert.equal(p.$('#rows').value, '1');
  assert.equal(p.store('corral.cols'), '3');
  assert.equal(p.toast(), 'Using "G". 1 of its spaces no longer exists.');
  p.$('#laybtn').click();
  p.$$('#laymenu .saveduse')[1].click();
  await flush();
  assert.equal(p.store('corral.layout'), 'auto');
  assert.equal(p.toast(), 'Using "One gone". 2 of its spaces no longer exist.');
});

test('× deletes a saved layout, and Undo brings it back; the palette uses and saves layouts too', async () => {
  const saved = [{ name: 'Day', kind: 'halves', cols: '2', rows: 'auto', spaces: [] }];
  const p = await page({ storage: { 'corral.savedLayouts': JSON.stringify(saved) } });
  p.$('#laybtn').click();
  p.$('#laymenu .saveddel').click();
  assert.deepEqual(p.store('corral.savedLayouts'), []);
  assert.equal(p.$$('#laymenu .saveduse').length, 0);
  p.$('#toast button').click();
  assert.deepEqual(p.store('corral.savedLayouts').map((l) => l.name), ['Day']);
  p.$('#laybtn').click();
  assert.equal(p.$$('#laymenu .saveduse')[0].title, 'Halves: no spaces');
  key(p, 'k');
  typeIn(p.$('#palette input'), 'use layout: day');
  fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  await flush();
  assert.equal(p.toast(), 'Using "Day".');
  assert.equal(p.store('corral.layout'), 'halves');
  key(p, 'k');
  typeIn(p.$('#palette input'), 'save this layout');
  fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  const ask = p.$('#palette input');
  assert.equal(ask.placeholder, 'Name for this layout, then Enter');
  assert.equal(p.$$('#palette .pitem').length, 0);
  ask.value = '';
  fire(ask, 'keydown', { key: 'Enter' });
  assert.ok(p.$('#palette'), 'an empty name keeps it open');
  ask.value = 'Evening';
  fire(ask, 'keydown', { key: 'Enter' });
  assert.equal(p.$('#palette'), null);
  assert.equal(p.toast(), 'Saved "Evening": Halves with 0 spaces.'); // Day minimized every window
  // Saving a name that exists replaces it.
  key(p, 'k');
  typeIn(p.$('#palette input'), 'save this layout');
  fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  p.$('#palette input').value = 'Evening';
  fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  assert.deepEqual(p.store('corral.savedLayouts').map((l) => l.name), ['Day', 'Evening']);
});
