const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const WebSocket = require('ws');
const { loadServer, listen, PORT } = require('../helpers/server');
const { until } = require('../helpers/platform');

const LOCAL = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
const TAILNET = { host: 'mac.tail1234.ts.net:8443', origin: 'https://mac.tail1234.ts.net:8443', url: 'https://mac.tail1234.ts.net:8443/', logins: new Set(['me@example.com']), machine: 'mac', served: true };

async function world(t, opts = {}) {
  const h = loadServer(opts);
  const http = await listen(h.srv);
  const sockets = [];
  // Open sockets must go first, or server.close() waits on them forever.
  t.after(async () => { for (const ws of sockets) ws.terminate(); for (const ws of h.srv.wss.clients) ws.terminate(); await http.close(); });
  // Opens a socket and collects what it receives; headers override the default local ones.
  const connect = (query, headers = LOCAL) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${http.port}/ws?${query}`, { headers });
    const c = { ws, got: [], closed: false };
    ws.on('message', (d) => c.got.push(d.toString()));
    ws.on('close', () => { c.closed = true; });
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', (_req, res) => { res.resume(); reject(Object.assign(new Error('refused'), { status: res.statusCode })); });
    ws.on('error', reject);
    sockets.push(ws);
  });
  return { ...h, http, connect };
}

const refused = (p) => p.then(() => assert.fail('should be refused'), (e) => e.status);

test('a socket for a window gets its scrollback, live output, and sends keystrokes to the shell', async (t) => {
  const { srv, ptys, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  ptys[0].emitData('earlier output');
  const c = await connect(`id=${s.id}`);
  await until(() => c.got.length, 'the scrollback');
  assert.deepEqual(c.got, ['earlier output']);
  assert.equal(s.clients.size, 1);

  ptys[0].emitData('live');
  await until(() => c.got.includes('live'), 'live output');

  c.ws.send(JSON.stringify({ t: 'in', d: 'ls\r' }));
  await until(() => ptys[0].written.length, 'the keystrokes');
  assert.deepEqual(ptys[0].written, ['ls\r']);

  c.ws.send(JSON.stringify({ t: 'resize', cols: 9999, rows: 50 }));
  await until(() => ptys[0].sizes.length, 'the resize');
  assert.deepEqual(ptys[0].sizes, [[500, 50]]);

  // Messages that make no sense are ignored.
  for (const m of ['not json', JSON.stringify({ t: 'in', d: 5 }), JSON.stringify({ t: 'resize', cols: 0, rows: 5 }), JSON.stringify({ t: 'other' })]) c.ws.send(m);
  c.ws.send(JSON.stringify({ t: 'in', d: 'end' }));
  await until(() => ptys[0].written.length === 2, 'the last keystrokes');
  assert.deepEqual([ptys[0].written, ptys[0].sizes.length], [['ls\r', 'end'], 1]);

  c.ws.close();
  await until(() => s.clients.size === 0, 'the socket to leave');
});

test('a window with nothing printed yet sends no scrollback, and a resize the pty rejects is ignored', async (t) => {
  const { srv, ptys, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  const c = await connect(`id=${s.id}`);
  ptys[0].throwOnResize = true;
  c.ws.send(JSON.stringify({ t: 'resize', cols: 80, rows: 24 }));
  c.ws.send(JSON.stringify({ t: 'in', d: 'after' }));
  await until(() => ptys[0].written.length, 'the keystrokes after the failed resize');
  assert.deepEqual(c.got, []);
});

test('input to a window whose process has ended is dropped', async (t) => {
  const { srv, ptys, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  const c = await connect(`id=${s.id}`);
  ptys[0].emitExit(0);
  await until(() => c.got.some((m) => m.includes('tmux session ended')), 'the exit notice');
  c.ws.send(JSON.stringify({ t: 'in', d: 'late' }));
  c.ws.send(JSON.stringify({ t: 'in', d: 'later' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ptys[0].written, []);
});

test('a socket is refused for a bad host, a bad origin, a wrong path, or an unknown window', async (t) => {
  const { srv, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  assert.equal(await refused(connect(`id=${s.id}`, { host: 'evil.example', origin: LOCAL.origin })), 403);
  assert.equal(await refused(connect(`id=${s.id}`, { host: LOCAL.host, origin: 'http://evil.example' })), 403);
  assert.equal(await refused(connect(`id=${s.id}`, { host: LOCAL.host })), 403);
  assert.equal(await refused(connect('id=nope')), 403);
  assert.equal(await refused(connect('')), 403);
  const wrongPath = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.server.address().port}/other?id=${s.id}`, { headers: LOCAL });
    ws.on('unexpected-response', (_q, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('open', () => reject(new Error('opened')));
    ws.on('error', reject);
  });
  assert.equal(await wrongPath, 403);
});

