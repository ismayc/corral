const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadServer, tick, PORT } = require('../helpers/server');
const { UUID1, quiet, fakeHerdr, writeFile } = require('../helpers/platform');

const data = (home, f) => path.join(home, '.local/share/corral', f);

// A tailscale status document for a Mac named "mac" owned by me@example.com.
const status = (over = {}) => JSON.stringify({
  Self: { DNSName: 'mac.tail1234.ts.net.', UserID: 7, HostName: 'Mac' },
  User: { 7: { LoginName: 'me@example.com' } },
  ...over,
});
const serveStatus = (host, proxy) => JSON.stringify({ Web: { [host]: { Handlers: { '/': { Proxy: proxy } } } } });

function tailscale(opts) {
  const calls = [];
  const h = loadServer({
    tailscale: true,
    exec: { tailscale: (args) => { calls.push(args); return args[0] === 'status' ? opts.status : opts.serve(); } },
  });
  return { ...h, calls };
}

test('detectTailnet records the tailnet name, the owner login, and whether tailscale serve forwards here', async (t) => {
  const out = quiet(t);
  const { srv, calls } = tailscale({ status: status(), serve: () => serveStatus('mac.tail1234.ts.net:8443', `http://127.0.0.1:${PORT}`) });
  srv.detectTailnet();
  await tick(30);
  const tn = srv.state.tailnet;
  assert.equal(tn.host, 'mac.tail1234.ts.net:8443');
  assert.equal(tn.origin, 'https://mac.tail1234.ts.net:8443');
  assert.equal(tn.url, 'https://mac.tail1234.ts.net:8443/');
  assert.deepEqual([...tn.logins], ['me@example.com']);
  assert.deepEqual([tn.machine, tn.served], ['Mac', true]);
  assert.deepEqual(calls, [['status', '--json'], ['serve', 'status', '--json']]);
  assert.deepEqual(out.logs, ['tailnet access: https://mac.tail1234.ts.net:8443/ for me@example.com']);

  // The same answer again is not announced twice.
  srv.detectTailnet();
  await tick(30);
  assert.equal(out.logs.length, 1);
});

test('detectTailnet announces a change of name or of serve state, and tells how to serve when it is not served', async (t) => {
  const out = quiet(t);
  let proxy = 'http://localhost:9999';
  let name = 'mac.tail1234.ts.net.';
  const { srv } = tailscale({
    get status() { return status({ Self: { DNSName: name, UserID: 7 } }); },
    serve: () => serveStatus(`${name.replace(/\.$/, '')}:8443`, proxy),
  });
  srv.detectTailnet();
  await tick(30);
  assert.equal(srv.state.tailnet.served, false); // wrong port
  assert.equal(srv.state.tailnet.machine, 'mac.tail1234.ts.net'); // no HostName: the DNS name
  assert.match(out.logs[0], /\(not served yet: tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:18777\)$/);

  proxy = `127.0.0.1:${PORT}/`; // another accepted spelling
  srv.detectTailnet();
  await tick(30);
  assert.equal(srv.state.tailnet.served, true);
  assert.equal(out.logs.length, 2);

  name = 'renamed.tail1234.ts.net.';
  srv.detectTailnet();
  await tick(30);
  assert.equal(srv.state.tailnet.host, 'renamed.tail1234.ts.net:8443');
  assert.equal(out.logs.length, 3);
  proxy = 'https://example.com'; // not loopback
  srv.detectTailnet();
  await tick(30);
  assert.equal(srv.state.tailnet.served, false);
});

test('detectTailnet uses the allowed logins and port from the environment', async (t) => {
  quiet(t);
  const h = loadServer({ tailscale: true, env: { CORRAL_TAILSCALE_USERS: ' a@x.com, b@x.com ,', CORRAL_TAILSCALE_PORT: '9443' }, exec: { tailscale: (args) => (args[0] === 'status' ? status({ User: {} }) : '') } });
  h.srv.detectTailnet();
  await tick(30);
  assert.deepEqual([...h.srv.state.tailnet.logins], ['a@x.com', 'b@x.com']);
  assert.equal(h.srv.state.tailnet.host, 'mac.tail1234.ts.net:9443');
  assert.equal(h.srv.state.tailnet.served, false); // serve status printed nothing
});

