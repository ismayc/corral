const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mock } = require('node:test');
const { setup } = require('../helpers/claude');

// Runs the real git in a folder (spawnSync is not one of the calls the harness fakes).
function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function makeRepo(home, name = 'repo') {
  const dir = path.join(home, name);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('git returns the output of a git command, or null when it fails', async () => {
  const c = setup();
  const dir = makeRepo(c.home);
  assert.equal((await c.srv.git(dir, ['branch', '--show-current'])).trim(), 'main');
  assert.equal(await c.srv.git(path.join(c.home, 'nowhere'), ['status']), null);
});

test('git runs without taking the index lock and without Claude Code variables', async () => {
  let seen;
  const c = setup({ exec: { git: (args, opts) => { seen = { args, env: opts.env }; return 'out'; } } });
  process.env.CLAUDECODE = '1';
  assert.equal(await c.srv.git('/some/dir', ['status']), 'out');
  delete process.env.CLAUDECODE;
  assert.deepEqual(seen.args, ['-C', '/some/dir', 'status']);
  assert.equal(seen.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal('CLAUDECODE' in seen.env, false);
});

test('windowChanges reports no repository for a folder outside git', async () => {
  const c = setup();
  const plain = path.join(c.home, 'plain');
  fs.mkdirSync(plain);
  const s = c.open('a', plain);
  assert.deepEqual(await c.srv.windowChanges(s), { status: 200, repo: null, cwd: plain });
});

test('windowChanges lists changed files and the diff against HEAD', async () => {
  const c = setup();
  const dir = makeRepo(c.home);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n');
  fs.rmSync(path.join(dir, 'b.txt'));
  const s = c.open('proj', dir);
  const r = await c.srv.windowChanges(s);
  assert.equal(r.status, 200);
  assert.equal(r.repo, 'repo');
  assert.equal(r.root, dir);
  assert.equal(r.branch, 'main');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.files, [{ code: ' M', path: 'a.txt' }, { code: ' D', path: 'b.txt' }]);
  assert.match(r.diff, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(r.diff, /\+gamma/);
  assert.match(r.diff, /-bee/);
});

test('windowChanges shows the start of small new text files, and skips big, binary, and non-file ones', async () => {
  const c = setup();
  const dir = makeRepo(c.home);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hello\nworld\n');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(64 * 1024 + 1));
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([65, 0, 66]));
  fs.mkdirSync(path.join(dir, 'folder'));
  fs.symlinkSync(path.join(dir, 'folder'), path.join(dir, 'link'));
  const r = await c.srv.windowChanges(c.open('proj', dir));
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['big.txt', 'blob.bin', 'link', 'new.txt']);
  assert.equal(r.diff, 'diff --git a/new.txt b/new.txt\nnew file (not added to git yet)\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n');
});

test('windowChanges uses the folder Claude is working in, and finds the repository root from it', async () => {
  const c = setup();
  const dir = makeRepo(c.home);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), 'x\n');
  const s = c.open('proj', c.home);
  c.claude(s, { cwd: path.join(dir, 'sub') });
  const r = await c.srv.windowChanges(s);
  assert.equal(r.repo, 'repo');
  assert.equal(r.root, dir);
  assert.deepEqual(r.files, [{ code: '??', path: 'sub/x.txt' }]);
});

test('windowChanges copes with a repository that has no commits and with a detached HEAD', async () => {
  const c = setup();
  const fresh = path.join(c.home, 'fresh');
  fs.mkdirSync(fresh);
  sh(fresh, 'init', '-q', '-b', 'trunk');
  fs.writeFileSync(path.join(fresh, 'a.txt'), 'a\n');
  const r = await c.srv.windowChanges(c.open('fresh', fresh));
  assert.equal(r.branch, 'trunk');
  assert.deepEqual(r.files, [{ code: '??', path: 'a.txt' }]);
  assert.match(r.diff, /^diff --git a\/a\.txt b\/a\.txt\nnew file/);

  const dir = makeRepo(c.home, 'second');
  sh(dir, 'checkout', '-q', '--detach');
  assert.equal((await c.srv.windowChanges(c.open('second', dir))).branch, '');
});

// A fake git whose answers the test controls, for cases real git cannot make on demand.
function fakeGit(top, answers) {
  return (args) => {
    const cmd = args[2] === 'rev-parse' ? 'rev-parse' : args[2] === 'branch' ? 'branch' : args[2] === 'status' ? 'status' : 'diff';
    const a = answers[cmd];
    const v = typeof a === 'function' ? a(args) : a;
    if (v instanceof Error) throw v;
    return cmd === 'rev-parse' ? `${top}\n` : v;
  };
}

test('windowChanges tolerates failing branch, status, and diff commands', async () => {
  const boom = new Error('git failed');
  const c = setup({ exec: { git: fakeGit('/tmp/proj-x', { branch: boom, status: boom, diff: boom }) } });
  const r = await c.srv.windowChanges(c.open('a'));
  assert.deepEqual(r, { status: 200, repo: 'proj-x', root: '/tmp/proj-x', branch: '', files: [], diff: '', truncated: false });
});

test('windowChanges cuts a diff over 600 KB and flags it', async () => {
  const c = setup({ exec: { git: fakeGit('/tmp/p', { branch: 'main\n', status: '', diff: 'x'.repeat(700 * 1024) }) } });
  const r = await c.srv.windowChanges(c.open('a'));
  assert.equal(r.truncated, true);
  assert.equal(r.diff.length, 600 * 1024);
});

