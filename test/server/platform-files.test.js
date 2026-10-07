const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadServer } = require('../helpers/server');
const { fakeHerdr, writeFile } = require('../helpers/platform');

const realTmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'files-'));

function herdrWorld(extra = {}) {
  const state = { calls: [], snap: { workspaces: [], panes: [] } };
  const h = loadServer({ exec: { herdr: fakeHerdr(state), ...extra } });
  return { ...h, state };
}

test('herdrSnapshot lists spaces with their folders, using the first pane of each', async () => {
  const { srv, state, home } = herdrWorld();
  writeFile(path.join(home, '.config/herdr/session.json'), JSON.stringify({ workspaces: [{ id: 'w1', identity_cwd: '/work/identity' }, { id: 'w9' }] }));
  state.snap = {
    workspaces: [
      { workspace_id: 'w1', number: 1, label: 'One', agent_status: 'idle', pane_count: 2, focused: true },
      { workspace_id: 'w2', number: 2, label: 'Two', agent_status: 'working', pane_count: 1, focused: false },
      { workspace_id: 'w3', number: 3, label: 'Three' },
    ],
    panes: [
      { workspace_id: 'w1', foreground_cwd: '/work/one/sub', cwd: '/work/one' },
      { workspace_id: 'w1', foreground_cwd: '/ignored' }, // only the first pane of a space counts
      { workspace_id: 'w2', cwd: '/work/two' },
    ],
  };
  const r = await srv.herdrSnapshot();
  assert.equal(r.available, true);
  assert.deepEqual(r.spaces, [
    { id: 'w1', number: 1, label: 'One', status: 'idle', panes: 2, focused: true, cwd: '/work/one/sub', root: '/work/identity' },
    { id: 'w2', number: 2, label: 'Two', status: 'working', panes: 1, focused: false, cwd: '/work/two', root: '/work/two' },
    { id: 'w3', number: 3, label: 'Three', status: undefined, panes: undefined, focused: undefined, cwd: null, root: null },
  ]);
  assert.deepEqual([...srv.ledger.keys()].sort(), ['/work/identity', '/work/two']); // the ledger learns the roots
  assert.deepEqual(state.calls[0], ['api', 'snapshot']);
});

test('herdrSnapshot copes with a snapshot that has no panes or workspaces, and leaves the ledger alone', async () => {
  const { srv, state } = herdrWorld();
  state.snap = '{"result":{"snapshot":{}}}';
  assert.deepEqual(await srv.herdrSnapshot(), { available: true, spaces: [] });
  assert.equal(srv.ledger.size, 0);
});

test('herdrSnapshot says herdr is unavailable when it fails or prints something unreadable', async () => {
  const { srv, state } = herdrWorld();
  state.fail = true;
  const down = await srv.herdrSnapshot();
  assert.deepEqual([down.available, down.spaces], [false, []]);
  assert.match(down.error, /herdr is not running/);
  state.fail = false;
  state.snap = 'not json';
  assert.deepEqual(await srv.herdrSnapshot(), { available: false, error: 'could not parse herdr snapshot', spaces: [] });
  state.snap = '{"result":{}}';
  assert.equal((await srv.herdrSnapshot()).available, false);
});

test('herdrSnapshot reports a failure that carries no message', async () => {
  const { srv } = loadServer({ exec: { herdr: () => { throw Object.assign(new Error(''), { message: '' }); } } });
  const r = await srv.herdrSnapshot();
  assert.equal(r.available, false);
  assert.match(r.error, /Error/);
});

test('identityRoots maps space ids to project folders and is empty without herdr data', () => {
  const { srv, home } = loadServer();
  assert.equal(srv.identityRoots().size, 0);
  writeFile(path.join(home, '.config/herdr/session.json'), '{}');
  assert.equal(srv.identityRoots().size, 0);
  writeFile(path.join(home, '.config/herdr/session.json'), JSON.stringify({ workspaces: [{ id: 'a', identity_cwd: '/x' }, { id: 'b' }] }));
  assert.deepEqual([...srv.identityRoots()], [['a', '/x']]);
});

