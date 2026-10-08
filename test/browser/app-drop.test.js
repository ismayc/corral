// Images dropped on a Mac window: uploaded to the Mac's data folder and their paths pasted for Claude Code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, session, dt, flush, fire } = require('../helpers/app');

test.afterEach(stop);

const routes = (upload) => ({ 'GET /api/sessions': { sessions: [session('a'), session('b')] }, ...(upload && { 'POST /api/sessions/a/upload': upload }) });
const file = (p, name, type) => new p.window.File(['png bytes'], name, { type });
// A file drag as the browser gives it: the 'Files' type, and the files themselves on drop.
const files = (list) => Object.assign(dt({ Files: '' }), { files: list });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await sleep(2); };

test('dragging files over a window marks it and allows the drop; leaving clears the mark', async () => {
  const p = await start({ routes: routes() });
  const win = p.slotOf('a').querySelector('.win');
  assert.ok(fire(win, 'dragover', { dataTransfer: files([]) }).defaultPrevented);
  assert.ok(win.classList.contains('filedrop'));
  fire(win, 'dragleave');
  assert.ok(!win.classList.contains('filedrop'));
  // A window being moved by its title bar is not a file drop.
  fire(win, 'dragover', { dataTransfer: dt({ 'text/x-corral': 'b' }) });
  assert.ok(!win.classList.contains('filedrop'));
  win.classList.add('filedrop');
  fire(win, 'drop', { dataTransfer: dt({ 'text/x-corral': 'b' }) });
  assert.ok(!win.classList.contains('filedrop'));
  assert.equal(p.api.called('POST', '/api/sessions/a/upload').length, 0);
});

test('a dropped screenshot is uploaded and its path pasted into that window, which takes the focus', async () => {
  let n = 0;
  const p = await start({ routes: routes(() => ({ path: `/data/uploads/${++n}.png` })) });
  const win = p.slotOf('a').querySelector('.win');
  p.terms[1].focus();
  const ev = fire(win, 'drop', { dataTransfer: files([file(p, 'Screenshot.png', 'image/png'), file(p, 'b.jpg', 'image/jpeg')]) });
  assert.ok(ev.defaultPrevented);
  assert.ok(win.classList.contains('focus'));
  await until(() => p.terms[0].pasted.length === 2);
  assert.deepEqual(p.terms[0].pasted, ['/data/uploads/1.png ', '/data/uploads/2.png ']);
  const [first, second] = p.api.called('POST', '/api/sessions/a/upload');
  assert.deepEqual(first.body, { type: 'image/png', data: Buffer.from('png bytes').toString('base64') });
  assert.equal(second.body.type, 'image/jpeg');
  assert.deepEqual(p.terms[1].pasted, []);
  assert.equal(p.toast(), null);
});

test('files that are not images are skipped and named; the images among them still go', async () => {
  const p = await start({ routes: routes({ path: '/data/uploads/1.png' }) });
  const win = p.slotOf('a').querySelector('.win');
  fire(win, 'drop', { dataTransfer: files([file(p, 'notes.txt', 'text/plain'), file(p, 'shot.png', 'image/png')]) });
  assert.equal(p.toast(), 'Skipped notes.txt: only images (PNG, JPEG, HEIC, WebP, or GIF) can be dropped.');
  await until(() => p.terms[0].pasted.length);
  assert.deepEqual(p.terms[0].pasted, ['/data/uploads/1.png ']);
  fire(win, 'drop', { dataTransfer: files([file(p, 'a.pdf', 'application/pdf'), file(p, 'b', '')]) });
  assert.equal(p.toast(), 'Skipped 2 files: only images (PNG, JPEG, HEIC, WebP, or GIF) can be dropped.');
  await flush();
  assert.equal(p.api.called('POST', '/api/sessions/a/upload').length, 1);
});

test('an upload the server refuses, or one that cannot reach it, says so and pastes nothing', async () => {
  let answer;
  const p = await start({ routes: routes(() => answer) });
  const win = p.slotOf('a').querySelector('.win');
  answer = p.api.reply(413, { error: 'the photo is empty or too large' });
  fire(win, 'drop', { dataTransfer: files([file(p, 'big.png', 'image/png')]) });
  await until(() => p.toast());
  assert.equal(p.toast(), 'the photo is empty or too large');
  answer = p.api.reply(500, {});
  fire(win, 'drop', { dataTransfer: files([file(p, 'odd.png', 'image/png')]) });
  await until(() => p.toast() !== 'the photo is empty or too large');
  assert.equal(p.toast(), 'Could not add odd.png.');
  answer = new Error('offline');
  fire(win, 'drop', { dataTransfer: files([file(p, 'far.png', 'image/png')]) });
  await until(() => p.toast() !== 'Could not add odd.png.');
  assert.equal(p.toast(), 'Could not add far.png.');
  assert.deepEqual(p.terms[0].pasted, []);
});

test('a file dropped outside every window is caught, so the browser does not open it in place of Corral', async () => {
  const p = await start({ routes: routes() });
  const side = p.$('#spaces');
  assert.ok(fire(side, 'dragover', { dataTransfer: files([]) }).defaultPrevented);
  assert.ok(fire(side, 'drop', { dataTransfer: files([file(p, 'x.png', 'image/png')]) }).defaultPrevented);
  assert.ok(!fire(side, 'dragover').defaultPrevented);
  assert.ok(!fire(side, 'drop').defaultPrevented);
  await flush();
  assert.equal(p.api.calls.filter((c) => c.path.endsWith('/upload')).length, 0);
});
