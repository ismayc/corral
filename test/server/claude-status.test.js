const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { setup, promptScreen, uuid } = require('../helpers/claude');
const { claudeSession } = require('../helpers/server');

const keysFor = (tmux, id) => tmux.keys.filter((k) => k.target === `wt-${id}`).map((k) => k.keys);

test('claudeUnder finds the session file of the root process itself', () => {
  const { srv, home } = setup();
  claudeSession(home, 100, { sessionId: uuid(1), cwd: '/work', status: 'busy', statusUpdatedAt: 1234 });
  assert.deepEqual(srv.claudeUnder(100, new Map()), { sessionId: uuid(1), cwd: '/work', status: 'busy', waitingFor: null, since: 1234 });
});

test('claudeUnder walks down the process tree, breadth first', () => {
  const { srv, home } = setup();
  claudeSession(home, 300, { sessionId: uuid(3), cwd: '/deep', status: 'idle' });
  claudeSession(home, 201, { sessionId: uuid(2), cwd: '/near', status: 'idle' });
  const children = new Map([[100, [200, 201]], [200, [300]]]);
  assert.equal(srv.claudeUnder(100, children).sessionId, uuid(2));
  assert.equal(srv.claudeUnder(200, children).sessionId, uuid(3));
  assert.equal(srv.claudeUnder(999, children), null);
});

test('claudeUnder reads waitingFor only while the status is waiting', () => {
  const { srv, home } = setup();
  claudeSession(home, 1, { sessionId: uuid(1), cwd: '/a', status: 'waiting', waitingFor: 'permission prompt' });
  claudeSession(home, 2, { sessionId: uuid(2), cwd: '/a', status: 'busy', waitingFor: 'permission prompt' });
  claudeSession(home, 3, { sessionId: uuid(3), cwd: '/a', status: 'waiting', waitingFor: 7 });
  assert.equal(srv.claudeUnder(1, new Map()).waitingFor, 'permission prompt');
  assert.equal(srv.claudeUnder(2, new Map()).waitingFor, null);
  assert.equal(srv.claudeUnder(3, new Map()).waitingFor, null);
});

test('claudeUnder tolerates a missing status or time, and ignores malformed session files', () => {
  const { srv, home } = setup();
  claudeSession(home, 1, { sessionId: uuid(1), cwd: '/a', status: 5, statusUpdatedAt: 'soon' });
  assert.deepEqual(srv.claudeUnder(1, new Map()), { sessionId: uuid(1), cwd: '/a', status: null, waitingFor: null, since: null });
  claudeSession(home, 2, { sessionId: 'not-a-uuid', cwd: '/a' });
  claudeSession(home, 3, { sessionId: uuid(3), cwd: 42 });
  claudeSession(home, 4, { sessionId: undefined, cwd: '/a' });
  for (const pid of [2, 3, 4]) assert.equal(srv.claudeUnder(pid, new Map()), null);
  fs.writeFileSync(path.join(home, '.claude/sessions/5.json'), '{broken');
  assert.equal(srv.claudeUnder(5, new Map()), null);
});

test('claudeUnder gives up after 200 processes', () => {
  const { srv, home } = setup();
  const children = new Map();
  for (let p = 1; p < 300; p++) children.set(p, [p + 1]);
  claudeSession(home, 250, { sessionId: uuid(9), cwd: '/far' });
  claudeSession(home, 150, { sessionId: uuid(8), cwd: '/near' });
  assert.equal(srv.claudeUnder(1, children).sessionId, uuid(8));
  fs.rmSync(path.join(home, '.claude/sessions/150.json'));
  assert.equal(srv.claudeUnder(1, children), null);
});

test('processChildren maps each parent to its child processes', () => {
  const { srv, ps } = setup();
  ps.out = '  10     1\n  11    10\n  12    10\n\n   0     0\n  13    11\n';
  const kids = srv.processChildren();
  assert.deepEqual([...kids], [[1, [10]], [10, [11, 12]], [11, [13]]]);
});

