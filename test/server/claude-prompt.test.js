const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, promptScreen, RULE } = require('../helpers/claude');

const lines = (text) => text.split('\n');

test('permissionPrompt reads the question and the numbered answers from a real-shaped screen', () => {
  const { srv } = setup();
  const p = srv.permissionPrompt('x', lines(promptScreen()));
  assert.equal(p.text, 'Bash command\n npm test\n Run the tests\nDo you want to proceed?');
  assert.deepEqual(p.options, [
    { n: '1', label: 'Yes' },
    { n: '2', label: "Yes, and don't ask again for npm test commands in /x" },
    { n: '3', label: 'No, and tell Claude what to do differently (esc)' },
  ]);
});

test('permissionPrompt reads the window screen itself when it is not given one', () => {
  const c = setup();
  const s = c.open('a');
  c.screen(s, promptScreen());
  assert.equal(c.srv.permissionPrompt(s.id).options.length, 3);
  c.tmux.fail.add('capture-pane');
  assert.equal(c.srv.permissionPrompt(s.id), null);
});

test('permissionPrompt is null without an "Esc to cancel" line', () => {
  const { srv } = setup();
  assert.equal(srv.permissionPrompt('x', lines(promptScreen({ tail: false }))), null);
  assert.equal(srv.permissionPrompt('x', []), null);
});

test('permissionPrompt is null when no answer 1 sits within 40 lines above the footer', () => {
  const { srv } = setup();
  const noOne = ['Do you want to proceed?', '  2. Maybe', 'Esc to cancel'];
  assert.equal(srv.permissionPrompt('x', noOne), null);
  const far = [' ❯ 1. Yes', ...Array(40).fill('filler'), 'Esc to cancel'];
  assert.equal(srv.permissionPrompt('x', far), null);
  const near = [' ❯ 1. Yes', ...Array(38).fill('filler'), 'Esc to cancel'];
  assert.equal(srv.permissionPrompt('x', near).options.length, 1);
});

test('permissionPrompt joins a wrapped answer with a space', () => {
  const { srv } = setup();
  const screen = promptScreen({ options: ['Yes', 'Yes, and do not ask again for npm run build commands in this folder', 'No'] }).split('\n');
  const at = screen.findIndex((l) => l.includes('2. Yes, and'));
  screen.splice(at + 1, 0, '      or any subfolder of it');
  const p = srv.permissionPrompt('x', screen);
  assert.equal(p.options[1].label, 'Yes, and do not ask again for npm run build commands in this folder or any subfolder of it');
  assert.equal(p.options.length, 3);
});

test('permissionPrompt glues a long path that the terminal broke mid-word', () => {
  const { srv } = setup();
  const path1 = '/Users/chesterismay/repos/corral/public/';
  const screen = promptScreen({ options: ['Yes', `Allow edits in ${path1}`, 'No'] }).split('\n');
  const at = screen.findIndex((l) => l.includes('2. Allow'));
  screen.splice(at + 1, 0, 'index.html this session');
  const p = srv.permissionPrompt('x', screen);
  assert.equal(p.options[1].label, `Allow edits in ${path1}index.html this session`);
});

test('rejoin adds a space unless the line ended in a 30-character unbroken run', () => {
  const { srv } = setup();
  assert.equal(srv.rejoin('Yes, allow', 'this'), 'Yes, allow this');
  assert.equal(srv.rejoin('a'.repeat(29), 'b'), `${'a'.repeat(29)} b`);
  assert.equal(srv.rejoin('a'.repeat(30), 'b'), `${'a'.repeat(30)}b`);
});

test('permissionPrompt treats an out-of-order number as part of the answer above it', () => {
  const { srv } = setup();
  const p = srv.permissionPrompt('x', ['Ask?', ' ❯ 1. Yes', '  3. surprise', '  2. No', 'Esc to cancel']);
  assert.deepEqual(p.options, [{ n: '1', label: 'Yes 3. surprise' }, { n: '2', label: 'No' }]);
});

test('permissionPrompt skips blank lines between answers', () => {
  const { srv } = setup();
  const p = srv.permissionPrompt('x', ['Ask?', ' ❯ 1. Yes', '', '  2. No', '', 'Esc to cancel']);
  assert.deepEqual(p.options, [{ n: '1', label: 'Yes' }, { n: '2', label: 'No' }]);
});

test('permissionPrompt takes the last "Esc to cancel" and the last run of answers', () => {
  const { srv } = setup();
  const old = ['old?', ' ❯ 1. Old yes', '  2. Old no', 'Esc to cancel', ''];
  const p = srv.permissionPrompt('x', [...old, RULE, 'new?', ' ❯ 1. New yes', '  2. New no', 'Esc to cancel']);
  assert.equal(p.text, 'new?');
  assert.deepEqual(p.options.map((o) => o.label), ['New yes', 'New no']);
});

