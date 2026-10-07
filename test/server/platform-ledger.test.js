const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadServer, ROOT } = require('../helpers/server');
const { UUID1, UUID2, quiet, writeFile } = require('../helpers/platform');

const data = (home, f) => path.join(home, '.local/share/corral', f);
const jsonOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('skippedRoot ignores scratch folders and their children, but not lookalikes', () => {
  const { srv } = loadServer();
  for (const r of ['/tmp', '/tmp/x', '/private/tmp/a/b', '/var/folders/zz', '/private/var/folders']) assert.equal(srv.skippedRoot(r), true, r);
  for (const r of ['/tmpfoo', '/Users/me/tmp', '/home/x']) assert.equal(srv.skippedRoot(r), false, r);
});

test('writeJson writes atomically with private permissions, and readJsonFile returns null for bad files', () => {
  const { srv, home } = loadServer();
  const f = data(home, 'x.json');
  srv.writeJson(f, { a: 1 });
  assert.deepEqual(jsonOf(f), { a: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['x.json']); // no temp file left behind
  assert.deepEqual(srv.readJsonFile(f), { a: 1 });
  assert.equal(srv.readJsonFile(data(home, 'missing.json')), null);
  fs.writeFileSync(f, '{nope');
  assert.equal(srv.readJsonFile(f), null);
});

test('saveLedger writes every project, and a failure is logged without throwing', (t) => {
  const out = quiet(t);
  const { srv, home } = loadServer();
  srv.ledger.set('/p', { root: '/p', label: 'p', firstSeen: 1, lastSeen: 2 });
  srv.saveLedger();
  assert.deepEqual(jsonOf(data(home, 'projects.json')), { version: 1, projects: [{ root: '/p', label: 'p', firstSeen: 1, lastSeen: 2 }] });
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('read-only'); });
  srv.saveLedger();
  assert.deepEqual(out.errors, ['ledger save failed: read-only']);
});

test('migrateLegacyData copies the pre-rename ledger once and leaves the old file', (t) => {
  const out = quiet(t);
  const { srv, home } = loadServer();
  const old = path.join(home, '.local/share/webterm/projects.json');
  srv.migrateLegacyData(); // nothing to copy yet
  assert.equal(fs.existsSync(data(home, 'projects.json')), false);

  writeFile(old, JSON.stringify({ projects: [{ root: '/legacy' }] }));
  srv.migrateLegacyData();
  assert.equal(fs.readFileSync(data(home, 'projects.json'), 'utf8'), fs.readFileSync(old, 'utf8'));
  assert.equal(fs.statSync(data(home, 'projects.json')).mode & 0o777, 0o600);
  assert.deepEqual(out.logs, ['copied the project ledger from the earlier data directory']);

  fs.writeFileSync(data(home, 'projects.json'), '{"projects":[]}');
  srv.migrateLegacyData(); // the new file exists: left alone
  assert.equal(fs.readFileSync(data(home, 'projects.json'), 'utf8'), '{"projects":[]}');

  fs.rmSync(data(home, 'projects.json'));
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('nope'); });
  srv.migrateLegacyData();
  assert.deepEqual(out.errors, ['ledger migration failed: nope']);
});

test('loadLedger reads saved projects, skips rows without a root, and reports whether a file was there', () => {
  const { srv, home } = loadServer();
  assert.equal(srv.loadLedger(), false);
  writeFile(data(home, 'projects.json'), JSON.stringify({ projects: [{ root: '/a', label: 'A' }, { label: 'no root' }] }));
  assert.equal(srv.loadLedger(), true);
  assert.deepEqual([...srv.ledger.keys()], ['/a']);
  writeFile(data(home, 'projects.json'), '{}');
  assert.equal(srv.loadLedger(), true); // a file without a project list is still a file
});

test('loadLedger migrates the pre-rename file when only that one exists', (t) => {
  quiet(t);
  const { srv, home } = loadServer();
  writeFile(path.join(home, '.local/share/webterm/projects.json'), JSON.stringify({ projects: [{ root: '/old', label: 'Old' }] }));
  assert.equal(srv.loadLedger(), true);
  assert.equal(srv.ledger.get('/old').label, 'Old');
});

