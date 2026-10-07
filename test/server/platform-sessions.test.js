const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadServer, claudeSession } = require('../helpers/server');
const { UUID1, quiet } = require('../helpers/platform');

const jsonOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('cleanEnv drops the variables that tie a shell to another Claude Code, herdr, or tmux session', (t) => {
  const { srv } = loadServer();
  const leaky = ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'HERDR_PANE_ID', 'TMUX', 'TMUX_PANE'];
  for (const k of leaky) process.env[k] = '1';
  process.env.KEEP_ME = 'yes';
  t.after(() => { for (const k of [...leaky, 'KEEP_ME']) delete process.env[k]; });
  const env = srv.cleanEnv({ TERM: 'xterm-256color' });
  for (const k of leaky) assert.equal(k in env, false, k);
  assert.equal(env.KEEP_ME, 'yes');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(srv.cleanEnv().TERM, process.env.TERM);
});

test('tmux runs a subcommand on the corral socket and returns its output', (t) => {
  const { srv, tmux } = loadServer();
  tmux.add('wt-a');
  const cp = require('child_process');
  assert.equal(srv.tmux('list-sessions', '-F', '#{session_name}'), 'wt-a');
  const call = cp.execFileSync.mock.calls.at(-1);
  assert.deepEqual(call.arguments[1].slice(0, 2), ['-L', 'corral']);
  assert.equal(call.arguments[2].cwd, os.homedir());
  assert.equal('TMUX' in call.arguments[2].env, false);
});

test('scrubTmuxEnv removes each leaky variable from the tmux server, and stops at the first failure', (t) => {
  process.env.CLAUDECODE = '1';
  process.env.TMUX_PANE = '%1';
  t.after(() => { delete process.env.CLAUDECODE; delete process.env.TMUX_PANE; });
  const a = loadServer();
  process.env.CLAUDECODE = '1';
  process.env.TMUX_PANE = '%1';
  a.srv.scrubTmuxEnv();
  const names = a.tmux.env.map((e) => e.at(-1));
  assert.ok(names.includes('CLAUDECODE') && names.includes('TMUX_PANE'));
  assert.ok(a.tmux.env.every((e) => e[0] === '-gu'));

  const b = loadServer();
  process.env.CLAUDECODE = '1';
  process.env.TMUX_PANE = '%1';
  b.tmux.fail.add('set-environment');
  b.srv.scrubTmuxEnv();
  assert.deepEqual(b.tmux.env, []);
  assert.equal(b.tmux.calls.filter((c) => c[0] === 'set-environment').length, 1);

  const c = loadServer({ tmux: false });
  c.srv.scrubTmuxEnv();
  assert.deepEqual(c.tmux.calls, []);
});

test('shq quotes a string for sh, including single quotes inside it', () => {
  const { srv } = loadServer();
  assert.equal(srv.shq("it's"), `'it'\\''s'`);
  assert.equal(srv.shq(5), "'5'");
});

test('programFor picks a resume command first, then a fixed agent name, else nothing', () => {
  const { srv } = loadServer();
  assert.equal(srv.programFor('claude', UUID1), `claude --resume ${UUID1}`);
  assert.equal(srv.programFor('claude'), 'claude');
  assert.equal(srv.programFor('claude-continue'), 'claude --continue');
  assert.equal(srv.programFor('rm -rf /'), null);
  assert.equal(srv.programFor(null), null);
});

test('startCommand wraps the program in a login shell that stays open afterward', (t) => {
  const { srv } = loadServer();
  assert.deepEqual(srv.startCommand(null), { shell: '/bin/zsh', command: null });
  const c = srv.startCommand('claude');
  assert.equal(c.shell, '/bin/zsh');
  assert.equal(c.command, `/bin/zsh -lc 'claude; exec /bin/zsh -l'`);
  delete process.env.SHELL;
  t.after(() => { process.env.SHELL = '/bin/zsh'; });
  assert.equal(srv.startCommand(null).shell, '/bin/zsh');
});

