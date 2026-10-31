const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { JSDOM } = require('jsdom');

const W = require('../../scripts/corral-watch.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corral-watch-'));
const OWNER = 'me@example.com';
const MINI = 'mini.tail1.ts.net';

// `tailscale status --json` on the mini, with the MacBook Pro as a peer.
function tsStatus({ online = false, lastSeen = '2026-10-30T20:15:00Z', peer = true, owner = OWNER } = {}) {
  return JSON.stringify({
    Self: { DNSName: `${MINI}.`, UserID: 1 },
    User: owner ? { 1: { LoginName: owner } } : {},
    Peer: peer ? {
      a: { HostName: 'phone', DNSName: 'phone.tail1.ts.net.' },
      b: { HostName: 'Chesters-MacBook-Pro', DNSName: 'chesters-macbook-pro.tail1.ts.net.', Online: online, LastSeen: lastSeen, TailscaleIPs: ['100.64.0.2'] },
    } : undefined,
  });
}
// `tailscale status --json` on the MacBook Pro, as the SSH probe prints it.
const macStatus = (state = 'Running', owner = OWNER) => JSON.stringify({ BackendState: state, Self: { UserID: 1 }, User: owner ? { 1: { LoginName: owner } } : {} });
const probeOut = ({ app = 'yes', corral = '200', status = macStatus() } = {}) => `app=${app}\ncorral=${corral}\n---\n${status}\n`;
const PING_OK = { ok: true, out: 'PING Chesters-MacBook-Pro.local (192.168.1.20): 56 data bytes\n64 bytes from 192.168.1.20', err: '' };
const PING_DOWN = { ok: false, out: '', err: 'ping: cannot resolve Chesters-MacBook-Pro.local: Unknown host' };
const ARP = { ok: true, out: '? (192.168.1.20) at a:b:c:d:e:f on en0 ifscope [ethernet]\n', err: '' };

// A stand-in for running programs: answers by command name from `world`, and records every call.
function fakeRun(world) {
  const calls = [];
  const fn = async (cmd, args, timeout) => {
    calls.push({ cmd, args, timeout });
    const key = cmd.endsWith('tailscale') || cmd.endsWith('Tailscale') ? 'ts' : cmd;
    const v = world[key];
    const r = typeof v === 'function' ? v(args) : v;
    return r || { ok: false, out: '', err: `${cmd}: not found` };
  };
  fn.calls = calls;
  return fn;
}

function cfgFor(dir, env = {}) {
  return W.config({ WATCH_TARGET: 'chesters-macbook-pro', WATCH_STATE: path.join(dir, 'watch.json'), WATCH_TAILSCALE_BIN: 'tailscale', ...env });
}

// A request/response pair for handle().
function exchange(w, method, url, headers = {}) {
  return new Promise((resolve) => {
    const res = {
      writeHead(code, h) { this.code = code; this.headers = h; },
      end(body) { const json = (() => { try { return JSON.parse(body); } catch { return null; } })(); resolve({ code: this.code, headers: this.headers, body, json }); },
    };
    w.handle({ method, url, headers }, res);
  });
}
const LOCAL = { host: '127.0.0.1:8778' };

test('config reads its settings from the environment, with defaults', () => {
  const c = W.config({});
  assert.equal(c.port, 8778);
  assert.equal(c.tsPort, 8444);
  assert.equal(c.target, '');
  assert.equal(c.broadcast, '255.255.255.255');
  assert.equal(c.corralPort, 8777);
  assert.equal(c.repo, '$HOME/repos/corral');
  assert.deepEqual(c.users, []);
  assert.equal(c.stateFile, path.join(os.homedir(), '.local', 'share', 'corral', 'watch.json'));
  const d = W.config({ WATCH_PORT: '9000', WATCH_TAILSCALE_PORT: '9443', WATCH_TARGET: ' MBP ', WATCH_LAN_HOST: 'mbp.lan', WATCH_SSH: 'me@mbp',
    WATCH_MAC: 'aa:bb:cc:dd:ee:ff', WATCH_BROADCAST: '192.168.1.255', WATCH_CORRAL_PORT: '9777', WATCH_CORRAL_REPO: '/src/corral',
    WATCH_USERS: 'a@x.com, b@x.com,', WATCH_STATE: '/s.json', WATCH_TAILSCALE_BIN: '/bin/ts' });
  assert.deepEqual([d.port, d.tsPort, d.target, d.lanHost, d.ssh, d.mac, d.broadcast, d.corralPort, d.repo, d.users, d.stateFile, d.tsBin],
    [9000, 9443, 'mbp', 'mbp.lan', 'me@mbp', 'aa:bb:cc:dd:ee:ff', '192.168.1.255', 9777, '/src/corral', ['a@x.com', 'b@x.com'], '/s.json', '/bin/ts']);
});