test('seedFromSnapshots adds spaces from herdr snapshots, skipping scratch folders and updating known ones', (t) => {
  const { srv } = loadServer();
  // The temp home sits under a skipped scratch prefix, so use a home outside it.
  fs.mkdirSync(path.join(ROOT, 'coverage'), { recursive: true });
  const home = fs.mkdtempSync(path.join(ROOT, 'coverage', 'home-'));
  t.after(() => { process.env.HOME = tempHome; fs.rmSync(home, { recursive: true, force: true }); });
  const tempHome = process.env.HOME;
  process.env.HOME = home;
  srv.seedFromSnapshots(); // no snapshot folder: nothing happens
  assert.equal(srv.ledger.size, 0);

  const dir = path.join(home, '.config/herdr/session-snapshots');
  writeFile(path.join(dir, 'a.json'), JSON.stringify({ workspaces: [
    { identity_cwd: '/work/one' },
    { identity_cwd: home },
    { identity_cwd: '/work/named', custom_name: 'Custom' },
    { identity_cwd: '/tmp/scratch' },
    { label: 'no folder' },
  ] }));
  writeFile(path.join(dir, 'b.json'), JSON.stringify({ workspaces: [{ identity_cwd: '/work/one', custom_name: 'Renamed' }] }));
  writeFile(path.join(dir, 'c.json'), JSON.stringify({}));
  writeFile(path.join(dir, 'broken.json'), '{nope');
  writeFile(path.join(dir, 'notes.txt'), 'ignored');
  fs.utimesSync(path.join(dir, 'a.json'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'b.json'), 2000, 2000);
  srv.seedFromSnapshots();
  assert.deepEqual([...srv.ledger.keys()].sort(), [home, '/work/named', '/work/one'].sort());
  assert.equal(srv.ledger.get(home).label, '~');
  assert.equal(srv.ledger.get('/work/named').label, 'Custom');
  const one = srv.ledger.get('/work/one');
  assert.deepEqual([one.label, one.firstSeen, one.lastSeen], ['Renamed', 1000000, 2000000]);
});

