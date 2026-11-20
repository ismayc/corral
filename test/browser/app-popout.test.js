// public/app.js: popping a window out into a browser window of its own (/pop).
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, flush } = require('../helpers/app');

test.afterEach(stop);

const routes = {
  'GET /api/herdr': { available: true, spaces: [space('alpha'), space('beta')] },
  'POST /api/sessions': (req) => ({ __reply: true, status: 201, body: session(`n-${req.body.space}`, { label: req.body.label, space: req.body.space }) }),
};

async function twoWindows() {
  const p = await start({ routes });
  p.row('alpha').click();
  await flush();
  p.row('beta').click();
  await flush();
  const opened = [];
  p.blocked = false;
  p.window.open = (...a) => {
    if (p.blocked) return null;
    const w = { closed: false, focused: false, focus() { w.focused = true; } };
    opened.push({ args: a, w });
    return w;
  };
  p.opened = opened;
  return p;
}

test('the pop-out button opens the window in a browser window of its own and minimizes it here', async () => {
  const p = await twoWindows();
  const btn = p.slotOf('alpha').querySelector('.title .pop');
  assert.match(btn.title, /Pop out/);
  btn.click();
  assert.deepEqual(p.opened[0].args, ['/pop?id=n-alpha', 'corral-pop:n-alpha', 'popup,width=1500,height=950']);
  assert.equal(p.opened[0].w.focused, true);
  assert.deepEqual(p.visible(), ['beta']);
  assert.deepEqual(p.chips(), ['alpha']);
  assert.match(p.toast(), /^Popped out alpha\. It comes back here when you close the pop-out\.$/);

  // Still open: nothing changes. Closed: it comes back into a zone, once.
  p.tick(1500);
  assert.deepEqual(p.chips(), ['alpha']);
  p.opened[0].w.closed = true;
  p.tick(1500);
  assert.deepEqual(p.visible().sort(), ['alpha', 'beta']);
  assert.deepEqual(p.chips(), []);
  p.tick(1500);
  assert.deepEqual(p.chips(), []);
});

test('a pop-out closed after its window came back by hand, or after the window closed, changes nothing here', async () => {
  const p = await twoWindows();
  p.slotOf('alpha').querySelector('.title .pop').click();
  p.slotOf('beta').querySelector('.title .pop').click();
  assert.deepEqual(p.chips().sort(), ['alpha', 'beta']);
  p.$$('#tray .chip').find((c) => c.textContent === 'alpha').click(); // back by hand
  p.api.routes['DELETE /api/sessions/n-beta'] = { ok: true };
  p.slotOf('beta').querySelector('.title .close').click(); // closed for good
  await flush();
  assert.deepEqual([p.visible(), p.chips()], [['alpha'], []]);
  for (const o of p.opened) o.w.closed = true;
  p.tick(1500);
  assert.deepEqual([p.visible(), p.chips()], [['alpha'], []]);
});

test('Send back in a pop-out brings the window back, even after this page reloaded and lost the pop-out', async () => {
  const p = await twoWindows();
  p.slotOf('alpha').querySelector('.title .pop').click();
  const channel = p.channels.find((c) => c.name === 'corral-pop');
  channel.emit({ sendBack: 'n-alpha' });
  assert.deepEqual([p.visible().sort(), p.chips()], [['alpha', 'beta'], []]);
  p.opened[0].w.closed = true;
  p.tick(1500); // the pop-out closing afterwards changes nothing
  assert.deepEqual(p.chips(), []);

  // A page that never saw the pop-out (reloaded since) still brings it back from the bottom bar.
  p.slotOf('beta').querySelector('.title .min').click();
  channel.emit({ sendBack: 'n-beta' });
  assert.deepEqual(p.chips(), []);
  // A window not in the bottom bar, one not on this page, or a message of another kind changes nothing.
  channel.emit({ sendBack: 'n-alpha' });
  channel.emit({ sendBack: 'nope' });
  channel.emit(null);
  assert.deepEqual([p.visible().sort(), p.chips()], [['alpha', 'beta'], []]);
});

test('a blocked pop-up says so and leaves the window in place', async () => {
  const p = await twoWindows();
  p.blocked = true;
  p.slotOf('alpha').querySelector('.title .pop').click();
  assert.match(p.toast(), /blocked the new window/);
  assert.deepEqual(p.visible().sort(), ['alpha', 'beta']);
});
