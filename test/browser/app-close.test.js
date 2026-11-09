const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, flush, fire } = require('../helpers/app');

test.afterEach(stop);

// The Mac page's space menu can close one space, after asking, through POST /api/spaces/close.
// By default the close works, and herdr then lists the space no more.
async function page(close) {
  let ids = ['a', 'b'];
  return start({ routes: {
    'GET /api/herdr': () => ({ available: true, spaces: ids.map((id) => space(id)) }),
    'GET /api/categories': { version: 1, categories: [], uncatCollapsed: false, assign: {} },
    'POST /api/spaces/close': close || ((req) => { ids = ids.filter((id) => id !== req.body.space); return { ok: true }; }),
  } });
}
const items = (p) => p.$$('.catmenu button').map((b) => b.textContent);
const pick = (p, text) => p.$$('.catmenu button').find((b) => b.textContent === text).click();
const ask = (p, name) => { p.row(name).querySelector('.more').click(); pick(p, 'Close space…'); };

test('Close space asks first, then closes the space and drops it from the list', async () => {
  const p = await page();
  p.row('b').querySelector('.more').click();
  assert.equal(items(p).at(-1), 'Close space…');
  pick(p, 'Close space…');
  assert.equal(p.$('.catmenu .mhead').textContent, 'Close b?');
  assert.match(p.$('.catmenu .murl').textContent, /Claude Code included/);
  assert.deepEqual(items(p), ['Close it', 'Keep it']);
  assert.equal(p.doc.activeElement.textContent, 'Close it');
  pick(p, 'Close it');
  assert.equal(p.$('.catmenu'), null);
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/spaces/close').map((c) => c.body), [{ space: 'b' }]);
  assert.equal(p.toast(), 'Closed b.');
  assert.deepEqual(p.rowNames(), ['a']);
});

test('Keep it closes the menu and leaves the space alone', async () => {
  const p = await page();
  ask(p, 'a');
  pick(p, 'Keep it');
  assert.equal(p.$('.catmenu'), null);
  await flush();
  assert.equal(p.api.called('POST', '/api/spaces/close').length, 0);
  assert.deepEqual(p.rowNames(), ['a', 'b']);
});

test('a close that fails, or never reaches Corral, says why', async () => {
  let p = await page(() => ({ error: 'herdr not reachable' }));
  ask(p, 'a');
  pick(p, 'Close it');
  await flush();
  assert.equal(p.toast(), 'Could not close a: herdr not reachable');
  assert.deepEqual(p.rowNames(), ['a', 'b']);
  stop();
  p = await page(new Error('offline'));
  ask(p, 'b');
  pick(p, 'Close it');
  await flush();
  assert.equal(p.toast(), 'Could not close b: Could not reach Corral.');
});

test('a menu for several spaces has no Close', async () => {
  const p = await page();
  fire(p.row('a'), 'click', { metaKey: true });
  fire(p.row('b'), 'click', { metaKey: true });
  p.row('b').querySelector('.more').click();
  assert.equal(items(p).includes('Close space…'), false);
});
