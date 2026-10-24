// The message box, Send, and quick replies.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, settle, win, unloadPage, fire } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

test('Send pastes the message as one piece, then presses Enter, and empties the box', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a')]);
  const { ws, term } = await p.openWin('a');
  p.$('#msg').value = 'line one\nline two';
  p.$('#send').click();
  assert.deepEqual(term.pasted, ['line one\nline two']);
  assert.equal(p.$('#msg').value, '');
  mock.timers.tick(79);
  assert.deepEqual(p.typed(ws), []);
  mock.timers.tick(1);
  assert.deepEqual(p.typed(ws), ['\r']);
});

test('Send with an empty box just presses Enter', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a')]);
  const { ws, term } = await p.openWin('a');
  p.$('#send').click();
  mock.timers.tick(0);
  assert.deepEqual(term.pasted, []);
  assert.deepEqual(p.typed(ws), ['\r']);
});

test('Enter in the box sends, but not with Shift or while composing, and other keys type', async () => {
  const p = await phone([win('a')]);
  const { term } = await p.openWin('a');
  const msg = p.$('#msg');
  msg.value = 'hi';
  assert.equal(fire(msg, 'keydown', { key: 'Enter', shiftKey: true }).defaultPrevented, false);
  assert.equal(fire(msg, 'keydown', { key: 'Enter', isComposing: true }).defaultPrevented, false);
  assert.equal(fire(msg, 'keydown', { key: 'a' }).defaultPrevented, false);
  assert.deepEqual(term.pasted, []);
  assert.equal(fire(msg, 'keydown', { key: 'Enter' }).defaultPrevented, true);
  assert.deepEqual(term.pasted, ['hi']);
});

test('Send does nothing with no terminal open, and keeps the focus in the box', async () => {
  const p = await phone([]);
  p.$('#msg').value = 'kept';
  p.$('#send').click();
  assert.equal(p.$('#msg').value, 'kept');
  assert.equal(fire(p.$('#send'), 'pointerdown').defaultPrevented, true);
});

test('the box grows with its text up to a third of the screen', async () => {
  const p = await phone([]);
  const msg = p.$('#msg');
  Object.defineProperty(msg, 'scrollHeight', { configurable: true, value: 60 });
  fire(msg, 'input');
  assert.equal(msg.style.height, '60px');
  Object.defineProperty(msg, 'scrollHeight', { configurable: true, value: 900 });
  fire(msg, 'input');
  assert.equal(msg.style.height, `${844 * 0.3}px`);
});

test('quick replies fill the box without sending, and add to what is already there', async () => {
  const p = await phone([win('a')]);
  const { ws } = await p.openWin('a');
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Continue', 'Yes, go ahead', 'Run the tests', 'Commit and push', '/clear', 'Edit']);
  const q = (label) => p.$$('#quick button').find((b) => b.textContent === label);
  assert.equal(fire(q('Continue'), 'pointerdown').defaultPrevented, true);
  q('Continue').click();
  assert.equal(p.$('#msg').value, 'Continue');
  q('Run the tests').click();
  assert.equal(p.$('#msg').value, 'Continue Run the tests');
  assert.deepEqual(ws.sent.filter((s) => s.includes('"in"')), []);
});

test('Edit saves one quick reply per line, trimmed, at most twenty, on the Mac and on the phone', async () => {
  const p = await phone([]);
  p.button('Edit', p.$('#quick')).click();
  assert.equal(p.sheetTitle(), 'Quick replies');
  const ta = p.$('#genbody textarea');
  assert.equal(ta.value, 'Continue\nYes, go ahead\nRun the tests\nCommit and push\n/clear');
  ta.value = ['  ok  ', '', ...Array.from({ length: 25 }, (_, i) => `r${i}`)].join('\n');
  p.button('Save').click();
  assert.equal(p.button('Save').disabled, true);
  await settle();
  assert.equal(p.sheetTitle(), null);
  assert.equal(p.api.called('POST', '/api/quick')[0].body.replies.length, 20);
  const saved = JSON.parse(p.window.localStorage.getItem('corral.m.quick'));
  assert.equal(saved.length, 20);
  assert.equal(saved[0], 'ok');
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent).slice(0, 2), ['ok', 'r0']);
});

