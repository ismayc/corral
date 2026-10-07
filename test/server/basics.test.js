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
