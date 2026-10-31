const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadServer, listen, PORT } = require('../helpers/server');

test('loading the server starts nothing', () => {
  const { srv, tmux, ptys } = loadServer();
  assert.equal(srv.server.listening, false);
  assert.equal(ptys.length, 0);
  assert.deepEqual(tmux.calls, []);
});

test('the tmux socket is "corral", or "webterm" while pre-rename sessions are alive', () => {
  assert.equal(loadServer().srv.constants.TMUX_SOCKET, 'corral');
  assert.equal(loadServer({ legacy: true }).srv.constants.TMUX_SOCKET, 'webterm');
  assert.equal(loadServer({ legacy: 'throw' }).srv.constants.TMUX_SOCKET, 'corral');
  assert.equal(loadServer({ env: { CORRAL_TMUX_SOCKET: 'mine' } }).srv.constants.TMUX_SOCKET, 'mine');
  assert.equal(loadServer({ env: { WEBTERM_TMUX_SOCKET: 'old' } }).srv.constants.TMUX_SOCKET, 'old');
  const none = loadServer({ tmux: false }).srv;
  assert.equal(none.constants.TMUX, null);
  assert.equal(none.legacyTmuxInUse(), false);
});

test('herdr is found in ~/.local/bin, or else on PATH', () => {
  const { srv, home } = loadServer();
  assert.equal(srv.constants.HERDR, path.join(home, 'bin', 'herdr')); // HERDR_BIN wins
  delete process.env.HERDR_BIN;
  fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local/bin/herdr'), '');
  delete require.cache[require.resolve('../../server.js')];
  assert.equal(require('../../server.js').constants.HERDR, path.join(home, '.local/bin/herdr'));
  fs.rmSync(path.join(home, '.local/bin/herdr'));
  delete require.cache[require.resolve('../../server.js')];
  assert.equal(require('../../server.js').constants.HERDR, 'herdr');
});

test('the port comes from CORRAL_PORT, then WEBTERM_PORT, then 8777', () => {
  assert.equal(loadServer().srv.constants.PORT, PORT);
  assert.equal(loadServer({ env: { CORRAL_PORT: '', WEBTERM_PORT: '9000' } }).srv.constants.PORT, 9000);
  assert.equal(loadServer({ env: { CORRAL_PORT: '' } }).srv.constants.PORT, 8777);
});

test('requests must name this Mac on loopback', async () => {
  const { srv } = loadServer();
  const h = await listen(srv);
  try {
    assert.equal((await h.request('GET', '/api/sessions', { headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await h.request('GET', '/api/sessions')).status, 200);
    assert.equal((await h.request('GET', '/api/sessions', { headers: { host: `localhost:${PORT}` } })).status, 200);
    const noOrigin = await h.request('POST', '/api/sessions', { body: {}, headers: { origin: null } });
    assert.deepEqual([noOrigin.status, noOrigin.json], [403, { error: 'bad origin' }]);
    const notJson = await h.request('POST', '/api/sessions', { raw: 'x', headers: { 'content-type': 'text/plain' } });
    assert.equal(notJson.status, 415);
  } finally { await h.close(); }
});

test('GET /api/hub gives the hub address from its file, and null unless it is an http(s) address', async () => {
  const file = path.join(require('os').tmpdir(), `corral-hub-${process.pid}`);
  const { srv } = loadServer({ env: { CORRAL_HUB_FILE: file } });
  const h = await listen(srv);
  try {
    assert.deepEqual((await h.request('GET', '/api/hub')).json, { url: null, watch: null }); // no file
    for (const [text, want] of [
      ['https://hub.example/\n', 'https://hub.example/'],
      ['  http://hub.example:8443/x \nsecond line\n', 'http://hub.example:8443/x'],
      ['', null], ['\n', null], ['hub.example\n', null], ['javascript:alert(1)\n', null], ['https://a b\n', null],
    ]) {
      fs.writeFileSync(file, text);
      assert.deepEqual((await h.request('GET', '/api/hub')).json, { url: want, watch: null }, JSON.stringify(text));
    }
  } finally { fs.rmSync(file, { force: true }); await h.close(); }
});

test('the hub file defaults to ~/.config/tailnet-hub/url', async () => {
  const { srv, home } = loadServer();
  const h = await listen(srv);
  try {
    fs.mkdirSync(path.join(home, '.config/tailnet-hub'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/tailnet-hub/url'), 'https://hub.example/\n');
    assert.deepEqual((await h.request('GET', '/api/hub')).json, { url: 'https://hub.example/', watch: null });
  } finally { await h.close(); }
});

test('GET /api/hub also gives the watch page from ~/.config/corral/watch-url, or CORRAL_WATCH_FILE', async () => {
  let { srv, home } = loadServer();
  let h = await listen(srv);
  try {
    fs.mkdirSync(path.join(home, '.config/corral'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/corral/watch-url'), 'https://mini.example.ts.net:8444/\n');
    assert.deepEqual((await h.request('GET', '/api/hub')).json, { url: null, watch: 'https://mini.example.ts.net:8444/' });
  } finally { await h.close(); }
  const file = path.join(require('os').tmpdir(), `corral-watch-${process.pid}`);
  ({ srv } = loadServer({ env: { CORRAL_WATCH_FILE: file } }));
  h = await listen(srv);
  try {
    fs.writeFileSync(file, 'javascript:alert(1)\n');
    assert.deepEqual((await h.request('GET', '/api/hub')).json, { url: null, watch: null });
    fs.writeFileSync(file, 'http://mini.local:8778/\n');
    assert.deepEqual((await h.request('GET', '/api/hub')).json, { url: null, watch: 'http://mini.local:8778/' });
  } finally { fs.rmSync(file, { force: true }); await h.close(); }
});