test('detectTailnet ignores a missing tailscale, an opt-out, errors, and statuses that name no usable Mac', async () => {
  const none = loadServer();
  none.srv.detectTailnet();
  await tick(10);
  assert.equal(none.srv.state.tailnet, null);

  const off = loadServer({ tailscale: true, env: { CORRAL_TAILSCALE: '0' }, exec: { tailscale: () => { throw new Error('should not run'); } } });
  off.srv.detectTailnet();
  await tick(10);
  assert.equal(off.srv.state.tailnet, null);

  const bad = [
    new Error('tailscale is not running'),
    'not json',
    status({ Self: { DNSName: 'mac.example.com.', UserID: 7 } }), // not a ts.net name
    status({ Self: undefined }),
    status({ User: {} }), // no owner and no allowed logins
  ];
  for (const s of bad) {
    const h = loadServer({ tailscale: true, exec: { tailscale: () => { if (s instanceof Error) throw s; return s; } } });
    h.srv.detectTailnet();
    await tick(20);
    assert.equal(h.srv.state.tailnet, null, String(s).slice(0, 40));
  }
});

test('detectTailnet treats a serve status without a matching forward as not served', async (t) => {
  quiet(t);
  const host = 'mac.tail1234.ts.net:8443';
  const docs = ['{}', '{"Web":{}}', JSON.stringify({ Web: { [host]: {} } }), JSON.stringify({ Web: { [host]: { Handlers: {} } } }), JSON.stringify({ Web: { [host]: { Handlers: { '/': {} } } } })];
  for (const doc of docs) {
    const { srv } = tailscale({ status: status(), serve: () => doc });
    srv.detectTailnet();
    await tick(30);
    assert.equal(srv.state.tailnet.served, false, doc);
  }
});

test('requestAccess classifies a request as local, remote with a login, or refused', () => {
  const { srv } = loadServer();
  const req = (headers) => ({ headers });
  const local = srv.requestAccess(req({ host: `127.0.0.1:${PORT}` }));
  assert.equal(local.local, true);
  assert.equal(local.origins.has(`http://localhost:${PORT}`), true);
  assert.equal(srv.requestAccess(req({ host: `LOCALHOST:${PORT}` })).local, true);
  assert.equal(srv.requestAccess(req({})), null);
  assert.equal(srv.requestAccess(req({ host: 'mac.tail1234.ts.net:8443', 'tailscale-user-login': 'me@example.com' })), null); // no tailnet yet
  srv.state.tailnet = { host: 'mac.tail1234.ts.net:8443', origin: 'https://mac.tail1234.ts.net:8443', logins: new Set(['me@example.com']) };
  const remote = srv.requestAccess(req({ host: 'Mac.Tail1234.ts.net:8443', 'tailscale-user-login': 'me@example.com' }));
  assert.deepEqual([remote.remote, remote.login, [...remote.origins]], [true, 'me@example.com', ['https://mac.tail1234.ts.net:8443']]);
  assert.equal(srv.requestAccess(req({ host: 'mac.tail1234.ts.net:8443', 'tailscale-user-login': 'x@example.com' })), null);
  assert.equal(srv.requestAccess(req({ host: 'mac.tail1234.ts.net:8443' })), null);
  assert.equal(srv.requestAccess(req({ host: 'other.ts.net:8443', 'tailscale-user-login': 'me@example.com' })), null);
});