test('config finds the tailscale command where it is installed, or falls back to the PATH', () => {
  const m = mock.method(fs, 'existsSync', (p) => p === '/opt/homebrew/bin/tailscale');
  try { assert.equal(W.config({}).tsBin, '/opt/homebrew/bin/tailscale'); } finally { m.mock.restore(); }
  const n = mock.method(fs, 'existsSync', () => false);
  try { assert.equal(W.config({}).tsBin, 'tailscale'); } finally { n.mock.restore(); }
});

test('run resolves with the output, or with the error text when the program fails', async () => {
  assert.deepEqual(await W.run(process.execPath, ['-e', 'process.stdout.write("hi")'], 5000), { ok: true, out: 'hi', err: '' });
  assert.deepEqual(await W.run(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(2)'], 5000), { ok: false, out: '', err: 'bad' });
  const r = await W.run('/no/such/program', [], 5000);
  assert.equal(r.ok, false);
  assert.match(r.err, /ENOENT/);
});

test('a wake packet is six 0xFF bytes and the MAC address sixteen times', () => {
  const p = W.magicPacket('0a:0b:0c:0d:0e:0f');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], Array(6).fill(255));
  for (let i = 0; i < 16; i++) assert.deepEqual([...p.subarray(6 + i * 6, 12 + i * 6)], [10, 11, 12, 13, 14, 15]);
  assert.throws(() => W.magicPacket('nope'), /not a MAC address: nope/);
});

test('sendUdp sends the packet, and rejects when it cannot', async () => {
  const rx = dgram.createSocket('udp4');
  await new Promise((r) => rx.bind(0, '127.0.0.1', r));
  const got = new Promise((r) => rx.once('message', (m) => r(m)));
  await W.sendUdp(Buffer.from('hello'), '127.0.0.1', rx.address().port);
  assert.equal(String(await got), 'hello');
  rx.close();
  await assert.rejects(W.sendUdp(Buffer.from('x'), 'no-such-host.invalid', 9));
  // A socket error before sending.
  const sock = Object.assign(new EventEmitter(), { closed: 0, close() { sock.closed++; }, bind() { sock.emit('error', new Error('bind failed')); } });
  const m = mock.method(dgram, 'createSocket', () => sock);
  try { await assert.rejects(W.sendUdp(Buffer.from('x'), '127.0.0.1', 9), /bind failed/); } finally { m.mock.restore(); }
  assert.equal(sock.closed, 1);
});

test('normMac writes each byte as two lowercase digits, and refuses anything else', () => {
  assert.equal(W.normMac('a:B:c:d:e:ff'), '0a:0b:0c:0d:0e:ff');
  for (const x of [undefined, '(incomplete)', 'a:b:c', 'a:b:c:d:e:fff', 'g:b:c:d:e:f']) assert.equal(W.normMac(x), null);
});

test('tsState reads Tailscale status the way Corral does', () => {
  assert.equal(W.tsState(''), 'off');
  assert.equal(W.tsState(macStatus('Stopped')), 'stopped');
  assert.equal(W.tsState(macStatus('NeedsLogin')), 'logged-out');
  assert.equal(W.tsState(macStatus('Running', null)), 'logged-out');
  assert.equal(W.tsState(JSON.stringify({ BackendState: 'Running' })), 'logged-out');
  assert.equal(W.tsState(macStatus()), 'running');
});

test('the SSH probe finds tailscale, checks the app and Corral, and parses back', () => {
  const s = W.sshProbeScript(W.config({ WATCH_CORRAL_PORT: '9777' }));
  assert.match(s, /^TS=tailscale; for p in \/usr\/local\/bin\/tailscale /);
  assert.match(s, /http:\/\/127\.0\.0\.1:9777\/api\/hub/);
  assert.deepEqual(W.parseProbe(probeOut()), { app: true, corral: true, tailscale: 'running' });
  assert.deepEqual(W.parseProbe(probeOut({ app: 'no', corral: '000', status: '' })), { app: false, corral: false, tailscale: 'off' });
  assert.deepEqual(W.parseProbe('garbage'), { app: false, corral: false, tailscale: 'off' });
  assert.match(W.TS_FIX, /open -a Tailscale/);
});