test('rootFor looks a space up, and asks herdr again only when the id is unknown or the answer is old', async () => {
  const { srv, state } = herdrWorld();
  state.snap = { workspaces: [{ workspace_id: 'w1', label: 'One' }], panes: [{ workspace_id: 'w1', cwd: '/work/one' }] };
  assert.equal(await srv.rootFor('w1'), '/work/one');
  assert.equal(await srv.rootFor('w1'), '/work/one');
  assert.equal(state.calls.length, 1);
  assert.equal(await srv.rootFor('nope'), null); // unknown id: asks again
  assert.equal(state.calls.length, 2);
  srv.state.rootCache = { at: 0, map: new Map([['w1', '/stale']]) };
  assert.equal(await srv.rootFor('w1'), '/work/one'); // old answer: refreshed
  assert.equal(state.calls.length, 3);
});

test('reopenProject creates the space in herdr, sorts the spaces, and refreshes the ledger', async () => {
  const dir = realTmp();
  const sorted = [];
  const { srv, state } = herdrWorld({ 'herdr-sort-spaces': (args) => { sorted.push(args); return ''; } });
  state.other = (args) => {
    state.snap = { workspaces: [{ workspace_id: 'w9', label: args[args.indexOf('--label') + 1] }], panes: [{ workspace_id: 'w9', cwd: dir }] };
    return '';
  };
  srv.ledger.set(dir, { root: dir, label: 'Proj', firstSeen: 1, lastSeen: 1 });
  const r = await srv.reopenProject(dir);
  assert.deepEqual(r, { status: 200, ok: true, label: 'Proj' });
  const create = state.calls.find((c) => c[0] === 'workspace');
  assert.deepEqual(create, ['workspace', 'create', '--cwd', dir, '--label', 'Proj', '--no-focus']);
  assert.deepEqual(sorted, [['--apply']]);
  assert.equal(state.calls.filter((c) => c[0] === 'api').length, 2); // before the create, and again to refresh
});

test('reopenProject gives a space a longer name when another open space already has its label', async () => {
  const dir = realTmp();
  const { srv, state } = herdrWorld();
  state.snap = { workspaces: [{ workspace_id: 'w1', label: 'Proj' }], panes: [{ workspace_id: 'w1', cwd: '/elsewhere' }] };
  srv.ledger.set(dir, { root: dir, label: 'Proj', firstSeen: 1, lastSeen: 1 });
  const r = await srv.reopenProject(dir);
  assert.equal(r.label, `${path.basename(path.dirname(dir))}/${path.basename(dir)}`);
});

test('reopenProject refuses an unknown project, an unreachable herdr, an open space, and a missing folder', async () => {
  const dir = realTmp();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, '');
  const { srv, state } = herdrWorld();
  assert.deepEqual(await srv.reopenProject('/unknown'), { status: 404, error: 'unknown project' });
  srv.ledger.set(dir, { root: dir, label: 'P', firstSeen: 1, lastSeen: 1 });
  srv.ledger.set(file, { root: file, label: 'F', firstSeen: 1, lastSeen: 1 });
  srv.ledger.set('/gone/forever', { root: '/gone/forever', label: 'G', firstSeen: 1, lastSeen: 1 });
  state.fail = true;
  assert.deepEqual(await srv.reopenProject(dir), { status: 502, error: 'herdr not reachable' });
  state.fail = false;
  state.snap = { workspaces: [{ workspace_id: 'w1', label: 'P' }], panes: [{ workspace_id: 'w1', cwd: dir }] };
  assert.deepEqual(await srv.reopenProject(dir), { status: 409, error: 'already open in herdr' });
  state.snap = { workspaces: [{ workspace_id: 'w2', label: 'Other' }], panes: [{ workspace_id: 'w2', cwd: '/other' }] };
  assert.deepEqual(await srv.reopenProject('/gone/forever'), { status: 410, error: 'folder no longer exists' });
  assert.deepEqual(await srv.reopenProject(file), { status: 410, error: 'folder no longer exists' });
});

test('reopenProject reports it when herdr cannot create the space', async () => {
  const dir = realTmp();
  const { srv, state } = herdrWorld();
  state.other = () => { throw new Error('create failed'); };
  srv.ledger.set(dir, { root: dir, label: 'P', firstSeen: 1, lastSeen: 1 });
  assert.deepEqual(await srv.reopenProject(dir), { status: 502, error: 'herdr could not create the space' });
});

