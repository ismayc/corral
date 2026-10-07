// Photos: scaled to JPEG on the phone, uploaded to the Mac, and their paths pasted for Claude Code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, win, settle, unloadPage, fire, deferred } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

// Puts files in the hidden file input and fires change, as picking photos does.
function pick(p, files) {
  const input = p.$('#photofile');
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  fire(input, 'change');
}
const photo = (p, name = 'a.heic', type = 'image/heic') => new p.window.File(['raw'], name, { type });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await sleep(2); };

test('the camera button opens the photo picker and keeps the focus', async () => {
  const p = await phone([win('a')]);
  let opened = 0;
  p.$('#photofile').addEventListener('click', () => { opened++; });
  p.$('#photo').click();
  assert.equal(opened, 1);
  assert.equal(fire(p.$('#photo'), 'pointerdown').defaultPrevented, true);
});

test('a photo is scaled down, sent as JPEG, and its path is pasted for Claude', async () => {
  const drawn = [];
  const p = await phone([win('a')], {
    routes: { 'POST /api/sessions/a/upload': { path: '/tmp/corral/1.jpg' } },
    setup: (w) => { w.HTMLCanvasElement.prototype.getContext = function () { return { drawImage: (...a) => drawn.push([this.width, this.height, a.slice(1)]) }; }; },
  });
  const { term } = await p.openWin('a');
  pick(p, [photo(p)]);
  assert.equal(p.toast(), 'Sending the photo to the Mac…');
  await until(() => term.pasted.length);
  const call = p.api.called('POST', '/api/sessions/a/upload')[0];
  assert.deepEqual(call.body, { type: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') });
  assert.deepEqual(drawn, [[2048, 1536, [0, 0, 2048, 1536]]]);
  assert.deepEqual(term.pasted, ['/tmp/corral/1.jpg ']);
  await settle();
  assert.equal(p.toast(), 'Photo added to Claude\'s message. Type what you want and Send.');
  assert.equal(p.$('#photofile').value, '');
});

test('several photos are sent one by one and counted', async () => {
  let n = 0;
  const p = await phone([win('a')], {
    routes: { 'POST /api/sessions/a/upload': () => ({ path: `/tmp/${++n}.jpg` }) },
    createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
  });
  const { term } = await p.openWin('a');
  pick(p, [photo(p), photo(p, 'b.png', 'image/png')]);
  assert.equal(p.toast(), 'Sending 2 photos to the Mac…');
  await until(() => term.pasted.length === 2);
  await settle();
  assert.deepEqual(term.pasted, ['/tmp/1.jpg ', '/tmp/2.jpg ']);
  assert.equal(p.toast(), '2 photos added to Claude\'s message. Type what you want and Send.');
});

test('a photo the browser cannot draw is sent as it is', async () => {
  const p = await phone([win('a')], {
    routes: { 'POST /api/sessions/a/upload': { path: '/tmp/x.heic' } },
    createImageBitmap: async () => { throw new Error('unsupported'); },
  });
  const { term } = await p.openWin('a');
  pick(p, [photo(p)]);
  await until(() => term.pasted.length);
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/upload')[0].body, { type: 'image/heic', data: Buffer.from('raw').toString('base64') });
});

test('when the canvas gives no JPEG the original file is sent', async () => {
  const p = await phone([win('a')], { toBlobNull: true, routes: { 'POST /api/sessions/a/upload': { path: '/tmp/x' } } });
  const { term } = await p.openWin('a');
  pick(p, [photo(p, 'x.png', 'image/png')]);
  await until(() => term.pasted.length);
  assert.equal(p.api.called('POST', '/api/sessions/a/upload')[0].body.type, 'image/png');
});

test('a scaled image without a type is sent with the original file type', async () => {
  const p = await phone([win('a')], {
    routes: { 'POST /api/sessions/a/upload': { path: '/tmp/x' } },
    setup: (w) => { w.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new w.Blob(['jpeg'])); },
  });
  const { term } = await p.openWin('a');
  pick(p, [photo(p, 'x.png', 'image/png')]);
  await until(() => term.pasted.length);
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/upload')[0].body, { type: 'image/png', data: Buffer.from('jpeg').toString('base64') });
});

test('a photo the Mac refuses shows its reason and adds nothing', async () => {
  const p = await phone([win('a')], { routes: { 'POST /api/sessions/a/upload': { __reply: true, status: 400, body: { error: 'the photo is too large' } } } });
  const { term } = await p.openWin('a');
  pick(p, [photo(p)]);
  await until(() => p.toast() === 'the photo is too large');
  assert.equal(p.toast(), 'the photo is too large');
  assert.deepEqual(term.pasted, []);
});

test('a refusal without a reason, and a lost connection, both say the photo was not sent', async () => {
  const p = await phone([win('a')], { routes: { 'POST /api/sessions/a/upload': { __reply: true, status: 502, body: 'Bad gateway', type: 'text/plain' } } });
  await p.openWin('a');
  pick(p, [photo(p)]);
  await until(() => p.toast() === 'Could not send the photo.');
  assert.equal(p.toast(), 'Could not send the photo.');
  p.api.routes['POST /api/sessions/a/upload'] = new Error('offline');
  p.$('#toast').hidden = true;
  pick(p, [photo(p)]);
  await until(() => p.toast() === 'Could not send the photo.');
  assert.equal(p.toast(), 'Could not send the photo.');
});

test('a photo that cannot be read says it was not sent', async () => {
  const p = await phone([win('a')], {
    createImageBitmap: async () => { throw new Error('no'); },
    setup: (w) => {
      w.FileReader = class { readAsDataURL() { setTimeout(() => this.onerror(new Error('read')), 0); } };
    },
  });
  await p.openWin('a');
  pick(p, [photo(p)]);
  await until(() => p.toast() === 'Could not send the photo.');
  assert.equal(p.toast(), 'Could not send the photo.');
  assert.equal(p.api.called('POST', '/api/sessions/a/upload').length, 0);
});

test('a photo that finishes after another window opened is not pasted there', async () => {
  const d = deferred();
  const p = await phone([win('a'), win('b')], { routes: { 'POST /api/sessions/a/upload': () => d.promise } });
  const { term } = await p.openWin('a');
  pick(p, [photo(p)]);
  await until(() => p.api.called('POST', '/api/sessions/a/upload').length);
  p.sw.emit('message', { open: 'b' });
  await settle();
  d.resolve({ path: '/tmp/late.jpg' });
  await sleep(20);
  await settle();
  assert.deepEqual(term.pasted, []);
  assert.deepEqual(p.terms.at(-1).pasted, []);
  assert.equal(p.toast(), 'Sending the photo to the Mac…');
});

test('picking nothing, or picking with no terminal open, sends nothing', async () => {
  const p = await phone([win('a')]);
  pick(p, [photo(p)]);
  await settle();
  assert.equal(p.toast(), null);
  await p.openWin('a');
  pick(p, []);
  await settle();
  assert.equal(p.toast(), null);
  assert.equal(p.api.called('POST', '/api/sessions/a/upload').length, 0);
});