test('verdict names the problem and the fix', () => {
  const v = (ts, lan, ssh, wake = false) => W.verdict('MBP', ts, lan, ssh, wake);
  const on = { peer: { online: true } };
  const off = { peer: { online: false, lastSeen: '2026-10-30T20:15:00Z' } };
  const up = { up: true };
  const ssh = (tailscale, corral = true) => ({ ok: true, tailscale, corral });
  assert.equal(v(on, up, ssh('off')).fix, 'tailscale');
  assert.match(v(on, up, ssh('off')).title, /not running on MBP/);
  assert.match(v(on, up, ssh('stopped')).title, /turned off/);
  assert.match(v(on, up, ssh('logged-out')).title, /logged out/);
  assert.deepEqual([v(on, up, ssh('running', false)).fix, v(on, up, ssh('running', false)).level], ['corral', 'down']);
  assert.deepEqual([v(off, up, ssh('running')).fix, v(off, up, ssh('running')).level], ['tailscale', 'warn']);
  assert.deepEqual([v({ peer: null }, up, ssh('running')).level], ['warn']);
  assert.deepEqual([v(on, up, ssh('running')).level, v(on, up, ssh('running')).fix], ['ok', undefined]);
  assert.match(v(on, up, { ok: false, err: 'Permission denied' }).detail, /^SSH said: Permission denied Check Remote Login/);
  assert.match(v(on, up, null).detail, /^Check Remote Login/);
  assert.match(v(on, { up: false }, null).title, /online, but it does not answer on the home network/);
  const asleep = v(off, { up: false }, null, true);
  assert.deepEqual([asleep.level, asleep.fix], ['down', 'wake']);
  assert.match(asleep.detail, /Tailscale last saw it at/);
  const never = v({ peer: null }, { up: false }, null, false);
  assert.equal(never.fix, undefined);
  assert.equal(never.detail, 'It does not answer on the home network.');
});

test('status: asleep or away, with Tailscale last seen and a known wake address', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'watch.json'), JSON.stringify({ mac: '0a:0b:0c:0d:0e:0f' }));
  const run = fakeRun({ ts: { ok: true, out: tsStatus() }, ping: PING_DOWN });
  const s = await W.createWatch(cfgFor(dir), { run }).status();
  assert.equal(s.name, 'Chesters-MacBook-Pro');
  assert.deepEqual(s.tailscale.peer, { name: 'Chesters-MacBook-Pro', online: false, lastSeen: '2026-10-30T20:15:00Z', ip: '100.64.0.2' });
  assert.deepEqual(s.lan, { host: 'Chesters-MacBook-Pro.local', up: false, ip: null });
  assert.equal(s.ssh, null);
  assert.equal(s.mac, '0a:0b:0c:0d:0e:0f');
  assert.equal(s.verdict.fix, 'wake');
  assert.deepEqual(run.calls.map((c) => c.cmd), ['tailscale', 'ping']);
  assert.deepEqual(run.calls[1].args, ['-c', '1', '-t', '2', 'Chesters-MacBook-Pro.local']);
});

test('status: awake on the home network, learns its address, and asks it over SSH', async () => {
  const dir = tmp();
  const run = fakeRun({ ts: { ok: true, out: tsStatus({ online: true, lastSeen: '0001-01-01T00:00:00Z' }) }, ping: PING_OK, arp: ARP,
    ssh: { ok: true, out: probeOut({ status: macStatus('Stopped') }), err: '' } });
  const w = W.createWatch(cfgFor(dir), { run });
  const s = await w.status();
  assert.equal(s.tailscale.peer.lastSeen, null);
  assert.deepEqual(s.lan, { host: 'Chesters-MacBook-Pro.local', up: true, ip: '192.168.1.20', mac: '0a:0b:0c:0d:0e:0f' });
  assert.deepEqual(s.ssh, { ok: true, app: true, corral: true, tailscale: 'stopped' });
  assert.equal(s.verdict.fix, 'tailscale');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'watch.json'), 'utf8')), { mac: '0a:0b:0c:0d:0e:0f' });
  const sshCall = run.calls.find((c) => c.cmd === 'ssh');
  assert.deepEqual(sshCall.args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'Chesters-MacBook-Pro.local']);
  // The same address again is not written again.
  fs.rmSync(path.join(dir, 'watch.json'));
  await w.status();
  assert.equal(fs.existsSync(path.join(dir, 'watch.json')), false);
});

