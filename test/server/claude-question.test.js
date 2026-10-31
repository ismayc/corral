// Claude Code's question dialog (AskUserQuestion), read from the screen and answered with keys. The
// fixtures are screens captured from Claude Code 2.1.302 on October 17, 2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, RULE } = require('../helpers/claude');
const { listen } = require('../helpers/server');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', `question-${name}.txt`), 'utf8');
const lines = (name) => fixture(name).split('\n');

test('questionPrompt reads a single-select question, its answers, and their wrapped descriptions', () => {
  const { srv } = setup();
  const q = srv.questionPrompt('x', lines('single'));
  assert.equal(q.text, 'Pick a fruit');
  assert.equal(q.review, false);
  assert.equal(q.multi, false);
  assert.deepEqual(q.options.map((o) => [o.n, o.label]), [['1', 'Apple'], ['2', 'Pear'], ['3', 'Type something.'], ['4', 'Chat about this']]);
  assert.equal(q.options[0].detail, 'A crisp, round fruit with white flesh and thin skin. Apples keep well and are eaten fresh, '
    + 'baked, or pressed into juice. They come in many varieties, from tart green ones to sweet red ones.');
  assert.equal(q.options[2].free, true);
  assert.equal(q.options[3].detail, '');
  assert.equal('checked' in q.options[0], false);
});

test('questionPrompt reads the checkboxes of a multi-select question and leaves out its Submit line', () => {
  const { srv } = setup();
  const q = srv.questionPrompt('x', lines('multi'));
  assert.equal(q.text, 'Pick colors');
  assert.equal(q.multi, true);
  assert.deepEqual(q.options.map((o) => [o.label, o.checked, o.detail]),
    [['Red', false, 'Red'], ['Green', true, 'Green'], ['Blue', false, 'Blue'], ['Type something', false, ''], ['Chat about this', undefined, '']]);
  assert.equal(q.options[3].free, true);
});

test('questionPrompt reads the review screen, which has no footer, keeping its lines apart', () => {
  const { srv } = setup();
  const q = srv.questionPrompt('x', lines('review'));
  assert.equal(q.review, true);
  assert.equal(q.text, 'Review your answers\n\n● Pick a fruit\n→ Apple\n● Pick colors\n→ Green\n\nReady to submit your answers?');
  assert.deepEqual(q.options.map((o) => o.label), ['Submit answers', 'Cancel']);
});

test('questionPrompt joins a question the terminal wrapped, and drops the box border before it', () => {
  const { srv } = setup();
  const q = srv.questionPrompt('x', [RULE, ' ☐ Plan', '', '│ On a joint return, how should the plan treat', '│ it?', '', '❯ 1. One', '  2. Two',
    'Enter to select · ↑/↓ to navigate · Esc to cancel']);
  assert.equal(q.text, 'On a joint return, how should the plan treat it?');
  const top = srv.questionPrompt('x', ['Asked at the top?', '❯ 1. Yes', 'Enter to select · Esc to cancel']);
  assert.equal(top.text, 'Asked at the top?');
});

// A 39-column window (a phone) wraps the footer onto two or three lines. Before the fix the question
// came back null, so the phone showed its answers for a moment and then lost them (October 31, 2026).
test('questionPrompt reads a question whose footer a narrow window wrapped', () => {
  const { srv } = setup();
  const q = srv.questionPrompt('x', lines('narrow'));
  assert.equal(q.text, 'Which YouTube TV game should be the first live lookahead test? (The TV would run about 2 minutes behind live.)');
  assert.deepEqual(q.options.map((o) => o.label),
    ['Thunder at Rockets, today 17:30', '76ers at Hornets, today 15:00', 'Mavericks at Spurs, Nov 4 19:30', 'Type something.', 'Chat about this']);
  const three = srv.questionPrompt('x', ['Pick', '❯ 1. A', '  2. B', '', 'Enter to select · Tab/Arrow keys to',
    'navigate · ctrl+g to edit in VS Code ·', 'Esc to cancel']);
  assert.deepEqual(three.options.map((o) => o.label), ['A', 'B']);
  assert.equal(srv.questionPrompt('x', ['Pick', '❯ 1. A', 'Enter to select', '', 'Esc to cancel']), null);
});

test('questionPrompt is null with no dialog, no answer 1, or a review line under its answers', () => {
  const { srv } = setup();
  assert.equal(srv.questionPrompt('x', ['❯ ', 'Esc to cancel']), null);
  assert.equal(srv.questionPrompt('x', ['Pick', '  2. B', 'Enter to select · Esc to cancel']), null);
  assert.equal(srv.questionPrompt('x', ['❯ 1. Old', 'Ready to submit your answers?']), null);
  assert.equal(srv.questionPrompt('x', ['❯ 1. Submit answers']), null);
});