test('legacyTmuxInUse is true only while pre-rename wt- sessions are alive on the old socket', () => {
  assert.equal(loadServer({ legacy: true }).srv.legacyTmuxInUse(), true);
  assert.equal(loadServer().srv.legacyTmuxInUse(), false);
  assert.equal(loadServer({ legacy: 'throw' }).srv.legacyTmuxInUse(), false);
});

// start() with timers and signal handlers stubbed, listening on a free port.
async function started(t, opts = {}, prep = () => {}, loaded = null) {
  const out = quiet(t);
  const h = loaded || loadServer(opts);
  prep(h);
  const timers = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; });
  const handlers = {};
  t.mock.method(process, 'on', (sig, fn) => { handlers[sig] = fn; return process; });
  const server = h.srv.start(0);
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return { ...h, out, timers, handlers, server };
}

test('start scrubs tmux, adopts live windows, queues lost ones for restore, and loads saved state', async (t) => {
  const state = { calls: [], snap: { workspaces: [{ workspace_id: 'w1', label: 'Proj' }], panes: [{ workspace_id: 'w1', cwd: '/work/proj' }] } };
  process.env.CLAUDECODE = '1';
  t.after(() => { delete process.env.CLAUDECODE; });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'start-'));
  const h = loadServer({ exec: { herdr: fakeHerdr(state) } });
  process.env.CLAUDECODE = '1';
  h.tmux.add('wt-live', { created: 1000, path: dir, options: { '@corral_label': 'Live' } });
  const d = (f) => data(h.home, f);
  writeFile(d('open-sessions.json'), JSON.stringify({ savedAt: 'then', windows: [{ id: 'live', label: 'Live' }, { id: 'lost', label: 'Lost' }] }));
  writeFile(d('categories.json'), JSON.stringify({ categories: [{ name: 'Work' }], assign: {} }));
  writeFile(d('open-with.json'), JSON.stringify({ defaults: { '.md': 'finder' } }));
  writeFile(d('projects.json'), JSON.stringify({ projects: [{ root: '/saved', label: 'Saved', firstSeen: 1, lastSeen: 1 }] }));
  writeFile(path.join(d('uploads'), 'photo-old.png'), 'x');
  fs.utimesSync(path.join(d('uploads'), 'photo-old.png'), 1, 1);

  const { out, timers, handlers, server } = await started(t, undefined, undefined, h);
  await tick(30); // the first herdr snapshot arrives

  assert.equal(server, h.srv.server);
  assert.ok(h.tmux.env.some((e) => e.at(-1) === 'CLAUDECODE'));
  assert.deepEqual([...h.srv.sessions.keys()], ['live']);
  assert.deepEqual(JSON.parse(fs.readFileSync(d('restore.json'), 'utf8')).windows, [{ id: 'lost', label: 'Lost' }]);
  assert.equal(JSON.parse(fs.readFileSync(d('open-sessions.json'), 'utf8')).windows[0].id, 'live'); // the backup now mirrors what runs
  assert.equal(h.srv.state.categories.categories[0].name, 'Work');
  assert.equal(h.srv.openWith.get('.md'), 'finder');
  assert.ok(h.srv.state.push.publicKey);
  assert.equal(fs.existsSync(path.join(d('uploads'), 'photo-old.png')), false);
  assert.deepEqual([...h.srv.ledger.keys()].sort(), ['/saved', '/work/proj']);
  assert.deepEqual(timers.map((x) => x[1]), [30000, 3000, 6 * 3600000, 30000, 60000]);
  assert.match(out.logs.at(-1), /^Corral listening on http:\/\/127\.0\.0\.1:\d+ \(tmux corral\)$/);
  assert.equal(typeof handlers.SIGINT, 'function');
  assert.equal(handlers.SIGTERM, handlers.SIGINT);
});

