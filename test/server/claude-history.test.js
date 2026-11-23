// Past conversations (lib/history.js) and their routes: the list, the export, and resume.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const history = require('../../lib/history');
const { setup } = require('../helpers/claude');
const { listen } = require('../helpers/server');

const ID1 = '11111111-2222-4333-8444-555555555555';
const ID2 = '66666666-7777-4888-9999-000000000000';
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, timestamp: '2026-11-20T17:00:00.000Z', ...extra });
const said = (t) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] }, timestamp: '2026-11-20T17:01:00.000Z' });
const typed = (c) => (typeof c === 'string' ? c : '');
const write = (dir, id, lines) => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corral-hist-'));

test('encode turns every character but letters and digits into a dash', () => {
  assert.equal(history.encode('/Users/me/repos/my_app.v2'), '-Users-me-repos-my-app-v2');
});

test('projectDirs finds the plain folder and one with a hash suffix, and nothing else', () => {
  const projects = tmp();
  for (const d of ['-a-b', '-a-b.0123456789abcdef', '-a-bc', '-a-b.xyz']) fs.mkdirSync(path.join(projects, d));
  assert.deepEqual(history.projectDirs(projects, '/a/b').map((d) => path.basename(d)).sort(), ['-a-b', '-a-b.0123456789abcdef']);
  assert.deepEqual(history.projectDirs('/no/such/folder', '/a/b'), []);
});

