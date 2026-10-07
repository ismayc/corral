// Card controls: permission answers, Stop, and the ⋯ menu with Last reply, Next mode, Mute, Rename, and Close.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage, fire, deferred, popstate } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const PROMPT = {
  key: 'k1', text: 'Bash(rm -rf build)',
  options: [{ n: '1', label: 'Yes' }, { n: '2', label: 'Yes, and don\'t ask again' }, { n: '3', label: 'No, and tell Claude what to do' }],
};
const asking = (o = {}) => win('a', { claude: claude('waiting', { waitingFor: 'permission prompt' }), prompt: PROMPT, ...o });

test('a card with a permission prompt shows what is asked and one button per answer, with Deny last', async () => {
  const p = await phone([asking()]);
  const ask = p.card('a').querySelector('.ask');
  assert.equal(ask.querySelector('pre').textContent, 'Bash(rm -rf build)');
  assert.deepEqual([...ask.querySelectorAll('button')].map((b) => [b.textContent, b.className]),
    [['Yes', 'primary'], ['Yes, and don\'t ask again', ''], ['Deny', 'deny']]);
});

test('an answer numbered 1 is kept even when its label starts with No', async () => {
  const p = await phone([asking({ prompt: { key: 'k', text: 't', options: [{ n: '1', label: 'No problem' }] } })]);
  assert.deepEqual([...p.card('a').querySelectorAll('.ask button')].map((b) => b.textContent), ['No problem', 'Deny']);
});

test('tapping an answer sends it with the prompt key, without opening the window, then refreshes', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([asking()], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  const yes = p.button('Yes', p.card('a'));
  yes.click();
  assert.ok([...p.card('a').querySelectorAll('.ask button')].every((b) => b.disabled));
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/answer')[0].body, { choice: '1', key: 'k1' });
  assert.equal(p.toast(), 'Answered: Yes');
  assert.equal(p.$('#termview').hidden, true);
  const polls = p.api.called('GET', '/api/overview').length;
  mock.timers.tick(600);
  await settle();
  assert.equal(p.api.called('GET', '/api/overview').length, polls + 1);
});

test('Deny sends deny and says Claude will ask what to do', async () => {
  const p = await phone([asking()], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  p.button('Deny', p.card('a')).click();
  await settle();
  assert.equal(p.api.called('POST', '/api/sessions/a/answer')[0].body.choice, 'deny');
  assert.equal(p.toast(), 'Denied. a will ask what to do instead.');
});

test('an answer the Mac refuses shows its reason, or a general one', async () => {
  const p = await phone([asking()], { routes: { 'POST /api/sessions/a/answer': (r) => ({ __reply: true, status: 409, body: { error: 'the prompt has changed' } }) } });
  p.button('Yes', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'the prompt has changed');
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  p.api.routes['POST /api/sessions/a/answer'] = { __reply: true, status: 500, body: 'oops', type: 'text/plain' };
  p.button('Deny', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Could not answer.');
});

test('an answer that cannot reach the Mac says so', async () => {
  const p = await phone([asking()], { routes: { 'POST /api/sessions/a/answer': new Error('offline') } });
  p.button('Yes', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Could not reach the Mac.');
});

test('Stop on a working card sends Esc to it and refreshes soon after', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a', { claude: claude('busy') })], { routes: { 'POST /api/sessions/a/key': { ok: true } } });
  p.button('Stop', p.card('a')).click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/key')[0].body, { key: 'stop' });
  assert.equal(p.$('#termview').hidden, true);
  const polls = p.api.called('GET', '/api/overview').length;
  mock.timers.tick(700);
  await settle();
  assert.equal(p.api.called('GET', '/api/overview').length, polls + 1);
});

test('a card key the Mac refuses or cannot get shows why', async () => {
  const p = await phone([win('a', { claude: claude('busy') })], { routes: { 'POST /api/sessions/a/key': { __reply: true, status: 409, body: { error: 'no tmux' } } } });
  p.button('Stop', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'no tmux');
  p.api.routes['POST /api/sessions/a/key'] = { __reply: true, status: 500, body: '<html>', type: 'text/html' };
  p.button('Stop', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Could not do that.');
  p.api.routes['POST /api/sessions/a/key'] = new Error('offline');
  p.button('Stop', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Could not reach the Mac.');
});

test('the ⋯ menu of a Claude window lists every action and names its mode', async () => {
  const p = await phone([win('a', { claude: claude('idle', { mode: 'plan' }) })]);
  const more = p.card('a').querySelector('.more');
  assert.equal(more.getAttribute('aria-label'), 'More for a');
  more.click();
  assert.equal(p.sheetTitle(), 'a');
  assert.equal(p.$('#termview').hidden, true);
  assert.deepEqual(p.$$('#genbody .menu button').map((b) => b.textContent),
    ['Open the window', 'Last reply', 'Next mode (now Plan mode)', 'Mute notifications for this window', 'Rename', 'Close the window']);
  assert.equal(p.button('Close the window').className, 'danger');
});

test('the menu leaves out Next mode while Claude waits on a prompt, and names no mode when none is known', async () => {
  const p = await phone([win('a', { claude: claude('waiting') }), win('b', { claude: claude('idle') })]);
  p.card('a').querySelector('.more').click();
  assert.ok(!p.$$('#genbody button').some((b) => b.textContent.startsWith('Next mode')));
  p.card('b').querySelector('.more').click();
  assert.ok(p.button('Next mode'));
});

test('the menu of a shell has no Claude actions, and a muted window offers to notify again', async () => {
  const p = await phone([win('sh', { muted: true })]);
  p.card('sh').querySelector('.more').click();
  assert.deepEqual(p.$$('#genbody .menu button').map((b) => b.textContent),
    ['Open the window', 'Notify me about this window again', 'Rename', 'Close the window']);
});

test('Open the window from the menu closes the sheet and opens the terminal', async () => {
  const p = await phone([win('a')]);
  p.card('a').querySelector('.more').click();
  p.button('Open the window').click();
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.$('#termview').hidden, false);
});

test('Next mode from the menu sends Shift-Tab to the window', async () => {
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'POST /api/sessions/a/key': { ok: true } } });
  p.card('a').querySelector('.more').click();
  p.button('Next mode').click();
  await settle();
  assert.equal(p.sheetTitle(), null);
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/key')[0].body, { key: 'mode' });
  assert.equal(p.toast(), 'Switched a to the next mode.');
});

