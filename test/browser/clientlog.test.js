// public/clientlog.js: what a page reports going wrong, sent to the Mac in batches.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { phone, win, claude, settle, unloadPage, fire } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

test('a repeated event is counted, and the batch goes out after 2 seconds', async () => {
  const sent = [];
  const p = await phone([], { routes: { 'POST /api/clientlog': (req) => { sent.push(req.body); return {}; } } });
  mock.timers.enable({ apis: ['setTimeout'] });
  clientLog('copy', { ok: false });
  clientLog('copy', { ok: false });
  clientLog('copy', { ok: true });
  clientLog('bare');
  assert.equal(sent.length, 0);
  mock.timers.tick(2000);
  mock.timers.reset();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].page, p.window.location.pathname);
  assert.deepEqual(sent[0].events.map((e) => [e.kind, e.ok, e.n]), [['copy', false, 2], ['copy', true, 1], ['bare', undefined, 1]]);
  assert.ok(sent[0].events[0].t > 0);
});

test('hiding the page sends at once, and an empty queue sends nothing', async () => {
  const sent = [];
  const p = await phone([], { routes: { 'POST /api/clientlog': (req) => { sent.push(req.body); return {}; } } });
  const doc = p.window.document;
  let state = 'visible';
  Object.defineProperty(doc, 'visibilityState', { get: () => state, configurable: true });
  clientLog('a');
  fire(doc.body, 'visibilitychange');
  await settle();
  assert.equal(sent.length, 0, 'a visible page waits');
  state = 'hidden';
  fire(doc.body, 'visibilitychange');
  await settle();
  assert.equal(sent.length, 1);
  fire(doc.body, 'visibilitychange');
  await settle();
  assert.equal(sent.length, 1);
});

test('events wait through a failed send and go with the next, up to 50', async () => {
  let refuse = true;
  const sent = [];
  const p = await phone([], { routes: { 'POST /api/clientlog': (req) => {
    if (refuse) return { __reply: true, status: 500, body: {} };
    sent.push(req.body);
    return {};
  } } });
  const doc = p.window.document;
  Object.defineProperty(doc, 'visibilityState', { get: () => 'hidden', configurable: true });
  clientLog('first');
  fire(doc.body, 'visibilitychange');
  await settle();
  assert.equal(sent.length, 0);
  for (let i = 0; i < 60; i++) clientLog('more', { i });
  refuse = false;
  fire(doc.body, 'visibilitychange');
  await settle();
  assert.equal(sent[0].events.length, 50);
  assert.equal(sent[0].events[0].kind, 'first');
});

test('events beyond the limit during a failing send are dropped', async () => {
  let release;
  const sent = [];
  const p = await phone([], { routes: { 'POST /api/clientlog': async (req) => {
    if (!release) { await new Promise((r) => { release = r; }); throw new Error('no'); }
    sent.push(req.body);
    return {};
  } } });
  const doc = p.window.document;
  Object.defineProperty(doc, 'visibilityState', { get: () => 'hidden', configurable: true });
  for (let i = 0; i < 5; i++) clientLog('old', { i });
  fire(doc.body, 'visibilitychange');
  await settle();
  for (let i = 0; i < 48; i++) clientLog('new', { i });
  release();
  await settle();
  fire(doc.body, 'visibilitychange');
  await settle();
  const kinds = sent[0].events.map((e) => e.kind);
  assert.equal(kinds.length, 50);
  assert.equal(kinds.filter((k) => k === 'old').length, 2, 'only the room left is kept');
});

test('uncaught errors and rejections are logged, with a plain reason too', async () => {
  const sent = [];
  const p = await phone([], { routes: { 'POST /api/clientlog': (req) => { sent.push(req.body); return {}; } } });
  const w = p.window;
  const doc = w.document;
  Object.defineProperty(doc, 'visibilityState', { get: () => 'hidden', configurable: true });
  w.dispatchEvent(Object.assign(new w.Event('error'), { message: 'boom', filename: '/m.js', lineno: 3, colno: 7 }));
  w.dispatchEvent(Object.assign(new w.Event('unhandledrejection'), { reason: new Error('nope') }));
  w.dispatchEvent(Object.assign(new w.Event('unhandledrejection'), { reason: 'plain' }));
  fire(doc.body, 'visibilitychange');
  await settle();
  assert.deepEqual(sent[0].events.map((e) => [e.kind, e.msg, e.src]), [['error', 'boom', '/m.js:3:7'], ['rejection', 'nope', undefined], ['rejection', 'plain', undefined]]);
});

test('a failed fetch is logged by method and path without its query, and the caller still gets the result', async () => {
  const sent = [];
  const p = await phone([], { routes: {
    'POST /api/clientlog': (req) => { sent.push(req.body); return {}; },
    'GET /api/ok': () => ({ fine: true }),
    'GET /api/lost': () => new TypeError('offline'),
  } });
  const doc = p.window.document;
  Object.defineProperty(doc, 'visibilityState', { get: () => 'hidden', configurable: true });
  assert.equal((await fetch('/api/ok')).ok, true);
  const missing = await fetch('/api/none?secret=1', { method: 'POST', body: '{}' });
  assert.equal(missing.ok, false);
  await assert.rejects(fetch('/api/lost'), TypeError);
  fire(doc.body, 'visibilitychange');
  await settle();
  const api = sent[0].events.filter((e) => e.kind === 'api');
  assert.deepEqual(api.map((e) => [e.method, e.path, e.status, e.err]), [['POST', '/api/none', 404, undefined], ['GET', '/api/lost', undefined, 'TypeError']]);
});

test('a copy logs its event, its user gesture, and its result, never its text', async () => {
  const sent = [];
  const p = await phone([win('a', { claude: claude('idle') })], { routes: {
    'POST /api/clientlog': (req) => { sent.push(req.body); return {}; },
    'GET /api/sessions/a/conversation': () => ({ items: [{ who: 'claude', text: 'Run `! zsh ~/run.sh` now.' }] }),
  } });
  await p.openWin('a');
  await settle();
  const doc = p.window.document;
  Object.defineProperty(doc, 'visibilityState', { get: () => 'hidden', configurable: true });
  Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  const el = p.$('#chat .bang');
  fire(el, 'click');
  await settle();
  p.clipboard.fail = true;
  fire(el, 'click');
  await settle();
  delete navigator.userActivation;
  fire(doc.body, 'visibilitychange');
  await settle();
  const copies = sent.flatMap((b) => b.events).filter((e) => e.kind === 'copy');
  assert.deepEqual(copies.map((e) => [e.from, e.event, e.act, e.ok, e.err]), [['tap', 'click', true, true, undefined], ['tap', 'click', true, false, 'Error']]);
  assert.ok(!JSON.stringify(sent).includes('run.sh'));
});
