const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { mock } = require('node:test');
const { setup, promptScreen, makeSub, decryptPush } = require('../helpers/claude');
const { tick } = require('../helpers/server');

// A server with a subscribed phone whose pushes are decrypted, and a fake caffeinate.
function watcher(opts = {}) {
  let idle = 'HIDIdleTime unknown';
  const c = setup({ ...opts, exec: { ioreg: () => idle, ...opts.exec } });
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  const ua = makeSub();
  const children = [];
  const spawn = mock.method(cp, 'spawn', () => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  });
  const fetch = mock.method(globalThis, 'fetch', async () => ({ status: 201, ok: true, text: async () => '' }));
  let seen = 0;
  c.ua = ua;
  c.subscribe = () => { c.srv.state.push.subs = [ua.sub]; };
  c.spawn = spawn;
  c.children = children;
  c.idleFor = (seconds) => { idle = `"HIDIdleTime" = ${seconds * 1e9}`; };
  // One watcher pass; returns the pushes it sent.
  c.step = async () => {
    c.srv.watchWindows();
    await tick(10);
    const calls = fetch.mock.calls.slice(seen);
    seen = fetch.mock.calls.length;
    return calls.map((x) => JSON.parse(decryptPush(ua, x.arguments[1].body).text));
  };
  const ids = new Map();
  c.set = (s, fields) => { ids.set(s.id, c.claude(s, { sessionId: ids.get(s.id), ...fields })); };
  return c;
}

test('watchWindows keeps the Mac awake only while a window is busy or waiting', async () => {
  const c = watcher();
  const s = c.open('a');
  c.set(s, { status: 'idle' });
  c.srv.watchWindows();
  assert.equal(c.spawn.mock.calls.length, 0);
  c.set(s, { status: 'busy' });
  c.srv.watchWindows();
  assert.equal(c.spawn.mock.calls.length, 1);
  c.set(s, { status: 'waiting', waitingFor: 'input' });
  c.srv.watchWindows();
  assert.equal(c.spawn.mock.calls.length, 1);
  assert.equal(c.children[0].killed, undefined);
  c.set(s, { status: 'idle' });
  c.srv.watchWindows();
  assert.equal(c.children[0].killed, true);
});

test('watchWindows does not keep the Mac awake when the awake setting is off, or for a shell window', () => {
  const c = watcher();
  const s = c.open('a');
  c.set(s, { status: 'busy' });
  c.srv.state.push.prefs.awake = false;
  c.srv.watchWindows();
  c.srv.state.push.prefs.awake = true;
  c.srv.watchWindows();
  assert.equal(c.spawn.mock.calls.length, 1);
  const c2 = watcher();
  c2.open('shell');
  c2.srv.watchWindows();
  assert.equal(c2.spawn.mock.calls.length, 0);
});

test('watchWindows ignores an exited window when deciding to stay awake', () => {
  const c = watcher();
  const s = c.open('a');
  c.set(s, { status: 'busy' });
  s.exited = true;
  c.srv.watchWindows();
  assert.equal(c.spawn.mock.calls.length, 0);
});

test('watchWindows gives up quietly when the window list cannot be read', () => {
  const c = watcher();
  c.open('a');
  c.srv.state.push = null; // overview reads push.muted for each window and throws
  assert.doesNotThrow(() => c.srv.watchWindows());
  assert.equal(c.spawn.mock.calls.length, 0);
});

test('watchWindows forgets muted settings for windows that no longer exist', () => {
  const c = watcher();
  const a = c.open('a');
  c.srv.state.push.muted = { [a.id]: true, gone: true };
  c.srv.watchWindows();
  assert.deepEqual(c.srv.state.push.muted, { [a.id]: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.home, '.local/share/corral/push.json'), 'utf8')).muted, { [a.id]: true });
});

test('watchWindows leaves the saved file alone when no muted window is gone', () => {
  const c = watcher();
  const a = c.open('a');
  c.srv.state.push.muted = { [a.id]: true };
  const file = path.join(c.home, '.local/share/corral/push.json');
  fs.rmSync(file);
  c.srv.watchWindows();
  assert.equal(fs.existsSync(file), false);
});

test('watchWindows with no devices forgets what it has seen and unprimes', async () => {
  const c = watcher();
  const s = c.open('a');
  c.set(s, { status: 'busy' });
  c.subscribe();
  await c.step();
  assert.equal(c.srv.state.watchPrimed, true);
  assert.equal(c.srv.lastSeen.get(s.id), 'busy');
  c.srv.state.push.subs = [];
  await c.step();
  assert.equal(c.srv.state.watchPrimed, false);
  assert.equal(c.srv.lastSeen.size, 0);
});

test('watchWindows sends no push for states that were already there at its first look', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('asking');
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(s, promptScreen());
  const idle = c.open('idle one');
  c.set(idle, { status: 'idle' });
  assert.deepEqual(await c.step(), []);
  assert.equal(c.srv.lastSeen.get(s.id), 'permission');
  assert.equal(c.srv.lastSeen.get(idle.id), 'idle');
  assert.deepEqual(await c.step(), []);
});

test('watchWindows tells the phone when a turn ends (busy to idle), once', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('my project');
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'idle' });
  assert.deepEqual(await c.step(), [{ title: 'my project: your turn', body: 'Claude finished and is waiting for you.', tag: s.id, url: `/m?w=${s.id}` }]);
  assert.deepEqual(await c.step(), []);
});