test('permissionPrompt reads up to the screen top when there is no rule above the prompt', () => {
  const { srv } = setup();
  const p = srv.permissionPrompt('x', ['', 'Edit file', '  src/a.js', 'Make this edit?', ' ❯ 1. Yes', 'Esc to cancel']);
  assert.equal(p.text, 'Edit file\n src/a.js\nMake this edit?');
});

test('permissionPrompt drops rules, dashed rules, and tips, and removes box borders', () => {
  const { srv } = setup();
  const dash = '╌'.repeat(30);
  const p = srv.permissionPrompt('x', [
    RULE, '│ Write file', dash, '│   a.txt', ' Tip: use shift+tab', dash, 'Create it?', ' ❯ 1. Yes', 'Esc to cancel',
  ]);
  assert.equal(p.text, 'Write file\n a.txt\nCreate it?');
});

test('permissionPrompt keeps only the last 30 lines of a long prompt', () => {
  const { srv } = setup();
  const body = Array.from({ length: 50 }, (_, i) => `row ${i}`);
  const p = srv.permissionPrompt('x', [...body, 'Go on?', ' ❯ 1. Yes', 'Esc to cancel']);
  const text = p.text.split('\n');
  assert.equal(text.length, 30);
  assert.equal(text[0], 'row 21');
  assert.equal(text[29], 'Go on?');
});

test('permissionPrompt shortens an answer longer than 160 characters', () => {
  const { srv } = setup();
  const p = srv.permissionPrompt('x', ['Ask?', ` ❯ 1. ${'word '.repeat(60)}`, 'Esc to cancel']);
  assert.equal(p.options[0].label.length, 160);
});

function asking(extra = {}) {
  const c = setup();
  const s = c.open('asker');
  const id = c.claude(s, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 900, ...extra });
  c.screen(s, promptScreen());
  const key = c.srv.promptKey({ sessionId: id, since: 900 });
  return { c, s, key };
}

test('answerPrompt types the chosen number into the window', () => {
  const { c, s, key } = asking();
  assert.deepEqual(c.srv.answerPrompt(s, '2', key), { status: 200, ok: true });
  assert.deepEqual(c.tmux.keys, [{ target: `wt-${s.id}`, keys: ['-l', '2'] }]);
});

test('answerPrompt deny presses Escape', () => {
  const { c, s, key } = asking();
  assert.deepEqual(c.srv.answerPrompt(s, 'deny', key), { status: 200, ok: true });
  assert.deepEqual(c.tmux.keys, [{ target: `wt-${s.id}`, keys: ['Escape'] }]);
});

test('answerPrompt refuses a number the prompt does not offer', () => {
  const { c, s, key } = asking();
  assert.deepEqual(c.srv.answerPrompt(s, '4', key), { status: 400, error: 'that is not one of the answers' });
  assert.deepEqual(c.srv.answerPrompt(s, 'yes', key), { status: 400, error: 'that is not one of the answers' });
  assert.deepEqual(c.tmux.keys, []);
});

test('answerPrompt refuses a stale or missing key', () => {
  const { c, s } = asking();
  const stale = { status: 409, error: 'Claude is asking something else now. Look again before answering.' };
  assert.deepEqual(c.srv.answerPrompt(s, '1', 'deadbeefdeadbeef'), stale);
  assert.deepEqual(c.srv.answerPrompt(s, '1', null), stale);
  assert.deepEqual(c.tmux.keys, []);
});

test('answerPrompt refuses when no prompt is open', () => {
  const c = setup();
  const s = c.open('a');
  const none = { status: 409, error: 'no permission prompt is open in this window' };
  assert.deepEqual(c.srv.answerPrompt(s, '1', 'k'), none);
  c.claude(s, { status: 'waiting', waitingFor: 'input' });
  assert.deepEqual(c.srv.answerPrompt(s, '1', 'k'), none);
  assert.deepEqual(c.tmux.keys, []);
});

test('answerPrompt refuses when the screen no longer shows the prompt', () => {
  const { c, s, key } = asking();
  c.screen(s, 'Claude is working...');
  assert.deepEqual(c.srv.answerPrompt(s, '1', key), { status: 409, error: 'could not read the prompt on the screen' });
  assert.deepEqual(c.tmux.keys, []);
});

test('windowHistory returns the scrollback with trailing blank lines collapsed to one newline', () => {
  const c = setup();
  const s = c.open('a');
  c.tmux.sessions.get(`wt-${s.id}`).history = 'first\nsecond\n\n\n\n';
  assert.equal(c.srv.windowHistory(s.id), 'first\nsecond\n');
  const call = c.tmux.calls.find((a) => a[0] === 'capture-pane' && a.includes('-S'));
  assert.deepEqual(call, ['capture-pane', '-p', '-J', '-S', '-3000', '-t', `wt-${s.id}`]);
});

test('windowHistory throws when tmux cannot read the window', () => {
  const c = setup();
  assert.throws(() => c.srv.windowHistory('missing'), /can't find session/);
});
