// scripts/claude-jobs.js: finding the LaunchAgents that run `claude -p`, their schedules and launchd status,
// their logs, and Run now. plutil and launchctl are replaced; HOME is a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { mock } = require('node:test');

const FILE = path.join(__dirname, '..', '..', 'scripts', 'claude-jobs.js');

// A home with LaunchAgents described as JSON (what plutil would print), and a fake launchctl.
function home(agents, state = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corral-jobs-'));
  fs.mkdirSync(path.join(dir, 'Library', 'LaunchAgents'), { recursive: true });
  for (const [name, plist] of Object.entries(agents)) fs.writeFileSync(path.join(dir, 'Library', 'LaunchAgents', name), typeof plist === 'string' ? plist : JSON.stringify(plist));
  const calls = [];
  mock.method(cp, 'execFileSync', (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'plutil') {
      const text = fs.readFileSync(args.at(-1), 'utf8');
      JSON.parse(text); // a broken plist makes plutil fail
      return text;
    }
    const label = args[1].split('/').pop();
    if (args[0] === 'print') {
      if (!(label in state)) throw new Error('Could not find service');
      return state[label];
    }
    if (state.kickFails) throw new Error('Operation not permitted\nmore');
    return '';
  });
  const prev = process.env.HOME;
  process.env.HOME = dir;
  delete require.cache[FILE];
  const J = require(FILE);
  process.env.HOME = prev;
  return { dir, J, calls };
}
test.afterEach(() => mock.restoreAll());

test('RUNS_CLAUDE matches claude -p, --print, and an argument list, and not other claude uses', () => {
  const { J } = home({});
  for (const t of ['claude -p "x"', 'claude --print', '"claude", "-p"', "['claude','--print']"]) assert.ok(J.RUNS_CLAUDE.test(t), t);
  for (const t of ['claude --resume x', 'claudette -p', 'echo claude']) assert.ok(!J.RUNS_CLAUDE.test(t), t);
});

test('scheduleText reads intervals, calendars, lists, and on-demand jobs', () => {
  const { J } = home({});
  assert.equal(J.scheduleText({ StartInterval: 900 }), 'every 15 min');
  assert.equal(J.scheduleText({}), 'on demand');
  assert.equal(J.scheduleText({ RunAtLoad: true }), 'at login');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Weekday: 1, Hour: 6, Minute: 30 } }), 'Mondays 06:30');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Weekday: 7, Hour: 9 } }), 'Sundays 09:00');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Day: 1, Hour: 4, Minute: 30 } }), 'day 1 of the month 04:30');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Day: 31, Month: 10, Hour: 15, Minute: 0 } }), 'day 31 of Oct 15:00');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Month: 3, Hour: 8, Minute: 5 } }), 'every day of Mar 08:05');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Hour: 3, Minute: 10 } }), 'daily 03:10');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Minute: 15 } }), 'every hour at :15');
  assert.equal(J.scheduleText({ StartCalendarInterval: {} }), 'every hour at :00');
  assert.equal(J.scheduleText({ StartCalendarInterval: { Weekday: 2 } }), 'Tuesdays every hour at :00');
  assert.equal(J.scheduleText({ StartCalendarInterval: [{ Weekday: 1, Hour: 8, Minute: 7 }, { Weekday: 4, Hour: 8, Minute: 7 }] }), 'Mondays 08:07, Thursdays 08:07');
  assert.equal(J.scheduleText({ StartCalendarInterval: [1, 2, 3, 4].map((m) => ({ Month: m, Day: 1, Hour: 7, Minute: 0 })) }), 'day 1 of Jan 07:00, day 1 of Feb 07:00, and 2 more');
});

test('jobs finds a job by its own arguments or by a script it names, and leaves the rest out', () => {
  const h = home({}, {});
  const scripts = path.join(h.dir, 'bin');
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, 'run.sh'), '#!/bin/sh\nclaude -p "digest" > out.txt\n');
  fs.writeFileSync(path.join(scripts, 'other.sh'), '#!/bin/sh\necho hi\n');
  const agents = path.join(h.dir, 'Library', 'LaunchAgents');
  const put = (name, plist) => fs.writeFileSync(path.join(agents, name), JSON.stringify(plist));
  put('a.plist', { Label: 'com.x.direct', ProgramArguments: ['/bin/zsh', '-lc', 'claude -p hello'], StartInterval: 3600 });
  put('b.plist', { Label: 'com.x.script', ProgramArguments: ['/bin/sh', '~/bin/run.sh'], StandardOutPath: path.join(h.dir, 'out.log'), StandardErrorPath: path.join(h.dir, 'missing.log'), StartCalendarInterval: { Hour: 6, Minute: 0 } });
  put('c.plist', { Label: 'com.x.plain', ProgramArguments: ['/bin/sh', '$HOME/bin/other.sh'] });
  put('d.plist', { Label: 'com.x.program', Program: '/bin/true' });
  put('e.plist', { ProgramArguments: ['claude -p x'] }); // no label
  put('f.plist', { Label: 'com.x.nothing' });
  fs.writeFileSync(path.join(agents, 'g.plist'), 'not a plist');
  fs.writeFileSync(path.join(agents, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(h.dir, 'out.log'), 'line\n');
  const found = h.J.jobs();
  assert.deepEqual(found.map((j) => [j.label, j.script, j.schedule]), [['com.x.direct', null, 'every 60 min'], ['com.x.script', '~/bin/run.sh', 'daily 06:00']]);
  assert.equal(found[1].loaded, false);
  assert.ok(found[1].logAt > 0);
  assert.equal(found[0].logAt, null);
});

