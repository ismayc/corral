const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mock } = require('node:test');
const { setup, promptScreen, makeSub, decryptPush } = require('../helpers/claude');
const { listen } = require('../helpers/server');

// Runs fn with a server listening on a free port; closes it afterwards.
async function withServer(opts, fn) {
  const c = setup(opts);
  const h = await listen(c.srv);
  try { await fn(c, h.request); } finally { await h.close(); }
}
const pushFile = (c) => path.join(c.home, '.local/share/corral/push.json');
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

test('GET /api/overview lists the windows with their Claude status, under this Mac\'s name', () => withServer({}, async (c, req) => {
  const s = c.open('proj');
  c.claude(s, { status: 'busy' });
  const r = await req('GET', '/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.machine, os.hostname().replace(/\.local$/, ''));
  assert.equal(r.json.sessions.length, 1);
  assert.equal(r.json.sessions[0].id, s.id);
  assert.equal(r.json.sessions[0].claude.status, 'busy');
}));

test('GET /api/overview names the Mac as Tailscale does when it knows', () => withServer({}, async (c, req) => {
  c.srv.state.tailnet = { host: 'studio.tail1.ts.net:8443', origin: 'https://studio.tail1.ts.net:8443', url: 'https://studio.tail1.ts.net:8443/', logins: new Set(['me@example.com']), machine: 'Studio', served: true };
  assert.equal((await req('GET', '/api/overview')).json.machine, 'Studio');
}));

test('GET /api/remote offers the tailnet link only when tailscale serve forwards here', () => withServer({}, async (c, req) => {
  assert.deepEqual((await req('GET', '/api/remote')).json, { url: null, machine: null, remote: false });
  const tailnet = { host: 'studio.tail1.ts.net:8443', origin: 'https://studio.tail1.ts.net:8443', url: 'https://studio.tail1.ts.net:8443/', logins: new Set(['me@example.com']), machine: 'Studio', served: false };
  c.srv.state.tailnet = tailnet;
  assert.deepEqual((await req('GET', '/api/remote')).json, { url: null, machine: 'Studio', remote: false });
  tailnet.served = true;
  assert.deepEqual((await req('GET', '/api/remote')).json, { url: 'https://studio.tail1.ts.net:8443/', machine: 'Studio', remote: false });
  const viaTailnet = await req('GET', '/api/remote', { headers: { host: tailnet.host, 'tailscale-user-login': 'me@example.com' } });
  assert.deepEqual(viaTailnet.json, { url: 'https://studio.tail1.ts.net:8443/', machine: 'Studio', remote: true });
}));

test('GET /api/sessions/:id/history returns the scrollback as plain text', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  c.tmux.sessions.get(`wt-${s.id}`).history = 'line one\nline two\n\n\n';
  const r = await req('GET', `/api/sessions/${s.id}/history`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/plain/);
  assert.equal(r.text, 'line one\nline two\n');
}));

test('GET /api/sessions/:id/history is 404 for an unknown, plain, or exited window', async () => {
  await withServer({}, async (c, req) => {
    const gone = c.open('gone');
    gone.exited = true;
    for (const id of ['nope', gone.id]) assert.deepEqual((await req('GET', `/api/sessions/${id}/history`)).json, { error: 'no such window' });
  });
  await withServer({ tmux: false }, async (c, req) => {
    const plain = c.open('plain');
    assert.equal((await req('GET', `/api/sessions/${plain.id}/history`)).status, 404);
  });
});

test('GET /api/sessions/:id/history is 500 when tmux cannot read the window', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  c.tmux.fail.add('capture-pane');
  assert.deepEqual((await req('GET', `/api/sessions/${s.id}/history`)).json, { error: 'could not read the window' });
}));

test('window actions are 404 for an unknown or exited window', () => withServer({}, async (c, req) => {
  const gone = c.open('gone');
  gone.exited = true;
  const cases = [['GET', 'prompt'], ['POST', 'answer'], ['POST', 'key'], ['POST', 'rename'], ['POST', 'mute'], ['GET', 'last'], ['GET', 'conversation'], ['GET', 'changes'], ['POST', 'upload']];
  for (const id of ['nope', gone.id]) {
    for (const [method, action] of cases) {
      const r = await req(method, `/api/sessions/${id}/${action}`, method === 'POST' ? { body: {} } : {});
      assert.deepEqual([r.status, r.json], [404, { error: 'no such window' }], `${method} ${action}`);
    }
  }
}));