test('listDir lists folders first, hides dotfiles unless asked, skips noise, and follows safe symlinks only', () => {
  const root = realTmp();
  const outside = realTmp();
  fs.mkdirSync(path.join(root, 'b-dir'));
  fs.mkdirSync(path.join(root, 'A-dir'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.config'));
  for (const f of ['z.txt', 'a.txt', 'B.txt', '.hidden', '.DS_Store']) fs.writeFileSync(path.join(root, f), '');
  fs.symlinkSync(path.join(root, 'b-dir'), path.join(root, 'link-in'));
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link-file'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'link-broken'));
  const { srv } = loadServer();
  const r = srv.listDir(root, '', false);
  assert.equal(r.status, 200);
  assert.deepEqual(r.entries.map((e) => `${e.name}:${e.type}:${e.link}`), [
    'A-dir:dir:false', 'b-dir:dir:false', 'link-in:dir:true',
    'a.txt:file:false', 'B.txt:file:false', 'link-broken:file:true', 'link-file:file:true', 'link-out:file:true', 'z.txt:file:false',
  ]);
  assert.equal(r.path, '');
  assert.equal(r.truncated, false);
  const hidden = srv.listDir(root, '', true);
  assert.ok(hidden.entries.some((e) => e.name === '.hidden') && hidden.entries.some((e) => e.name === '.config'));
  assert.equal(hidden.entries.some((e) => e.name === '.git' || e.name === '.DS_Store' || e.name === 'node_modules'), false);
  assert.equal(srv.listDir(root, 'b-dir', false).path, 'b-dir');
});

test('listDir refuses paths that leave the project, and reports what is missing or not a folder', () => {
  const root = realTmp();
  const outside = realTmp();
  fs.writeFileSync(path.join(root, 'f.txt'), '');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const { srv } = loadServer();
  assert.deepEqual(srv.listDir(root, '../', false), { status: 403, error: 'outside the project folder' });
  assert.deepEqual(srv.listDir(root, 'escape', false), { status: 403, error: 'outside the project folder' });
  assert.deepEqual(srv.listDir(root, '/etc', false), { status: 400, error: 'bad path' });
  assert.deepEqual(srv.listDir(root, 'a\0b', false), { status: 400, error: 'bad path' });
  assert.deepEqual(srv.listDir(root, 'missing', false), { status: 404, error: 'not found' });
  assert.deepEqual(srv.listDir('/no/root', '', false), { status: 404, error: 'not found' });
  assert.deepEqual(srv.listDir(root, 'f.txt', false), { status: 404, error: 'not a readable folder' });
});

test('listDir cuts a very large folder at 1000 entries', () => {
  const root = realTmp();
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(root, `f${i}`), '');
  const { srv } = loadServer();
  const r = srv.listDir(root, '', false);
  assert.equal(r.entries.length, 1000);
  assert.equal(r.truncated, true);
});

test('spaceFile returns the real path of a file inside a space and null for everything else', async () => {
  const root = realTmp();
  const outside = realTmp();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub/a.md'), '');
  fs.writeFileSync(path.join(outside, 'secret'), '');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'leak'));
  const { srv, state } = herdrWorld();
  state.snap = { workspaces: [{ workspace_id: 'w1', label: 'W' }], panes: [{ workspace_id: 'w1', cwd: root }] };
  assert.equal(await srv.spaceFile('w1', 'sub/a.md'), path.join(root, 'sub/a.md'));
  assert.equal(await srv.spaceFile('w1', 'sub'), null); // a folder
  assert.equal(await srv.spaceFile('w1', 'leak'), null);
  assert.equal(await srv.spaceFile('w1', '../x'), null);
  assert.equal(await srv.spaceFile('w1', 'nope.md'), null);
  assert.equal(await srv.spaceFile('w1', ''), null);
  assert.equal(await srv.spaceFile('w1', 'a\0b'), null);
  assert.equal(await srv.spaceFile('w1', '/etc/hosts'), null);
  assert.equal(await srv.spaceFile('w1', 7), null);
  assert.equal(await srv.spaceFile('other', 'sub/a.md'), null);
  assert.equal(await srv.spaceFile(null, 'sub/a.md'), null);
});

const APPS = { def: '/Applications/Typora.app', apps: [{ name: 'Typora', path: '/Applications/Typora.app' }, { name: 'TextEdit', path: '/System/Applications/TextEdit.app' }] };