test('windowChanges lists at most 500 files, and previews at most 20 new ones, 200 lines each', async () => {
  const c = setup();
  const top = path.join(c.home, 'many');
  fs.mkdirSync(top);
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(top, `f${String(i).padStart(2, '0')}.txt`), i === 0 ? Array.from({ length: 250 }, (_, n) => `l${n}`).join('\n') : 'one line');
  const status = [...Array.from({ length: 25 }, (_, i) => `?? f${String(i).padStart(2, '0')}.txt`), ...Array.from({ length: 600 }, (_, i) => ` M mod${i}`)].join('\n');
  const c2 = setup({ exec: { git: fakeGit(top, { branch: 'main', status, diff: '' }) } });
  const r = await c2.srv.windowChanges(c2.open('a'));
  assert.equal(r.files.length, 500);
  const previews = r.diff.match(/^diff --git /gm);
  assert.equal(previews.length, 20);
  assert.match(r.diff, /@@ -0,0 \+1,200 @@/);
  assert.match(r.diff, /\+l199\n/);
  assert.doesNotMatch(r.diff, /\+l200/);
  assert.doesNotMatch(r.diff, /f20\.txt/);
});

test('windowChanges skips a new file that vanished before it was read', async () => {
  const c = setup({ exec: { git: fakeGit('/tmp/p', { branch: 'main', status: '?? ghost.txt', diff: 'D\n' }) } });
  const r = await c.srv.windowChanges(c.open('a'));
  assert.deepEqual(r.files, [{ code: '??', path: 'ghost.txt' }]);
  assert.equal(r.diff, 'D\n');
});

test('windowChanges shows a new file without a final newline in full', async () => {
  const c = setup();
  const top = path.join(c.home, 'solo');
  fs.mkdirSync(top);
  fs.writeFileSync(path.join(top, 'n.txt'), 'only');
  const c2 = setup({ exec: { git: fakeGit(top, { branch: 'main', status: '?? n.txt', diff: '' }) } });
  assert.match((await c2.srv.windowChanges(c2.open('a'))).diff, /@@ -0,0 \+1,1 @@\n\+only\n$/);
});

const png = Buffer.from('89504e470d0a1a0a', 'hex');

test('saveUpload stores the photo in the uploads folder with a type-based extension', () => {
  const c = setup();
  const types = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/webp': '.webp', 'image/gif': '.gif' };
  for (const [type, ext] of Object.entries(types)) {
    const r = c.srv.saveUpload({ type, data: png.toString('base64') });
    assert.equal(r.status, 201);
    assert.equal(path.dirname(r.path), c.srv.constants.UPLOAD_DIR);
    assert.match(path.basename(r.path), new RegExp(`^photo-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-[a-z0-9]{1,4}\\${ext}$`));
    assert.deepEqual(fs.readFileSync(r.path), png);
    assert.equal(fs.statSync(r.path).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(c.srv.constants.UPLOAD_DIR).mode & 0o777, 0o700);
});

test('saveUpload refuses anything but a supported image type with text data', () => {
  const c = setup();
  const bad = { status: 400, error: 'send a photo (JPEG, PNG, HEIC, WebP, or GIF)' };
  const data = png.toString('base64');
  assert.deepEqual(c.srv.saveUpload({ type: 'image/svg+xml', data }), bad);
  assert.deepEqual(c.srv.saveUpload({ type: 'image/png', data: 5 }), bad);
  assert.deepEqual(c.srv.saveUpload({ type: 'image/png' }), bad);
  assert.deepEqual(c.srv.saveUpload({}), bad);
  assert.deepEqual(c.srv.saveUpload(null), bad);
  assert.equal(fs.existsSync(c.srv.constants.UPLOAD_DIR), false);
});

test('saveUpload refuses an empty photo or one over 20 MB', () => {
  const c = setup();
  const big = { status: 413, error: 'the photo is empty or too large' };
  assert.deepEqual(c.srv.saveUpload({ type: 'image/png', data: '' }), big);
  assert.deepEqual(c.srv.saveUpload({ type: 'image/png', data: '!!!' }), big);
  assert.deepEqual(c.srv.saveUpload({ type: 'image/png', data: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') }), big);
  assert.equal(c.srv.saveUpload({ type: 'image/png', data: Buffer.alloc(20 * 1024 * 1024).toString('base64') }).status, 201);
});

test('pruneUploads deletes photos older than 14 days and keeps the rest', () => {
  const c = setup();
  const dir = c.srv.constants.UPLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const day = 86400;
  const make = (name, ageDays) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    const t = Date.now() / 1000 - ageDays * day;
    fs.utimesSync(f, t, t);
  };
  make('photo-old.jpg', 15);
  make('photo-new.jpg', 13);
  make('notes.txt', 40);
  const log = mock.method(console, 'log', () => {});
  c.srv.pruneUploads();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'photo-new.jpg']);
  assert.deepEqual(log.mock.calls.map((x) => x.arguments[0]), ['deleted 1 photo(s) older than 14 days']);
});

test('pruneUploads is quiet when nothing is old, when the folder is missing, or when a file cannot be read', () => {
  const c = setup();
  const log = mock.method(console, 'log', () => {});
  c.srv.pruneUploads(); // no folder
  const dir = c.srv.constants.UPLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'photo-fresh.png'), 'x');
  fs.symlinkSync(path.join(dir, 'missing-target'), path.join(dir, 'photo-dangling.png'));
  c.srv.pruneUploads();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['photo-dangling.png', 'photo-fresh.png']);
  assert.equal(log.mock.calls.length, 0);
});
