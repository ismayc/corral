const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadServer, listen, PORT, ROOT } = require('../helpers/server');
const { quiet, fakeHerdr, writeFile } = require('../helpers/platform');

const realTmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'http-'));
const APPS = { def: '/Applications/Typora.app', apps: [{ name: 'Typora', path: '/Applications/Typora.app' }] };
const TAILNET = { host: 'mac.tail1234.ts.net:8443', origin: 'https://mac.tail1234.ts.net:8443', url: 'https://mac.tail1234.ts.net:8443/', logins: new Set(['me@example.com']), machine: 'mac', served: true };

// Loads the server with fake herdr, osascript, and open, and starts its HTTP handler.
async function world(t, opts = {}) {
  const herdr = { calls: [], snap: { workspaces: [], panes: [] } };
  const opened = [];
  const h = loadServer({ ...opts, exec: { herdr: fakeHerdr(herdr), osascript: () => JSON.stringify(APPS), open: (args) => { opened.push(args); return ''; }, ...opts.exec } });
  const http = await listen(h.srv);
  t.after(() => http.close());
  return { ...h, http, herdr, opened, req: http.request };
}

const remote = (extra = {}) => ({ host: TAILNET.host, origin: TAILNET.origin, 'tailscale-user-login': 'me@example.com', ...extra });

test('a request through the tailnet is accepted only for an allowed login, with the tailnet origin', async (t) => {
  const { srv, req } = await world(t);
  srv.state.tailnet = TAILNET;
  assert.equal((await req('GET', '/api/sessions', { headers: remote() })).status, 200);
  assert.equal((await req('GET', '/api/sessions', { headers: remote({ 'tailscale-user-login': 'other@example.com' }) })).status, 403);
  assert.equal((await req('GET', '/api/sessions', { headers: remote({ 'tailscale-user-login': null }) })).status, 403);
  assert.equal((await req('POST', '/api/restore/dismiss', { body: {}, headers: remote() })).status, 200);
  const wrongOrigin = await req('POST', '/api/restore/dismiss', { body: {}, headers: remote({ origin: `http://127.0.0.1:${PORT}` }) });
  assert.deepEqual([wrongOrigin.status, wrongOrigin.json], [403, { error: 'bad origin' }]);
  assert.equal((await req('GET', '/api/sessions', { headers: { host: null } })).status, 403);
});

test('a mutating request with no content type is refused', async (t) => {
  const { req } = await world(t);
  const r = await req('POST', '/api/sessions', { body: {}, headers: { 'content-type': null } });
  assert.deepEqual([r.status, r.json], [415, { error: 'json only' }]);
});

test('GET /api/herdr returns the snapshot, or says herdr is unavailable', async (t) => {
  const { req, herdr } = await world(t);
  herdr.snap = { workspaces: [{ workspace_id: 'w1', label: 'One' }], panes: [{ workspace_id: 'w1', cwd: '/w' }] };
  const ok = await req('GET', '/api/herdr');
  assert.equal(ok.json.available, true);
  assert.equal(ok.json.spaces[0].label, 'One');
  herdr.fail = true;
  assert.equal((await req('GET', '/api/herdr')).json.available, false);
});

test('categories can be read and replaced, and a bad document is refused', async (t) => {
  const { req, home } = await world(t);
  const first = await req('GET', '/api/categories');
  assert.deepEqual(first.json, { version: 1, categories: [], uncatCollapsed: false, assign: {} });
  const doc = { categories: [{ name: 'Work', collapsed: true }], uncatCollapsed: true, assign: { '/a': 'Work', '/b': 'Nope' } };
  const saved = await req('POST', '/api/categories', { body: doc });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.assign, { '/a': 'Work' });
  assert.deepEqual((await req('GET', '/api/categories')).json, saved.json);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.local/share/corral/categories.json'), 'utf8')), saved.json);
  const bad = await req('POST', '/api/categories', { body: { categories: 'x' } });
  assert.deepEqual([bad.status, bad.json], [400, { error: 'bad categories' }]);
  assert.equal((await req('POST', '/api/categories', { raw: '{nope' })).status, 400);
});