test('Mute and unmute post the new setting and say what changed', async () => {
  const p = await phone([win('a'), win('b', { muted: true })], { routes: { 'POST /api/sessions/*/mute': (r) => ({ muted: r.body.muted }) } });
  p.card('a').querySelector('.more').click();
  p.button('Mute notifications for this window').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/mute')[0].body, { muted: true });
  assert.equal(p.toast(), 'No notifications for a until you turn them back on.');
  p.card('b').querySelector('.more').click();
  p.button('Notify me about this window again').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions/b/mute')[0].body, { muted: false });
  assert.equal(p.toast(), 'Notifications for b are back on.');
});

test('a mute the Mac refuses says it could not change that', async () => {
  const p = await phone([win('a')], { routes: { 'POST /api/sessions/a/mute': { __reply: true, status: 400, body: { error: 'bad json' } } } });
  p.card('a').querySelector('.more').click();
  p.button('Mute notifications for this window').click();
  await settle();
  assert.equal(p.toast(), 'Could not change that.');
});

test('Rename shows the current name, and Save or Enter sends the new one', async () => {
  const p = await phone([win('a')], { routes: { 'POST /api/sessions/a/rename': (r) => ({ label: r.body.label }) } });
  p.card('a').querySelector('.more').click();
  p.button('Rename').click();
  assert.equal(p.sheetTitle(), 'Rename the window');
  const input = p.$('#genbody input');
  assert.equal(input.value, 'a');
  assert.equal(input.getAttribute('maxlength'), '60');
  assert.equal(p.doc.activeElement, input);
  input.value = 'notes';
  fire(input, 'keydown', { key: 'x' });
  await settle();
  assert.equal(p.api.called('POST', '/api/sessions/a/rename').length, 0);
  fire(input, 'keydown', { key: 'Enter' });
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/rename')[0].body, { label: 'notes' });
  assert.equal(p.toast(), 'Renamed to notes.');
  assert.equal(p.sheetTitle(), null);
  p.card('a').querySelector('.more').click();
  p.button('Rename').click();
  p.$('#genbody input').value = 'two';
  p.button('Save').click();
  await settle();
  assert.equal(p.toast(), 'Renamed to two.');
});

test('a name the Mac refuses keeps the sheet open and says what names work', async () => {
  const p = await phone([win('a')], { routes: { 'POST /api/sessions/a/rename': { __reply: true, status: 400, body: { error: 'bad' } } } });
  p.card('a').querySelector('.more').click();
  p.button('Rename').click();
  p.$('#genbody input').value = '';
  p.button('Save').click();
  await settle();
  assert.equal(p.toast(), 'Use a name of 1 to 60 characters.');
  assert.equal(p.sheetTitle(), 'Rename the window');
});

