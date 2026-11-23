// Prompts waiting their turn (lib/queue.js), the queue routes, and the watcher that types them in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const q = require('../../lib/queue');
const { setup } = require('../helpers/claude');
const { listen } = require('../helpers/server');

const RULE = '─'.repeat(40);
const box = (...inside) => ['earlier output', RULE, ...inside, RULE, '  status line'];
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corral-q-')), 'sub', 'queue.json');

test('inputDraft reads typed text, skips Claude Code\'s dim suggestion, and is null with no input box', () => {
  assert.equal(q.inputDraft(box('\x1b[38;5;246m❯\xa0\x1b[39m')), '');
  assert.equal(q.inputDraft(box('\x1b[39m❯\xa0\x1b[2mopen the page\x1b[0m')), '');
  assert.equal(q.inputDraft(box('\x1b[39m❯\xa0fix the \x1b[1mbug\x1b[22m now')), 'fix the bug now');
  assert.equal(q.inputDraft(box('❯ first line', '  second line')), 'first line second line');
  assert.equal(q.inputDraft(box('\x1b[2;33m❯ dim\x1b[m typed')), 'typed'); // an empty SGR resets
  assert.equal(q.inputDraft(box('\x1b[2m❯ \x1b[22mtyped')), 'typed');
  assert.equal(q.inputDraft(box('no prompt mark here')), null);
  assert.equal(q.inputDraft(['only', RULE, 'one rule']), null);
  assert.equal(q.inputDraft(null), null);
});

test('cleanText makes one line of at most 4000 characters, or null', () => {
  assert.equal(q.cleanText('  a\nb\t c  '), 'a b c');
  assert.equal(q.cleanText('x'.repeat(5000)).length, 4000);
  assert.equal(q.cleanText('\n\n'), null);
  assert.equal(q.cleanText(5), null);
});

test('a queue adds, lists, removes, clears, and keeps its prompts in a file across a restart', () => {
  const file = tmpFile();
  const a = q.createQueue(file);
  assert.deepEqual(a.list('w1'), []);
  assert.equal(a.count('w1'), 0);
  assert.equal(a.add('w1', '  ').status, 400);
  const one = a.add('w1', 'first');
  assert.equal(one.status, 200);
  a.add('w1', 'second');
  assert.deepEqual(a.list('w1').map((x) => x.text), ['first', 'second']);
  const b = q.createQueue(file);
  assert.deepEqual(b.list('w1').map((x) => x.text), ['first', 'second']);
  assert.equal(b.remove('w1', 'nope').status, 404);
  assert.equal(b.remove('w9', 'nope').status, 404);
  assert.deepEqual(b.remove('w1', one.item.id).items.map((x) => x.text), ['second']);
  assert.deepEqual(b.clear('w1'), { status: 200, items: [] });
  assert.deepEqual(b.clear('w9'), { status: 200, items: [] });
  assert.equal(b.count('w1'), 0);
});

test('a queue holds at most 50 prompts, starts empty from a bad file, and logs a failed save', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"windows": 5}');
  const a = q.createQueue(file);
  for (let i = 0; i < q.MAX_ITEMS; i++) a.add('w1', `p${i}`);
  assert.equal(a.add('w1', 'one more').status, 409);
  fs.writeFileSync(file, 'not json');
  assert.equal(q.createQueue(file).count('w1'), 0);
  const errors = mock.method(console, 'error', () => {});
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corral-q-')), 'file');
  fs.writeFileSync(blocked, '');
  const c = q.createQueue(path.join(blocked, 'queue.json')); // its folder is a file
  assert.equal(c.add('w1', 'x').status, 200);
  assert.match(errors.mock.calls[0].arguments[0], /queue save failed/);
  errors.mock.restore();
});

test('due waits for an idle Claude that has been quiet a while and has taken up the last prompt', () => {
  const a = q.createQueue(tmpFile());
  const now = 1_000_000;
  const idle = (since, extra = {}) => ({ status: 'idle', waitingFor: null, since, ...extra });
  assert.equal(a.due('w1', idle(0), now), null, 'nothing queued');
  a.add('w1', 'first');
  a.add('w1', 'second');
  assert.equal(a.due('w1', null, now), null, 'no Claude');
  assert.equal(a.due('w1', idle(0, { status: 'busy' }), now), null);
  assert.equal(a.due('w1', idle(0, { waitingFor: 'permission prompt' }), now), null);
  assert.equal(a.due('w1', idle(now - 1000), now), null, 'just finished');
  const item = a.due('w1', idle(now - q.QUIET_MS), now);
  assert.equal(item.text, 'first');
  a.sent('w1', item.id, now);
  assert.deepEqual(a.list('w1').map((x) => x.text), ['second']);
  assert.equal(a.due('w1', idle(now - q.QUIET_MS), now + q.QUIET_MS), null, 'Claude has not taken it up');
  assert.equal(a.due('w1', idle(now + 10), now + 10 + q.QUIET_MS).text, 'second');
  assert.equal(a.due('w1', { status: 'idle' }, now + 1e9), null, 'no status time counts as before the last prompt');
  a.sent('w9', 'x', now); // a window with no queue: nothing happens
});