test('attachPty attaches to tmux, runs a program in a login shell, or starts a plain login shell', () => {
  const { srv, ptys } = loadServer();
  const T = srv.constants.TMUX;
  srv.attachPty('abc', os.tmpdir(), true);
  assert.equal(ptys[0].file, T);
  assert.deepEqual(ptys[0].args, ['-L', 'corral', 'attach-session', '-t', 'wt-abc']);
  assert.equal(ptys[0].opts.env.CORRAL_SESSION, 'abc');
  assert.equal(ptys[0].opts.env.TERM, 'xterm-256color');
  assert.equal(ptys[0].opts.cwd, os.tmpdir());

  srv.attachPty('abc', os.tmpdir(), false, 'claude');
  assert.deepEqual([ptys[1].file, ptys[1].args], ['/bin/zsh', ['-lc', 'claude; exec /bin/zsh -l']]);

  srv.attachPty('abc', os.tmpdir(), false);
  assert.deepEqual([ptys[2].file, ptys[2].args], ['/bin/zsh', ['-l']]);

  delete process.env.SHELL;
  srv.attachPty('abc', os.tmpdir(), false);
  process.env.SHELL = '/bin/zsh';
  assert.equal(ptys[3].file, '/bin/zsh');
});

test('register streams output to open sockets, keeps a bounded scrollback, and marks the exit', (t) => {
  const { srv, ptys } = loadServer();
  const s = srv.register('r1', '/', null, 123, false, null);
  assert.equal(s.label, '/'); // no label and no base name: the path itself
  assert.equal(s.space, null);
  const open = { readyState: 1, sent: [], send(d) { this.sent.push(d); } };
  const closed = { readyState: 3, sent: [], send(d) { this.sent.push(d); } };
  s.clients.add(open); s.clients.add(closed);
  ptys[0].emitData('hello');
  assert.deepEqual(open.sent, ['hello']);
  assert.deepEqual(closed.sent, []);
  ptys[0].emitData('x'.repeat(300 * 1024));
  assert.equal(s.buf.length, 256 * 1024);
  assert.equal(s.buf.endsWith('x'), true);

  ptys[0].emitExit(3);
  assert.equal(s.exited, true);
  assert.match(s.buf, /\[process exited, code 3\]/);
  assert.match(open.sent.at(-1), /process exited, code 3/);
  assert.equal(closed.sent.length, 0);
  t.mock.timers.reset();

  const m = srv.register('r2', os.tmpdir(), 'named', 1, true, 'sp');
  assert.equal(m.label, 'named');
  assert.equal(m.space, 'sp');
  ptys[1].emitExit(0);
  assert.match(m.buf, /\[tmux session ended, code 0\]/);
  assert.equal(srv.sessions.get('r2'), m);
});

test('publicSession shows only the fields the page needs', () => {
  const { srv } = loadServer();
  const s = srv.register('p1', os.tmpdir(), 'lbl', 5, true, 'sp');
  s.remote = true;
  assert.deepEqual(srv.publicSession(s), { id: 'p1', cwd: os.tmpdir(), label: 'lbl', space: 'sp', exited: false, created: 5, persistent: true, remote: true });
  assert.equal(srv.publicSession(srv.register('p2', os.tmpdir(), 'x', 5, false)).remote, false);
});

test('createSession starts a tmux session that changes into the folder, labels it, and records the space', () => {
  const { srv, tmux, ptys } = loadServer();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'proj-'));
  const s = srv.createSession(dir, 'My label', 'sp1', 'claude');
  const t = tmux.sessions.get(`wt-${s.id}`);
  assert.equal(t.path, dir);
  assert.equal(t.options['@corral_label'], 'My label');
  assert.equal(t.options['@corral_space'], 'sp1');
  assert.deepEqual(t.command.slice(-3), ['/bin/sh', '-c', `/bin/zsh -lc 'claude; exec /bin/zsh -l'`]);
  assert.ok(t.command.includes('/bin/zsh') && t.command.includes('-fc'));
  assert.equal(tmux.calls.some((c) => c[0] === 'source-file' && c[1].endsWith('corral.tmux.conf')), true);
  assert.equal(s.tmux, true);
  assert.equal(s.cwd, dir);
  assert.equal(ptys.length, 1);
  assert.deepEqual(ptys[0].args.slice(0, 3), ['-L', 'corral', 'attach-session']);
});