test('a window action used with the wrong method falls through to not found', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  for (const action of ['answer', 'key', 'rename', 'mute', 'upload']) {
    assert.equal((await req('GET', `/api/sessions/${s.id}/${action}`)).status, 404, `GET ${action}`);
  }
  for (const action of ['prompt', 'last', 'conversation', 'changes']) {
    assert.deepEqual((await req('POST', `/api/sessions/${s.id}/${action}`, { body: {} })).json, { error: 'not found' }, `POST ${action}`);
  }
}));

test('GET /api/sessions/:id/prompt returns the open permission prompt with its key', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  assert.deepEqual((await req('GET', `/api/sessions/${s.id}/prompt`)).json, { prompt: null });
  const id = c.claude(s, { status: 'waiting', waitingFor: 'input' });
  c.screen(s, promptScreen());
  assert.deepEqual((await req('GET', `/api/sessions/${s.id}/prompt`)).json, { prompt: null });
  c.claude(s, { sessionId: id, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 55 });
  const r = (await req('GET', `/api/sessions/${s.id}/prompt`)).json.prompt;
  assert.equal(r.key, c.srv.promptKey({ sessionId: id, since: 55 }));
  assert.deepEqual(r.options.map((o) => o.n), ['1', '2', '3']);
  c.screen(s, 'cleared');
  assert.deepEqual((await req('GET', `/api/sessions/${s.id}/prompt`)).json, { prompt: null });
}));

function asking(c) {
  const s = c.open('asker');
  const id = c.claude(s, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 31 });
  c.screen(s, promptScreen());
  return { s, key: c.srv.promptKey({ sessionId: id, since: 31 }) };
}

test('POST /api/sessions/:id/answer sends the chosen answer to the window', () => withServer({}, async (c, req) => {
  const { s, key } = asking(c);
  const r = await req('POST', `/api/sessions/${s.id}/answer`, { body: { choice: '2', key } });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepEqual(c.tmux.keys, [{ target: `wt-${s.id}`, keys: ['-l', '2'] }]);
  const deny = await req('POST', `/api/sessions/${s.id}/answer`, { body: { choice: 'deny', key } });
  assert.equal(deny.status, 200);
  assert.deepEqual(c.tmux.keys[1].keys, ['Escape']);
}));

test('POST /api/sessions/:id/answer refuses a stale key, a bad choice, and bad input', () => withServer({}, async (c, req) => {
  const { s, key } = asking(c);
  const url = `/api/sessions/${s.id}/answer`;
  assert.equal((await req('POST', url, { body: { choice: '1', key: 'old' } })).status, 409);
  assert.equal((await req('POST', url, { body: { choice: '1' } })).status, 409);
  assert.equal((await req('POST', url, { body: { choice: '1', key: 5 } })).status, 409);
  assert.deepEqual((await req('POST', url, { body: { choice: '9', key } })).json, { error: 'that is not one of the answers' });
  assert.equal((await req('POST', url, { raw: 'not json' })).status, 400);
  assert.deepEqual((await req('POST', url, { body: { choice: 2, key } })).json, { error: 'bad json' });
  assert.deepEqual(c.tmux.keys, []);
}));

test('POST /api/sessions/:id/answer and /key are 409 for a window without tmux', () => withServer({ tmux: false }, async (c, req) => {
  const s = c.open('plain');
  for (const [action, body] of [['answer', { choice: '1' }], ['key', { key: 'stop' }]]) {
    const r = await req('POST', `/api/sessions/${s.id}/${action}`, { body });
    assert.deepEqual([r.status, r.json], [409, { error: 'this window has no tmux session' }]);
  }
}));

test('POST /api/sessions/:id/key sends Stop and Shift-Tab to a window that is working', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const url = `/api/sessions/${s.id}/key`;
  c.claude(s, { status: 'busy' });
  assert.deepEqual((await req('POST', url, { body: { key: 'stop' } })).json, { ok: true });
  assert.deepEqual((await req('POST', url, { body: { key: 'mode' } })).json, { ok: true });
  assert.deepEqual(c.tmux.keys.map((k) => k.keys), [['Escape'], ['BTab']]);
}));