test('renaming the window that is open also renames its terminal title', async () => {
  const p = await phone([win('a'), win('b')], { routes: { 'POST /api/sessions/*/rename': (r) => ({ label: r.body.label }) } });
  // The rename sheet stays up while a tapped notification opens that same window under it.
  p.card('a').querySelector('.more').click();
  p.button('Rename').click();
  p.sw.emit('message', { open: 'a' });
  await settle();
  assert.equal(p.text('#ttitle'), 'a');
  p.$('#genbody input').value = 'renamed';
  p.button('Save').click();
  await settle();
  assert.equal(p.text('#ttitle'), 'renamed');
  // A rename of another window leaves the open one's title alone.
  p.sw.emit('message', { open: 'b' });
  await settle();
  p.card('a').querySelector('.more').click();
  p.button('Rename').click();
  p.$('#genbody input').value = 'other';
  p.button('Save').click();
  await settle();
  assert.equal(p.text('#ttitle'), 'b');
});

test('Close asks first, with words that fit a Claude window or a shell', async () => {
  const p = await phone([win('a', { claude: claude('idle') }), win('sh')]);
  p.card('a').querySelector('.more').click();
  p.button('Close the window').click();
  assert.equal(p.sheetTitle(), 'Close a?');
  assert.match(p.text('#genbody p'), /Claude Code session/);
  p.button('Keep it').click();
  assert.equal(p.sheetTitle(), null);
  p.card('sh').querySelector('.more').click();
  p.button('Close the window').click();
  assert.equal(p.text('#genbody p'), 'This ends the window and its shell, on the Mac too.');
});

test('Close it deletes the window on the Mac and says so', async () => {
  const p = await phone([win('a')], { routes: { 'DELETE /api/sessions/a': { ok: true } } });
  p.card('a').querySelector('.more').click();
  p.button('Close the window').click();
  p.button('Close it').click();
  await settle();
  assert.equal(p.api.called('DELETE', '/api/sessions/a').length, 1);
  assert.equal(p.toast(), 'Closed a.');
  assert.equal(p.sheetTitle(), null);
});

test('a close that fails says so', async () => {
  const p = await phone([win('a')], { routes: { 'DELETE /api/sessions/a': { __reply: true, status: 404, body: { error: 'no such session' } } } });
  p.card('a').querySelector('.more').click();
  p.button('Close the window').click();
  p.button('Close it').click();
  await settle();
  assert.equal(p.toast(), 'Could not close it.');
});

test('closing the window that is open goes back to the list', async () => {
  const p = await phone([win('a'), win('b')], { routes: { 'DELETE /api/sessions/*': { ok: true } } });
  p.card('b').querySelector('.more').click();
  p.button('Close the window').click();
  p.sw.emit('message', { open: 'a' });
  await settle();
  // Closing another window keeps the terminal.
  p.button('Close it').click();
  await settle();
  assert.equal(p.$('#termview').hidden, false);
  p.card('a').querySelector('.more').click();
  p.button('Close the window').click();
  const popped = popstate(p);
  p.button('Close it').click();
  await popped;
  assert.equal(p.$('#home').hidden, false);
});

test('Last reply shows Claude\'s last message, or says there is none yet', async () => {
  const d = deferred();
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'GET /api/sessions/a/last': () => d.promise } });
  p.card('a').querySelector('.more').click();
  p.button('Last reply').click();
  assert.equal(p.sheetTitle(), 'a: last reply');
  assert.equal(p.text('#genbody p'), 'Loading…');
  d.resolve({ text: 'Here is the plan.' });
  await settle();
  assert.equal(p.text('#genbody .reply'), 'Here is the plan.');
  p.api.routes['GET /api/sessions/a/last'] = { text: '' };
  p.card('a').querySelector('.more').click();
  p.button('Last reply').click();
  await settle();
  assert.equal(p.text('#genbody p'), 'Claude has not replied since your last message.');
  p.button('Open the window').click();
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.$('#termview').hidden, false);
});

test('a last reply that cannot be read says so', async () => {
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'GET /api/sessions/a/last': { __reply: true, status: 500, body: { error: 'x' } } } });
  p.card('a').querySelector('.more').click();
  p.button('Last reply').click();
  await settle();
  assert.equal(p.text('#genbody p'), 'Could not read it.');
});

test('the sheet closes with its × or a tap outside it, not a tap inside', async () => {
  const p = await phone([win('a')]);
  p.card('a').querySelector('.more').click();
  p.$('#genbody').click();
  assert.equal(p.sheetTitle(), 'a');
  p.$('#gen').click();
  assert.equal(p.sheetTitle(), null);
  p.card('a').querySelector('.more').click();
  p.$('#genx').click();
  assert.equal(p.sheetTitle(), null);
});