test('createSession falls back to home for a missing or non-folder path, and names the window after the folder', () => {
  const { srv, tmux, home } = loadServer();
  const file = path.join(home, 'afile');
  fs.writeFileSync(file, '');
  const a = srv.createSession('/definitely/not/here');
  assert.equal(a.cwd, os.homedir());
  assert.equal(a.label, path.basename(os.homedir()));
  assert.equal(srv.createSession(file).cwd, os.homedir());
  assert.equal(srv.createSession(null).cwd, os.homedir());
  // No space and no label: no @corral_space is set, and a plain login shell runs.
  const t = tmux.sessions.get(`wt-${a.id}`);
  assert.equal('@corral_space' in t.options, false);
  assert.deepEqual(t.command.slice(-2), [process.env.SHELL, '-l']);
});

test('a window opened at the root folder is labeled with the path itself', () => {
  const { srv } = loadServer();
  const s = srv.createSession('/', null);
  assert.deepEqual([s.cwd, s.label], ['/', '/']);
});

test('createSession uses /bin/sh when zsh is missing', (t) => {
  const { srv, tmux } = loadServer();
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p) => (p === '/bin/zsh' ? false : exists(p)));
  const s = srv.createSession(os.tmpdir(), 'x');
  const cmd = tmux.sessions.get(`wt-${s.id}`).command;
  assert.deepEqual(cmd.slice(0, 2), ['/bin/sh', '-c']);
});

test('createSession without tmux starts a plain shell and records the label from the folder', () => {
  const { srv, tmux, ptys } = loadServer({ tmux: false });
  const s = srv.createSession(os.tmpdir(), null, null, 'claude-continue');
  assert.equal(s.tmux, false);
  assert.deepEqual(tmux.calls, []);
  assert.deepEqual(ptys[0].args, ['-lc', 'claude --continue; exec /bin/zsh -l']);
  assert.equal(srv.publicSession(s).persistent, false);
});

test('createSession passes a Claude resume id through and schedules a backup soon and again after 8 seconds', (t) => {
  const { srv, tmux } = loadServer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = srv.createSession(os.tmpdir(), 'r', null, null, UUID1);
  assert.equal(tmux.sessions.get(`wt-${s.id}`).command.at(-1), `/bin/zsh -lc 'claude --resume ${UUID1}; exec /bin/zsh -l'`);
  const backup = path.join(process.env.HOME, '.local/share/corral/open-sessions.json');
  assert.equal(fs.existsSync(backup), false);
  t.mock.timers.tick(1000);
  assert.equal(fs.existsSync(backup), true);
  fs.rmSync(backup);
  t.mock.timers.tick(7000); // the 8 second timer asks for another backup, which waits its own second
  t.mock.timers.tick(1000);
  assert.equal(fs.existsSync(backup), true);
});

test('adoptSessions reattaches only live corral windows, defaulting the folder to home', (t) => {
  const out = quiet(t);
  const { srv, tmux, ptys } = loadServer();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adopt-'));
  tmux.add('wt-one', { created: 1000, path: dir, options: { '@corral_label': 'One', '@corral_space': 'sp', '@corral_remote': '1' } });
  tmux.add('wt-two', { created: 2000, path: '/gone/away' });
  tmux.add('wt-three', { created: 3000, path: '' });
  tmux.add('personal', { path: dir }); // not a corral window
  tmux.add('wt-bad id', { path: dir }); // not a valid id
  tmux.add('', { path: dir }); // blank name
  srv.adoptSessions();
  assert.deepEqual([...srv.sessions.keys()].sort(), ['one', 'three', 'two']);
  const one = srv.sessions.get('one');
  assert.deepEqual([one.cwd, one.label, one.space, one.created, one.remote, one.tmux], [dir, 'One', 'sp', 1000000, true, true]);
  assert.equal(srv.sessions.get('two').cwd, os.homedir());
  assert.equal(srv.sessions.get('three').cwd, os.homedir());
  assert.equal(srv.sessions.get('two').remote, false);
  assert.equal(ptys.length, 3);
  assert.deepEqual(out.logs, ['adopted 3 tmux session(s)']);

  // Running it again adopts nothing new: the ids are already known.
  srv.adoptSessions();
  assert.equal(ptys.length, 3);
});

