const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { mock } = require('node:test');
const { setup, makeSub, decryptPush, checkVapid } = require('../helpers/claude');
const { loadServer } = require('../helpers/server');

const quiet = () => ({ log: mock.method(console, 'log', () => {}), error: mock.method(console, 'error', () => {}) });
const pushFile = (home) => path.join(home, '.local/share/corral/push.json');
const readPush = (home) => JSON.parse(fs.readFileSync(pushFile(home), 'utf8'));
const response = (status, body = '') => ({ status, ok: status >= 200 && status < 300, text: async () => body });

test('loadPush makes a P-256 key pair, default prefs, and saves them', () => {
  const { srv, home } = loadServer();
  srv.loadPush();
  const p = srv.state.push;
  assert.deepEqual(p.prefs, { turn: true, permission: true, away: true, awake: true });
  assert.deepEqual([p.subs, p.muted], [[], {}]);
  const pub = Buffer.from(p.publicKey, 'base64url');
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);
  assert.equal(p.privateKey.crv, 'P-256');
  assert.deepEqual(readPush(home), JSON.parse(JSON.stringify(p)));
  assert.equal(fs.statSync(pushFile(home)).mode & 0o777, 0o600);
});

test('loadPush keeps the saved key, subscriptions, and settings, and fills in what is missing', () => {
  const first = loadServer();
  first.srv.loadPush();
  const saved = readPush(first.home);
  saved.subs = [{ endpoint: 'https://web.push.apple.com/x', keys: {} }];
  saved.prefs = { turn: false, extra: 1 };
  saved.muted = { s1: true };
  fs.writeFileSync(pushFile(first.home), JSON.stringify(saved));
  first.srv.loadPush();
  const p = first.srv.state.push;
  assert.equal(p.publicKey, saved.publicKey);
  assert.deepEqual(p.privateKey, saved.privateKey);
  assert.deepEqual(p.subs, saved.subs);
  assert.deepEqual(p.prefs, { turn: false, permission: true, away: true, awake: true, extra: 1 });
  assert.deepEqual(p.muted, { s1: true });
});

test('loadPush repairs a saved file whose subs or muted have the wrong shape', () => {
  const { srv, home } = loadServer();
  srv.loadPush();
  const saved = readPush(home);
  fs.writeFileSync(pushFile(home), JSON.stringify({ ...saved, subs: 'oops', muted: 'oops' }));
  srv.loadPush();
  assert.deepEqual([srv.state.push.subs, srv.state.push.muted], [[], {}]);
  fs.writeFileSync(pushFile(home), JSON.stringify({ ...saved, muted: null }));
  srv.loadPush();
  assert.deepEqual(srv.state.push.muted, {});
});

test('loadPush makes a new key when the saved file has none or is not JSON', () => {
  const { srv, home } = loadServer();
  srv.loadPush();
  const old = srv.state.push.publicKey;
  fs.writeFileSync(pushFile(home), '{not json');
  srv.loadPush();
  assert.notEqual(srv.state.push.publicKey, old);
  fs.writeFileSync(pushFile(home), JSON.stringify({ publicKey: 'x' }));
  srv.loadPush();
  assert.equal(srv.state.push.privateKey.crv, 'P-256');
});

test('savePush writes the current state, and reports a failure instead of throwing', () => {
  const { srv, home } = loadServer();
  srv.loadPush();
  srv.state.push.prefs.turn = false;
  srv.savePush();
  assert.equal(readPush(home).prefs.turn, false);

  const bad = loadServer();
  bad.srv.state.push = { subs: [] };
  fs.mkdirSync(path.dirname(path.dirname(pushFile(bad.home))), { recursive: true });
  fs.writeFileSync(path.dirname(pushFile(bad.home)), 'a file where the data folder should be');
  const { error } = quiet();
  bad.srv.savePush();
  assert.match(error.mock.calls[0].arguments.join(' '), /^push save failed: /);
});

test('vapidHeader is a JWT signed with the server key, naming the push service and this server', () => {
  const { srv } = setup();
  const before = Math.floor(Date.now() / 1000);
  const h = checkVapid(srv.vapidHeader('https://web.push.apple.com/send/abc?x=1'));
  assert.equal(h.valid, true);
  assert.equal(h.k, srv.state.push.publicKey);
  assert.deepEqual(h.head, { typ: 'JWT', alg: 'ES256' });
  assert.equal(h.claims.aud, 'https://web.push.apple.com');
  assert.equal(h.claims.sub, 'https://github.com/ismayc/corral');
  assert.ok(h.claims.exp >= before + 12 * 3600 && h.claims.exp <= before + 12 * 3600 + 5);
});

test('vapidHeader signatures fail to verify under a different key', () => {
  const { srv } = setup();
  const header = srv.vapidHeader('https://fcm.googleapis.com/fcm/send/x');
  const other = setup();
  const swapped = header.replace(/k=.*$/, `k=${other.srv.state.push.publicKey}`);
  assert.equal(checkVapid(swapped).valid, false);
  assert.throws(() => srv.vapidHeader('not a url'));
});

