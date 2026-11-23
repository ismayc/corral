// ntfy (lib/ntfy.js): the setting, the message it sends, the watcher's use of it, and the routes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const ntfyLib = require('../../lib/ntfy');
const { setup, makeSub } = require('../helpers/claude');
const { listen, tick } = require('../helpers/server');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corral-ntfy-')), 'sub', 'ntfy.json');

test.afterEach(() => mock.restoreAll());

test('ntfy starts off, makes a long random topic when turned on, keeps it, and can replace it', () => {
  const file = tmpFile();
  const n = ntfyLib.createNtfy(file);
  assert.deepEqual(n.view(), { on: false, topic: null, server: 'https://ntfy.sh', url: null });
  assert.equal(n.on, false);
  assert.equal(n.set({}).status, 400);
  assert.equal(n.set(null).status, 400);
  const on = n.set({ on: true });
  assert.equal(on.status, 200);
  assert.match(on.topic, /^corral-[\w-]{24}$/);
  assert.equal(on.url, `https://ntfy.sh/${on.topic}`);
  assert.equal(n.on, true);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const again = ntfyLib.createNtfy(file);
  assert.deepEqual(again.view(), n.view());
  assert.equal(again.set({ on: false }).topic, on.topic, 'off keeps the topic');
  assert.equal(again.set({ on: true }).topic, on.topic);
  assert.notEqual(again.set({ newTopic: true }).topic, on.topic);
  assert.notEqual(ntfyLib.newTopic(), ntfyLib.newTopic());
});

test('ntfy ignores a settings file with a bad topic or bad JSON, and a failed save says so', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ on: true, topic: 'short' }));
  assert.equal(ntfyLib.createNtfy(file).view().topic, null);
  fs.writeFileSync(file, '{');
  assert.equal(ntfyLib.createNtfy(file).view().topic, null);
  fs.writeFileSync(file, JSON.stringify({ on: 'yes', topic: `corral-${'a'.repeat(24)}` }));
  assert.equal(ntfyLib.createNtfy(file).view().on, false);
  const errors = mock.method(console, 'error', () => {});
  const blocked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corral-ntfy-')), 'file');
  fs.writeFileSync(blocked, '');
  assert.deepEqual(ntfyLib.createNtfy(path.join(blocked, 'ntfy.json')).set({ on: true }), { status: 500, error: 'could not save the setting' });
  assert.match(errors.mock.calls[0].arguments[0], /ntfy save failed/);
});

test('send posts the title and reason to ntfy.sh as JSON, and says off, ok, or failed', async () => {
  const n = ntfyLib.createNtfy(tmpFile());
  const fetch = mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  assert.equal(await n.send({ title: 't', brief: 'b', tag: 'turn' }), 'off');
  assert.equal(fetch.mock.calls.length, 0);
  const { topic } = n.set({ on: true });
  assert.equal(await n.send({ title: 'api needs permission', brief: 'Claude is asking for permission.', tag: 'permission' }), 'ok');
  const [url, opts] = fetch.mock.calls[0].arguments;
  assert.equal(url, 'https://ntfy.sh');
  assert.equal(opts.method, 'POST');
  assert.deepEqual(JSON.parse(opts.body), { topic, title: 'api needs permission', message: 'Claude is asking for permission.', tags: ['warning'], priority: 4 });
  await n.send({ title: 'x', brief: 'y', tag: 'turn' });
  assert.deepEqual(JSON.parse(fetch.mock.calls[1].arguments[1].body).tags, ['white_check_mark']);
  const errors = mock.method(console, 'error', () => {});
  fetch.mock.mockImplementation(async () => ({ ok: false, status: 429 }));
  assert.equal(await n.send({ title: 'x', brief: 'y', tag: 'turn' }), 'failed');
  fetch.mock.mockImplementation(async () => { throw new Error('offline'); });
  assert.equal(await n.send({ title: 'x', brief: 'y', tag: 'turn' }), 'failed');
  assert.deepEqual(errors.mock.calls.map((c) => c.arguments.join(' ')), ['ntfy answered 429', 'ntfy send failed: offline']);
});

test('the watcher sends ntfy only the window name and the reason, even with no phone subscribed to Web Push', async () => {
  const c = setup({ exec: { ioreg: () => 'HIDIdleTime unknown' } });
  mock.method(console, 'log', () => {});
  const fetch = mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, text: async () => '' }));
  const s = c.open('api');
  const ids = { id: undefined };
  const set = (fields) => { ids.id = c.claude(s, { sessionId: ids.id, ...fields }); };
  set({ status: 'busy' });
  c.srv.watchWindows(); // off and no subscriptions: nothing is watched
  c.srv.state.ntfy.set({ on: true });
  c.srv.watchWindows();
  set({ status: 'idle' });
  c.srv.watchWindows();
  await tick(10);
  const sent = fetch.mock.calls.map((x) => JSON.parse(x.arguments[1].body));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'api: your turn');
  assert.equal(sent[0].message, 'Claude finished and is waiting for you.');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['message', 'priority', 'tags', 'title', 'topic']);
  // Web Push still gets its own copy, without the ntfy fields.
  const ua = makeSub();
  c.srv.state.push.subs = [ua.sub];
  set({ status: 'busy' });
  c.srv.watchWindows();
  set({ status: 'idle' });
  c.srv.watchWindows();
  await tick(10);
  assert.equal(fetch.mock.calls.length, 3);
  assert.equal(fetch.mock.calls[1].arguments[0], ua.sub.endpoint);
});

test('the ntfy routes read, change, and test the setting', async () => {
  const c = setup();
  mock.method(console, 'error', () => {});
  const h = await listen(c.srv);
  const fetch = mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
  try {
    assert.deepEqual((await h.request('GET', '/api/ntfy')).json, { on: false, topic: null, server: 'https://ntfy.sh', url: null });
    assert.equal((await h.request('POST', '/api/ntfy/test')).status, 409);
    assert.equal((await h.request('POST', '/api/ntfy', { body: { on: 'yes' } })).status, 400);
    const on = await h.request('POST', '/api/ntfy', { body: { on: true } });
    assert.equal(on.json.on, true);
    assert.deepEqual((await h.request('POST', '/api/ntfy/test')).json, { ok: true });
    assert.equal(JSON.parse(fetch.mock.calls.at(-1).arguments[1].body).tags[0], 'white_check_mark');
    fetch.mock.mockImplementation(async () => ({ ok: false, status: 500 }));
    const bad = await h.request('POST', '/api/ntfy/test');
    assert.deepEqual([bad.status, bad.json.error], [502, 'ntfy.sh did not take the message']);
  } finally { await h.close(); }
});
