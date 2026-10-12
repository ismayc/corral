// Claude Code's folder trust dialog in the phone terminal: the bar's "Yes, I trust this folder" button moves
// ❯ to Yes with ↓ (which wraps, so only after checking the screen) and confirms with Enter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage, goBack } = require('../helpers/m');

test.beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const dialog = (onYes) => [
  ' Accessing workspace:', ' Quick safety check: Is this a project you created or one you trust?',
  onYes ? '   No, exit' : ' ❯ No, exit', onYes ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder',
  '', ' Enter to confirm · Esc to cancel',
];
const step = async (ms) => { mock.timers.tick(ms); await settle(); };
const YES = 'Yes, I trust this folder';

// Opens a shell window, shows `screen`, and lets the page look at it.
async function open(screen, w = win('a')) {
  const p = await phone([w]);
  const { ws, term } = await p.openWin('a');
  term.screen = screen;
  ws.message('x');
  await step(200);
  return { p, ws, term };
}

test('the trust dialog shows a Yes button that moves down to Yes, then confirms', async () => {
  const { p, ws, term } = await open(dialog(false));
  assert.equal(p.$('#askbar').hidden, false);
  assert.equal(p.text('#askbar .head'), 'Claude Code asks whether to trust this folder.');
  assert.deepEqual(p.$$('#askbar button').map((b) => b.textContent), [YES]);
  p.button(YES).click();
  await settle();
  assert.deepEqual(p.typed(ws), ['\x1b[B']);
  assert.equal(p.button(YES).disabled, true);
  term.screen = dialog(true);
  await step(100);
  assert.deepEqual(p.typed(ws), ['\x1b[B', '\r']);
  // Claude Code starts; the bar goes once the screen shows something else.
  term.screen = ['❯ Try "how does <filepath> work?"'];
  ws.message('y');
  await step(200);
  assert.equal(p.$('#askbar').hidden, true);
});

test('with ❯ already on Yes, the button only confirms', async () => {
  const { p, ws } = await open(dialog(true));
  p.button(YES).click();
  await settle();
  assert.deepEqual(p.typed(ws), ['\r']);
});

test('output is looked at once per 200 ms, and only the dialog drawn last counts', async () => {
  const p = await phone([win('a')]);
  const { ws, term } = await p.openWin('a');
  ws.message('x');
  await step(200);
  assert.equal(p.$('#askbar').hidden, true); // nothing on the screen yet
  term.screen = dialog(false);
  ws.message('a');
  await step(100);
  ws.message('b');
  assert.equal(p.$('#askbar').hidden, true);
  await step(100);
  assert.equal(p.$('#askbar').hidden, false);
  // After "No, exit" the shell prompt follows the leftover dialog, so it is no longer open.
  term.screen = [...dialog(false), 'chester@mac tempe-election-prep %'];
  ws.message('c');
  await step(200);
  assert.equal(p.$('#askbar').hidden, true);
  // Another menu that ends the same way is not the trust dialog.
  term.screen = [' ❯ 1. Yes', '   2. No', ' Enter to confirm · Esc to cancel'];
  ws.message('d');
  await step(200);
  assert.equal(p.$('#askbar').hidden, true);
});

test('when ❯ never reaches Yes, nothing is confirmed and the button comes back', async () => {
  const { p, ws } = await open(dialog(false));
  p.button(YES).click();
  for (let i = 0; i < 15; i++) await step(100);
  assert.deepEqual(p.typed(ws), ['\x1b[B']);
  assert.equal(p.toast(), 'Could not move to Yes. Use ↓, then ⏎.');
  assert.equal(p.button(YES).disabled, false);
});

test('leaving the window stops the answer', async () => {
  const { p, ws, term } = await open(dialog(false));
  p.button(YES).click();
  await settle();
  await goBack(p, () => mock.timers.tick(1));
  term.screen = dialog(true);
  for (let i = 0; i < 15; i++) await step(100);
  assert.deepEqual(p.typed(ws), ['\x1b[B']);
});

test('a look at the screen due after leaving the window does nothing', async () => {
  const p = await phone([win('a')]);
  const { ws, term } = await p.openWin('a');
  term.screen = dialog(false);
  ws.message('x');
  await goBack(p, () => mock.timers.tick(1));
  await step(200);
  assert.equal(p.$('#askbar').hidden, true);
});

test('a permission prompt keeps the bar for itself', async () => {
  const PROMPT = { key: 'k', text: 'Edit file', options: [{ n: '1', label: 'Yes' }] };
  const { p } = await open(dialog(false), win('a', { claude: claude('waiting', { waitingFor: 'permission prompt' }), prompt: PROMPT }));
  assert.equal(p.text('#askbar .head'), 'Claude is asking for permission. Answer:');
});
