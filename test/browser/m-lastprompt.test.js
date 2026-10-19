// The last prompt you typed, in a line under the window's header on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, win, claude, overview, settle, unloadPage, deferred, goBack } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });
const visible = (p) => p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
const typed = (text, status = 'idle') => win('a', { claude: claude(status, { lastPrompt: text }) });

test('the last prompt shows under the header and follows the next one', async () => {
  const p = await phone([typed('fix the scrolling')]);
  await p.openWin('a');
  const bar = p.$('#lastprompt');
  assert.equal(bar.hidden, false);
  assert.equal(bar.previousElementSibling.tagName, 'HEADER');
  assert.equal(p.text('#lastprompt .pt'), 'fix the scrolling');
  p.api.routes['GET /api/overview'] = overview(typed('and the tests', 'busy'));
  visible(p);
  await settle();
  assert.equal(p.text('#lastprompt .pt'), 'and the tests');
  p.api.routes['GET /api/overview'] = overview(win('a'));
  visible(p);
  await settle();
  assert.equal(bar.hidden, true, 'Claude has exited');
  p.api.routes['GET /api/overview'] = overview();
  visible(p);
  await settle();
  assert.equal(bar.hidden, true, 'the window is gone');
});

test('a window with nothing typed yet has no last prompt line', async () => {
  const p = await phone([win('a', { claude: claude('idle') })]);
  await p.openWin('a');
  assert.equal(p.$('#lastprompt').hidden, true);
});

test('the × hides it, remembered on this phone, and the ··· menu shows it again', async () => {
  const p = await phone([typed('one')]);
  await p.openWin('a');
  p.$('#lastprompt button').click();
  assert.equal(p.$('#lastprompt').hidden, true);
  assert.equal(p.sheetTitle(), null, 'the × does not open the list');
  assert.equal(p.window.localStorage.getItem('corral.m.prompts'), 'false');
  assert.equal(p.toast(), 'Your last prompt is hidden. The ··· menu shows it again.');
  visible(p);
  await settle();
  assert.equal(p.$('#lastprompt').hidden, true, 'stays hidden');
  p.$('#morebtn').click();
  p.button('Show my last prompt').click();
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.$('#lastprompt').hidden, false);
  assert.equal(p.window.localStorage.getItem('corral.m.prompts'), 'true');
});

test('it starts hidden when this phone hid it', async () => {
  const p = await phone([typed('one')], { storage: { 'corral.m.prompts': false } });
  await p.openWin('a');
  assert.equal(p.$('#lastprompt').hidden, true);
  p.$('#morebtn').click();
  assert.ok(p.button('Show my last prompt'));
});

test('a tap lists every prompt in the conversation in a sheet, newest at the bottom', async () => {
  const p = await phone([typed('fix it')], { routes: { 'GET /api/sessions/a/prompts': { prompts: [
    { text: 'an old one', at: '2020-01-02T15:04:00Z' }, { text: '/wrap-up', at: 'not a time' }, { text: 'fix it', at: new Date().toISOString() },
  ], cut: false } } });
  await p.openWin('a');
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.sheetTitle(), '3 prompts');
  assert.deepEqual(p.$$('#genbody .ptext').map((e) => e.textContent), ['an old one', '/wrap-up', 'fix it']);
  const when = p.$$('#genbody .pwhen').map((e) => e.textContent);
  assert.match(when[0], /^Jan 2, \d{1,2}:\d{2}/);
  assert.equal(when[1], '');
  assert.match(when[2], /^\d{1,2}:\d{2}/);
});

test('the prompt sheet says when it holds only the most recent, or a single prompt', async () => {
  const p = await phone([typed('one')], { routes: { 'GET /api/sessions/a/prompts': { prompts: [{ text: 'one', at: null }], cut: true } } });
  await p.openWin('a');
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.sheetTitle(), '1 prompt (the most recent)');
});

test('a prompt list that cannot load says so, and one that loads after you left the window is dropped', async () => {
  const p = await phone([typed('one')], { routes: { 'GET /api/sessions/a/prompts': { __reply: true, status: 500, body: '{}' } } });
  await p.openWin('a');
  p.$('#lastprompt').click();
  await settle();
  assert.equal(p.toast(), 'Could not list the prompts.');
  assert.equal(p.sheetTitle(), null);
  const late = deferred();
  p.api.routes['GET /api/sessions/a/prompts'] = () => late.promise;
  p.$('#lastprompt').click();
  await goBack(p);
  late.resolve({ prompts: [], cut: false });
  await settle();
  assert.equal(p.sheetTitle(), null);
});