test('saving categories reports a disk failure', async (t) => {
  quiet(t);
  const { req } = await world(t);
  t.mock.method(fs, 'renameSync', () => { throw new Error('full'); });
  const r = await req('POST', '/api/categories', { body: { categories: [], assign: {} } });
  assert.deepEqual([r.status, r.json], [500, { error: 'could not save' }]);
});

test('GET /api/projects lists the ledger after refreshing it from herdr', async (t) => {
  const { req, herdr, srv } = await world(t);
  srv.ledger.set('/old', { root: '/old', label: 'Old', firstSeen: 1, lastSeen: 1 });
  herdr.snap = { workspaces: [{ workspace_id: 'w1', label: 'New' }], panes: [{ workspace_id: 'w1', cwd: '/new' }] };
  const r = await req('GET', '/api/projects');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.projects.map((p) => [p.root, p.open]).sort(), [['/new', true], ['/old', false]]);
});

test('POST /api/projects/reopen validates the body and reports the result', async (t) => {
  const { req, herdr, srv } = await world(t);
  assert.deepEqual((await req('POST', '/api/projects/reopen', { raw: '{nope' })).json, { error: 'bad json' });
  assert.equal((await req('POST', '/api/projects/reopen', { body: { root: 5 } })).status, 400);
  const unknown = await req('POST', '/api/projects/reopen', { body: { root: '/unknown' } });
  assert.deepEqual([unknown.status, unknown.json], [404, { status: 404, error: 'unknown project' }]);
  const dir = realTmp();
  srv.ledger.set(dir, { root: dir, label: 'P', firstSeen: 1, lastSeen: 1 });
  herdr.other = () => '';
  const ok = await req('POST', '/api/projects/reopen', { body: { root: dir } });
  assert.deepEqual([ok.status, ok.json.ok, ok.json.label], [200, true, 'P']);
});

