const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, start, stop, session, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const one = { routes: { 'GET /api/sessions': { sessions: [session('a', { cwd: '/Users/me/repos/a' })] } } };
const sent = (ws) => ws.sent.map((m) => JSON.parse(m));
const b64 = (s) => Buffer.from(s).toString('base64');

test('a window shows its label and its folder with ~ for the home folder', async () => {
  const p = await start(one);
  const win = p.slotOf('a').querySelector('.win');
  assert.equal(win.querySelector('.cwd').textContent, '~/repos/a');
  assert.equal(p.terms[0].options.scrollback, 5000);
  assert.equal(p.terms[0].addons.length, 2);
  assert.equal(p.terms[0].element, win.querySelector('.term'));
});

test('the terminal connects over ws, resets and sizes itself on open, and sends what is typed', async () => {
  const p = await start(one);
  const ws = p.sockets[0];
  assert.equal(ws.url, 'ws://127.0.0.1:18777/ws?id=a');
  const term = p.terms[0];
  term.type('early');
  assert.deepEqual(ws.sent, [], 'nothing is sent before the socket opens');
  ws.open();
  assert.equal(term.resets, 1);
  assert.deepEqual(sent(ws), [{ t: 'resize', cols: 80, rows: 24 }]);
  ws.message('saved output');
  ws.message('live');
  assert.deepEqual(term.written, ['saved output', 'live']);
  term.writeCb();
  term.type('ls\r');
  term.resize(120, 40);
  assert.deepEqual(sent(ws).slice(1), [{ t: 'in', d: 'ls\r' }, { t: 'resize', cols: 120, rows: 40 }]);
});

test('answers xterm gives while replaying saved output never reach the shell', async () => {
  const p = await start(one);
  const ws = p.sockets[0];
  const term = p.terms[0];
  ws.open();
  ws.message('\x1b[c');
  term.type('\x1b[?1;2c');
  term.resize(90, 30);
  assert.deepEqual(sent(ws).map((m) => m.t), ['resize', 'resize']);
  term.writeCb();
  term.type('x');
  assert.deepEqual(sent(ws).at(-1), { t: 'in', d: 'x' });
});

test('on https the terminal connects over wss', async () => {
  const p = boot(one);
  globalThis.location = { protocol: 'https:', host: 'mac.tail.ts.net:8443', search: '' };
  await flush(20);
  assert.equal(p.sockets[0].url, 'wss://mac.tail.ts.net:8443/ws?id=a');
});

test('a dropped connection reconnects after a pause', async () => {
  const p = await start(one);
  p.sockets[0].open();
  p.sockets[0].drop();
  assert.equal(p.sockets.length, 1);
  assert.equal(p.tick(1500), 1);
  assert.equal(p.sockets.length, 2);
  assert.equal(p.sockets[1].url, 'ws://127.0.0.1:18777/ws?id=a');
  p.sockets[1].open();
  assert.equal(p.terms[0].resets, 2);
  // The first message on the new connection is a replay again.
  p.sockets[1].message('replay');
  p.terms[0].type('q');
  assert.deepEqual(sent(p.sockets[1]).map((m) => m.t), ['resize']);
});

test('closing a window kills its shell, removes it, and does not reconnect', async () => {
  const p = await start({ ...one, routes: { ...one.routes, 'DELETE /api/sessions/*': { ok: true } } });
  p.sockets[0].open();
  p.slotOf('a').querySelector('.close').click();
  await flush();
  assert.equal(p.sockets[0].readyState, 3);
  assert.equal(p.tick(1500), 0);
  assert.ok(p.terms[0].disposed);
  assert.deepEqual(p.wins(), []);
  assert.equal(p.api.called('DELETE', '/api/sessions/a').length, 1);
  assert.deepEqual(p.store('corral.open'), []);
  assert.equal(p.$('#count').textContent, '0 windows');
  assert.equal(p.$('#grid .zone-empty').textContent, 'Pick a space on the left to open it here.');
});

test('closing a minimized window also drops it from the bottom bar and the saved list', async () => {
  const p = await start({ ...one, routes: { ...one.routes, 'DELETE /api/sessions/*': { ok: true } } });
  p.slotOf('a').querySelector('.min').click();
  assert.deepEqual(p.store('corral.minimized'), ['a']);
  p.slotOf('a').querySelector('.close').click();
  await flush();
  assert.equal(p.$('#tray').hidden, true);
  assert.deepEqual(p.store('corral.minimized'), []);
});

test('the window refits when its terminal area changes size', async () => {
  const p = await start(one);
  const term = p.terms[0];
  const obs = p.observers.find((o) => o.els.includes(term.element));
  const before = term.addons[0].fits || 0;
  obs.fire();
  assert.equal(term.addons[0].fits, before + 1);
});

test('a click in a window gives it the keyboard and the focus outline', async () => {
  const p = await start({ routes: { 'GET /api/sessions': { sessions: [session('a'), session('b')] } } });
  fire(p.slotOf('a').querySelector('.term'), 'mousedown');
  assert.ok(p.slotOf('a').querySelector('.win').classList.contains('focus'));
  assert.ok(!p.slotOf('b').querySelector('.win').classList.contains('focus'));
  assert.equal(p.terms[0].focused, true);
});

test('text tmux copies with OSC 52 goes on the clipboard', async () => {
  const p = await start(one);
  const osc = p.terms[0].osc[52];
  p.terms[0].writeCb?.();
  assert.equal(osc(`c;${b64('héllo')}`), true);
  await flush();
  assert.equal(p.clipboard.text, 'héllo');
});

test('OSC 52 reads, empty copies, bad data, and copies replayed while reconnecting are ignored', async () => {
  const p = await start(one);
  const osc = p.terms[0].osc[52];
  assert.equal(osc('c;?'), true);
  assert.equal(osc('c;'), true);
  assert.equal(osc('c;***'), true);
  await flush();
  assert.equal(p.clipboard.text, null);
  p.sockets[0].open();
  p.sockets[0].message('replay');
  assert.equal(osc(`c;${b64('old')}`), true);
  await flush();
  assert.equal(p.clipboard.text, null);
});

test('a clipboard that refuses the write is not an error', async () => {
  const p = await start(one);
  p.clipboard.fail = true;
  assert.equal(p.terms[0].osc[52](`c;${b64('x')}`), true);
  await flush();
  assert.equal(p.clipboard.text, null);
});