test('launchdState reads running, the last exit code, and the run count', () => {
  const { J } = home({}, {
    a: 'state = running\n\truns = 4\n\tlast exit code = 0\n',
    b: 'state = not running\n\tlast exit code = 1\n',
    c: 'state = not running\n\tlast exit code = (never exited)\n',
  });
  assert.deepEqual(J.launchdState('a'), { loaded: true, running: true, lastExit: 0, runs: 4 });
  assert.deepEqual(J.launchdState('b'), { loaded: true, running: false, lastExit: 1, runs: 0 });
  assert.deepEqual(J.launchdState('c'), { loaded: true, running: false, lastExit: null, runs: 0 });
  assert.deepEqual(J.launchdState('gone'), { loaded: false, running: false, lastExit: null, runs: 0 });
});

test('filesNamed skips what is not a file, and a folder of LaunchAgents that is missing lists nothing', () => {
  const h = home({});
  assert.deepEqual(h.J.filesNamed(['/no/such/file', 'relative.sh', h.dir]), []);
  fs.rmSync(path.join(h.dir, 'Library'), { recursive: true });
  assert.deepEqual(h.J.jobs(), []);
  assert.equal(h.J.claudeSource(['/no/file']), null);
});

test('claudeSource skips a script it cannot read', () => {
  const h = home({});
  const f = path.join(h.dir, 'locked.sh');
  fs.writeFileSync(f, 'claude -p x');
  const real = fs.readFileSync;
  mock.method(fs, 'readFileSync', (p, ...a) => { if (p === f) throw new Error('EACCES'); return real(p, ...a); });
  assert.equal(h.J.claudeSource([f]), null);
});

test('tail answers the last 80 lines of a log, and null for a missing file', () => {
  const h = home({});
  const f = path.join(h.dir, 'big.log');
  fs.writeFileSync(f, Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const t = h.J.tail(f).split('\n');
  assert.equal(t.length, 80);
  assert.equal(t.at(-1), 'line 199');
  assert.equal(h.J.tail(path.join(h.dir, 'none.log')), null);
});

test('main lists jobs without their log paths, reads a log, runs a job, and refuses the rest', () => {
  const h = home({}, { 'com.x.s': 'state = not running\n', 'com.x.busy': 'state = running\n' });
  const agents = path.join(h.dir, 'Library', 'LaunchAgents');
  const log = path.join(h.dir, 's.log');
  fs.writeFileSync(log, 'done\n');
  fs.writeFileSync(path.join(agents, 's.plist'), JSON.stringify({ Label: 'com.x.s', ProgramArguments: ['claude -p go'], StandardOutPath: log }));
  fs.writeFileSync(path.join(agents, 't.plist'), JSON.stringify({ Label: 'com.x.busy', ProgramArguments: ['claude -p go'] }));
  const list = h.J.main(['list']);
  assert.deepEqual(list.jobs.map((j) => j.label), ['com.x.s', 'com.x.busy']);
  assert.equal('logs' in list.jobs[0], false);
  const l = h.J.main(['log', 'com.x.s']);
  assert.equal(l.logs[0].file, '~/s.log');
  assert.equal(l.logs[0].text, 'done');
  assert.deepEqual(h.J.main(['run', 'com.x.s']), { ok: true, label: 'com.x.s' });
  assert.deepEqual(h.calls.at(-1), ['launchctl', 'kickstart', `gui/${process.getuid()}/com.x.s`]);
  assert.deepEqual(h.J.main(['run', 'com.x.busy']), { error: 'it is running now' });
  assert.deepEqual(h.J.main(['run', 'com.x.none']), { error: 'no scheduled Claude job by that name here' });
  assert.deepEqual(h.J.main(['nope']), { error: 'usage: list | log <label> | run <label>' });
  assert.deepEqual(h.J.main([]), { error: 'usage: list | log <label> | run <label>' });
});

test('main says what launchctl answered when Run now fails', () => {
  const h = home({}, { 'com.x.s': 'state = not running\n', kickFails: true });
  fs.writeFileSync(path.join(h.dir, 'Library', 'LaunchAgents', 's.plist'), JSON.stringify({ Label: 'com.x.s', ProgramArguments: ['claude -p go'] }));
  assert.deepEqual(h.J.main(['run', 'com.x.s']), { error: 'launchctl could not start it: Operation not permitted' });
});

test('run as a program, from a file or from stdin, it prints its answer as JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corral-jobs-'));
  const env = { ...process.env, HOME: dir };
  const a = cp.spawnSync(process.execPath, [FILE, 'nope'], { encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(a.stdout), { error: 'usage: list | log <label> | run <label>' });
  const b = cp.spawnSync(process.execPath, ['-', 'list'], { encoding: 'utf8', env, input: fs.readFileSync(FILE, 'utf8') });
  assert.deepEqual(JSON.parse(b.stdout), { jobs: [] });
});
