const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, session, flush } = require('../helpers/app');

test.afterEach(stop);

test('after a restart the bar offers to restore the earlier windows and lists them in the tooltip', async () => {
  const savedAt = Date.UTC(2026, 9, 7, 15, 30);
  const p = await start({ routes: { 'GET /api/restore': { savedAt, windows: [{ label: 'alpha', claude: true }, { label: 'notes', claude: false }] } } });
  assert.equal(p.$('#restorewrap').hidden, false);
  assert.equal(p.$('#restore').textContent, 'Restore 2 windows');
  assert.equal(p.$('#restore').title, `Open again, as of ${new Date(savedAt).toLocaleString()}:\nalpha (resumes its Claude conversation)\nnotes`);
});

test('one window to restore with no saved time says before the restart', async () => {
  const p = await start({ routes: { 'GET /api/restore': { savedAt: null, windows: [{ label: 'alpha', claude: false }] } } });
  assert.equal(p.$('#restore').textContent, 'Restore 1 window');
  assert.equal(p.$('#restore').title, 'Open again, as of before the restart:\nalpha');
});

test('nothing to restore, or no answer, keeps the offer hidden', async () => {
  let p = await start();
  assert.equal(p.$('#restorewrap').hidden, true);
  p = await start({ routes: { 'GET /api/restore': new Error('offline') } });
  assert.equal(p.$('#restorewrap').hidden, true);
});

test('Restore opens the windows and says which conversations were not found', async () => {
  const p = await start({
    routes: {
      'GET /api/restore': { savedAt: 1, windows: [{ label: 'alpha', claude: true }, { label: 'beta', claude: true }] },
      'POST /api/restore': { sessions: [session('r1', { label: 'alpha' }), session('r2', { label: 'beta' })], notResumed: ['beta'] },
    },
  });
  p.$('#restore').click();
  assert.equal(p.$('#restorewrap').hidden, true);
  await flush();
  assert.deepEqual(p.wins(), ['alpha', 'beta']);
  assert.equal(p.toast(), 'Restored 2 windows (beta: conversation not found, opened as a shell)');
});

test('Restore with one window, or none, reports the count', async () => {
  const p = await start({
    routes: { 'GET /api/restore': { savedAt: 1, windows: [{ label: 'alpha', claude: true }] }, 'POST /api/restore': { sessions: [session('r1', { label: 'alpha' })], notResumed: [] } },
  });
  p.$('#restore').click();
  await flush();
  assert.equal(p.toast(), 'Restored 1 window');
  p.api.routes['POST /api/restore'] = {};
  p.$('#restore').click();
  await flush();
  assert.equal(p.toast(), 'Restored 0 windows');
});

test('the x forgets the earlier windows', async () => {
  const p = await start({ routes: { 'GET /api/restore': { savedAt: 1, windows: [{ label: 'alpha' }] }, 'POST /api/restore/dismiss': { ok: true } } });
  p.$('#restorex').click();
  assert.equal(p.$('#restorewrap').hidden, true);
  await flush();
  assert.equal(p.api.called('POST', '/api/restore/dismiss').length, 1);
  assert.equal(p.toast(), 'Forgot the windows from before the restart');
});