test('adoptSessions does nothing when tmux is missing, has no server, or a window cannot attach', (t) => {
  const out = quiet(t);
  const none = loadServer({ tmux: false });
  none.srv.adoptSessions();
  assert.equal(none.srv.sessions.size, 0);

  const idle = loadServer(); // fake tmux with no sessions says "no server running"
  idle.srv.adoptSessions();
  assert.equal(idle.srv.sessions.size, 0);

  let fail = false;
  const bad = loadServer({ ptyThrows: () => fail });
  bad.tmux.add('wt-x', { path: os.tmpdir() });
  fail = true;
  bad.srv.adoptSessions();
  assert.equal(bad.srv.sessions.size, 0);
  assert.deepEqual(out.logs, []);
});

test('saveBackup lists open windows, with the Claude conversation running in each', () => {
  const { srv, tmux, home, ptys } = loadServer();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bk-'));
  const a = srv.createSession(dir, 'Alpha', 'sp1');
  const b = srv.createSession(dir, "Beta's", null);
  const c = srv.createSession(dir, 'Gamma');
  b.created = a.created + 10;
  c.created = a.created + 20;
  tmux.sessions.get(`wt-${a.id}`).panePid = 700;
  claudeSession(home, 700, { sessionId: UUID1, cwd: `${dir}/it's` });
  ptys[2].emitExit(0); // Gamma has ended, so it is not listed
  tmux.fail.add('display-message'); // Beta's pane cannot be read: its own pty pid is used
  claudeSession(home, ptys[1].pid, { sessionId: '99999999-2222-3333-4444-555555555555', cwd: dir });
  srv.saveBackup();
  const saved = jsonOf(path.join(home, '.local/share/corral/open-sessions.json'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.windows.map((w) => w.label), ['Alpha', "Beta's"]);
  assert.deepEqual(saved.windows[0], { id: a.id, label: 'Alpha', cwd: dir, space: 'sp1' });
  assert.equal(saved.windows[1].claudeSession, '99999999-2222-3333-4444-555555555555');
  assert.equal(saved.windows[1].resumeCommand, `cd '${dir}' && claude --resume 99999999-2222-3333-4444-555555555555`);

  tmux.fail.delete('display-message');
  srv.saveBackup();
  const again = jsonOf(path.join(home, '.local/share/corral/open-sessions.json'));
  assert.equal(again.windows[0].claudeSession, UUID1);
  assert.equal(again.windows[0].claudeCwd, `${dir}/it's`);
  assert.equal(again.windows[0].resumeCommand, `cd '${dir}/it'\\''s' && claude --resume ${UUID1}`);
});

test('saveBackup reports a write failure instead of throwing', (t) => {
  const out = quiet(t);
  const { srv } = loadServer();
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk full'); });
  srv.saveBackup();
  assert.deepEqual(out.errors, ['backup save failed: disk full']);
});

test('saveBackupSoon writes once, a second after the last request', (t) => {
  const { srv, home } = loadServer();
  const backup = path.join(home, '.local/share/corral/open-sessions.json');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  srv.saveBackupSoon();
  t.mock.timers.tick(600);
  srv.saveBackupSoon(); // restarts the wait
  t.mock.timers.tick(600);
  assert.equal(fs.existsSync(backup), false);
  t.mock.timers.tick(400);
  assert.equal(fs.existsSync(backup), true);
});

test('a window whose process exits triggers a backup soon', (t) => {
  const { srv, ptys, home } = loadServer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  srv.createSession(os.tmpdir(), 'x');
  t.mock.timers.tick(1000);
  const backup = path.join(home, '.local/share/corral/open-sessions.json');
  assert.equal(jsonOf(backup).windows.length, 1);
  ptys[0].emitExit(0);
  t.mock.timers.tick(1000);
  assert.equal(jsonOf(backup).windows.length, 0);
});