test('watchWindows does not announce idle after waiting, or a shell after Claude exits', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('a');
  c.set(s, { status: 'waiting', waitingFor: 'input' });
  await c.step();
  c.set(s, { status: 'idle' });
  assert.deepEqual(await c.step(), []);
  c.set(s, { status: 'busy' });
  await c.step();
  fs.rmSync(path.join(c.home, '.claude/sessions', `${c.pidOf(s)}.json`));
  assert.deepEqual(await c.step(), []);
  assert.equal(c.srv.lastSeen.get(s.id), 'shell');
});

test('watchWindows asks for permission with the prompt text and Allow and Deny buttons', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('deploy');
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: 4242 });
  c.screen(s, promptScreen());
  const [p] = await c.step();
  const key = c.srv.promptKey({ sessionId: c.srv.windowClaude(s).sessionId, since: 4242 });
  assert.deepEqual(p, {
    title: 'deploy needs permission', body: 'Bash command · npm test · Run the tests', tag: s.id, url: `/m?w=${s.id}`,
    answer: { id: s.id, key },
    actions: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }],
  });
  assert.deepEqual(await c.step(), []);
});

test('watchWindows sends a plain permission push when the prompt cannot be read from the screen', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('deploy');
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(s, 'nothing recognizable');
  assert.deepEqual(await c.step(), [{ title: 'deploy needs permission', body: 'Claude is asking before it goes on', tag: s.id, url: `/m?w=${s.id}` }]);
});

test('watchWindows summarizes at most four lines of the prompt and cuts the body at 220 characters', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('w');
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt' });
  const body = ['one', 'two', 'three', 'four', 'five'];
  c.screen(s, promptScreen({ body, title: 'Tool use' }));
  assert.equal((await c.step())[0].body, 'Tool use · one · two · three');
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(s, promptScreen({ body: ['x'.repeat(300)] }));
  assert.equal((await c.step())[0].body.length, 220);
});

test('watchWindows leaves out the approval line and the question from the summary', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('w');
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(s, promptScreen({ title: 'Edit file', body: ['src/app.js', 'This command requires approval'], question: 'Do you want to make this edit?' }));
  assert.equal((await c.step())[0].body, 'Edit file · src/app.js');
});

test('watchWindows respects the permission and turn settings', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('w');
  c.set(s, { status: 'busy' });
  await c.step();
  c.srv.state.push.prefs.turn = false;
  c.set(s, { status: 'idle' });
  assert.deepEqual(await c.step(), []);
  c.srv.state.push.prefs.permission = false;
  c.set(s, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(s, promptScreen());
  assert.deepEqual(await c.step(), []);
  assert.equal(c.srv.lastSeen.get(s.id), 'permission');
});

test('watchWindows stays quiet for a muted window but keeps tracking it', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('w');
  c.set(s, { status: 'busy' });
  await c.step();
  c.srv.state.push.muted[s.id] = true;
  c.set(s, { status: 'idle' });
  assert.deepEqual(await c.step(), []);
  assert.equal(c.srv.lastSeen.get(s.id), 'idle');
  delete c.srv.state.push.muted[s.id];
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'idle' });
  assert.equal((await c.step()).length, 1);
});

test('watchWindows treats a window opened after the first look as just started', async () => {
  const c = watcher();
  c.subscribe();
  const first = c.open('first');
  c.set(first, { status: 'idle' });
  await c.step();
  const busy = c.open('busy new');
  c.set(busy, { status: 'busy' });
  assert.deepEqual(await c.step(), []);
  const asking = c.open('asking new');
  c.set(asking, { status: 'waiting', waitingFor: 'permission prompt' });
  c.screen(asking, promptScreen());
  const pushes = await c.step();
  assert.deepEqual(pushes.map((p) => p.title), ['asking new needs permission']);
  c.set(busy, { status: 'idle' });
  assert.deepEqual((await c.step()).map((p) => p.title), ['busy new: your turn']);
});

test('watchWindows sends one push per event, to every device', async () => {
  const c = watcher();
  c.subscribe();
  const a = c.open('a');
  const b = c.open('b');
  c.set(a, { status: 'busy' });
  c.set(b, { status: 'busy' });
  await c.step();
  c.set(a, { status: 'idle' });
  c.set(b, { status: 'idle' });
  assert.deepEqual((await c.step()).map((p) => p.title).sort(), ['a: your turn', 'b: your turn']);
});

test('watchWindows forgets windows that are gone or exited', async () => {
  const c = watcher();
  c.subscribe();
  const a = c.open('a');
  const b = c.open('b');
  await c.step();
  assert.deepEqual([...c.srv.lastSeen.keys()].sort(), [a.id, b.id].sort());
  a.exited = true;
  c.srv.sessions.delete(b.id);
  await c.step();
  assert.equal(c.srv.lastSeen.size, 0);
});

test('watchWindows holds back pushes while you are at the Mac, when the away setting is on', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('w');
  c.set(s, { status: 'busy' });
  await c.step();
  c.idleFor(5);
  c.set(s, { status: 'idle' });
  assert.deepEqual(await c.step(), []);
  c.idleFor(119);
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'idle' });
  assert.deepEqual(await c.step(), []);
});

test('watchWindows sends once you have been away 120 seconds or the away setting is off', async () => {
  const c = watcher();
  c.subscribe();
  const s = c.open('w');
  c.set(s, { status: 'busy' });
  await c.step();
  c.idleFor(120);
  c.set(s, { status: 'idle' });
  assert.equal((await c.step()).length, 1);
  c.idleFor(1);
  c.srv.state.push.prefs.away = false;
  c.set(s, { status: 'busy' });
  await c.step();
  c.set(s, { status: 'idle' });
  assert.equal((await c.step()).length, 1);
});