test('processChildren returns an empty map when ps fails', () => {
  const { srv } = setup({ exec: { ps: () => { throw new Error('ps broke'); } } });
  assert.equal(srv.processChildren().size, 0);
});

test('screenMode reads the permission mode from the line under the input box', () => {
  const { srv } = setup();
  const mode = (line) => srv.screenMode(['output', '', line, '']);
  assert.equal(mode('  ⏵⏵ auto mode on (shift+tab to cycle)'), 'auto');
  assert.equal(mode('⏵⏵ accept edits on'), 'accept edits');
  assert.equal(mode('⏸ plan mode on'), 'plan');
  assert.equal(mode('⏸ manual mode on'), 'manual');
  assert.equal(mode('nothing to see'), null);
  assert.equal(srv.screenMode([]), null);
});

test('screenMode looks only at the last eight non-empty lines', () => {
  const { srv } = setup();
  const filler = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  assert.equal(srv.screenMode(['⏸ plan mode on', '', ...filler]), null);
  assert.equal(srv.screenMode(['⏸ plan mode on', '', ...filler.slice(1)]), 'plan');
});

test('screenLines returns the pane trimmed per line, or null when tmux fails', () => {
  const { srv, tmux } = setup();
  const s = srv.createSession(process.env.HOME, 'a');
  tmux.sessions.get(`wt-${s.id}`).screen = 'one   \n  two  \n';
  assert.deepEqual(srv.screenLines(s.id), ['one', '  two', '']);
  tmux.fail.add('capture-pane');
  assert.equal(srv.screenLines(s.id), null);
});

test('promptKey is a stable 16-character key for one conversation and status time', () => {
  const { srv } = setup();
  const key = srv.promptKey({ sessionId: 'abc', since: 5 });
  assert.equal(key, crypto.createHash('sha256').update('abc:5').digest('hex').slice(0, 16));
  assert.equal(key, srv.promptKey({ sessionId: 'abc', since: 5 }));
  assert.notEqual(key, srv.promptKey({ sessionId: 'abc', since: 6 }));
  assert.notEqual(key, srv.promptKey({ sessionId: 'abd', since: 5 }));
});

test('withKey adds the prompt key, or stays null with no prompt', () => {
  const { srv } = setup();
  const claude = { sessionId: 'abc', since: 5 };
  assert.deepEqual(srv.withKey({ text: 't', options: [] }, claude), { text: 't', options: [], key: srv.promptKey(claude) });
  assert.equal(srv.withKey(null, claude), null);
});

test('windowClaude reads the Claude under the pane process of a tmux window', () => {
  const c = setup();
  const s = c.open('a');
  assert.equal(c.srv.windowClaude(s), null);
  const id = c.claude(s, { status: 'busy', cwd: '/proj' });
  assert.deepEqual(c.srv.windowClaude(s), { sessionId: id, cwd: '/proj', status: 'busy', waitingFor: null, since: 1791390000000 });
});

test('windowClaude finds a Claude that runs as a child of the pane shell', () => {
  const c = setup();
  const s = c.open('a');
  const pane = c.pidOf(s);
  c.ps.out = `${pane + 1000} ${pane}\n${pane + 2000} ${pane + 1000}\n`;
  const id = c.claude(s, { pid: pane + 2000 });
  assert.equal(c.srv.windowClaude(s).sessionId, id);
});

test('windowClaude falls back to the attach client when tmux cannot name the pane', () => {
  const c = setup();
  const s = c.open('a');
  c.tmux.fail.add('display-message');
  const id = c.claude(s, { pid: s.pty.pid });
  assert.equal(c.srv.windowClaude(s).sessionId, id);
});

test('windowClaude uses the shell process when the window has no tmux', () => {
  const c = setup({ tmux: false });
  const s = c.open('plain');
  assert.equal(s.tmux, false);
  const id = c.claude(s);
  assert.equal(c.srv.windowClaude(s).sessionId, id);
});