test('questionPrompt reads the window screen itself, and is null when it cannot', () => {
  const c = setup();
  const s = c.open('a');
  c.screen(s, fixture('single'));
  assert.equal(c.srv.questionPrompt(s.id).options.length, 4);
  c.tmux.fail.add('capture-pane');
  assert.equal(c.srv.questionPrompt(s.id), null);
});

test('questionKey changes with the question but not with how its words wrap', () => {
  const { srv } = setup();
  const claude = { sessionId: 'abc', since: 5 };
  const k = srv.questionKey(claude, { text: 'Pick a\nfruit' });
  assert.equal(k, srv.questionKey(claude, { text: 'Pick a fruit' }));
  assert.notEqual(k, srv.questionKey(claude, { text: 'Pick colors' }));
  assert.notEqual(k, srv.questionKey({ sessionId: 'abc', since: 6 }, { text: 'Pick a fruit' }));
});

function asking(screen = 'single') {
  const c = setup();
  const s = c.open('asker');
  const sessionId = c.claude(s, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 77 });
  c.screen(s, fixture(screen));
  const key = () => c.srv.questionKey({ sessionId, since: 77 }, c.srv.questionPrompt(s.id));
  return { c, s, key, target: `wt-${s.id}` };
}

test('answerQuestion types the chosen number, and Esc for Cancel', () => {
  const { c, s, key, target } = asking();
  assert.deepEqual(c.srv.answerQuestion(s, '2', key()), { status: 200, ok: true });
  assert.deepEqual(c.srv.answerQuestion(s, 'deny', key()), { status: 200, ok: true });
  assert.deepEqual(c.tmux.keys, [{ target, keys: ['-l', '2'] }, { target, keys: ['Escape'] }]);
});

test('answerQuestion types the number of "Type something", then the words on one line, then Enter', () => {
  const { c, s, key, target } = asking();
  assert.deepEqual(c.srv.answerQuestion(s, '3', key(), '  a quick\nfox '), { status: 200, ok: true });
  assert.deepEqual(c.tmux.keys, [{ target, keys: ['-l', '3'] }, { target, keys: ['-l', 'a quick fox'] }, { target, keys: ['Enter'] }]);
});

test('answerQuestion refuses "Type something" with no words', () => {
  const { c, s, key } = asking();
  for (const text of [undefined, '   ', 5]) assert.deepEqual(c.srv.answerQuestion(s, '3', key(), text), { status: 400, error: 'type your answer first' });
  assert.deepEqual(c.tmux.keys, []);
});

test('answerQuestion toggles and moves on from a multi-select question, but leaves its own answer to the terminal', () => {
  const { c, s, key, target } = asking('multi');
  assert.deepEqual(c.srv.answerQuestion(s, '1', key()), { status: 200, ok: true });
  assert.deepEqual(c.srv.answerQuestion(s, 'next', key()), { status: 200, ok: true });
  assert.deepEqual(c.srv.answerQuestion(s, '4', key(), 'teal'), { status: 400, error: 'type your own answer in the terminal' });
  assert.deepEqual(c.tmux.keys, [{ target, keys: ['-l', '1'] }, { target, keys: ['Right'] }]);
});

test('answerQuestion refuses Next on a single-select question and a number it does not offer', () => {
  const { c, s, key } = asking();
  for (const choice of ['next', '9']) assert.deepEqual(c.srv.answerQuestion(s, choice, key()), { status: 400, error: 'that is not one of the answers' });
  assert.deepEqual(c.tmux.keys, []);
});

test('answerQuestion refuses a key for another question, a closed dialog, and an unreadable screen', () => {
  const { c, s, key } = asking();
  const k = key();
  c.screen(s, fixture('multi'));
  assert.deepEqual(c.srv.answerQuestion(s, '1', k), { status: 409, error: 'Claude is asking something else now. Look again before answering.' });
  c.screen(s, 'Claude is working...');
  assert.deepEqual(c.srv.answerQuestion(s, '1', k), { status: 409, error: 'could not read the question on the screen' });
  c.claude(s, { status: 'busy' });
  assert.deepEqual(c.srv.answerQuestion(s, '1', k), { status: 409, error: 'no question is open in this window' });
  assert.deepEqual(c.tmux.keys, []);
});

test('overview gives a window with an open question the question and its key, and no permission prompt', () => {
  const { c, s, key } = asking();
  const row = c.srv.overview().find((r) => r.id === s.id);
  assert.equal(row.prompt, null);
  assert.equal(row.askKey, null);
  assert.equal(row.question.key, key());
  assert.equal(row.question.text, 'Pick a fruit');
  c.screen(s, 'nothing asked');
  assert.equal(c.srv.overview().find((r) => r.id === s.id).question, null);
});

// Real screens from October 31, 2026, in a 39x29 window: a long question lost its first answers off the
// top of the screen, and its footer wrapped between "Esc" and "to cancel".
test('questionPrompt reads a footer wrapped at any word, and is null when answer 1 is cut off', () => {
  const { srv } = setup();
  const q = srv.questionPrompt('x', ['Pick', '❯ 1. A', '  2. B', '', 'Enter to select · ↑/↓ to navigate · Esc', 'to cancel']);
  assert.deepEqual(q.options.map((o) => o.label), ['A', 'B']);
  assert.equal(srv.questionPrompt('x', lines('cut')), null);
});