test('encryptPush output decrypts to the message with the subscriber keys (RFC 8291)', () => {
  const { srv } = setup();
  const ua = makeSub();
  const message = { title: 'Hello', body: 'Ünïcode body', tag: 'x' };
  const body = srv.encryptPush(ua.sub, JSON.stringify(message));
  const d = decryptPush(ua, body);
  assert.deepEqual(JSON.parse(d.text), message);
  assert.equal(d.recordSize, 4096);
  assert.equal(d.idLen, 65);
  assert.equal(d.delimiter, 2);
  assert.equal(d.asPub[0], 4);
  assert.equal(body.length, 21 + 65 + Buffer.byteLength(JSON.stringify(message)) + 1 + 16);
});

test('encryptPush uses a new salt and key each time, and only the matching subscriber can read it', () => {
  const { srv } = setup();
  const ua = makeSub();
  const a = srv.encryptPush(ua.sub, 'same');
  const b = srv.encryptPush(ua.sub, 'same');
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
  assert.notDeepEqual(a, b);
  const stranger = makeSub();
  assert.throws(() => decryptPush({ ...stranger }, a));
  assert.equal(decryptPush(ua, b).text, 'same');
});

test('sendPush posts the encrypted message with VAPID and the TTL headers, and answers ok', async () => {
  const { srv } = setup();
  const ua = makeSub('https://web.push.apple.com/send/abc');
  const fetch = mock.method(globalThis, 'fetch', async () => response(201));
  assert.equal(await srv.sendPush(ua.sub, { title: 'T', body: 'B' }), 'ok');
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, ua.sub.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.headers.TTL, '3600');
  assert.equal(init.headers.Urgency, 'high');
  assert.equal(checkVapid(init.headers.Authorization).valid, true);
  assert.deepEqual(JSON.parse(decryptPush(ua, init.body).text), { title: 'T', body: 'B' });
  assert.ok(init.signal instanceof AbortSignal);
});

test('sendPush answers gone when the push service says the subscription is dropped', async () => {
  const { srv } = setup();
  const ua = makeSub();
  const { error } = quiet();
  for (const status of [404, 410]) {
    mock.method(globalThis, 'fetch', async () => response(status));
    assert.equal(await srv.sendPush(ua.sub, {}), 'gone');
  }
  assert.equal(error.mock.calls.length, 0);
});

test('sendPush answers failed and logs the service reply on another HTTP error', async () => {
  const { srv } = setup();
  const ua = makeSub();
  const { error } = quiet();
  mock.method(globalThis, 'fetch', async () => response(413, 'x'.repeat(500)));
  assert.equal(await srv.sendPush(ua.sub, {}), 'failed');
  assert.equal(error.mock.calls[0].arguments[0], `push to web.push.apple.com failed: HTTP 413 ${'x'.repeat(200)}`);
});

test('sendPush answers failed when the request itself throws', async () => {
  const { srv } = setup();
  const { error } = quiet();
  mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  assert.equal(await srv.sendPush(makeSub().sub, {}), 'failed');
  assert.deepEqual(error.mock.calls[0].arguments, ['push failed:', 'network down']);
});

test('pushAll with no devices sends nothing', async () => {
  const { srv } = setup();
  const fetch = mock.method(globalThis, 'fetch', async () => response(201));
  assert.deepEqual(await srv.pushAll({ title: 'x' }), []);
  assert.equal(fetch.mock.calls.length, 0);
});

test('pushAll sends to every device and logs the results', async () => {
  const c = setup();
  const [a, b] = [makeSub('https://web.push.apple.com/a'), makeSub('https://fcm.googleapis.com/b')];
  c.srv.state.push.subs = [a.sub, b.sub];
  const { log } = quiet();
  mock.method(globalThis, 'fetch', async () => response(201));
  assert.deepEqual(await c.srv.pushAll({ title: 'Window needs you' }), ['ok', 'ok']);
  assert.deepEqual(log.mock.calls[0].arguments, ['push "Window needs you": ok, ok']);
  assert.equal(c.srv.state.push.subs.length, 2);
});

test('pushAll forgets and saves devices the push service reports gone', async () => {
  const c = setup();
  const [a, b, d] = [makeSub('https://web.push.apple.com/a'), makeSub('https://fcm.googleapis.com/b'), makeSub('https://web.push.apple.com/d')];
  c.srv.state.push.subs = [a.sub, b.sub, d.sub];
  quiet();
  mock.method(globalThis, 'fetch', async (url) => response(url.endsWith('/b') ? 410 : url.endsWith('/d') ? 500 : 201));
  assert.deepEqual(await c.srv.pushAll({ title: 't' }), ['ok', 'gone', 'failed']);
  assert.deepEqual(c.srv.state.push.subs.map((s) => s.endpoint), [a.sub.endpoint, d.sub.endpoint]);
  assert.deepEqual(readPush(c.home).subs.map((s) => s.endpoint), [a.sub.endpoint, d.sub.endpoint]);
});