test('status: an SSH failure keeps its last line, and settings name the hosts', async () => {
  const dir = tmp();
  const run = fakeRun({ ts: { ok: true, out: tsStatus({ peer: false }) }, ping: PING_OK, arp: { ok: true, out: 'no entry' },
    ssh: { ok: false, out: '', err: 'Warning: something\nme@mbp: Permission denied (publickey).\n' } });
  const s = await W.createWatch(cfgFor(dir, { WATCH_LAN_HOST: 'mbp.lan', WATCH_SSH: 'me@mbp', WATCH_MAC: '0a:0b:0c:0d:0e:0f' }), { run }).status();
  assert.equal(s.name, 'chesters-macbook-pro');
  assert.equal(s.lan.host, 'mbp.lan');
  assert.equal(s.lan.mac, null);
  assert.deepEqual(s.ssh, { ok: false, err: 'me@mbp: Permission denied (publickey).' });
  assert.equal(s.mac, '0a:0b:0c:0d:0e:0f');
  assert.equal(run.calls.find((c) => c.cmd === 'ssh').args[4], 'me@mbp');
});

test('status: a ping with no address counts as no answer, and Tailscale down here is reported', async () => {
  const dir = tmp();
  const run = fakeRun({ ts: { ok: false, out: '' }, ping: { ok: true, out: 'odd output' } });
  const s = await W.createWatch(cfgFor(dir), { run }).status();
  assert.deepEqual(s.tailscale, { error: 'Tailscale on this Mac did not answer.', peer: null });
  assert.equal(s.lan.up, false);
  assert.equal(s.lan.host, 'chesters-macbook-pro.local');
  assert.equal(s.mac, null);
  assert.equal(s.verdict.fix, undefined);
});

test('a peer found by its DNS name, a peer with no addresses, and a state file that cannot be written', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'file'), '');
  const status = JSON.stringify({ Self: {}, Peer: { b: { DNSName: 'chesters-macbook-pro.tail1.ts.net.', Online: true } } });
  const run = fakeRun({ ts: { ok: true, out: status }, ping: PING_OK, arp: ARP, ssh: { ok: true, out: probeOut() } });
  const s = await W.createWatch(cfgFor(dir, { WATCH_STATE: path.join(dir, 'file', 'watch.json') }), { run }).status();
  assert.deepEqual(s.tailscale.peer, { name: undefined, online: true, lastSeen: null, ip: null });
  assert.equal(s.mac, '0a:0b:0c:0d:0e:0f'); // kept in memory even though the file could not be written
  assert.equal(s.verdict.level, 'ok');
});

test('two looks at once share one probe', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const run = fakeRun({ ts: () => gate.then(() => ({ ok: true, out: tsStatus() })), ping: PING_DOWN });
  const w = W.createWatch(cfgFor(tmp()), { run });
  const a = w.status(), b = w.status();
  assert.equal(a, b);
  release();
  await a;
  await w.status();
  assert.equal(run.calls.filter((c) => c.cmd === 'tailscale').length, 2);
});

test('wake sends the packet to the broadcast address, or says it does not know the address', async () => {
  const sent = [];
  const udp = async (buf, host, port) => { sent.push([buf.length, host, port]); };
  const dir = tmp();
  let w = W.createWatch(cfgFor(dir), { run: fakeRun({}), udp });
  assert.deepEqual(await w.actions.wake(), { ok: false, output: 'This Mac has not seen that Mac on the home network yet, so it does not know its address to wake. Set WATCH_MAC.' });
  w = W.createWatch(cfgFor(dir, { WATCH_MAC: 'aa:bb:cc:dd:ee:ff', WATCH_BROADCAST: '192.168.1.255' }), { run: fakeRun({}), udp });
  const r = await w.actions.wake();
  assert.equal(r.ok, true);
  assert.match(r.output, /Sent a wake packet to aa:bb:cc:dd:ee:ff/);
  assert.deepEqual(sent, [[102, '192.168.1.255', 9]]);
  fs.writeFileSync(path.join(dir, 'watch.json'), JSON.stringify({ mac: '0a:0b:0c:0d:0e:0f' }));
  w = W.createWatch(cfgFor(dir), { run: fakeRun({}), udp });
  assert.match((await w.actions.wake()).output, /0a:0b:0c:0d:0e:0f/);
});

