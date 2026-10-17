// Claude's questions (its AskUserQuestion dialog) on the phone: on the card, and in the bar under the
// terminal or the conversation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, overview, settle, unloadPage } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const SINGLE = {
  key: 'q1', text: 'Pick a fruit', review: false, multi: false,
  options: [
    { n: '1', label: 'Apple', detail: 'Crisp and round.' }, { n: '2', label: 'Pear', detail: 'Soft and grainy.' },
    { n: '3', label: 'Type something.', detail: '', free: true }, { n: '4', label: 'Chat about this', detail: '' },
  ],
};
const MULTI = {
  key: 'q2', text: 'Pick colors', review: false, multi: true,
  options: [
    { n: '1', label: 'Red', detail: 'Red', checked: false }, { n: '2', label: 'Green', detail: 'Green', checked: true },
    { n: '3', label: 'Type something', detail: '', checked: false, free: true }, { n: '4', label: 'Chat about this', detail: '' },
  ],
};
const REVIEW = {
  key: 'q3', text: 'Review your answers\n\n● Pick a fruit\n→ Apple\n\nReady to submit your answers?', review: true, multi: false,
  options: [{ n: '1', label: 'Submit answers', detail: '' }, { n: '2', label: 'Cancel', detail: '' }],
};
const asking = (question, o = {}) => win('a', { claude: claude('waiting', { waitingFor: 'input needed' }), question, ...o });
const labels = (root) => [...root.querySelectorAll('.answers > button')].map((b) => b.querySelector('.label')?.textContent ?? b.textContent);
const answered = (p) => p.api.called('POST', '/api/sessions/a/answer').map((c) => c.body);

test('a card with a question says so, and shows the question and its answers with their descriptions', async () => {
  const p = await phone([asking(SINGLE)]);
  assert.equal(p.card('a').querySelector('.pill').textContent, 'Has a question');
  const ask = p.card('a').querySelector('.ask');
  assert.equal(ask.querySelector('pre').textContent, 'Pick a fruit');
  assert.deepEqual(labels(ask), ['Apple', 'Pear', 'Type your own answer…', 'Chat about this', 'Cancel']);
  assert.equal(ask.querySelector('.answers > button').className, 'primary');
  assert.deepEqual([...ask.querySelectorAll('.detail')].map((d) => d.textContent), ['Crisp and round.', 'Soft and grainy.']);
  assert.equal(ask.querySelector('input'), null);
});

test('tapping an answer on a card sends it with the question key, says so, and refreshes', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const p = await phone([asking(SINGLE)], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  const pear = [...p.card('a').querySelectorAll('.answers > button')][1];
  pear.click();
  assert.ok([...p.card('a').querySelectorAll('.ask button')].every((b) => b.disabled));
  await settle();
  assert.deepEqual(answered(p), [{ question: true, choice: '2', key: 'q1' }]);
  assert.equal(p.toast(), 'Answered: Pear');
  assert.equal(p.$('#termview').hidden, true);
  const polls = p.api.called('GET', '/api/overview').length;
  mock.timers.tick(400);
  await settle();
  assert.equal(p.api.called('GET', '/api/overview').length, polls + 1);
});