test('start seeds the ledger from herdr snapshots on a first run, and says so when tmux is missing', async (t) => {
  const h = loadServer({ tmux: false });
  const snaps = path.join(h.home, '.config/herdr/session-snapshots');
  writeFile(path.join(snaps, 'a.json'), JSON.stringify({ workspaces: [{ identity_cwd: '/work/seeded', custom_name: 'Seeded' }] }));
  const { out } = await started(t, undefined, undefined, h);
  assert.equal(h.srv.ledger.get('/work/seeded').label, 'Seeded');
  assert.deepEqual(h.tmux.calls, []);
  assert.match(out.logs.at(-1), /\(no tmux, plain shells\)$/);
});

test('the recurring jobs registered by start are the backup, the watcher, the photo cleanup, the herdr poll, and the tailnet check', async (t) => {
  const { srv, timers, home } = await started(t);
  const [saveBackup, watch, prune, snapshot, detect] = timers.map((x) => x[0]);
  assert.equal(saveBackup, srv.saveBackup);
  assert.equal(snapshot, srv.herdrSnapshot);
  assert.equal(detect, srv.detectTailnet);
  assert.equal(typeof watch, 'function');
  const old = path.join(home, '.local/share/corral/uploads/photo-old.png');
  writeFile(old, 'x');
  fs.utimesSync(old, 1, 1);
  prune();
  assert.equal(fs.existsSync(old), false);
  fs.rmSync(path.join(home, '.local/share/corral/open-sessions.json'));
  saveBackup();
  assert.equal(fs.existsSync(path.join(home, '.local/share/corral/open-sessions.json')), true);
});

test('shutdown detaches from every window and exits, even when a pty will not die', (t) => {
  const { srv, ptys } = loadServer();
  const exit = t.mock.method(process, 'exit', () => {});
  srv.createSession(os.tmpdir(), 'a');
  srv.createSession(os.tmpdir(), 'b');
  ptys[0].throwOnKill = true;
  srv.shutdown();
  assert.deepEqual([ptys[0].killed, ptys[1].killed], [false, true]);
  assert.deepEqual(exit.mock.calls.map((c) => c.arguments), [[0]]);
});

test('the signal handlers installed by start run shutdown', async (t) => {
  const { handlers, ptys, srv } = await started(t);
  const exit = t.mock.method(process, 'exit', () => {});
  srv.createSession(os.tmpdir(), 'a');
  handlers.SIGTERM();
  assert.equal(ptys.at(-1).killed, true);
  assert.equal(exit.mock.callCount(), 1);
});

test('a restore after start brings back the windows that were running before', async (t) => {
  const h = loadServer();
  writeFile(data(h.home, 'open-sessions.json'), JSON.stringify({ savedAt: 'then', windows: [{ id: 'gone', label: 'Gone', cwd: h.home, claudeSession: UUID1 }] }));
  await started(t, undefined, undefined, h);
  const r = h.srv.restoreList();
  assert.deepEqual(r.windows.map((w) => w.label), ['Gone']);
  const done = h.srv.restoreWindows();
  assert.deepEqual(done.notResumed, ['Gone']); // the conversation file is not on this machine
  assert.equal(done.sessions[0].cwd, h.home);
});

test('running server.js directly starts it, serves requests, and exits cleanly on SIGTERM', async () => {
  const { spawn } = require('child_process');
  const net = require('net');
  const http = require('http');
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'main-'));
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [path.join(__dirname, '../../server.js')], {
    env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/zsh', CORRAL_PORT: String(port), CORRAL_TAILSCALE: '0', CORRAL_TMUX_SOCKET: `corral-test-${process.pid}`, HERDR_BIN: path.join(home, 'no-herdr') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  try {
    for (let i = 0; i < 300 && !log.includes('Corral listening'); i++) await tick(20);
    assert.match(log, new RegExp(`Corral listening on http://127.0.0.1:${port} `));
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/sessions' }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t)); }).on('error', reject);
    });
    assert.deepEqual(JSON.parse(body), { sessions: [] });
  } finally { child.kill('SIGTERM'); }
  assert.deepEqual(await exited, { code: 0, signal: null });
});