test('overview lists a window with no Claude as a shell with no ask key or prompt', () => {
  const c = setup();
  const s = c.open('shell');
  const [row] = c.srv.overview();
  assert.deepEqual(row, { id: s.id, cwd: c.home, label: 'shell', space: null, exited: false, created: s.created, persistent: true, remote: false, activity: 1791390100000, claude: null, askKey: null, prompt: null, muted: false });
});

test('overview reports the Claude status, mode, and since-time of a window', () => {
  const c = setup();
  const s = c.open('busy one');
  c.claude(s, { status: 'busy' });
  c.screen(s, 'output\n\n  ⏸ plan mode on\n');
  const [row] = c.srv.overview();
  assert.deepEqual(row.claude, { status: 'busy', waitingFor: null, since: 1791390000000, mode: 'plan' });
  assert.equal(row.askKey, null);
  assert.equal(row.prompt, null);
});

test('overview leaves the mode out when screens is false', () => {
  const c = setup();
  const s = c.open('a');
  c.claude(s, { status: 'idle' });
  c.screen(s, '⏸ plan mode on');
  assert.equal(c.srv.overview({ screens: false })[0].claude.mode, null);
  assert.equal(c.srv.overview({ screens: true })[0].claude.mode, 'plan');
  assert.equal(c.tmux.calls.filter((a) => a[0] === 'capture-pane').length, 1);
});

test('overview shows an open permission prompt with its answers and key', () => {
  const c = setup();
  const s = c.open('asker');
  const id = c.claude(s, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 777 });
  c.screen(s, promptScreen());
  const [row] = c.srv.overview();
  const key = c.srv.promptKey({ sessionId: id, since: 777 });
  assert.equal(row.askKey, key);
  assert.equal(row.claude.waitingFor, 'permission prompt');
  assert.equal(row.claude.mode, 'auto');
  assert.equal(row.prompt.key, key);
  assert.deepEqual(row.prompt.options.map((o) => o.n), ['1', '2', '3']);
  assert.match(row.prompt.text, /npm test/);
});

test('overview gives an ask key but no prompt when the screen has no prompt', () => {
  const c = setup();
  const s = c.open('asker');
  c.claude(s, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(s, 'nothing here');
  const [row] = c.srv.overview();
  assert.equal(typeof row.askKey, 'string');
  assert.equal(row.prompt, null);
});

test('overview gives no ask key when Claude waits for something else', () => {
  const c = setup();
  const s = c.open('a');
  c.claude(s, { status: 'waiting', waitingFor: 'input' });
  c.screen(s, promptScreen());
  const [row] = c.srv.overview();
  assert.equal(row.askKey, null);
  assert.equal(row.prompt, null);
});

test('overview marks muted windows', () => {
  const c = setup();
  const a = c.open('a');
  const b = c.open('b');
  c.srv.state.push.muted[b.id] = true;
  assert.deepEqual(c.srv.overview().map((r) => [r.id, r.muted]), [[a.id, false], [b.id, true]]);
});

test('overview sorts by creation time and skips Claude lookups for exited windows', () => {
  const c = setup();
  const a = c.open('a');
  const b = c.open('b');
  a.created = 2000;
  b.created = 1000;
  c.claude(a, { status: 'busy' });
  a.exited = true;
  const rows = c.srv.overview();
  assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);
  assert.equal(rows[1].exited, true);
  assert.equal(rows[1].claude, null);
});

test('overview works when the window has no tmux pane entry or tmux is missing', () => {
  const c = setup({ tmux: false });
  const s = c.open('plain');
  c.claude(s, { status: 'idle' });
  const [row] = c.srv.overview();
  assert.equal(row.activity, null);
  assert.equal(row.persistent, false);
  assert.equal(row.claude.status, 'idle');
  assert.equal(row.claude.mode, null);
});

