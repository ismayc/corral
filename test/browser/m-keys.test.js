// The row of keys a phone keyboard lacks: Esc, Shift-Tab, arrows, Ctrl, Type, and Use suggestion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, settle, win, unloadPage, fire } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const key = (p, label) => p.$$('#keys button').find((b) => b.textContent === label);

test('the key row lists every key, with spoken names where the label is a symbol', async () => {
  const p = await phone([]);
  assert.deepEqual(p.$$('#keys button').map((b) => b.textContent), ['Use suggestion', 'Type', 'Esc', '⇧Tab', 'Tab', 'Ctrl', '^C',
    '↑', '↓', '←', '→', '⏎', '1', '2', '3', 'y', 'n', '/', 'PgUp', 'PgDn', 'A−', 'A+']);
  assert.equal(key(p, '⏎').getAttribute('aria-label'), 'Enter');
  assert.equal(key(p, '⇧Tab').getAttribute('aria-label'), 'Shift Tab');
  assert.equal(key(p, 'Type').getAttribute('aria-label'), 'Type straight into the terminal');
  assert.equal(key(p, 'Esc').getAttribute('aria-label'), null);
  assert.equal(key(p, 'Ctrl').dataset.k, 'ctrl');
  assert.equal(key(p, 'Esc').dataset.k, undefined);
});

test('a key keeps the focus where it is', async () => {
  const p = await phone([]);
  assert.equal(fire(key(p, 'Esc'), 'pointerdown').defaultPrevented, true);
});

test('each sending key sends its characters to the window', async () => {
  const p = await phone([win('a')]);
  const { ws } = await p.openWin('a');
  for (const label of ['Esc', '⇧Tab', 'Tab', '^C', '↑', '↓', '←', '→', '⏎', '1', '2', '3', 'y', 'n', '/', 'PgUp', 'PgDn']) key(p, label).click();
  assert.deepEqual(p.typed(ws), ['\x1b', '\x1b[Z', '\t', '\x03', '\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C', '\r', '1', '2', '3', 'y', 'n', '/', '\x1b[5~', '\x1b[6~']);
});

test('Ctrl lights up and turns the next typed letter into its control character', async () => {
  const p = await phone([win('a')]);
  const { ws, term } = await p.openWin('a');
  key(p, 'Ctrl').click();
  assert.ok(key(p, 'Ctrl').classList.contains('on'));
  term.type('c');
  assert.deepEqual(p.typed(ws), ['\x03']);
  assert.ok(!key(p, 'Ctrl').classList.contains('on'));
  // A paste of several characters is not changed, and Ctrl stays armed for the next key.
  key(p, 'Ctrl').click();
  term.type('abc');
  assert.ok(key(p, 'Ctrl').classList.contains('on'));
  key(p, 'Ctrl').click();
  assert.ok(!key(p, 'Ctrl').classList.contains('on'));
  term.type('d');
  assert.deepEqual(p.typed(ws), ['\x03', 'abc', 'd']);
});

test('Ctrl is turned off when the terminal closes', async () => {
  const p = await phone([win('a'), win('b')]);
  await p.openWin('a');
  key(p, 'Ctrl').click();
  p.sw.emit('message', { open: 'b' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(!key(p, 'Ctrl').classList.contains('on'));
});

test('Use suggestion sends Tab, then Enter a moment later', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a')]);
  const { ws } = await p.openWin('a');
  key(p, 'Use suggestion').click();
  assert.deepEqual(p.typed(ws), ['\t']);
  mock.timers.tick(150);
  assert.deepEqual(p.typed(ws), ['\t', '\r']);
});

test('Type opens the keyboard on the terminal itself, and a second tap closes it', async () => {
  const p = await phone([win('a')]);
  const { term } = await p.openWin('a');
  const ta = term.textarea;
  key(p, 'Type').click();
  assert.equal(ta.getAttribute('inputmode'), 'text');
  assert.equal(p.doc.activeElement, ta);
  assert.ok(key(p, 'Type').classList.contains('on'));
  key(p, 'Type').click();
  assert.equal(ta.getAttribute('inputmode'), 'none');
  assert.notEqual(p.doc.activeElement, ta);
  assert.ok(!key(p, 'Type').classList.contains('on'));
  // Text mode with the focus elsewhere counts as not typing, so a tap brings the keyboard back.
  ta.setAttribute('inputmode', 'text');
  key(p, 'Type').click();
  assert.equal(p.doc.activeElement, ta);
  assert.ok(key(p, 'Type').classList.contains('on'));
});

test('keys do nothing with no terminal open', async () => {
  const p = await phone([]);
  key(p, 'Type').click();
  key(p, 'Esc').click();
  assert.ok(!key(p, 'Type').classList.contains('on'));
  assert.equal(p.sockets.length, 0);
});