test('updateLedger records new spaces, label changes, reopened and closed spaces, and saves only on change', (t) => {
  const { srv, home } = loadServer();
  const file = data(home, 'projects.json');
  t.mock.method(Date, 'now', () => 5000);
  srv.updateLedger([{ root: '/a', label: 'A' }, { root: '/tmp/x', label: 'scratch' }, { label: 'no root' }]);
  assert.deepEqual(srv.ledger.get('/a'), { root: '/a', label: 'A', firstSeen: 5000, lastSeen: 5000 });
  assert.equal(srv.ledger.has('/tmp/x'), false);
  assert.deepEqual([...srv.state.openRoots], ['/a']);
  assert.equal(jsonOf(file).projects.length, 1);

  // Nothing changed: no save, only lastSeen moves.
  fs.rmSync(file);
  Date.now.mock.mockImplementation(() => 6000);
  srv.updateLedger([{ root: '/a', label: 'A' }]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(srv.ledger.get('/a').lastSeen, 6000);

  // A renamed space is saved.
  srv.updateLedger([{ root: '/a', label: 'A2' }]);
  assert.equal(jsonOf(file).projects[0].label, 'A2');

  // A closed space is saved too, and its entry stays.
  fs.rmSync(file);
  srv.updateLedger([]);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual([...srv.state.openRoots], []);
  assert.equal(srv.ledger.has('/a'), true);

  // Coming back after being closed is saved.
  fs.rmSync(file);
  srv.updateLedger([{ root: '/a', label: 'A2' }]);
  assert.equal(fs.existsSync(file), true);
});

test('ledgerView marks open and missing folders and lists the most recently seen first', () => {
  const { srv } = loadServer();
  const home = ROOT; // a real folder that is not under a skipped scratch prefix
  srv.ledger.set(home, { root: home, label: 'home', firstSeen: 1, lastSeen: 10 });
  srv.ledger.set('/no/such/dir', { root: '/no/such/dir', label: 'gone', firstSeen: 1, lastSeen: 50 });
  srv.updateLedger([{ root: home, label: 'home' }]);
  const view = srv.ledgerView();
  assert.deepEqual(view.map((e) => [e.label, e.open, e.exists]), [['home', true, true], ['gone', false, false]]);
});

test('cleanCategories accepts a well-formed document and rejects each kind of bad one', () => {
  const { srv } = loadServer();
  const ok = srv.cleanCategories({ categories: [{ name: ' Work ', collapsed: 1 }, { name: 'Play' }], uncatCollapsed: 1, assign: { '/a': 'Work', '/b': 'Nope', '/c': 5, ['x'.repeat(1024)]: 'Play' } });
  assert.deepEqual(ok, { version: 1, categories: [{ name: 'Work', collapsed: true }, { name: 'Play', collapsed: false }], uncatCollapsed: true, assign: { '/a': 'Work' } });
  assert.equal(srv.cleanCategories({ categories: [], assign: {} }).uncatCollapsed, false);
  const proto = srv.cleanCategories(JSON.parse('{"categories":[{"name":"W"}],"assign":{"__proto__":"W"}}'));
  assert.equal(Object.getPrototypeOf(proto.assign), Object.prototype);
  assert.equal(Object.hasOwn(proto.assign, '__proto__'), true);
  const bad = [
    null, {}, { categories: 'x', assign: {} }, { categories: [] }, { categories: [], assign: 'x' },
    { categories: Array.from({ length: 61 }, (_, i) => ({ name: `c${i}` })), assign: {} },
    { categories: [{ name: '' }], assign: {} }, { categories: [{ name: '   ' }], assign: {} },
    { categories: [{ name: 5 }], assign: {} }, { categories: [null], assign: {} },
    { categories: [{ name: 'x'.repeat(41) }], assign: {} },
    { categories: [{ name: 'a' }, { name: 'a' }], assign: {} },
  ];
  for (const b of bad) assert.equal(srv.cleanCategories(b), null, JSON.stringify(b)?.slice(0, 60));
});

test('loadCategories keeps the default when the file is missing or invalid, and saveCategories round-trips', (t) => {
  const out = quiet(t);
  const { srv, home } = loadServer();
  const file = data(home, 'categories.json');
  srv.loadCategories();
  assert.deepEqual(srv.state.categories.categories, []);
  writeFile(file, '{nope');
  srv.loadCategories();
  assert.deepEqual(srv.state.categories.categories, []);
  writeFile(file, JSON.stringify({ categories: 'bad', assign: {} }));
  srv.loadCategories();
  assert.deepEqual(srv.state.categories.categories, []);
  writeFile(file, JSON.stringify({ categories: [{ name: 'Work' }], assign: { '/a': 'Work' } }));
  srv.loadCategories();
  assert.equal(srv.state.categories.categories[0].name, 'Work');

  assert.equal(srv.saveCategories(), true);
  assert.deepEqual(jsonOf(file).assign, { '/a': 'Work' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  t.mock.method(fs, 'renameSync', () => { throw new Error('busy'); });
  assert.equal(srv.saveCategories(), false);
  assert.deepEqual(out.errors, ['categories save failed: busy']);
});

test('prepareRestore moves windows that are no longer running into the restore file', (t) => {
  const out = quiet(t);
  const { srv, home } = loadServer();
  srv.prepareRestore(); // no backup yet
  assert.equal(fs.existsSync(data(home, 'restore.json')), false);

  srv.register('live', os.tmpdir(), 'Live', 1, false);
  const windows = [{ id: 'live', label: 'Live' }, { id: 'dead', label: 'Dead' }, { label: 'no id' }, null];
  writeFile(data(home, 'open-sessions.json'), JSON.stringify({ savedAt: '2026-10-01T10:00:00Z', windows }));
  srv.prepareRestore();
  assert.deepEqual(jsonOf(data(home, 'restore.json')), { version: 1, savedAt: '2026-10-01T10:00:00Z', windows: [{ id: 'dead', label: 'Dead' }] });
  assert.deepEqual(out.logs, ['1 window(s) from 2026-10-01T10:00:00Z can be restored']);

  // Everything still running: the restore file is left as it was.
  writeFile(data(home, 'open-sessions.json'), JSON.stringify({ windows: [{ id: 'live' }] }));
  fs.rmSync(data(home, 'restore.json'));
  srv.prepareRestore();
  assert.equal(fs.existsSync(data(home, 'restore.json')), false);

  writeFile(data(home, 'open-sessions.json'), JSON.stringify({ savedAt: 'x', windows: [{ id: 'dead' }] }));
  t.mock.method(fs, 'renameSync', () => { throw new Error('locked'); });
  srv.prepareRestore();
  assert.deepEqual(out.errors, ['restore list save failed: locked']);
});

test('resumableId accepts only a well-formed id that Claude Code has on disk', () => {
  const { srv, home } = loadServer();
  assert.equal(srv.resumableId(UUID1), null); // no projects folder yet
  writeFile(path.join(home, '.claude/projects/p1/other.jsonl'), '');
  assert.equal(srv.resumableId(UUID1), null);
  writeFile(path.join(home, `.claude/projects/p2/${UUID1}.jsonl`), '');
  assert.equal(srv.resumableId(UUID1), UUID1);
  assert.equal(srv.resumableId(UUID2), null);
  assert.equal(srv.resumableId('../../etc/passwd'), null);
  assert.equal(srv.resumableId(42), null);
  assert.equal(srv.resumableId(undefined), null);
});

test('restoreList returns an empty list for a missing or malformed file', () => {
  const { srv, home } = loadServer();
  assert.deepEqual(srv.restoreList(), { savedAt: null, windows: [] });
  writeFile(data(home, 'restore.json'), JSON.stringify({ windows: 'x' }));
  assert.deepEqual(srv.restoreList(), { savedAt: null, windows: [] });
  writeFile(data(home, 'restore.json'), JSON.stringify({ savedAt: 's', windows: [{ label: 'a' }] }));
  assert.deepEqual(srv.restoreList(), { savedAt: 's', windows: [{ label: 'a' }] });
});

test('restoreWindows reopens each saved window, resuming only conversations that still exist', () => {
  const { srv, home, tmux } = loadServer();
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rs-'));
  const other = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rs2-'));
  writeFile(path.join(home, `.claude/projects/p/${UUID1}.jsonl`), '');
  writeFile(data(home, 'restore.json'), JSON.stringify({ savedAt: 's', windows: [
    { id: 'a', label: 'Resumed', cwd: dir, claudeSession: UUID1, claudeCwd: other, space: 'sp-1' },
    { id: 'b', label: 'Lost', cwd: dir, claudeSession: UUID2, claudeCwd: other, space: 'bad space!' },
    { id: 'c', label: 'Plain', cwd: dir },
    { id: 'd', label: 'No folder' },
    { id: 'e', label: 'Resumed no cwd', claudeSession: UUID1 },
    { id: 'f' },
    null,
  ] }));
  const r = srv.restoreWindows();
  assert.deepEqual(r.sessions.map((s) => [s.label, s.cwd, s.space]), [
    ['Resumed', other, 'sp-1'], ['Lost', dir, null], ['Plain', dir, null], ['No folder', os.homedir(), null], ['Resumed no cwd', os.homedir(), null],
  ]);
  assert.deepEqual(r.notResumed, ['Lost']);
  assert.equal(fs.existsSync(data(home, 'restore.json')), false);
  const first = [...tmux.sessions.values()][0];
  assert.match(first.command.at(-1), new RegExp(`claude --resume ${UUID1}`));
});

test('restoreWindows skips a window that cannot start and still clears the restore file', () => {
  let fail = false;
  const { srv, home } = loadServer({ ptyThrows: () => fail });
  writeFile(data(home, 'restore.json'), JSON.stringify({ windows: [{ label: 'x', cwd: home }] }));
  fail = true;
  assert.deepEqual(srv.restoreWindows(), { sessions: [], notResumed: [] });
  assert.equal(fs.existsSync(data(home, 'restore.json')), false);
  assert.deepEqual(srv.restoreWindows(), { sessions: [], notResumed: [] }); // nothing to unlink the second time
});

test('openWith defaults load from their file, ignoring junk, and save back', (t) => {
  const out = quiet(t);
  const { srv, home } = loadServer();
  const file = data(home, 'open-with.json');
  srv.loadOpenWith();
  assert.equal(srv.openWith.size, 0);
  writeFile(file, JSON.stringify({ defaults: 'x' }));
  srv.loadOpenWith();
  assert.equal(srv.openWith.size, 0);
  writeFile(file, JSON.stringify({ defaults: { '.md': '/Applications/Typora.app', '.js': 5, '.txt': 'system' } }));
  srv.loadOpenWith();
  assert.deepEqual([...srv.openWith], [['.md', '/Applications/Typora.app'], ['.txt', 'system']]);

  srv.openWith.set('.py', 'finder');
  assert.equal(srv.saveOpenWith(), true);
  assert.equal(jsonOf(file).defaults['.py'], 'finder');
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('full'); });
  assert.equal(srv.saveOpenWith(), false);
  assert.deepEqual(out.errors, ['open-with save failed: full']);
});

test('fileKind is the lowercase extension, or the whole name when there is none', () => {
  const { srv } = loadServer();
  assert.equal(srv.fileKind('/x/Report.MD'), '.md');
  assert.equal(srv.fileKind('/x/Makefile'), 'Makefile');
  assert.equal(srv.appName('system'), 'its macOS default app');
  assert.equal(srv.appName('finder'), 'Finder');
  assert.equal(srv.appName('/Applications/Typora.app'), 'Typora');
});