test('reconnecting Tailscale runs the fix over SSH and passes on a login link', async () => {
  const run = fakeRun({ ping: PING_OK, arp: ARP, ssh: { ok: true, out: 'Tailscale: NeedsLogin\n\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/abc123\n', err: '' } });
  const w = W.createWatch(cfgFor(tmp()), { run });
  const r = await w.actions.tailscale();
  assert.deepEqual([r.ok, r.login], [true, 'https://login.tailscale.com/a/abc123']);
  assert.match(r.output, /^Tailscale: NeedsLogin/);
  assert.equal(run.calls.find((c) => c.cmd === 'ssh').args[5], W.TS_FIX);
  const r2 = await W.createWatch(cfgFor(tmp()), { run: fakeRun({ ping: PING_OK, ssh: { ok: false, out: '', err: 'timed out' } }) }).actions.tailscale();
  assert.deepEqual(r2, { ok: false, output: 'timed out', login: null });
});

test('restarting Corral runs the launcher without opening the page', async () => {
  const run = fakeRun({ ping: PING_OK, ssh: { ok: true, out: '', err: '' } });
  const w = W.createWatch(cfgFor(tmp(), { WATCH_CORRAL_REPO: '$HOME/src/corral' }), { run });
  assert.deepEqual(await w.actions.corral(), { ok: true, output: 'Corral is running.' });
  assert.equal(run.calls.find((c) => c.cmd === 'ssh').args[5], 'CORRAL_NO_OPEN=1 "$HOME/src/corral/scripts/corral-launcher.sh" 2>&1');
  const fail = W.createWatch(cfgFor(tmp()), { run: fakeRun({ ping: PING_OK, ssh: { ok: false, out: '', err: '' } }) });
  assert.deepEqual(await fail.actions.corral(), { ok: false, output: 'The launcher failed.' });
  const said = W.createWatch(cfgFor(tmp()), { run: fakeRun({ ping: PING_OK, ssh: { ok: false, out: 'corral-launcher: node was not found.', err: '' } }) });
  assert.deepEqual(await said.actions.corral(), { ok: false, output: 'corral-launcher: node was not found.' });
});

test('access: from this Mac, or through tailscale serve with an allowed login', async () => {
  const run = fakeRun({ ts: { ok: true, out: tsStatus() } });
  const w = W.createWatch(cfgFor(tmp()), { run });
  assert.deepEqual(await w.access({ headers: LOCAL }), { origins: ['http://127.0.0.1:8778'] });
  assert.deepEqual(await w.access({ headers: { host: 'localhost:8778' } }), { origins: ['http://localhost:8778'] });
  assert.equal(run.calls.length, 0);
  const remote = { host: `${MINI}:8444`, 'tailscale-user-login': OWNER };
  assert.deepEqual(await w.access({ headers: remote }), { origins: [`https://${MINI}:8444`] });
  assert.equal(run.calls.length, 1);
  await w.access({ headers: remote });
  assert.equal(run.calls.length, 1); // this Mac's name is looked up once
  assert.equal(await w.access({ headers: { ...remote, 'tailscale-user-login': 'other@x.com' } }), null);
  assert.equal(await w.access({ headers: { host: `${MINI}:8444` } }), null);
  assert.equal(await w.access({ headers: { ...remote, host: `${MINI}:8443` } }), null);
  assert.equal(await w.access({ headers: {} }), null);
  const listed = W.createWatch(cfgFor(tmp(), { WATCH_USERS: 'other@x.com' }), { run });
  assert.deepEqual(await listed.access({ headers: { ...remote, 'tailscale-user-login': 'other@x.com' } }), { origins: [`https://${MINI}:8444`] });
  assert.equal(await listed.access({ headers: remote }), null);
  // No owner and no list, or Tailscale not answering: nobody gets in through the tailnet.
  const noOwner = W.createWatch(cfgFor(tmp()), { run: fakeRun({ ts: { ok: true, out: tsStatus({ owner: null }) } }) });
  assert.equal(await noOwner.access({ headers: { ...remote, 'tailscale-user-login': '' } }), null);
  const down = W.createWatch(cfgFor(tmp()), { run: fakeRun({}) });
  assert.equal(await down.access({ headers: remote }), null);
});

