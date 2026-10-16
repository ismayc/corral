// Slash commands: typing "/" in the message box lists the window's skills and commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, settle, win, deferred, goBack, unloadPage, fire } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

const COMMANDS = { commands: [
  { name: 'prime', description: 'Start-of-session orientation', source: 'user' },
  { name: 'verify', description: 'Pre-commit gate', source: 'user' },
  { name: 'tools:review', description: 'Plugin review', source: 'plugin' },
  { name: 'resume', description: '', source: 'built-in' },
  { name: 'clear', description: 'Start a new session', source: 'built-in' },
] };

// Types into the box as the keyboard does, then waits for the list.
async function type(p, text) {
  p.$('#msg').value = text;
  fire(p.$('#msg'), 'input');
  await settle();
}
const shown = (p) => (p.$('#slash').hidden ? null : p.$$('#slash b').map((b) => b.textContent));

test('a "/" at the start lists the commands, narrowed as you type, names starting with it first', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/commands': COMMANDS } });
  await p.openWin('a');
  assert.equal(shown(p), null);
  await type(p, '/');
  assert.deepEqual(shown(p), ['/prime', '/verify', '/tools:review', '/resume', '/clear']);
  assert.equal(p.$$('#slash button')[0].querySelector('span').textContent, 'Start-of-session orientation');
  assert.equal(p.$$('#slash button')[3].querySelector('span'), null); // no description, no second line
  await type(p, '/re');
  assert.deepEqual(shown(p), ['/resume', '/tools:review']);
  await type(p, '/RE');
  assert.deepEqual(shown(p), ['/resume', '/tools:review']);
  await type(p, '/zzz');
  assert.equal(shown(p), null);
  await type(p, '/prime now');
  assert.equal(shown(p), null);
  await type(p, 'not /prime');
  assert.equal(shown(p), null);
  assert.equal(p.api.called('GET', '/api/sessions/a/commands').length, 1); // loaded once for the window
});

test('a tap fills in the name and a space, keeps the keyboard up, and closes the list', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/commands': COMMANDS } });
  const { term } = await p.openWin('a');
  await type(p, '/ver');
  const row = p.$('#slash button');
  assert.equal(fire(row, 'pointerdown').defaultPrevented, true);
  row.click();
  assert.equal(p.$('#msg').value, '/verify ');
  assert.equal(p.doc.activeElement, p.$('#msg'));
  assert.equal(shown(p), null);
  assert.deepEqual(term.pasted, []); // filling in does not send
});

test('Escape and Send close the list', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/commands': COMMANDS } });
  await p.openWin('a');
  await type(p, '/');
  fire(p.$('#msg'), 'keydown', { key: 'Escape' });
  assert.equal(shown(p), null);
  await type(p, '/');
  p.$('#send').click();
  assert.equal(shown(p), null);
});

test('a failed load shows nothing and is tried again on the next keystroke', async () => {
  let fail = true;
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/commands': () => (fail ? p.api.reply(500, { error: 'x' }) : COMMANDS) } });
  await p.openWin('a');
  await type(p, '/');
  assert.equal(shown(p), null);
  fail = false;
  await type(p, '/p');
  assert.deepEqual(shown(p), ['/prime']);
  assert.equal(p.api.called('GET', '/api/sessions/a/commands').length, 2);
});

test('a list that arrives after the box or the window changed is not shown', async () => {
  const slow = deferred();
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/commands': () => slow.promise } });
  await p.openWin('a');
  await type(p, '/');
  await type(p, 'hello');
  slow.resolve(COMMANDS);
  await settle();
  assert.equal(shown(p), null);

});

test('a list that arrives after you left the window is not shown', async () => {
  const slow = deferred();
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/commands': () => slow.promise } });
  await p.openWin('a');
  await type(p, '/');
  await goBack(p);
  slow.resolve(COMMANDS);
  await settle();
  assert.equal(shown(p), null);
});

test('with no window open, a "/" shows nothing', async () => {
  const p = await phone([]);
  await type(p, '/');
  assert.equal(shown(p), null);
  assert.equal(p.api.called('GET', '/api/sessions/a/commands').length, 0);
});
