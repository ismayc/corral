// The ntfy section of the phone's Alerts sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, settle, unloadPage, fire } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

const TOPIC = 'corral-abcdefghijklmnopqrstuvwx';
const ON = { on: true, topic: TOPIC, server: 'https://ntfy.sh', url: `https://ntfy.sh/${TOPIC}` };
const OFF = { on: false, topic: null, server: 'https://ntfy.sh', url: null };
async function alerts(routes) {
  const p = await phone([], { routes: { 'GET /api/push': { key: 'k', devices: 0, prefs: { awake: true } }, ...routes } });
  p.$('#bell').click();
  await settle();
  return p;
}
const ntfyBox = (p) => p.$$('#notifybody label.row').find((l) => /ntfy app/.test(l.textContent)).querySelector('input');

test('ntfy starts off with a switch, and turning it on saves and draws the topic', async () => {
  let state = OFF;
  const p = await alerts({ 'GET /api/ntfy': () => state, 'POST /api/ntfy': (req) => { state = { ...ON, on: req.body.on }; return state; } });
  assert.ok(p.$$('#notifybody .section').some((s) => s.textContent === 'ntfy app'));
  const box = ntfyBox(p);
  assert.equal(box.checked, false);
  assert.equal(p.$('#notifybody .topic'), null);
  box.checked = true;
  fire(box, 'change');
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/ntfy')[0].body, { on: true });
  assert.equal(p.$('#toast').textContent, 'ntfy is on. Subscribe to the topic in the ntfy app.');
  const link = p.$('#notifybody .topic a');
  assert.equal(link.textContent, TOPIC);
  assert.equal(link.getAttribute('href'), `https://ntfy.sh/${TOPIC}`);
  ntfyBox(p).checked = false;
  fire(ntfyBox(p), 'change');
  await settle();
  assert.equal(p.$('#toast').textContent, 'ntfy is off.');
});

test('Copy, Send a test, and New topic do what they say, and failures say so', async () => {
  const p = await alerts({ 'GET /api/ntfy': ON, 'POST /api/ntfy/test': { ok: true }, 'POST /api/ntfy': ON });
  p.button('Copy the topic').click();
  await settle();
  assert.equal(p.clipboard.text, TOPIC);
  assert.equal(p.$('#toast').textContent, 'Copied the topic.');
  p.button('Send a test').click();
  await settle();
  assert.equal(p.$('#toast').textContent, 'Sent to ntfy. It should arrive in a few seconds.');
  p.button('New topic').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/ntfy').at(-1).body, { newTopic: true });
  assert.match(p.$('#toast').textContent, /^New topic made/);
  p.api.routes['POST /api/ntfy/test'] = new Error('down');
  p.button('Send a test').click();
  await settle();
  assert.equal(p.$('#toast').textContent, 'ntfy did not take the test.');
  p.api.routes['POST /api/ntfy'] = new Error('down');
  p.button('New topic').click();
  await settle();
  assert.equal(p.$('#toast').textContent, 'Could not save that.');
  p.clipboard.fail = true;
  p.button('Copy the topic').click();
  await settle();
  assert.equal(p.$('#toast').textContent, 'Could not copy. Press and hold the topic instead.');
});

test('the sheet says so when the ntfy setting cannot be read', async () => {
  const p = await alerts({ 'GET /api/ntfy': new Error('offline') });
  assert.ok(p.$$('#notifybody p').some((x) => x.textContent === 'Could not read the ntfy setting.'));
});