test('POST /api/sessions/:id/key refuses unknown keys, bad bodies, and the wrong state', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const url = `/api/sessions/${s.id}/key`;
  c.claude(s, { status: 'idle' });
  assert.deepEqual((await req('POST', url, { body: { key: 'stop' } })).json, { error: 'Claude is not working in this window' });
  assert.equal((await req('POST', url, { body: { key: 'enter' } })).status, 400);
  assert.equal((await req('POST', url, { raw: 'not json' })).status, 400);
  assert.deepEqual(c.tmux.keys, []);
}));

test('POST /api/sessions/:id/rename renames the window', () => withServer({}, async (c, req) => {
  const s = c.open('old');
  const r = await req('POST', `/api/sessions/${s.id}/rename`, { body: { label: ' Fresh  name ' } });
  assert.deepEqual([r.status, r.json], [200, { ok: true, label: 'Fresh name' }]);
  assert.equal(s.label, 'Fresh name');
  assert.equal((await req('POST', `/api/sessions/${s.id}/rename`, { body: { label: '' } })).status, 400);
  assert.equal((await req('POST', `/api/sessions/${s.id}/rename`, { raw: 'not json' })).status, 400);
  assert.equal(s.label, 'Fresh name');
}));

test('POST /api/sessions/:id/mute turns pushes for a window off and on, and saves it', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const url = `/api/sessions/${s.id}/mute`;
  assert.deepEqual((await req('POST', url, { body: { muted: true } })).json, { muted: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(pushFile(c), 'utf8')).muted, { [s.id]: true });
  assert.equal(c.srv.overview()[0].muted, true);
  assert.deepEqual((await req('POST', url, { body: { muted: false } })).json, { muted: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(pushFile(c), 'utf8')).muted, {});
  assert.equal((await req('POST', url, { body: { muted: 'yes' } })).status, 400);
  assert.equal((await req('POST', url, { raw: 'not json' })).status, 400);
}));

test('GET /api/sessions/:id/last returns the last reply, or why there is none', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const url = `/api/sessions/${s.id}/last`;
  assert.deepEqual((await req('GET', url)).json, { error: 'Claude Code is not running in this window' });
  const id = c.claude(s, { status: 'idle' });
  const missing = await req('GET', url);
  assert.deepEqual([missing.status, missing.json], [404, { error: 'no transcript yet' }]);
  const file = c.transcript(id, [{ type: 'user', message: { content: 'hi' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'hello back' }] } }]);
  const r = await req('GET', url);
  assert.deepEqual([r.status, r.json], [200, { text: 'hello back', at: fs.statSync(file).mtimeMs }]);
}));

test('GET /api/sessions/:id/conversation returns the conversation, or why there is none', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const url = `/api/sessions/${s.id}/conversation`;
  assert.equal((await req('GET', url)).status, 409);
  const id = c.claude(s, { status: 'idle' });
  assert.equal((await req('GET', url)).status, 404);
  c.transcript(id, [{ type: 'user', timestamp: 't', message: { content: 'hi' } }]);
  const r = await req('GET', url);
  assert.deepEqual([r.status, r.json], [200, { items: [{ who: 'you', text: 'hi', at: 't' }], cut: false, claude: 'idle', statusLines: [] }]);
}));

test('last and conversation answer 500 when the transcript cannot be read', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const id = c.claude(s, { status: 'idle' });
  fs.mkdirSync(path.join(c.home, '.claude/projects/p', `${id}.jsonl`), { recursive: true });
  for (const action of ['last', 'conversation']) {
    const r = await req('GET', `/api/sessions/${s.id}/${action}`);
    assert.deepEqual([r.status, r.json], [500, { error: 'could not read the transcript' }]);
  }
}));

test('GET /api/sessions/:id/changes reports the project\'s repository', () => withServer({
  exec: { git: (args) => ({ 'rev-parse': '/work/myrepo\n', branch: 'feature\n', status: ' M a.js\n', diff: 'DIFF' }[args[2]]) },
}, async (c, req) => {
  const s = c.open('a');
  const r = await req('GET', `/api/sessions/${s.id}/changes`);
  assert.deepEqual([r.status, r.json], [200, { repo: 'myrepo', root: '/work/myrepo', branch: 'feature', files: [{ code: ' M', path: 'a.js' }], diff: 'DIFF', truncated: false }]);
}));

