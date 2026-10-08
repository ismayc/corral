// New repos: git folders made in the repos folder lately that herdr has never had a space for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadServer, listen } = require('../helpers/server');
const { fakeHerdr } = require('../helpers/platform');

const DAY = 86400000;
// A folder in the repos folder; git: true gives it a .git folder.
function folder(home, name, git = true) {
  const d = path.join(home, 'repos', name);
  fs.mkdirSync(git ? path.join(d, '.git') : d, { recursive: true });
  return d;
}
// Makes some folders look older than they are (birth time is not settable on macOS).
function ages(t, days) {
  const real = fs.statSync;
  t.mock.method(fs, 'statSync', (p, ...a) => {
    const st = real(p, ...a);
    const n = days[path.basename(p)];
    return n === undefined ? st : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { birthtimeMs: Date.now() - n * DAY });
  });
}

async function world(t) {
  const herdr = { calls: [], snap: { workspaces: [], panes: [] } };
  const h = loadServer({ exec: { herdr: fakeHerdr(herdr), 'herdr-sort-spaces': () => '' } });
  const http = await listen(h.srv);
  t.after(() => http.close());
  return { ...h, herdr, req: http.request };
}

test('the repos folder defaults to ~/repos and can be set with CORRAL_REPOS', () => {
  let { srv, home } = loadServer();
  assert.equal(srv.constants.REPOS_DIR, path.join(home, 'repos'));
  ({ srv } = loadServer({ env: { CORRAL_REPOS: '/srv/code' } }));
  assert.equal(srv.constants.REPOS_DIR, '/srv/code');
});

test('newRepos lists recent git folders with no space, newest first', (t) => {
  const { srv, home } = loadServer();
  assert.deepEqual(srv.newRepos(), [], 'no repos folder yet');
  const a = folder(home, 'a');
  const b = folder(home, 'b');
  folder(home, 'plain', false); // not a git repo
  folder(home, 'old'); // made before the two-week window
  const known = folder(home, 'known'); // herdr has had a space for it
  fs.writeFileSync(path.join(home, 'repos', 'notes.txt'), '');
  srv.ledger.set(known, { root: known, label: 'known', firstSeen: 1, lastSeen: 1 });
  ages(t, { a: 2, b: 1, old: 20 });
  const list = srv.newRepos();
  assert.deepEqual(list.map((r) => [r.root, r.label]), [[b, 'b'], [a, 'a']]);
  assert.ok(list[0].born > list[1].born);
});

test('a hidden repo stays out of the list, and hiding keeps the earlier ones', () => {
  const { srv, home } = loadServer();
  const a = folder(home, 'a');
  const b = folder(home, 'b');
  srv.hideRepo(a);
  assert.deepEqual(srv.newRepos().map((r) => r.root), [b]);
  srv.hideRepo(b);
  assert.deepEqual(srv.newRepos(), []);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.local/share/corral/hidden-repos.json'), 'utf8'));
  assert.deepEqual(saved.roots, [a, b]);
});

test('GET /api/projects includes the new repos and the repos folder with ~ for home', async (t) => {
  const { req, home } = await world(t);
  const d = folder(home, 'fresh');
  const r = await req('GET', '/api/projects');
  assert.deepEqual(r.json.newRepos.map((x) => x.root), [d]);
  assert.equal(r.json.reposDir, '~/repos');
});

test('reopen makes a herdr space for a new repo under its folder name, and nothing else outside the ledger', async (t) => {
  const { req, herdr, home } = await world(t);
  const d = folder(home, 'fresh');
  folder(home, 'plain', false);
  herdr.other = () => '';
  const ok = await req('POST', '/api/projects/reopen', { body: { root: d } });
  assert.deepEqual([ok.status, ok.json.label], [200, 'fresh']);
  assert.deepEqual(herdr.calls.find((c) => c[0] === 'workspace'), ['workspace', 'create', '--cwd', d, '--label', 'fresh', '--no-focus']);
  const no = await req('POST', '/api/projects/reopen', { body: { root: path.join(home, 'repos', 'plain') } });
  assert.equal(no.status, 404);
});

test('POST /api/projects/hide hides a new repo and refuses anything else', async (t) => {
  const { req, home } = await world(t);
  const d = folder(home, 'fresh');
  assert.equal((await req('POST', '/api/projects/hide', { raw: '{nope' })).status, 400);
  assert.equal((await req('POST', '/api/projects/hide', { body: { root: 5 } })).status, 400);
  const other = await req('POST', '/api/projects/hide', { body: { root: '/etc' } });
  assert.deepEqual([other.status, other.json], [404, { error: 'not a new repo' }]);
  const ok = await req('POST', '/api/projects/hide', { body: { root: d } });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.deepEqual((await req('GET', '/api/projects')).json.newRepos, []);
});
