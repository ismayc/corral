// An opening prompt for Claude Code: on the command line of a new window, or typed into the Claude Code
// already running in the space's window. mail-triager's Mail Quick Action uses this to hand a window the
// brief it just staged.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { setup } = require('../helpers/claude');
const { listen, loadServer } = require('../helpers/server');

async function withServer(opts, fn) {
  const c = setup(opts);
  const h = await listen(c.srv);
  try { await fn(c, h.request); } finally { await h.close(); }
}

test('programFor, startCommand, and attachPty put an opening prompt on Claude Code\'s command line, quoted', () => {
  const { srv, ptys } = loadServer();
  assert.equal(srv.programFor('claude', null, "Read .mail-task.md, it's the brief"), `claude 'Read .mail-task.md, it'\\''s the brief'`);
  assert.equal(srv.programFor('claude-continue', null, 'go on'), `claude --continue 'go on'`);
  assert.equal(srv.programFor('claude', '00000000-aaaa-4bbb-8ccc-dddddddddddd', 'again'), `claude --resume 00000000-aaaa-4bbb-8ccc-dddddddddddd 'again'`);
  assert.equal(srv.programFor(null, null, 'go'), null); // a plain shell takes no prompt
  assert.equal(srv.programFor('claude', null, null), 'claude');
  assert.equal(srv.startCommand('claude', null, 'go').command, `/bin/zsh -lc 'claude '\\''go'\\''; exec /bin/zsh -l'`);
  srv.attachPty('abc', os.tmpdir(), false, 'claude', null, 'go');
  assert.deepEqual([ptys[0].file, ptys[0].args], ['/bin/zsh', ['-lc', `claude 'go'; exec /bin/zsh -l`]]);
});

test('POST /api/sessions with a prompt starts Claude Code with it, cleaned to one line of at most 4000 characters', () => withServer({}, async (c, req) => {
  const command = (r) => c.tmux.sessions.get(`wt-${r.json.id}`).command.at(-1);
  const expected = (prompt) => c.srv.startCommand('claude', null, prompt).command;
  const start = (space, prompt) => req('POST', '/api/sessions', { body: { cwd: c.home, space, agent: 'claude', prompt } });
  const r = await start('sp-1', '  Read\n\t.mail-task.md\x07 first  ');
  assert.equal(r.status, 201);
  assert.equal(command(r), expected('Read .mail-task.md first'));
  assert.match(command(r), /'\\''Read \.mail-task\.md first'\\''; exec/);
  // Blank, missing, and non-string prompts are no prompt; a long one is cut.
  assert.equal(command(await start('sp-2', ' \n ')), expected(null));
  assert.equal(command(await start('sp-3', 7)), expected(null));
  assert.equal(command(await start('sp-4')), expected(null));
  assert.equal(command(await start('sp-5', 'x'.repeat(5000))), expected('x'.repeat(4000)));
}));

test('POST /api/sessions with a prompt for a space that has a window types it into that window\'s Claude Code', () => withServer({}, async (c, req) => {
  const s = c.srv.createSession(c.home, 'proj', 'sp-1');
  const body = { cwd: c.home, space: 'sp-1', agent: 'claude', prompt: 'Read .mail-task.md' };
  // No Claude Code there: refused, since a shell would run the text as a command.
  let r = await req('POST', '/api/sessions', { body });
  assert.deepEqual([r.status, r.json.error, r.json.existing.id], [409, 'no Claude Code is running in that window', s.id]);
  // Claude is asking something: typed text would answer that instead.
  c.claude(s, { status: 'waiting', waitingFor: 'permission prompt' });
  r = await req('POST', '/api/sessions', { body });
  assert.deepEqual([r.status, r.json.error], [409, 'Claude is waiting on a permission prompt in that window; answer it first']);
  assert.deepEqual(c.tmux.keys, []);
  // Claude is free: the prompt goes in, then Enter.
  c.claude(s, { status: 'idle' });
  r = await req('POST', '/api/sessions', { body });
  assert.deepEqual([r.status, r.json.typed, r.json.existing.id], [200, true, s.id]);
  assert.deepEqual(c.tmux.keys.map((k) => [k.target, ...k.keys]), [[`wt-${s.id}`, '-l', 'Read .mail-task.md'], [`wt-${s.id}`, 'Enter']]);
  // Without a prompt, a second window for the space is still the plain 409.
  r = await req('POST', '/api/sessions', { body: { cwd: c.home, space: 'sp-1' } });
  assert.deepEqual([r.status, r.json.error], [409, 'this space already has a window']);
}));

test('POST /api/sessions with a prompt is 409 when the space\'s window has no tmux session', () => withServer({ tmux: false }, async (c, req) => {
  const s = c.srv.createSession(c.home, 'proj', 'sp-1');
  const r = await req('POST', '/api/sessions', { body: { cwd: c.home, space: 'sp-1', prompt: 'hi' } });
  assert.deepEqual([r.status, r.json.error, r.json.existing.id], [409, 'this window has no tmux session', s.id]);
}));

test('a window handed a prompt is marked summoned, new or typed into, and a refused or plain request is not', () => withServer({}, async (c, req) => {
  const before = Date.now();
  let r = await req('POST', '/api/sessions', { body: { cwd: c.home, space: 'sp-1', agent: 'claude', prompt: 'go' } });
  assert.ok(r.json.summoned >= before);
  assert.equal((await req('POST', '/api/sessions', { body: { cwd: c.home, space: 'sp-2' } })).json.summoned, 0);
  const s = c.srv.createSession(c.home, 'proj', 'sp-3');
  const body = { cwd: c.home, space: 'sp-3', prompt: 'go' };
  r = await req('POST', '/api/sessions', { body });
  assert.deepEqual([r.status, r.json.existing.summoned], [409, 0]);
  c.claude(s, { status: 'idle' });
  r = await req('POST', '/api/sessions', { body });
  assert.equal(r.status, 200);
  assert.ok(r.json.existing.summoned >= before);
}));