test('cleanSubscription accepts a subscription from a known push service and keeps only its fields', () => {
  const { srv } = setup();
  const ua = makeSub('https://web.push.apple.com/wpush/v2/abc');
  const raw = { subscription: { ...ua.sub, expirationTime: null, extra: 1 } };
  assert.deepEqual(srv.cleanSubscription(raw), ua.sub);
  for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'wns2.notify.windows.com', 'x.push.apple.com']) {
    assert.ok(srv.cleanSubscription({ subscription: { ...ua.sub, endpoint: `https://${host}/p` } }), host);
  }
});

test('cleanSubscription refuses a missing, malformed, or foreign subscription', () => {
  const { srv } = setup();
  const ua = makeSub();
  const withEndpoint = (endpoint) => ({ subscription: { ...ua.sub, endpoint } });
  const bad = [
    null, undefined, {}, { subscription: null }, { subscription: 'x' },
    withEndpoint(5), withEndpoint(undefined),
    withEndpoint(`https://web.push.apple.com/${'a'.repeat(2048)}`),
    withEndpoint('not a url'),
    withEndpoint('http://web.push.apple.com/a'),
    withEndpoint('https://evil.example/a'),
    withEndpoint('https://evilpush.apple.com.example/a'),
    withEndpoint('https://notpush.apple.com/a'),
    { subscription: { endpoint: ua.sub.endpoint } },
    { subscription: { endpoint: ua.sub.endpoint, keys: { p256dh: ua.sub.keys.p256dh } } },
    { subscription: { endpoint: ua.sub.endpoint, keys: { p256dh: 5, auth: ua.sub.keys.auth } } },
    { subscription: { endpoint: ua.sub.endpoint, keys: { p256dh: ua.sub.keys.p256dh, auth: 5 } } },
    { subscription: { endpoint: ua.sub.endpoint, keys: { p256dh: 'AAAA', auth: ua.sub.keys.auth } } },
    { subscription: { endpoint: ua.sub.endpoint, keys: { p256dh: ua.sub.keys.p256dh, auth: 'AAAA' } } },
  ];
  for (const b of bad) assert.equal(srv.cleanSubscription(b), null, JSON.stringify(b)?.slice(0, 80));
});

test('macIdleSeconds converts IOKit HIDIdleTime from nanoseconds', () => {
  let out = 'junk\n    "HIDIdleTime" = 5000000000\nmore';
  const { srv } = setup({ exec: { ioreg: () => out } });
  assert.equal(srv.macIdleSeconds(), 5);
  out = '"HIDIdleTime" = 1500000000';
  assert.equal(srv.macIdleSeconds(), 1.5);
});

test('macIdleSeconds is infinite when ioreg has no idle time or cannot run', () => {
  const { srv } = setup({ exec: { ioreg: () => 'nothing useful' } });
  assert.equal(srv.macIdleSeconds(), Infinity);
  assert.equal(setup().srv.macIdleSeconds(), Infinity); // no ioreg program at all
});

test('macIdleSeconds asks ioreg for the HID system only', () => {
  let args;
  const { srv } = setup({ exec: { ioreg: (a) => { args = a; return '"HIDIdleTime" = 1'; } } });
  srv.macIdleSeconds();
  assert.deepEqual(args, ['-c', 'IOHIDSystem', '-d', '4']);
});

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('keepAwake starts one caffeinate for this process and stops it when switched off', () => {
  const { srv } = setup();
  const child = fakeChild();
  const spawn = mock.method(cp, 'spawn', () => child);
  srv.keepAwake(true);
  srv.keepAwake(true);
  assert.equal(spawn.mock.calls.length, 1);
  assert.deepEqual(spawn.mock.calls[0].arguments, ['/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }]);
  assert.equal(srv.state.caffeinate, child);
  srv.keepAwake(false);
  assert.equal(child.killed, true);
  assert.equal(srv.state.caffeinate, null);
  srv.keepAwake(false);
});

test('keepAwake starts a new caffeinate after the old one exits on its own', () => {
  const { srv } = setup();
  const first = fakeChild();
  const second = fakeChild();
  const kids = [first, second];
  mock.method(cp, 'spawn', () => kids.shift());
  srv.keepAwake(true);
  first.emit('exit');
  assert.equal(srv.state.caffeinate, null);
  srv.keepAwake(true);
  assert.equal(srv.state.caffeinate, second);
});

test('keepAwake carries on when caffeinate cannot be started', () => {
  const { srv } = setup();
  mock.method(cp, 'spawn', () => { throw new Error('ENOENT'); });
  srv.keepAwake(true);
  assert.equal(srv.state.caffeinate, null);
  srv.keepAwake(false);
});