test('POST /api/projects/forget removes an inactive project and keeps an open one', async (t) => {
  const { req, herdr, srv, home } = await world(t);
  assert.equal((await req('POST', '/api/projects/forget', { raw: '{nope' })).status, 400);
  assert.equal((await req('POST', '/api/projects/forget', { body: {} })).status, 400);
  assert.equal((await req('POST', '/api/projects/forget', { body: { root: '/x' } })).status, 404);
  srv.ledger.set('/old', { root: '/old', label: 'Old', firstSeen: 1, lastSeen: 1 });
  srv.ledger.set('/live', { root: '/live', label: 'Live', firstSeen: 1, lastSeen: 1 });
  herdr.snap = { workspaces: [{ workspace_id: 'w1', label: 'Live' }], panes: [{ workspace_id: 'w1', cwd: '/live' }] };
  const open = await req('POST', '/api/projects/forget', { body: { root: '/live' } });
  assert.deepEqual([open.status, open.json], [409, { error: 'a space is open for this project' }]);
  const done = await req('POST', '/api/projects/forget', { body: { root: '/old' } });
  assert.deepEqual([done.status, done.json], [200, { ok: true }]);
  assert.equal(srv.ledger.has('/old'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.local/share/corral/projects.json'), 'utf8'));
  assert.deepEqual(saved.projects.map((p) => p.root), ['/live']);
});

test('GET /api/files lists a space folder and refuses what is outside it', async (t) => {
  const root = realTmp();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub/a.txt'), '');
  fs.writeFileSync(path.join(root, '.env'), '');
  const { req, herdr } = await world(t);
  herdr.snap = { workspaces: [{ workspace_id: 'w1', label: 'W' }], panes: [{ workspace_id: 'w1', cwd: root }] };
  const top = await req('GET', '/api/files?space=w1');
  assert.deepEqual(top.json.entries.map((e) => e.name), ['sub']);
  assert.deepEqual((await req('GET', '/api/files?space=w1&path=sub')).json.entries.map((e) => e.name), ['a.txt']);
  assert.equal((await req('GET', '/api/files?space=w1&hidden=1')).json.entries.some((e) => e.name === '.env'), true);
  assert.equal((await req('GET', '/api/files?space=nope')).status, 404);
  assert.equal((await req('GET', '/api/files')).status, 404);
  assert.equal((await req('GET', '/api/files?space=w1&path=..%2F')).status, 403);
  assert.equal((await req('GET', '/api/files?space=w1&path=%2Fetc')).status, 400);
});

test('GET /api/open-with names the file, its type, the saved choice, and the apps', async (t) => {
  const root = realTmp();
  fs.writeFileSync(path.join(root, 'notes.MD'), '');
  const { req, herdr, srv } = await world(t);
  herdr.snap = { workspaces: [{ workspace_id: 'w1', label: 'W' }], panes: [{ workspace_id: 'w1', cwd: root }] };
  const r = await req('GET', '/api/open-with?space=w1&path=notes.MD');
  assert.deepEqual(r.json, { name: 'notes.MD', kind: '.md', saved: null, ...APPS, asText: false });
  srv.openWith.set('.md', 'finder');
  assert.equal((await req('GET', '/api/open-with?space=w1&path=notes.MD')).json.saved, 'finder');
  assert.equal((await req('GET', '/api/open-with?space=w1&path=missing')).status, 404);
  assert.equal((await req('GET', '/api/open-with')).status, 404);
});

test('POST /api/open opens a file, remembers a chosen app, and asks when it has no choice yet', async (t) => {
  const root = realTmp();
  fs.writeFileSync(path.join(root, 'notes.md'), '');
  const { req, herdr, srv, opened, home } = await world(t);
  herdr.snap = { workspaces: [{ workspace_id: 'w1', label: 'W' }], panes: [{ workspace_id: 'w1', cwd: root }] };
  const open = (body) => req('POST', '/api/open', { body: { space: 'w1', path: 'notes.md', ...body } });

  assert.equal((await req('POST', '/api/open', { raw: '{nope' })).status, 400);
  assert.equal((await open({ path: 'missing.md' })).status, 404);
  assert.deepEqual((await open({})).json, { needsChoice: true });

  const typora = APPS.apps[0].path;
  const once = await open({ app: typora });
  assert.deepEqual(once.json, { ok: true, kind: '.md', app: 'Typora', remembered: false });
  assert.equal(srv.openWith.has('.md'), false);

  const kept = await open({ app: typora, remember: true });
  assert.equal(kept.json.remembered, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.local/share/corral/open-with.json'), 'utf8')).defaults['.md'], typora);

  // With no app named, the saved one is used.
  const saved = await open({});
  assert.deepEqual([saved.status, saved.json.app, saved.json.remembered], [200, 'Typora', true]);
  assert.deepEqual(opened.at(-1), ['-a', typora, path.join(root, 'notes.md')]);

  // Finder is never remembered.
  srv.openWith.clear();
  const finder = await open({ app: 'finder', remember: true });
  assert.deepEqual([finder.status, finder.json.app, finder.json.remembered], [200, 'Finder', false]);
  assert.equal(srv.openWith.has('.md'), false);

  // A saved app that is gone asks again; a named app that fails is an error.
  srv.openWith.set('.md', '/Applications/Gone.app');
  const gone = await open({});
  assert.deepEqual([gone.status, gone.json.needsChoice, gone.json.error], [200, true, 'that app does not open this file']);
  const refused = await open({ app: '/Applications/Gone.app' });
  assert.deepEqual([refused.status, refused.json.error], [400, 'that app does not open this file']);
});

test('POST /api/open-with/forget drops a saved choice for a type', async (t) => {
  const { req, srv } = await world(t);
  srv.openWith.set('.md', 'finder');
  assert.equal((await req('POST', '/api/open-with/forget', { raw: '{nope' })).status, 400);
  assert.equal((await req('POST', '/api/open-with/forget', { body: { kind: 5 } })).status, 400);
  const ok = await req('POST', '/api/open-with/forget', { body: { kind: '.md' } });
  assert.deepEqual([ok.status, ok.json, srv.openWith.has('.md')], [200, { ok: true }, false]);
  quiet(t);
  t.mock.method(fs, 'renameSync', () => { throw new Error('full'); });
  assert.deepEqual((await req('POST', '/api/open-with/forget', { body: { kind: '.md' } })).json, { error: 'could not save' });
});

test('GET /api/sessions lists the open windows', async (t) => {
  const { req, srv } = await world(t);
  assert.deepEqual((await req('GET', '/api/sessions')).json, { sessions: [] });
  srv.createSession(os.tmpdir(), 'one', 'sp');
  const r = await req('GET', '/api/sessions');
  assert.deepEqual(r.json.sessions.map((s) => [s.label, s.space, s.persistent]), [['one', 'sp', true]]);
});

test('POST /api/sessions starts a window with a label, a folder, a space, and an optional agent', async (t) => {
  const { req, tmux, srv } = await world(t);
  const dir = realTmp();
  const r = await req('POST', '/api/sessions', { body: { cwd: dir, label: 'Mine', space: 'sp-1', agent: 'claude' } });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.cwd, r.json.label, r.json.space, r.json.remote], [dir, 'Mine', 'sp-1', false]);
  assert.equal(tmux.sessions.get(`wt-${r.json.id}`).options['@corral_space'], 'sp-1');
  assert.match(tmux.sessions.get(`wt-${r.json.id}`).command.at(-1), /claude; exec/);
  assert.equal(srv.sessions.size, 1);

  // A bad space name is dropped, and a non-string agent is ignored.
  const plain = await req('POST', '/api/sessions', { body: { cwd: dir, space: 'bad space!', agent: 7 } });
  assert.deepEqual([plain.status, plain.json.space], [201, null]);
  assert.equal((await req('POST', '/api/sessions', { raw: '{nope' })).status, 400);
});

test('a second window for the same space gets 409 and the window that is already open', async (t) => {
  const { req, srv } = await world(t);
  const dir = realTmp();
  const first = (await req('POST', '/api/sessions', { body: { cwd: dir, space: 'sp-1' } })).json;
  const dup = await req('POST', '/api/sessions', { body: { cwd: dir, space: 'sp-1' } });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.json, { error: 'this space already has a window', existing: first });

  // A window with no space but the same folder also counts.
  const bare = srv.createSession(dir, 'bare');
  const other = await req('POST', '/api/sessions', { body: { cwd: bare.cwd, space: 'sp-2' } });
  assert.equal(other.status, 409);
  assert.equal(other.json.existing.id, bare.id);

  // An ended window does not count; a different space and folder is fine.
  srv.sessions.get(first.id).exited = true;
  srv.sessions.get(bare.id).exited = true;
  assert.equal((await req('POST', '/api/sessions', { body: { cwd: dir, space: 'sp-1' } })).status, 201);
  const nobody = await req('POST', '/api/sessions', { body: { cwd: realTmp(), space: 'sp-9' } });
  assert.equal(nobody.status, 201);
  const noCwd = await req('POST', '/api/sessions', { body: { space: 'sp-10' } });
  assert.equal(noCwd.status, 201);
});