test('appsFor asks macOS for the apps that open a file, and treats any failure as none', async () => {
  const seen = [];
  const a = loadServer({ exec: { osascript: (args) => { seen.push(args); return JSON.stringify(APPS); } } });
  assert.deepEqual(await a.srv.appsFor('/x/a.md'), APPS);
  assert.deepEqual(seen[0].slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(seen[0].at(-1), '/x/a.md');
  const b = loadServer({ exec: { osascript: () => { throw new Error('boom'); } } });
  assert.deepEqual(await b.srv.appsFor('/x'), { def: null, apps: [] });
  const c = loadServer({ exec: { osascript: () => 'not json' } });
  assert.deepEqual(await c.srv.appsFor('/x'), { def: null, apps: [] });
});

test('openChoices offers the apps for the file, or the plain-text apps when macOS knows none', async (t) => {
  const asked = [];
  const { srv, home } = loadServer({
    exec: { osascript: (args) => { asked.push(args.at(-1)); return JSON.stringify(args.at(-1).endsWith('.xyz') ? { def: null, apps: [] } : APPS); } },
  });
  assert.deepEqual(await srv.openChoices('/x/a.md'), { ...APPS, asText: false });
  const text = await srv.openChoices('/x/a.xyz');
  assert.deepEqual([text.def, text.asText, text.apps.length], [null, true, 2]);
  const sample = path.join(home, '.local/share/corral/plain-text-sample.txt');
  assert.equal(fs.existsSync(sample), true);
  assert.equal(asked.at(-1), sample);
  await srv.openChoices('/x/a.xyz'); // the sample is already there
  assert.equal(fs.readFileSync(sample, 'utf8'), '');

  fs.rmSync(sample);
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('read-only'); });
  assert.equal((await srv.openChoices('/x/a.xyz')).asText, true); // still answers without the sample file
});

test('openFile opens with the chosen app, the default app, or Finder, and says why it cannot', async () => {
  const opened = [];
  let defApp = '/Applications/Typora.app';
  let openFails = false;
  const { srv } = loadServer({
    exec: {
      osascript: () => JSON.stringify({ ...APPS, def: defApp }),
      open: (args) => { opened.push(args); if (openFails) throw new Error('no'); return ''; },
    },
  });
  assert.deepEqual(await srv.openFile('/x/a.md', 'finder'), { status: 200, ok: true });
  assert.deepEqual(opened.at(-1), ['-R', '/x/a.md']);
  assert.deepEqual(await srv.openFile('/x/a.md', 'system'), { status: 200, ok: true });
  assert.deepEqual(opened.at(-1), ['/x/a.md']);
  assert.deepEqual(await srv.openFile('/x/a.md', '/System/Applications/TextEdit.app'), { status: 200, ok: true });
  assert.deepEqual(opened.at(-1), ['-a', '/System/Applications/TextEdit.app', '/x/a.md']);
  assert.deepEqual(await srv.openFile('/x/a.md', '/Applications/Evil.app'), { status: 400, error: 'that app does not open this file' });
  openFails = true;
  assert.deepEqual(await srv.openFile('/x/a.md', 'finder'), { status: 502, error: 'macOS could not open it' });
  defApp = null;
  assert.deepEqual(await srv.openFile('/x/a.md', 'system'), { status: 409, error: 'macOS has no default app for this file' });
});

test('send writes JSON by default and serveFile answers 404 for a file it cannot read', async () => {
  const { srv } = loadServer();
  const res = { writeHead(c, h) { this.code = c; this.head = h; }, end(b) { this.body = b; } };
  srv.send(res, 201, { a: 1 });
  assert.deepEqual([res.code, res.head['Content-Type'], res.head['Cache-Control'], res.body], [201, 'application/json; charset=utf-8', 'no-store', '{"a":1}']);
  srv.send(res, 200, 'text', 'text/plain');
  assert.equal(res.body, 'text');
  const buf = Buffer.from('b');
  srv.send(res, 200, buf, 'x/y');
  assert.equal(res.body, buf);

  const missing = { writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  await new Promise((resolve) => { missing.end = (b) => { missing.body = b; resolve(); }; srv.serveFile(missing, '/no/such/file.js'); });
  assert.equal(missing.code, 404);
});