// Color codes as Claude Code drew them on October 31, 2026: the selected label in 153, descriptions in 246.
test('questionPrompt with the styled screen keeps a wrapped label whole and drops link codes', () => {
  const { srv } = setup();
  const styled = lines('styled');
  const q = srv.questionPrompt('x', null, styled);
  assert.deepEqual(q.options.slice(0, 2).map((o) => [o.label, o.detail]), [
    ['Thunder at Rockets, today 17:30 (Recommended)', 'NBA TV, Saturday.'],
    ['76ers at Hornets, today 15:00 at the Spectrum Center', 'NBA TV, later. See nba.com for more.']]);
  assert.equal(q.options[2].free, true);
  // A plain screen (no color codes) reads as before: the wrapped part goes into the description.
  const plain = srv.questionPrompt('x', styled.map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x1b]*\x1b\\/g, '')));
  assert.equal(plain.options[0].detail, '(Recommended) NBA TV, Saturday.');
  // A number with its own color codes before the dot gives no label color; an uncolored next line then
  // still joins the label.
  const odd = srv.questionPrompt('x', null, ['Pick', '\x1b[1m1\x1b[22m. A', '  rest of A', '  \x1b[2mabout A\x1b[22m',
    'Enter to select · Esc to cancel']);
  assert.deepEqual([odd.options[0].label, odd.options[0].detail], ['A rest of A', 'about A']);
});

test('overview reads the question from the styled screen', async () => {
  const { c, s } = asking('single');
  c.tmux.sessions.get(`wt-${s.id}`).screen = fixture('styled');
  assert.equal(c.srv.overview().find((r) => r.id === s.id).question.options[0].label, 'Thunder at Rockets, today 17:30 (Recommended)');
  assert.ok(c.tmux.calls.some((a) => a.includes('capture-pane') && a.includes('-e')));
});

test('overview holds a small window at 100x50 while a question is open, then gives it back to its clients', () => {
  const { c, s, target } = asking('cut');
  const win = () => c.tmux.sessions.get(target);
  c.srv.overview();
  assert.deepEqual([win().width, win().height, win().options['window-size']], [100, 50, 'manual']);
  // Every poll while the question is open leaves the held size alone: a phone that types or resizes does not
  // win it back, so the answers stay put.
  const resizes = () => c.tmux.calls.filter((a) => a[0] === 'resize-window').length;
  c.srv.overview();
  assert.equal(resizes(), 1);
  c.claude(s, { status: 'idle', statusUpdatedAt: 78 });
  c.srv.overview();
  assert.equal('window-size' in win().options, false);
  assert.equal(s.grown, false);
});

test('overview grows only the short side, leaves a big window alone, and survives tmux failing', () => {
  const short = asking('single');
  short.c.tmux.sessions.get(short.target).width = 160;
  short.c.tmux.sessions.get(short.target).height = 9; // as the phone left tv-game-starter: one answer showed
  short.c.srv.overview();
  assert.deepEqual([short.c.tmux.sessions.get(short.target).width, short.c.tmux.sessions.get(short.target).height], [160, 50]);
  const big = asking('single');
  Object.assign(big.c.tmux.sessions.get(big.target), { width: 120, height: 60 });
  big.c.srv.overview();
  assert.equal(big.c.tmux.calls.some((a) => a[0] === 'resize-window'), false);
  const fails = asking('single');
  fails.c.tmux.fail.add('resize-window');
  fails.c.tmux.fail.add('set-option');
  fails.c.srv.overview();
  assert.equal(fails.s.grown, true);
  fails.c.claude(fails.s, { status: 'idle', statusUpdatedAt: 78 });
  fails.c.srv.overview();
  assert.equal(fails.s.grown, false);
});

test('GET /prompt returns the open question, and POST /answer with question: true answers it', async () => {
  const { c, s, key } = asking();
  const h = await listen(c.srv);
  try {
    const got = (await h.request('GET', `/api/sessions/${s.id}/prompt`)).json;
    assert.equal(got.prompt, null);
    assert.equal(got.question.key, key());
    const r = await h.request('POST', `/api/sessions/${s.id}/answer`, { body: { question: true, choice: '3', key: key(), text: 'kiwi' } });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.deepEqual(c.tmux.keys.map((k) => k.keys), [['-l', '3'], ['-l', 'kiwi'], ['Enter']]);
    // Without question: true the answer is for a permission prompt, and there is none.
    const p = await h.request('POST', `/api/sessions/${s.id}/answer`, { body: { choice: '1', key: key() } });
    assert.deepEqual([p.status, p.json], [409, { error: 'no permission prompt is open in this window' }]);
    assert.equal(c.tmux.keys.length, 3);
  } finally { await h.close(); }
});