test('prune forgets the queues of windows that are gone', () => {
  const file = tmpFile();
  const a = q.createQueue(file);
  a.add('w1', 'x');
  a.add('w2', 'y');
  a.prune(new Set(['w1', 'w2']));
  a.prune(new Set(['w1']));
  assert.equal(a.count('w2'), 0);
  assert.equal(q.createQueue(file).count('w1'), 1);
});

// ---- The server

const idleFor = (c, s, ms = 10000) => c.claude(s, { status: 'idle', statusUpdatedAt: Date.now() - ms });

test('the watcher types the next prompt into an idle window with an empty prompt box, and only one at a time', () => {
  const c = setup();
  mock.method(console, 'log', () => {});
  const s = c.open('chat');
  const id = idleFor(c, s);
  c.screen(s, box('\x1b[39m❯\xa0\x1b[2msuggestion\x1b[0m').join('\n'));
  c.srv.state.queue.add(s.id, 'run the tests');
  c.srv.state.queue.add(s.id, 'then commit');
  c.srv.watchWindows();
  assert.deepEqual(c.tmux.keys.map((k) => k.keys), [['-l', 'run the tests'], ['Enter']]);
  assert.deepEqual(c.srv.state.queue.list(s.id).map((x) => x.text), ['then commit']);
  c.srv.watchWindows();
  assert.equal(c.tmux.keys.length, 2, 'waits for Claude to take the first one up');
  assert.equal(c.srv.overview().find((w) => w.id === s.id).queued, 1);
  c.claude(s, { sessionId: id, status: 'idle', statusUpdatedAt: Date.now() + 1 - 0 });
  c.srv.watchWindows();
  assert.equal(c.tmux.keys.length, 2, 'just finished: still quiet time');
});

test('the watcher leaves a window alone while you are typing in it, and forgets the queue of a closed window', () => {
  const c = setup();
  mock.method(console, 'log', () => {});
  const s = c.open('chat');
  idleFor(c, s);
  c.screen(s, box('❯ half a thought').join('\n'));
  c.srv.state.queue.add(s.id, 'later');
  c.srv.watchWindows();
  assert.deepEqual(c.tmux.keys, []);
  c.screen(s, 'no input box drawn');
  c.srv.watchWindows();
  assert.deepEqual(c.tmux.keys, []);
  c.srv.sessions.delete(s.id);
  c.srv.watchWindows();
  assert.equal(c.srv.state.queue.count(s.id), 0);
});

test('the watcher skips a window without tmux, and one whose Claude is not there when it types', () => {
  const c = setup({ tmux: false });
  mock.method(console, 'log', () => {});
  const s = c.open('chat');
  idleFor(c, s);
  c.srv.state.queue.add(s.id, 'x');
  c.srv.watchWindows();
  assert.equal(c.srv.state.queue.count(s.id), 1);
  const d = setup();
  const t = d.open('chat');
  idleFor(d, t);
  d.screen(t, box('❯ ').join('\n'));
  d.srv.state.queue.add(t.id, 'x');
  d.srv.state.queue.due = () => ({ id: 'q', text: 'x' }); // due, but Claude is waiting on a dialog by now
  d.claude(t, { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: 1 });
  d.srv.runQueue([{ id: t.id, claude: { status: 'idle' } }]);
  assert.equal(d.srv.state.queue.count(t.id), 1);
});

test('the queue routes list, add, remove, and clear, and refuse bad requests', async () => {
  const c = setup();
  const s = c.open('chat');
  const h = await listen(c.srv);
  try {
    const url = `/api/sessions/${s.id}/queue`;
    assert.deepEqual((await h.request('GET', url)).json, { items: [] });
    const added = await h.request('POST', url, { body: { text: 'hello' } });
    assert.equal(added.status, 200);
    assert.equal(added.json.items[0].text, 'hello');
    assert.equal((await h.request('POST', url, { body: { text: '' } })).status, 400);
    assert.equal((await h.request('POST', url, { raw: 'nope' })).status, 400);
    assert.equal((await h.request('POST', url, { body: { remove: 'zzz' } })).status, 404);
    assert.deepEqual((await h.request('POST', url, { body: { remove: added.json.item.id } })).json.items, []);
    await h.request('POST', url, { body: { text: 'again' } });
    assert.deepEqual((await h.request('POST', url, { body: { clear: true } })).json, { items: [] });
  } finally { await h.close(); }
});