test('handle serves the page and the status, runs actions only from its own origin, and refuses the rest', async () => {
  const run = fakeRun({ ts: { ok: true, out: tsStatus() }, ping: PING_DOWN });
  const udp = async () => { throw new Error('network is unreachable'); };
  const w = W.createWatch(cfgFor(tmp(), { WATCH_MAC: 'aa:bb:cc:dd:ee:ff' }), { run, udp });
  assert.deepEqual(await exchange(w, 'GET', '/', { host: 'evil.example' }).then((r) => [r.code, r.json]), [403, { error: 'not allowed' }]);
  const page = await exchange(w, 'GET', '/', LOCAL);
  assert.deepEqual([page.code, page.headers['Content-Type'], page.headers['Cache-Control']], [200, 'text/html; charset=utf-8', 'no-store']);
  assert.equal(page.body, W.PAGE);
  const st = await exchange(w, 'GET', '/api/status', LOCAL);
  assert.equal(st.json.verdict.fix, 'wake');
  assert.deepEqual((await exchange(w, 'POST', '/api/wake', LOCAL)).json, { error: 'bad origin' });
  assert.deepEqual((await exchange(w, 'POST', '/api/wake', { ...LOCAL, origin: 'https://evil.example' })).code, 403);
  const failed = await exchange(w, 'POST', '/api/wake', { ...LOCAL, origin: 'http://127.0.0.1:8778' });
  assert.deepEqual([failed.code, failed.json], [500, { ok: false, output: 'network is unreachable' }]);
  const ok = W.createWatch(cfgFor(tmp(), { WATCH_MAC: 'aa:bb:cc:dd:ee:ff' }), { run, udp: async () => {} });
  assert.equal((await exchange(ok, 'POST', '/api/wake', { ...LOCAL, origin: 'http://127.0.0.1:8778' })).json.ok, true);
  for (const [m, u] of [['GET', '/api/wake'], ['POST', '/api/status'], ['POST', '/api/other'], ['GET', '/nope']]) {
    assert.equal((await exchange(w, m, u, LOCAL)).code, 404, `${m} ${u}`);
  }
});

test('the page shows the verdict, the details, and the fix, and runs an action', async () => {
  const replies = {
    '/api/status': { name: 'MBP', checkedAt: '2026-10-31T10:00:00Z', tailscale: { peer: { online: false, lastSeen: null } }, lan: { up: true, ip: '192.168.1.20', host: 'MBP.local' },
      ssh: { ok: true, tailscale: 'logged-out', app: false, corral: false }, verdict: { level: 'down', title: 'Tailscale on MBP is logged out', detail: 'd', fix: 'tailscale' } },
    '/api/tailscale': { ok: true, output: 'Tailscale: NeedsLogin', login: 'https://login.tailscale.com/a/x' },
  };
  const dom = new JSDOM(W.PAGE, { runScripts: 'dangerously', beforeParse(win) {
    win.fetch = async (u) => ({ json: async () => replies[u] });
  } });
  const doc = dom.window.document;
  const tick = () => new Promise((r) => setTimeout(r, 10));
  await tick();
  assert.equal(doc.querySelector('#v h1').textContent, 'Tailscale on MBP is logged out');
  assert.equal(doc.querySelector('#v').className, 'down');
  assert.match(doc.querySelector('#d').textContent, /offline, last seen not known/);
  assert.match(doc.querySelector('#d').textContent, /Tailscale logged out \(app not running\), Corral not answering/);
  assert.equal(doc.querySelector('[data-a="tailscale"]').className, 'main');
  doc.querySelector('[data-a="tailscale"]').click();
  await tick();
  assert.equal(doc.querySelector('#out a').href, 'https://login.tailscale.com/a/x');
  assert.equal(doc.querySelector('#out pre').textContent, 'Tailscale: NeedsLogin');
  dom.window.close();
});

test('main needs a target, and otherwise listens on loopback and answers', async () => {
  const errs = mock.method(console, 'error', () => {});
  const logs = mock.method(console, 'log', () => {});
  try {
    assert.equal(W.main({}), null);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    const server = W.main({ WATCH_TARGET: 'mbp', WATCH_PORT: '0', WATCH_STATE: path.join(tmp(), 'w.json'), WATCH_TAILSCALE_BIN: '/no/such/tailscale' });
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address();
    const code = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/nope', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(code, 403);
    await new Promise((r) => setImmediate(r));
    assert.match(logs.mock.calls.at(-1).arguments[0], /^corral-watch: watching mbp on http:\/\/127\.0\.0\.1:\d+$/);
    await new Promise((r) => server.close(r));
  } finally { errs.mock.restore(); logs.mock.restore(); }
});

test('running the script directly without a target says what to set and fails', async () => {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '../../scripts/corral-watch.js')], { env: { PATH: process.env.PATH, HOME: tmp() }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /set WATCH_TARGET/);
});
