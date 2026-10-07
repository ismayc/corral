const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, unloadPage, flush } = require('../helpers/browser');

test.afterEach(unloadPage);

test('the phone page loads and lists windows', async () => {
  const p = loadPage('m', { routes: { 'GET /api/overview': { machine: 'Test Mac', sessions: [{ id: 's1', label: 'notes', cwd: '/x/notes', space: null, exited: false, created: 1, persistent: true, remote: false, activity: null, claude: { status: 'idle', waitingFor: null, since: 1, mode: 'auto' }, askKey: null, prompt: null, muted: false }] } } });
  await flush(10);
  assert.deepEqual([...p.window.document.querySelectorAll('.card .name')].map((n) => n.textContent), ['notes']);
});

test('the Mac page loads', async () => {
  const p = loadPage('app');
  await flush(10);
  assert.equal(p.window.document.title, 'Corral');
});