test('POST /api/sessions answers 500 when the shell cannot start', async (t) => {
  let fail = false;
  const { req } = await world(t, { ptyThrows: () => fail });
  fail = true;
  const r = await req('POST', '/api/sessions', { body: { cwd: os.tmpdir() } });
  assert.deepEqual([r.status, r.json], [500, { error: 'could not start shell: pty spawn failed' }]);
});

test('a window started from another device is marked remote, in memory and in tmux', async (t) => {
  const { req, srv, tmux } = await world(t);
  srv.state.tailnet = TAILNET;
  const r = await req('POST', '/api/sessions', { body: { cwd: os.tmpdir() }, headers: remote() });
  assert.deepEqual([r.status, r.json.remote], [201, true]);
  assert.equal(tmux.sessions.get(`wt-${r.json.id}`).options['@corral_remote'], '1');

  const run = tmux.run.bind(tmux); // the mark is best effort: only that one call fails
  tmux.run = (a) => { if (a.includes('@corral_remote')) throw new Error('set-option failed'); return run(a); };
  const again = await req('POST', '/api/sessions', { body: { cwd: os.tmpdir() }, headers: remote() });
  assert.equal(again.status, 201);
  assert.equal(again.json.remote, true);
});

test('a remote window without tmux is marked remote without calling tmux', async (t) => {
  const { req, srv, tmux } = await world(t, { tmux: false });
  srv.state.tailnet = TAILNET;
  const r = await req('POST', '/api/sessions', { body: { cwd: os.tmpdir() }, headers: remote() });
  assert.deepEqual([r.status, r.json.remote, r.json.persistent], [201, true, false]);
  assert.deepEqual(tmux.calls, []);
});

