// The last prompt you typed, in a line under the window's header on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, win, claude, overview, settle, unloadPage } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });
const visible = (p) => p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
const typed = (text, status = 'idle') => win('a', { claude: claude(status, { lastPrompt: text }) });

test('the last prompt shows under the header, follows the next one, and a tap shows all of it', async () => {
  const p = await phone([typed('fix the scrolling')]);
  await p.openWin('a');
  const bar = p.$('#lastprompt');
  assert.equal(bar.hidden, false);
  assert.equal(bar.previousElementSibling.tagName, 'HEADER');
  assert.equal(p.text('#lastprompt .pt'), 'fix the scrolling');
  bar.click();
  assert.ok(bar.classList.contains('full'));
  p.api.routes['GET /api/overview'] = overview(typed('and the tests', 'busy'));
  visible(p);
  await settle();
  assert.equal(p.text('#lastprompt .pt'), 'and the tests');
  assert.ok(bar.classList.contains('full'), 'stays open while it shows');
  p.api.routes['GET /api/overview'] = overview(win('a'));
  visible(p);
  await settle();
  assert.equal(bar.hidden, true, 'Claude has exited');
  assert.ok(!bar.classList.contains('full'));
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
  assert.ok(!p.$('#lastprompt').classList.contains('full'), 'the × does not open it');
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