test('Reset in the editor puts back the default quick replies', async () => {
  const p = await phone([], { storage: { 'corral.m.quick': ['Mine'] } });
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Mine', 'Edit']);
  p.button('Edit', p.$('#quick')).click();
  p.button('Reset').click();
  assert.equal(p.$('#genbody textarea').value, 'Continue\nYes, go ahead\nRun the tests\nCommit and push\n/clear');
  p.button('Save').click();
  await settle();
  assert.equal(p.$$('#quick button').length, 6);
});

test('a saved setting that is not valid JSON falls back to the default', async () => {
  const p = await phone([], { storage: { 'corral.m.quick': '{broken' } });
  assert.equal(p.$$('#quick button')[0].textContent, 'Continue');
});

test('storage that refuses writes leaves the page working', async () => {
  const p = await phone([], { setup: (w) => { w.Storage.prototype.setItem = () => { throw new Error('quota'); }; } });
  p.button('Edit', p.$('#quick')).click();
  p.$('#genbody textarea').value = 'Only';
  p.button('Save').click();
  await settle();
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Only', 'Edit']);
  assert.equal(p.window.localStorage.getItem('corral.m.quick'), null);
});

test('the Mac\'s quick replies replace this device\'s copy on load and when the page comes back', async () => {
  const p = await phone([], { storage: { 'corral.m.quick': ['Old'] }, routes: { 'GET /api/quick': { replies: ['Shared'] } } });
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Shared', 'Edit']);
  assert.deepEqual(JSON.parse(p.window.localStorage.getItem('corral.m.quick')), ['Shared']);
  assert.equal(p.api.called('POST', '/api/quick').length, 0);
  p.api.routes['GET /api/quick'] = { replies: ['Edited on the iPad'] };
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Edited on the iPad', 'Edit']);
});

test('a Mac with no quick replies yet takes an edited list from this device, but not the default', async () => {
  const p = await phone([], { storage: { 'corral.m.quick': ['Mine'] } });
  assert.deepEqual(p.api.called('POST', '/api/quick').map((c) => c.body), [{ replies: ['Mine'] }]);
  unloadPage();
  const q = await phone([], { routes: { 'POST /api/quick': new Error('offline') } });
  assert.equal(q.api.called('POST', '/api/quick').length, 0);
  assert.equal(q.$$('#quick button')[0].textContent, 'Continue');
  unloadPage();
  const r = await phone([], { storage: { 'corral.m.quick': ['Mine'] }, routes: { 'POST /api/quick': new Error('offline') } });
  assert.equal(r.api.called('POST', '/api/quick').length, 1);
  assert.equal(r.$$('#quick button')[0].textContent, 'Mine');
});

test('a Mac that cannot be read keeps this device\'s copy, and a save it refuses keeps the editor open', async () => {
  const p = await phone([], { storage: { 'corral.m.quick': ['Mine'] }, routes: { 'GET /api/quick': new Error('offline'), 'POST /api/quick': { __reply: true, status: 400, body: { error: 'bad quick replies' } } } });
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Mine', 'Edit']);
  p.button('Edit', p.$('#quick')).click();
  p.$('#genbody textarea').value = 'x'.repeat(501);
  p.button('Save').click();
  await settle();
  assert.equal(p.sheetTitle(), 'Quick replies');
  assert.equal(p.button('Save').disabled, false);
  assert.equal(p.toast(), 'Could not save on the Mac. A reply can be at most 500 characters.');
  assert.deepEqual(p.$$('#quick button').map((b) => b.textContent), ['Mine', 'Edit']);
});