test('DELETE /api/sessions/:id ends the window, closes its sockets, and tolerates failures', async (t) => {
  const { req, srv, tmux, ptys } = await world(t);
  assert.equal((await req('DELETE', '/api/sessions/nope')).status, 404);
  const s = srv.createSession(os.tmpdir(), 'x');
  const ws = { closed: 0, close() { this.closed++; } };
  s.clients.add(ws);
  const r = await req('DELETE', `/api/sessions/${s.id}`);
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(srv.sessions.has(s.id), false);
  assert.equal(tmux.sessions.has(`wt-${s.id}`), false);
  assert.equal(ptys[0].killed, true);
  assert.equal(ws.closed, 1);

  const bad = srv.createSession(os.tmpdir(), 'y');
  tmux.fail.add('kill-session');
  ptys[1].throwOnKill = true;
  assert.equal((await req('DELETE', `/api/sessions/${bad.id}`)).status, 200);
  assert.equal(srv.sessions.has(bad.id), false);
});

test('a plain-shell window is deleted without touching tmux', async (t) => {
  const { req, srv, tmux } = await world(t, { tmux: false });
  const s = srv.createSession(os.tmpdir(), 'x');
  assert.equal((await req('DELETE', `/api/sessions/${s.id}`)).status, 200);
  assert.deepEqual(tmux.calls, []);
});

test('restore: GET lists windows to bring back, POST reopens them, and dismiss throws them away', async (t) => {
  const { req, home, srv } = await world(t);
  const file = path.join(home, '.local/share/corral/restore.json');
  assert.deepEqual((await req('GET', '/api/restore')).json, { savedAt: null, windows: [] });
  writeFile(file, JSON.stringify({ savedAt: 's', windows: [{ label: 'A', claudeSession: 'x' }, { label: 'B' }] }));
  assert.deepEqual((await req('GET', '/api/restore')).json, { savedAt: 's', windows: [{ label: 'A', claude: true }, { label: 'B', claude: false }] });
  const posted = await req('POST', '/api/restore');
  assert.equal(posted.status, 200);
  assert.deepEqual(posted.json.sessions.map((s) => s.label), ['A', 'B']);
  assert.equal(srv.sessions.size, 2);
  assert.equal(fs.existsSync(file), false);

  writeFile(file, JSON.stringify({ windows: [{ label: 'C' }] }));
  const dismissed = await req('POST', '/api/restore/dismiss');
  assert.deepEqual([dismissed.status, dismissed.json], [200, { ok: true }]);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await req('POST', '/api/restore/dismiss')).status, 200); // nothing to remove: still fine
});