test('Cancel sends deny; a refused answer shows the reason, or a general one; a lost Mac says so', async () => {
  const p = await phone([asking(SINGLE)], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  p.button('Cancel', p.card('a')).click();
  await settle();
  assert.equal(answered(p)[0].choice, 'deny');
  assert.equal(p.toast(), 'Cancelled the question.');
  p.api.routes['POST /api/sessions/a/answer'] = { __reply: true, status: 409, body: { error: 'Claude is asking something else now.' } };
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  p.button('Cancel', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Claude is asking something else now.');
  p.api.routes['POST /api/sessions/a/answer'] = { __reply: true, status: 500, body: 'oops', type: 'text/plain' };
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  p.button('Cancel', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Could not answer.');
  p.api.routes['POST /api/sessions/a/answer'] = () => { throw new Error('offline'); };
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  p.button('Cancel', p.card('a')).click();
  await settle();
  assert.equal(p.toast(), 'Could not reach the Mac.');
});

test('"Type your own answer" on a card opens the window, whose bar has a box for it', async () => {
  const p = await phone([asking(SINGLE)], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  p.button('Type your own answer…', p.card('a')).click();
  await settle();
  assert.equal(p.$('#termview').hidden, false);
  const input = p.$('#askbar .mine input');
  assert.equal(input.placeholder, 'Type your own answer');
  // Send with nothing typed does nothing; Enter sends what is typed; other keys only type.
  p.button('Send', p.$('#askbar')).click();
  input.value = 'kiwi';
  input.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'k' }));
  await settle();
  assert.deepEqual(answered(p), []);
  const enter = new p.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  await settle();
  assert.deepEqual(answered(p), [{ question: true, choice: '3', key: 'q1', text: 'kiwi' }]);
  assert.equal(p.toast(), 'Answered: kiwi');
});

test('the Send button sends the typed answer too', async () => {
  const p = await phone([asking(SINGLE)], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  await p.openWin('a');
  p.$('#askbar .mine input').value = ' a quick fox ';
  p.button('Send', p.$('#askbar')).click();
  await settle();
  assert.deepEqual(answered(p), [{ question: true, choice: '3', key: 'q1', text: ' a quick fox ' }]);
  assert.equal(p.toast(), 'Answered: a quick fox');
});

test('a multi-select question shows ticks, toggles without a notice, has Next, and leaves its own answer to the terminal', async () => {
  const p = await phone([asking(MULTI)], { routes: { 'POST /api/sessions/a/answer': { ok: true } } });
  const ask = p.card('a').querySelector('.ask');
  assert.deepEqual(labels(ask), ['☐ Red', '☑ Green', 'Chat about this', 'Next', 'Cancel']);
  const buttons = [...ask.querySelectorAll('.answers > button')];
  assert.deepEqual(buttons.slice(0, 2).map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(buttons[0].className, '');
  assert.equal(buttons[3].className, 'primary');
  assert.equal(ask.querySelector('.hint').textContent, 'To add an answer of your own here, type it in the terminal.');
  buttons[0].click();
  await settle();
  assert.equal(p.toast(), null);
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  p.button('Next', p.card('a')).click();
  await settle();
  assert.deepEqual(answered(p).map((b) => b.choice), ['1', 'next']);
  assert.equal(p.toast(), null);
});

test('the review screen asks you to check your answers, with Submit and its own Cancel only', async () => {
  const p = await phone([asking(REVIEW)]);
  assert.deepEqual(labels(p.card('a').querySelector('.ask')), ['Submit answers', 'Cancel']);
  await p.openWin('a');
  assert.equal(p.text('#askbar .head'), 'Check your answers, then submit:');
});

test('the bar under a window shows the question in Chat, and only the answers in Terminal', async () => {
  const p = await phone([asking(SINGLE)]);
  await p.openWin('a');
  assert.equal(p.$('#convo').hidden, false);
  assert.equal(p.$('#askbar').hidden, false);
  assert.equal(p.text('#askbar .head'), 'Claude has a question. Answer:');
  assert.equal(p.text('#askbar pre'), 'Pick a fruit');
  p.$('#viewbtn').click();
  assert.equal(p.$('#convo').hidden, true);
  assert.equal(p.$('#askbar pre'), null);
  assert.equal(p.text('#tsub'), 'Has a question · ~/repos/a');
  // The question goes away when Claude moves on.
  p.api.routes['GET /api/overview'] = overview(win('a', { claude: claude('busy') }));
  p.window.document.dispatchEvent(new p.window.Event('visibilitychange'));
  await settle();
  assert.equal(p.$('#askbar').hidden, true);
});
