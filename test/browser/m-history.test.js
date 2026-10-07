// Scrollback as text: opened from the terminal's ⋯ menu, with Copy all and Back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, win, claude, settle, unloadPage, goBack, popstate } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

const text = (body, status = 200) => ({ __reply: true, status, body, type: 'text/plain' });

// Opens the scrollback from the terminal's ⋯ menu.
async function scrollback(p) {
  p.$('#morebtn').click();
  p.button('Scrollback as text').click();
  await settle();
}

test('the ⋯ menu in a terminal offers the changes and the scrollback', async () => {
  const p = await phone([win('a')]);
  await p.openWin('a');
  assert.equal(p.$('#morebtn').getAttribute('aria-label'), 'More: changes and scrollback');
  p.$('#morebtn').click();
  assert.equal(p.sheetTitle(), 'a');
  assert.deepEqual(p.$$('#genbody .menu button').map((b) => b.textContent), ['Changes not yet committed', 'Scrollback as text']);
});

test('Scrollback as text closes the menu and shows the window\'s scrollback', async () => {
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'GET /api/sessions/a/history': text('$ ls\nREADME.md') } });
  await p.openWin('a');
  p.$('#morebtn').click();
  p.button('Scrollback as text').click();
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.text('#histtext'), 'Loading…');
  assert.equal(p.$('#histview').hidden, false);
  assert.equal(p.$('#termview').hidden, true);
  assert.equal(p.text('#htitle'), 'a');
  assert.deepEqual(p.window.history.state, { hist: true });
  await settle();
  assert.equal(p.text('#histtext'), '$ ls\nREADME.md');
});

test('a window with no saved scrollback says so', async () => {
  const p = await phone([win('sh')], { routes: { 'GET /api/sessions/sh/history': { __reply: true, status: 404, body: { error: 'no such window' } } } });
  await p.openWin('sh');
  await scrollback(p);
  assert.equal(p.text('#histtext'), 'This window has no saved scrollback.');
});

test('a scrollback that cannot be fetched says so', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/history': new Error('offline') } });
  await p.openWin('a');
  await scrollback(p);
  assert.equal(p.text('#histtext'), 'Could not load the scrollback.');
});

test('Copy all copies the scrollback, and a refused copy says to select instead', async () => {
  const p = await phone([win('sh')], { routes: { 'GET /api/sessions/sh/history': text('scroll') } });
  await p.openWin('sh');
  await scrollback(p);
  p.$('#histcopy').click();
  await settle();
  assert.equal(p.clipboard.text, 'scroll');
  assert.equal(p.toast(), 'Copied the scrollback.');
  p.clipboard.fail = true;
  p.$('#histcopy').click();
  await settle();
  assert.equal(p.toast(), 'Could not copy. Select the text instead.');
});

test('Back from the scrollback returns to the same terminal', async () => {
  const p = await phone([win('sh')], { routes: { 'GET /api/sessions/sh/history': 'x' } });
  const { term } = await p.openWin('sh');
  await scrollback(p);
  await goBack(p);
  assert.equal(p.$('#histview').hidden, true);
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(term.disposed, false);
  // The header's back button goes back the same way.
  await scrollback(p);
  const popped = popstate(p);
  p.$('#histback').click();
  await popped;
  assert.equal(p.$('#termview').hidden, false);
});

test('a menu left open after going back to the list opens nothing', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': { repo: null, cwd: '/x' } } });
  await p.openWin('a');
  p.$('#morebtn').click();
  await goBack(p);
  assert.equal(p.$('#home').hidden, false);
  assert.equal(p.sheetTitle(), 'a');
  p.button('Scrollback as text').click();
  await settle();
  assert.equal(p.$('#histview').hidden, true);
  await p.openWin('a');
  p.$('#morebtn').click();
  await goBack(p);
  p.button('Changes not yet committed').click();
  await settle();
  assert.equal(p.$('#diffview').hidden, true);
  // The ⋯ button itself does nothing once the terminal is closed.
  p.$('#morebtn').click();
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.api.calls.filter((c) => /\/(history|changes)$/.test(c.path)).length, 0);
  assert.equal(p.$('#home').hidden, false);
});

test('a notification tapped while the scrollback is open shows that window\'s terminal', async () => {
  const p = await phone([win('a'), win('b')], { routes: { 'GET /api/sessions/a/history': text('x') } });
  await p.openWin('a');
  await scrollback(p);
  p.sw.emit('message', { open: 'b' });
  await settle();
  assert.equal(p.$('#histview').hidden, true);
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'b');
});