test('static files are served with their types, vendor files from node_modules, and / and /m map to the pages', async (t) => {
  const { req } = await world(t);
  const index = await req('GET', '/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.equal(index.text, fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'));
  assert.equal((await req('GET', '/m')).text, fs.readFileSync(path.join(ROOT, 'public/m.html'), 'utf8'));
  assert.equal((await req('GET', '/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await req('GET', '/favicon.svg')).headers['content-type'], 'image/svg+xml');
  assert.equal((await req('GET', '/favicon-32.png')).headers['content-type'], 'image/png');
  assert.equal((await req('GET', '/manifest.webmanifest')).headers['content-type'], 'application/manifest+json');
  const css = await req('GET', '/vendor/xterm.css');
  assert.deepEqual([css.status, css.headers['content-type']], [200, 'text/css; charset=utf-8']);
  assert.equal((await req('GET', '/vendor/xterm.js')).status, 200);
  assert.equal((await req('GET', '/vendor/addon-fit.js')).status, 200);
  assert.equal((await req('GET', '/vendor/addon-web-links.js')).status, 200);
  const missing = await req('GET', '/nope.js');
  assert.deepEqual([missing.status, missing.json], [404, { error: 'not found' }]);
});

test('a file type with no known content type is sent as a download', async (t) => {
  const { req } = await world(t);
  const real = fs.readFile;
  t.mock.method(fs, 'readFile', (file, cb) => (String(file).endsWith('blob.bin') ? cb(null, Buffer.from('bytes')) : real(file, cb)));
  const r = await req('GET', '/blob.bin');
  assert.deepEqual([r.status, r.headers['content-type'], r.text], [200, 'application/octet-stream', 'bytes']);
});

test('a path that resolves outside public/ is refused with 403', async (t) => {
  // The URL parser removes ".." from every request path, so no real request reaches this guard; the join is
  // forced to point outside to show the guard itself works.
  const { req } = await world(t);
  const join = path.join;
  t.mock.method(path, 'join', (...a) => (a.at(-1) === 'escape.js' ? path.resolve(ROOT, 'server.js') : join(...a)));
  const r = await req('GET', '/escape.js');
  assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }]);
});

test('requests that match no route get 404', async (t) => {
  const { req } = await world(t);
  const post = await req('POST', '/nope', { body: {} });
  assert.deepEqual([post.status, post.json], [404, { error: 'not found' }]);
  assert.equal((await req('DELETE', '/api/sessions')).status, 404);
  assert.equal((await req('PUT', '/api/categories', { body: {} })).status, 404);
  assert.equal((await req('HEAD', '/index.html')).status, 404);
});

test('an empty body reads as {}, which is not a valid categories document', async (t) => {
  const { req } = await world(t);
  assert.equal((await req('POST', '/api/categories', { raw: '' })).status, 400);
});

test('a body over 64 KB is cut off and never saved', async (t) => {
  const { req, srv } = await world(t);
  const big = JSON.stringify({ categories: [], assign: {}, pad: 'x'.repeat(70 * 1024) });
  const r = await req('POST', '/api/categories', { raw: big }).catch(() => ({ status: 'closed' }));
  assert.notEqual(r.status, 200);
  assert.deepEqual(srv.state.categories.categories, []);
});

test('readJson resolves the parsed body, {} when empty, and null when the request closes early', async () => {
  const { srv } = loadServer();
  const { EventEmitter } = require('events');
  const feed = (chunks, end = true) => {
    const r = new EventEmitter();
    r.destroy = () => r.emit('close');
    const p = srv.readJson(r, 20);
    for (const c of chunks) r.emit('data', c);
    if (end) r.emit('end');
    return p;
  };
  assert.deepEqual(await feed(['{"a":', '1}']), { a: 1 });
  assert.deepEqual(await feed([]), {});
  assert.equal(await feed(['{nope']), null);
  assert.equal(await feed(['x'.repeat(30)], false), null);
});