test('overview survives a failing list-panes and ignores other tmux sessions and duplicates', () => {
  const c = setup();
  const s = c.open('a');
  c.claude(s, { status: 'idle', pid: s.pty.pid });
  c.tmux.fail.add('list-panes');
  const [row] = c.srv.overview();
  assert.equal(row.activity, null);
  assert.equal(row.claude.status, 'idle');

  c.tmux.fail.delete('list-panes');
  c.tmux.add('other', { panePid: 1 });
  const realRun = c.tmux.run.bind(c.tmux);
  c.tmux.run = (args) => {
    const out = realRun(args);
    return args.includes('list-panes') ? `${out}\nwt-${s.id}\t4242\t1791399999` : out;
  };
  const [again] = c.srv.overview();
  assert.equal(again.activity, 1791390100000);
});

test('sendCardKey refuses a key it does not know', () => {
  const c = setup();
  const s = c.open('a');
  assert.deepEqual(c.srv.sendCardKey(s, 'rm'), { status: 400, error: 'unknown key' });
  assert.deepEqual(c.srv.sendCardKey(s, undefined), { status: 400, error: 'unknown key' });
  assert.deepEqual(c.tmux.keys, []);
});

test('sendCardKey stop sends Escape only while Claude is busy', () => {
  const c = setup();
  const s = c.open('a');
  assert.deepEqual(c.srv.sendCardKey(s, 'stop'), { status: 409, error: 'Claude is not working in this window' });
  c.claude(s, { status: 'idle' });
  assert.equal(c.srv.sendCardKey(s, 'stop').status, 409);
  assert.deepEqual(c.tmux.keys, []);
  c.claude(s, { status: 'busy' });
  assert.deepEqual(c.srv.sendCardKey(s, 'stop'), { status: 200, ok: true });
  assert.deepEqual(keysFor(c.tmux, s.id), [['Escape']]);
});

test('sendCardKey mode sends Shift-Tab while Claude is busy or idle, not waiting', () => {
  const c = setup();
  const s = c.open('a');
  assert.deepEqual(c.srv.sendCardKey(s, 'mode'), { status: 409, error: 'Claude is not ready to change modes' });
  c.claude(s, { status: 'waiting', waitingFor: 'input' });
  assert.equal(c.srv.sendCardKey(s, 'mode').status, 409);
  c.claude(s, { status: 'idle' });
  assert.equal(c.srv.sendCardKey(s, 'mode').status, 200);
  c.claude(s, { status: 'busy' });
  assert.equal(c.srv.sendCardKey(s, 'mode').status, 200);
  assert.deepEqual(keysFor(c.tmux, s.id), [['BTab'], ['BTab']]);
});

test('renameWindow trims, collapses spaces, and sets the tmux label', () => {
  const c = setup();
  const s = c.open('old');
  assert.deepEqual(c.srv.renameWindow(s, '  New   name \n here '), { status: 200, ok: true, label: 'New name here' });
  assert.equal(s.label, 'New name here');
  assert.equal(c.tmux.sessions.get(`wt-${s.id}`).options['@corral_label'], 'New name here');
});

test('renameWindow refuses an empty, non-text, or over-long name', () => {
  const c = setup();
  const s = c.open('keep');
  const bad = { status: 400, error: 'a name of 1 to 60 characters' };
  for (const v of ['', '   ', undefined, null, 5, {}, 'x'.repeat(61)]) assert.deepEqual(c.srv.renameWindow(s, v), bad);
  assert.equal(s.label, 'keep');
  assert.equal(c.srv.renameWindow(s, 'x'.repeat(60)).status, 200);
});

test('renameWindow still renames when tmux fails, and skips tmux for plain windows', () => {
  const c = setup();
  const s = c.open('a');
  c.tmux.fail.add('set-option');
  assert.equal(c.srv.renameWindow(s, 'b').status, 200);
  assert.equal(s.label, 'b');

  const p = setup({ tmux: false });
  const plain = p.open('a');
  assert.equal(p.srv.renameWindow(plain, 'c').label, 'c');
  assert.deepEqual(p.tmux.calls, []);
});