test('a socket with own=1 gets its own tmux client, sized from the request and clamped', async (t) => {
  const { srv, ptys, connect, tmux } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  const c = await connect(`id=${s.id}&own=1&cols=9999&rows=1`);
  await until(() => ptys.length === 2, 'the second pty');
  const own = ptys[1];
  assert.deepEqual(own.args, ['-L', 'corral', 'attach-session', '-t', `wt-${s.id}`]);
  assert.equal(own.file, srv.constants.TMUX);
  assert.deepEqual([own.opts.cols, own.opts.rows, own.opts.cwd], [500, 10, os.homedir()]);
  assert.equal(own.opts.env.CORRAL_SESSION, s.id);
  assert.equal(s.clients.size, 0); // not on the shared pty

  own.emitData('from tmux');
  await until(() => c.got.includes('from tmux'), 'output');
  c.ws.send(JSON.stringify({ t: 'in', d: 'x' }));
  c.ws.send(JSON.stringify({ t: 'resize', cols: 100, rows: 9999 }));
  await until(() => own.written.length && own.sizes.length, 'input and resize');
  assert.deepEqual([own.written, own.sizes, ptys[0].written], [['x'], [[100, 200]], []]);

  c.ws.close();
  await until(() => own.killed, 'the client to be detached');
  assert.equal(tmux.sessions.has(`wt-${s.id}`), true); // the window itself keeps running
  own.emitData('after close'); // nothing is sent to a closed socket
  assert.equal(c.got.includes('after close'), false);
  own.emitExit(0);
});

test('own sockets use a default size when the request gives none', async (t) => {
  const { srv, ptys, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  await connect(`id=${s.id}&own=1`);
  await until(() => ptys.length === 2, 'the second pty');
  assert.deepEqual([ptys[1].opts.cols, ptys[1].opts.rows], [80, 24]);
});

test('an own socket is told when its window closes, and closing it again does not fail if kill throws', async (t) => {
  const { srv, ptys, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  const c = await connect(`id=${s.id}&own=1`);
  await until(() => ptys.length === 2, 'the second pty');
  ptys[1].emitExit(0);
  await until(() => c.closed, 'the socket to close');
  assert.ok(c.got.some((m) => m.includes('[window closed]')));

  const d = await connect(`id=${s.id}&own=1`);
  await until(() => ptys.length === 3, 'the third pty');
  ptys[2].throwOnKill = true;
  d.ws.close();
  await until(() => d.closed, 'the socket to close');
});

test('an own socket whose client already left gets nothing when its window closes', async (t) => {
  const { srv, ptys, connect } = await world(t);
  const s = srv.createSession(os.tmpdir(), 'x');
  const c = await connect(`id=${s.id}&own=1`);
  await until(() => ptys.length === 2, 'the second pty');
  c.ws.terminate();
  await until(() => c.closed, 'the socket to close');
  ptys[1].emitExit(0);
  assert.equal(c.got.some((m) => m.includes('[window closed]')), false);
});

test('a plain-shell window shares one pty even when own=1 is asked for', async (t) => {
  const { srv, ptys, connect } = await world(t, { tmux: false });
  const s = srv.createSession(os.tmpdir(), 'x');
  await connect(`id=${s.id}&own=1`);
  await until(() => s.clients.size === 1, 'the shared socket');
  assert.equal(ptys.length, 1);
});

test('an own socket closes at once when its tmux client cannot start', async (t) => {
  let fail = false;
  const { srv, connect } = await world(t, { ptyThrows: () => fail });
  const s = srv.createSession(os.tmpdir(), 'x');
  fail = true;
  const c = await connect(`id=${s.id}&own=1`);
  await until(() => c.closed, 'the socket to close');
  assert.equal(s.clients.size, 0);
});

test('a socket from another device always gets its own tmux client', async (t) => {
  const { srv, ptys, connect } = await world(t);
  srv.state.tailnet = TAILNET;
  const s = srv.createSession(os.tmpdir(), 'x');
  await connect(`id=${s.id}`, { host: TAILNET.host, origin: TAILNET.origin, 'tailscale-user-login': 'me@example.com' });
  await until(() => ptys.length === 2, 'the second pty');
  assert.equal(s.clients.size, 0);
  assert.equal(await refused(connect(`id=${s.id}`, { host: TAILNET.host, origin: TAILNET.origin, 'tailscale-user-login': 'stranger@example.com' })), 403);
});
