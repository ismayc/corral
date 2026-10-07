// Changes: the git status and diff of the window's project, and asking Claude to commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage, goBack, popstate } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111..2222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'Binary files differ',
].join('\n');

const CHANGES = {
  repo: 'corral', branch: 'main', cwd: '/Users/chester/repos/corral', diff: DIFF, truncated: true,
  files: [
    { code: ' M', path: 'src/app.js' }, { code: '??', path: 'new.txt' }, { code: 'A ', path: 'added.js' },
    { code: 'R ', path: 'old.js -> moved.js' }, { code: 'MM', path: 'both.js' }, { code: ' X', path: 'odd.js' },
  ],
};

// Opens Changes from the terminal's ⋯ menu.
function openChanges(p) {
  p.$('#morebtn').click();
  p.button('Changes not yet committed').click();
}

test('Changes lists each changed file with its kind, then the diff colored by line', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  await p.openWin('a');
  openChanges(p);
  assert.equal(p.$('#diffview').hidden, false);
  assert.equal(p.$('#termview').hidden, true);
  assert.equal(p.text('#dtitle'), 'a');
  assert.equal(p.text('#difflist .note'), 'Reading git…');
  await settle();
  assert.equal(p.text('#dsub'), 'corral · main · 6 files changed');
  assert.deepEqual(p.$$('#difflist .files button').map((b) => [b.querySelector('b').textContent, b.querySelector('span').textContent]), [
    ['M', 'src/app.js'], ['new', 'new.txt'], ['A', 'added.js'], ['R', 'moved.js'], ['M', 'both.js'], ['X', 'odd.js'],
  ]);
  assert.deepEqual(p.$$('#difflist > .d').map((d) => [d.className, d.textContent]), [
    ['d file', 'src/app.js'],
    ['d meta', 'index 1111..2222 100644'],
    ['d meta', '--- a/src/app.js'],
    ['d meta', '+++ b/src/app.js'],
    ['d hunk', '@@ -1,3 +1,3 @@'],
    ['d', ' const a = 1;'],
    ['d del', '-const b = 2;'],
    ['d add', '+const b = 3;'],
    ['d', ' '],
    ['d file', 'new.txt'],
    ['d meta', 'new file mode 100644'],
    ['d meta', 'Binary files differ'],
  ]);
  assert.equal(p.$('#difflist').lastElementChild.textContent, 'The diff is long, so the rest is cut off here.');
  // A shell gets no commit button.
  assert.equal(p.$('#difflist .commit'), null);
});

test('tapping a file scrolls to its part of the diff', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  const header = p.$$('#difflist .d.file')[1];
  p.$$('#difflist .files button')[1].click();
  assert.equal(header.scrolledIntoView, true);
  // A file with no diff lines, such as an added one, has nowhere to scroll.
  p.$$('#difflist .files button')[2].click();
  assert.equal(p.$$('#difflist .d.file')[0].scrolledIntoView, undefined);
});

test('a project with one changed file on no branch says 1 file', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': { repo: 'r', branch: null, files: [{ code: ' M', path: 'x' }], diff: '', truncated: false } } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  assert.equal(p.text('#dsub'), 'r · 1 file changed');
  assert.equal(p.$$('#difflist .note').length, 0);
});

test('a clean project says nothing has changed since the last commit', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': { repo: 'r', branch: 'main', files: [], diff: '' } } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  assert.equal(p.text('#dsub'), 'r · main · 0 files changed');
  assert.equal(p.text('#difflist'), 'Nothing has changed since the last commit.');
});

test('a folder outside git says so and shows the folder', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': { repo: null, cwd: '/Users/chester/scratch' } } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  assert.equal(p.text('#dsub'), '~/scratch');
  assert.equal(p.text('#difflist'), 'This folder is not in a git repository.');
});

test('changes that cannot be read say so', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': new Error('offline') } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  assert.equal(p.text('#difflist'), 'Could not read the changes.');
});

test('Refresh reads git again without adding a step to Back', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  const length = p.window.history.length;
  p.$('#diffreload').click();
  await settle();
  assert.equal(p.window.history.length, length);
  assert.equal(p.api.called('GET', '/api/sessions/a/changes').length, 2);
  await goBack(p);
  assert.equal(p.$('#diffview').hidden, true);
  assert.equal(p.$('#termview').hidden, false);
});

test('the back button in Changes returns to the terminal', async () => {
  const p = await phone([win('a')], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  const popped = popstate(p);
  p.$('#diffback').click();
  await popped;
  assert.equal(p.$('#termview').hidden, false);
});

test('in a Claude window, Ask Claude to commit types the request, presses Enter, and goes back', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  const { ws, term } = await p.openWin('a');
  openChanges(p);
  await settle();
  const commit = p.$('#difflist .commit');
  assert.equal(commit.textContent, 'Ask Claude to commit these');
  const popped = popstate(p, () => mock.timers.tick(1));
  commit.click();
  assert.deepEqual(term.pasted, ['Commit these changes.']);
  assert.equal(p.toast(), 'Asked a to commit.');
  await popped;
  mock.timers.tick(100);
  assert.deepEqual(p.typed(ws), ['\r']);
  assert.equal(p.$('#termview').hidden, false);
});

test('the commit button left in the hidden view does nothing once its window is closed', async () => {
  const p = await phone([win('a', { claude: claude('idle') })], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  const { term } = await p.openWin('a');
  openChanges(p);
  await settle();
  await goBack(p);
  await goBack(p);
  assert.equal(p.$('#home').hidden, false);
  p.$('#difflist .commit').click();
  assert.deepEqual(term.pasted, []);
  assert.equal(p.toast(), null);
});

test('a notification tapped while Changes is open shows that window\'s terminal', async () => {
  const p = await phone([win('a'), win('b')], { routes: { 'GET /api/sessions/a/changes': CHANGES } });
  await p.openWin('a');
  openChanges(p);
  await settle();
  assert.equal(p.$('#diffview').hidden, false);
  p.sw.emit('message', { open: 'b' });
  await settle();
  assert.equal(p.$('#diffview').hidden, true);
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'b');
});