test('readLines drops a cut line at the end of a head read and at the start of a tail read', () => {
  const f = path.join(tmp(), 'x.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  assert.deepEqual(history.readLines(f, 6, true), ['one']);
  assert.deepEqual(history.readLines(f, 8, false), ['three', '']);
  assert.deepEqual(history.readLines(f, 100, true), ['one', 'two', 'three', '']);
});

test('summary takes the newest ai-title, the first prompt you typed, and caches by size and time', () => {
  const dir = tmp();
  const f = write(dir, ID1, [
    'not json "user"',
    user('hidden', { isMeta: true }),
    user('', {}),
    user('/clear'),
    user('Fix the login bug'),
    said('ok'),
    { type: 'ai-title', aiTitle: 'Old title' },
    { type: 'ai-title', aiTitle: 'Login bug fix' },
  ]);
  const row = history.summary(f, typed);
  assert.equal(row.id, ID1);
  assert.equal(row.title, 'Login bug fix');
  assert.equal(row.first, 'Fix the login bug');
  assert.equal(row.started, '2026-11-20T17:00:00.000Z');
  assert.equal(row.size, fs.statSync(f).size);
  assert.equal(history.summary(f, () => { throw new Error('not read again'); }), row);
});

test('summary falls back to the first prompt, then to Untitled, and cuts long text', () => {
  const dir = tmp();
  const long = 'x'.repeat(500);
  assert.equal(history.summary(write(dir, ID1, [user(long)]), typed).title, `${'x'.repeat(160)}…`);
  assert.equal(history.summary(write(dir, ID1, [user(long)]), typed).first, `${'x'.repeat(400)}…`);
  // A prompt line without a timestamp leaves the start unknown.
  assert.equal(history.summary(write(tmp(), ID1, [{ type: 'user', message: { content: 'no time' } }]), typed).started, null);
  const none = history.summary(write(dir, ID2, [said('hi'), { type: 'ai-title' }]), typed);
  assert.deepEqual([none.title, none.first, none.started], ['Untitled conversation', null, null]);
});

test('list returns the folder\'s conversations newest first, skips other files, and says when there are more', () => {
  const projects = tmp();
  const a = write(path.join(projects, '-p'), ID1, [user('first one')]);
  const b = write(path.join(projects, '-p.0123456789abcdef'), ID2, [user('second one')]);
  fs.writeFileSync(path.join(projects, '-p', 'notes.jsonl'), '');
  fs.writeFileSync(path.join(projects, '-p', `${ID2}.txt`), '');
  fs.utimesSync(a, new Date(1000), new Date(1000));
  fs.utimesSync(b, new Date(2000), new Date(2000));
  const r = history.list(projects, '/p', typed);
  assert.deepEqual(r.conversations.map((c) => c.id), [ID2, ID1]);
  assert.equal(r.more, false);
  const one = history.list(projects, '/p', typed, 1);
  assert.deepEqual([one.conversations.length, one.more], [1, true]);
  // A file whose summary cannot be read is left out.
  const c = write(path.join(projects, '-p'), '22222222-2222-4333-8444-555555555555', [user('third one')]);
  fs.utimesSync(c, new Date(500), new Date(500));
  assert.deepEqual(history.list(projects, '/p', () => { throw new Error('bad'); }).conversations.map((x) => x.id), [ID2, ID1]);
});

test('list skips a file that disappears between the listing and the stat', () => {
  const projects = tmp();
  write(path.join(projects, '-q'), ID1, [user('hi')]);
  const real = fs.statSync;
  let calls = 0;
  fs.statSync = (f, ...a) => { if (String(f).endsWith(`${ID1}.jsonl`) && calls++ === 0) throw new Error('gone'); return real(f, ...a); };
  try { assert.deepEqual(history.list(projects, '/q', typed).conversations, []); } finally { fs.statSync = real; }
});

test('fileFor finds a conversation by id in the folder and refuses anything that is not an id', () => {
  const projects = tmp();
  const f = write(path.join(projects, '-p'), ID1, [user('hi')]);
  assert.equal(history.fileFor(projects, '/p', ID1), f);
  assert.equal(history.fileFor(projects, '/p', ID2), null);
  assert.equal(history.fileFor(projects, '/p', '../etc/passwd'), null);
  assert.equal(history.fileFor(projects, '/p', 7), null);
});

test('markdown and html write out each message with its time, escape HTML, and note a cut', () => {
  const meta = { title: 'A <b> test', id: ID1, dir: '/p', cut: false };
  const items = [{ who: 'you', text: 'hi <there>', at: '2026-11-20T17:00:00.000Z' }, { who: 'claude', text: 'hello', at: null }, { who: 'note', text: 'Earlier messages were summarized.', at: 'garbage' }];
  const md = history.markdown(meta, items);
  assert.match(md, /^# A <b> test\n/);
  assert.match(md, new RegExp(`## You \\(${history.when('2026-11-20T17:00:00.000Z')}\\)\\n\\nhi <there>`));
  assert.match(md, /## Claude\n\nhello/);
  assert.match(md, /## Note\n\nEarlier/);
  assert.match(history.markdown({ ...meta, cut: true }, []), /the most recent part only/);
  const page = history.html(meta, items);
  assert.match(page, /<title>A &lt;b&gt; test<\/title>/);
  assert.match(page, /hi &lt;there&gt;/);
  assert.doesNotMatch(page, /<script/);
  assert.match(history.html({ ...meta, cut: true }, []), /the most recent part only/);
  assert.equal(history.when('not a date'), '');
  assert.match(history.when('2026-11-20T17:00:00.000Z'), /^2026-11-2\d \d\d:\d\d$/);
});

test('fileName keeps letters, digits, and dashes, and has a fallback', () => {
  assert.equal(history.fileName('Fix: the "login" bug!', 'md'), 'fix-the-login-bug.md');
  assert.equal(history.fileName('***', 'html'), 'conversation.html');
});

// The routes, with a space whose folder is the test's home.
async function withServer(fn) {
  const c = setup();
  const root = path.join(c.home, 'repos', 'proj');
  fs.mkdirSync(root, { recursive: true });
  c.srv.state.rootCache = { at: Date.now(), map: new Map([['sp1', root]]) };
  const dir = path.join(c.home, '.claude', 'projects', history.encode(root));
  const h = await listen(c.srv);
  try { await fn({ c, req: h.request, root, dir }); } finally { await h.close(); }
}

test('GET /api/history lists a space\'s conversations and refuses an unknown space', () => withServer(async ({ c, req, dir }) => {
  write(dir, ID1, [user('Build the thing'), said('Done.')]);
  const r = await req('GET', '/api/history?space=sp1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.conversations.map((x) => x.title), ['Build the thing']);
  c.srv.state.rootCache = { at: Date.now(), map: new Map([['sp1', r.json.root]]) };
  // An unknown space: herdr is asked and does not know it either.
  assert.equal((await req('GET', '/api/history?space=nope')).status, 404);
}));

test('GET /api/history/export sends Markdown or HTML as a download, and refuses a bad format or id', () => withServer(async ({ req, dir }) => {
  write(dir, ID1, [user('Build the thing'), said('Done.'), { type: 'ai-title', aiTitle: 'Build it' }]);
  const md = await req('GET', `/api/history/export?space=sp1&id=${ID1}`);
  assert.equal(md.status, 200);
  assert.equal(md.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(md.headers['content-disposition'], 'attachment; filename="build-it.md"');
  assert.match(md.text, /## You[^\n]*\n\nBuild the thing\n\n## Claude[^\n]*\n\nDone\./);
  const page = await req('GET', `/api/history/export?space=sp1&id=${ID1}&format=html`);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.text, /<h1>Build it<\/h1>/);
  assert.equal((await req('GET', `/api/history/export?space=sp1&id=${ID1}&format=pdf`)).status, 400);
  assert.equal((await req('GET', `/api/history/export?space=sp1&id=${ID2}`)).status, 404);
  assert.equal((await req('GET', `/api/history/export?space=nope&id=${ID1}`)).status, 404);
}));

test('POST /api/history/resume opens a window that resumes the conversation, once per space', () => withServer(async ({ c, req, dir, root }) => {
  write(dir, ID1, [user('Build the thing')]);
  assert.equal((await req('POST', '/api/history/resume', { body: { id: ID1 } })).status, 400);
  assert.equal((await req('POST', '/api/history/resume', { body: { space: 'sp1', id: ID2 } })).status, 404);
  const r = await req('POST', '/api/history/resume', { body: { space: 'sp1', id: ID1 } });
  assert.equal(r.status, 201);
  assert.equal(r.json.space, 'sp1');
  assert.equal(r.json.cwd, root);
  const pane = c.tmux.sessions.get(`wt-${r.json.id}`);
  assert.match(JSON.stringify(pane), new RegExp(`claude --resume ${ID1}`));
  const again = await req('POST', '/api/history/resume', { body: { space: 'sp1', id: ID1 } });
  assert.equal(again.status, 409);
  assert.equal(again.json.existing.id, r.json.id);
}));