test('GET /api/sessions/:id/changes says when the folder is not in a repository', () => withServer({}, async (c, req) => {
  const plain = path.join(c.home, 'plain');
  fs.mkdirSync(plain);
  const s = c.open('a', plain);
  assert.deepEqual((await req('GET', `/api/sessions/${s.id}/changes`)).json, { repo: null, cwd: plain });
}));

test('POST /api/sessions/:id/upload saves a photo and returns its path', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const r = await req('POST', `/api/sessions/${s.id}/upload`, { body: { type: 'image/png', data: png } });
  assert.equal(r.status, 201);
  assert.equal(path.dirname(r.json.path), c.srv.constants.UPLOAD_DIR);
  assert.equal(fs.readFileSync(r.json.path).toString('base64'), png);
}));

test('POST /api/sessions/:id/upload refuses bad JSON, unsupported or empty photos', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  const url = `/api/sessions/${s.id}/upload`;
  assert.deepEqual((await req('POST', url, { raw: 'not json' })).json, { error: 'bad json, or the photo is too large' });
  assert.equal((await req('POST', url, { body: { type: 'text/plain', data: png } })).status, 400);
  assert.equal((await req('POST', url, { body: { type: 'image/png', data: '' } })).status, 413);
}));

test('POST /api/sessions/:id/upload answers 500 when the photo cannot be written', () => withServer({}, async (c, req) => {
  const s = c.open('a');
  fs.mkdirSync(c.srv.constants.DATA_DIR, { recursive: true });
  fs.writeFileSync(c.srv.constants.UPLOAD_DIR, 'a file where the folder should be');
  const r = await req('POST', `/api/sessions/${s.id}/upload`, { body: { type: 'image/png', data: png } });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /^could not save: /);
}));

test('GET /api/push returns the public key, device count, and settings', () => withServer({}, async (c, req) => {
  const r = await req('GET', '/api/push');
  assert.deepEqual(r.json, { key: c.srv.state.push.publicKey, devices: 0, prefs: { turn: true, permission: true, away: true, awake: true } });
}));

test('POST /api/push/subscribe stores a valid subscription once, with its user agent', () => withServer({}, async (c, req) => {
  const ua = makeSub('https://web.push.apple.com/one');
  const body = { subscription: ua.sub };
  const r = await req('POST', '/api/push/subscribe', { body, headers: { 'user-agent': 'iPhone Safari' } });
  assert.deepEqual([r.status, r.json], [200, { ok: true, devices: 1 }]);
  const again = await req('POST', '/api/push/subscribe', { body, headers: { 'user-agent': 'x'.repeat(300) } });
  assert.deepEqual(again.json, { ok: true, devices: 1 });
  const [sub] = c.srv.state.push.subs;
  assert.deepEqual(sub.keys, ua.sub.keys);
  assert.equal(sub.ua, 'x'.repeat(200));
  assert.equal(typeof sub.added, 'number');
  assert.equal((await req('GET', '/api/push')).json.devices, 1);
  assert.equal(JSON.parse(fs.readFileSync(pushFile(c), 'utf8')).subs.length, 1);
}));

test('POST /api/push/subscribe records an empty user agent when none is sent', () => withServer({}, async (c, req) => {
  await req('POST', '/api/push/subscribe', { body: { subscription: makeSub().sub } });
  assert.equal(c.srv.state.push.subs[0].ua, '');
}));

test('POST /api/push/subscribe keeps the 10 newest devices', () => withServer({}, async (c, req) => {
  for (let i = 0; i < 12; i++) await req('POST', '/api/push/subscribe', { body: { subscription: makeSub(`https://web.push.apple.com/d${i}`).sub } });
  const ends = c.srv.state.push.subs.map((s) => s.endpoint);
  assert.equal(ends.length, 10);
  assert.equal(ends[0], 'https://web.push.apple.com/d2');
  assert.equal(ends[9], 'https://web.push.apple.com/d11');
}));

