const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, fire, flush } = require('../helpers/app');

test.afterEach(stop);

const MIN = 60000;
const proj = (label, extra = {}) => ({ root: `/Users/me/old/${label}`, label, open: false, exists: true, lastSeen: Date.now() - 5 * MIN, ...extra });
const rows = (p) => p.$$('#inactive .proj').map((r) => `${r.querySelector('.name').textContent} | ${r.querySelector('.ago').textContent}`);

test('inactive projects are listed with how long ago they were seen', async () => {
  const now = Date.now();
  const p = await start({ routes: { 'GET /api/projects': { projects: [
    proj('fresh', { lastSeen: now - 10000 }),
    proj('mins', { lastSeen: now - 5 * MIN }),
    proj('hours', { lastSeen: now - 3 * 60 * MIN }),
    proj('days', { lastSeen: now - 72 * 60 * MIN }),
    proj('live', { open: true }),
  ] } } });
  assert.equal(p.$('#inactive .sec').textContent, '▾ Inactive projects (4)');
  assert.deepEqual(rows(p), ['fresh | just now', 'mins | 5 min ago', 'hours | 3 hr ago', 'days | 3 days ago']);
  const r = p.$('#inactive .proj');
  assert.equal(r.title, '/Users/me/old/fresh');
  assert.equal(r.querySelector('button').disabled, false);
});

test('a project whose folder is gone is marked and cannot be reopened', async () => {
  const p = await start({ routes: { 'GET /api/projects': { projects: [proj('gone', { exists: false })] } } });
  const r = p.$('#inactive .proj');
  assert.equal(r.className, 'proj gone');
  assert.equal(r.title, '/Users/me/old/gone (folder no longer exists)');
  assert.equal(r.querySelector('button').disabled, true);
});

test('no inactive projects, or a ledger that fails to load, shows nothing', async () => {
  let p = await start({ routes: { 'GET /api/projects': { projects: [proj('live', { open: true })] } } });
  assert.equal(p.$('#inactive').textContent, '');
  p = await start({ routes: { 'GET /api/projects': new Error('offline') } });
  assert.equal(p.$('#inactive').textContent, '');
});

test('the heading folds the list and remembers it', async () => {
  const p = await start({ routes: { 'GET /api/projects': { projects: [proj('one')] } } });
  p.$('#inactive .sec').click();
  assert.equal(p.$('#inactive .sec').textContent, '▸ Inactive projects (1)');
  assert.equal(p.$$('#inactive .proj').length, 0);
  assert.equal(p.store('corral.inactiveOpen'), false);
  p.$('#inactive .sec').click();
  assert.equal(p.$$('#inactive .proj').length, 1);
});

test('a folded list stays folded on the next load', async () => {
  const p = await start({ storage: { 'corral.inactiveOpen': false }, routes: { 'GET /api/projects': { projects: [proj('one')] } } });
  assert.equal(p.$('#inactive .sec').textContent, '▸ Inactive projects (1)');
});

test('the search box filters inactive projects by name or folder', async () => {
  const p = await start({ routes: { 'GET /api/projects': { projects: [proj('Alpha'), proj('beta', { root: '/srv/ALPHA-two' })] } } });
  p.$('#filter').value = 'alpha';
  fire(p.$('#filter'), 'input');
  assert.equal(p.$$('#inactive .proj').length, 2);
  p.$('#filter').value = 'srv';
  fire(p.$('#filter'), 'input');
  assert.deepEqual(rows(p).map((r) => r.split(' ')[0]), ['beta']);
  p.$('#filter').value = 'zzz';
  fire(p.$('#filter'), 'input');
  assert.equal(p.$('#inactive .note').textContent, 'No match.');
  assert.equal(p.$('#inactive .sec').textContent, '▾ Inactive projects (2)');
});

test('Reopen asks herdr for a space and reloads the sidebar', async () => {
  const p = await start({ routes: { 'GET /api/projects': { projects: [proj('one')] }, 'POST /api/projects/reopen': { ok: true } } });
  p.api.routes['GET /api/herdr'] = { available: true, spaces: [space('one')] };
  p.api.routes['GET /api/projects'] = { projects: [proj('one', { open: true })] };
  const re = p.$('#inactive .proj button');
  assert.equal(re.title, 'Create a herdr space for this folder');
  re.click();
  assert.equal(re.disabled, true);
  assert.equal(re.textContent, '...');
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/projects/reopen')[0].body, { root: '/Users/me/old/one' });
  assert.deepEqual(p.rowNames(), ['one']);
  assert.equal(p.$('#inactive').textContent, '');
});

test('a failed Reopen says Failed and gives the reason on hover', async () => {
  const p = await start({ routes: { 'GET /api/projects': { projects: [proj('one')] }, 'POST /api/projects/reopen': { __reply: true, status: 500, body: { error: 'herdr said no' } } } });
  const re = p.$('#inactive .proj button');
  re.click();
  await flush();
  assert.equal(re.textContent, 'Failed');
  assert.equal(re.title, 'herdr said no');
  assert.equal(p.$('#inactive .proj .name').title, 'herdr said no');
  assert.equal(p.api.called('GET', '/api/herdr').length, 1);
});

test('the x forgets a project and reloads the list', async () => {
  const p = await start({ routes: { 'GET /api/projects': { projects: [proj('one'), proj('two')] }, 'POST /api/projects/forget': { ok: true } } });
  p.api.routes['GET /api/projects'] = { projects: [proj('two')] };
  const fg = p.$$('#inactive .proj button')[1];
  assert.equal(fg.textContent, '×');
  fg.click();
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/projects/forget')[0].body, { root: '/Users/me/old/one' });
  assert.deepEqual(rows(p).map((r) => r.split(' ')[0]), ['two']);
});