test('POST /api/push/subscribe refuses anything that is not a known push service subscription', () => withServer({}, async (c, req) => {
  const expected = { error: 'not a push subscription from a known push service' };
  for (const body of [{}, { subscription: { endpoint: 'https://evil.example/x', keys: makeSub().sub.keys } }]) {
    const r = await req('POST', '/api/push/subscribe', { body });
    assert.deepEqual([r.status, r.json], [400, expected]);
  }
  assert.equal((await req('POST', '/api/push/subscribe', { raw: 'not json' })).status, 400);
  assert.equal(c.srv.state.push.subs.length, 0);
}));

test('POST /api/push/unsubscribe removes one device', () => withServer({}, async (c, req) => {
  const [a, b] = [makeSub('https://web.push.apple.com/a'), makeSub('https://web.push.apple.com/b')];
  c.srv.state.push.subs = [a.sub, b.sub];
  assert.deepEqual((await req('POST', '/api/push/unsubscribe', { body: { endpoint: 'https://web.push.apple.com/other' } })).json, { ok: true, devices: 2 });
  assert.deepEqual((await req('POST', '/api/push/unsubscribe', { body: { endpoint: a.sub.endpoint } })).json, { ok: true, devices: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(pushFile(c), 'utf8')).subs.map((s) => s.endpoint), [b.sub.endpoint]);
  assert.equal((await req('POST', '/api/push/unsubscribe', { body: { endpoint: 5 } })).status, 400);
  assert.equal((await req('POST', '/api/push/unsubscribe', { body: {} })).status, 400);
  assert.equal((await req('POST', '/api/push/unsubscribe', { raw: 'not json' })).status, 400);
}));

test('POST /api/push/prefs changes only the settings sent as true or false, and saves them', () => withServer({}, async (c, req) => {
  const r = await req('POST', '/api/push/prefs', { body: { turn: false, away: false, permission: 'no', awake: 0, unknown: false } });
  assert.deepEqual([r.status, r.json], [200, { prefs: { turn: false, permission: true, away: false, awake: true } }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(pushFile(c), 'utf8')).prefs, { turn: false, permission: true, away: false, awake: true });
  assert.equal((await req('POST', '/api/push/prefs', { body: { awake: false } })).json.prefs.awake, false);
  assert.equal((await req('POST', '/api/push/prefs', { raw: 'not json' })).status, 400);
}));

test('POST /api/push/test sends an encrypted test notification to the asking device', () => withServer({}, async (c, req) => {
  const ua = makeSub();
  c.srv.state.push.subs = [ua.sub];
  const fetch = mock.method(globalThis, 'fetch', async () => ({ status: 201, ok: true, text: async () => '' }));
  const r = await req('POST', '/api/push/test', { body: { endpoint: ua.sub.endpoint } });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepEqual(JSON.parse(decryptPush(ua, fetch.mock.calls[0].arguments[1].body).text), {
    title: 'Corral', body: 'Notifications work. You will hear from Corral when a window needs you.', tag: 'test', url: '/m',
  });
}));

test('POST /api/push/test is 404 for a device that is not subscribed', () => withServer({}, async (c, req) => {
  c.srv.state.push.subs = [makeSub().sub];
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });
  for (const opts of [{ body: { endpoint: 'https://web.push.apple.com/zzz' } }, { body: {} }, { raw: 'not json' }]) {
    const r = await req('POST', '/api/push/test', opts);
    assert.deepEqual([r.status, r.json], [404, { error: 'this device is not subscribed' }]);
  }
  assert.equal(fetch.mock.calls.length, 0);
}));

test('POST /api/push/test is 502 with the push service answer when the push fails', () => withServer({}, async (c, req) => {
  const ua = makeSub();
  c.srv.state.push.subs = [ua.sub];
  mock.method(console, 'error', () => {});
  mock.method(globalThis, 'fetch', async () => ({ status: 410, ok: false, text: async () => '' }));
  const gone = await req('POST', '/api/push/test', { body: { endpoint: ua.sub.endpoint } });
  assert.deepEqual([gone.status, gone.json], [502, { error: 'the push service answered: gone' }]);
  mock.method(globalThis, 'fetch', async () => ({ status: 500, ok: false, text: async () => 'oops' }));
  const failed = await req('POST', '/api/push/test', { body: { endpoint: ua.sub.endpoint } });
  assert.deepEqual([failed.status, failed.json], [502, { error: 'the push service answered: failed' }]);
}));
