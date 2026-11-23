// Scheduled Claude jobs (public/jobs.js): the Mac page's panel and the phone's sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../helpers/app');
const m = require('../helpers/m');

test.afterEach(async () => { await m.settle(); app.stop(); });

const NOW = Date.now();
const LIST = { machines: [
  { name: 'Studio', host: '', jobs: [
    { label: 'com.chester.feature-digest', schedule: 'day 1 of the month 08:30', script: '~/bin/run.sh', loaded: true, running: false, lastExit: 0, logAt: NOW - 30 * 60000 },
    { label: 'com.chesterismay.busy', schedule: 'daily 06:00', script: null, loaded: true, running: true, lastExit: null, logAt: NOW - 20000 },
  ] },
  { name: 'mini', host: 'mini', jobs: [
    { label: 'com.x.failed', schedule: 'Mondays 06:30', loaded: true, running: false, lastExit: 1, logAt: NOW - 5 * 3600000 },
    { label: 'com.x.unloaded', schedule: 'on demand', loaded: false, running: false, lastExit: null, logAt: null },
    { label: 'com.x.fresh', schedule: 'on demand', loaded: true, running: false, lastExit: null, logAt: NOW - 3 * 86400000 },
  ] },
  { name: 'down', host: 'down', jobs: [], error: 'Could not ask down: refused' },
  { name: 'empty', host: 'empty', jobs: [] },
] };
async function panel(routes = {}) {
  const p = await app.start({ routes: { 'GET /api/jobs': LIST, ...routes } });
  p.$('#jobsbtn').click();
  await app.flush();
  return p;
}
const rows = (p) => p.$$('#jobspanel .jrow').map((r) => [r.querySelector('.jname').textContent, r.querySelector('.jstate').className, r.querySelector('.jstate').textContent, r.querySelector('.jinfo').textContent]);

test('the Jobs panel lists each Mac\'s jobs with schedule, last run, and log age, and says which Mac failed', async () => {
  const p = await panel();
  assert.equal(p.$('#jobspanel .jhead b').textContent, 'Scheduled Claude jobs');
  assert.deepEqual(p.$$('#jobspanel .jmac').map((n) => n.textContent), ['Studio', 'mini', 'down', 'empty']);
  assert.deepEqual(rows(p), [
    ['feature-digest', 'jstate ok', 'Last run worked', 'day 1 of the month 08:30 · log changed 30 min ago'],
    ['busy', 'jstate run', 'Running now', 'daily 06:00 · log changed just now'],
    ['com.x.failed', 'jstate bad', 'Last run failed (exit 1)', 'Mondays 06:30 · log changed 5 h ago'],
    ['com.x.unloaded', 'jstate off', 'Not loaded in launchd', 'on demand · no log yet'],
    ['com.x.fresh', 'jstate none', 'No run since the Mac started', 'on demand · log changed 3 days ago'],
  ]);
  assert.equal(p.$('#jobspanel .jname').title, 'com.chester.feature-digest\n~/bin/run.sh');
  assert.equal(p.$$('#jobspanel .jname')[1].title, 'com.chesterismay.busy');
  assert.deepEqual(p.$$('#jobspanel .jnote').map((n) => n.textContent), ['Could not ask down: refused', 'No scheduled Claude jobs here.']);
  // A running job has no Run now.
  assert.deepEqual([...p.$$('#jobspanel .jrow')[1].querySelectorAll('button')].map((b) => b.textContent), ['Log']);
});

test('Run now asks first; Cancel goes back, Run starts it and lists the jobs again', async () => {
  const p = await panel({ 'POST /api/jobs/run': { ok: true, label: 'com.x.failed' } });
  const row = () => p.$$('#jobspanel .jrow')[2];
  [...row().querySelectorAll('button')].find((b) => b.textContent === 'Run now').click();
  assert.equal(row().querySelector('.jask').textContent, 'Run com.x.failed now?');
  [...row().querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  assert.deepEqual([...row().querySelectorAll('button')].map((b) => b.textContent), ['Log', 'Run now']);
  [...row().querySelectorAll('button')].find((b) => b.textContent === 'Run now').click();
  [...row().querySelectorAll('button')].find((b) => b.textContent === 'Run').click();
  assert.equal(row().querySelector('.jask').textContent, 'Starting…');
  await app.flush();
  assert.deepEqual(p.api.called('POST', '/api/jobs/run')[0].body, { host: 'mini', label: 'com.x.failed' });
  assert.equal(p.toast(), 'Started com.x.failed on mini.');
  assert.deepEqual(p.api.called('GET', '/api/jobs').map((c) => c.query), [{}, { fresh: '1' }]);
});

test('a failed Run now says why', async () => {
  const p = await panel();
  p.api.routes['POST /api/jobs/run'] = p.api.reply(409, { error: 'it is running now' });
  const run = (i) => {
    const row = p.$$('#jobspanel .jrow')[i];
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Run now').click();
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'Run').click();
  };
  run(0);
  await app.flush();
  assert.equal(p.toast(), 'Could not start it: it is running now');
  p.api.routes['POST /api/jobs/run'] = p.api.reply(502, 'not json');
  run(0);
  await app.flush();
  assert.equal(p.toast(), 'Could not start it: HTTP 502');
});

test('Log shows each log file\'s last lines, and Back returns to the list; a failed read says so', async () => {
  const p = await panel({ 'GET /api/jobs/log': { label: 'com.x.failed', logs: [{ file: '~/a.out', at: 1, text: 'ran\nok' }, { file: '~/a.err', at: null, text: null }] } });
  [...p.$$('#jobspanel .jrow')[2].querySelectorAll('button')].find((b) => b.textContent === 'Log').click();
  await app.flush();
  assert.deepEqual(p.api.called('GET', '/api/jobs/log')[0].query, { host: 'mini', label: 'com.x.failed' });
  assert.equal(p.$('#jobspanel .jmac').textContent, 'com.x.failed on mini');
  assert.deepEqual(p.$$('#jobspanel .jfile').map((n) => n.textContent), ['~/a.out', '~/a.err']);
  assert.deepEqual(p.$$('#jobspanel .jlog').map((n) => n.textContent), ['ran\nok', '(no file yet)']);
  p.$$('#jobspanel button').find((b) => b.textContent === 'Back to the jobs').click();
  await app.flush();
  assert.equal(p.$$('#jobspanel .jrow').length, 5);
  p.api.routes['GET /api/jobs/log'] = { label: 'x', logs: [] };
  [...p.$$('#jobspanel .jrow')[0].querySelectorAll('button')].find((b) => b.textContent === 'Log').click();
  await app.flush();
  assert.equal(p.$('#jobspanel .jnote').textContent, 'This job writes no log file.');
  p.$$('#jobspanel button').find((b) => b.textContent === 'Back to the jobs').click();
  await app.flush();
  p.api.routes['GET /api/jobs/log'] = new Error('offline');
  [...p.$$('#jobspanel .jrow')[0].querySelectorAll('button')].find((b) => b.textContent === 'Log').click();
  await app.flush();
  assert.match(p.$('#jobspanel .jnote').textContent, /^Could not read the log: /);
});

test('Refresh asks again; a failed list says so; Esc, ×, and a click outside close the panel', async () => {
  const p = await panel();
  p.$('#jobspanel .jrefresh').click();
  await app.flush();
  assert.deepEqual(p.api.called('GET', '/api/jobs').at(-1).query, { fresh: '1' });
  app.fire(p.$('#jobspanel .jbox'), 'keydown', { key: 'Escape', bubbles: true });
  assert.equal(p.$('#jobspanel'), null);
  p.$('#jobsbtn').click();
  p.$('#jobsbtn').click(); // a second click replaces the panel
  assert.equal(p.$$('#jobspanel').length, 1);
  app.fire(p.$('#jobspanel .jbox'), 'mousedown');
  app.fire(p.$('#jobspanel .jbox'), 'keydown', { key: 'a', bubbles: true });
  assert.ok(p.$('#jobspanel'));
  p.$('#jobspanel .jclose').click();
  assert.equal(p.$('#jobspanel'), null);
  p.$('#jobsbtn').click();
  app.fire(p.$('#jobspanel'), 'mousedown');
  assert.equal(p.$('#jobspanel'), null);
  p.api.routes['GET /api/jobs'] = new Error('offline');
  p.$('#jobsbtn').click();
  await app.flush();
  assert.match(p.$('#jobspanel .jnote').textContent, /^Could not list the jobs: /);
});

test('the palette opens the Jobs panel', async () => {
  const p = await app.start({ routes: { 'GET /api/jobs': LIST } });
  app.fire(p.doc.body, 'keydown', { key: 'k', metaKey: true, bubbles: true });
  p.$('#palette input').value = 'scheduled claude';
  app.fire(p.$('#palette input'), 'input');
  app.fire(p.$('#palette input'), 'keydown', { key: 'Enter' });
  await app.flush();
  assert.ok(p.$('#jobspanel .jrow'));
});

test('the phone\'s Jobs button opens the same list in a sheet', async () => {
  const p = await m.phone([], { routes: { 'GET /api/jobs': LIST } });
  p.$('#jobsbtn').click();
  await m.settle();
  assert.equal(p.sheetTitle(), 'Scheduled Claude jobs');
  assert.equal(p.$$('#gen .jrow').length, 5);
});

test('the job helpers name the states and ages the list uses', () => {
  return m.phone([]).then(({ window }) => {
    const J = window.CorralJobs;
    assert.equal(J.short('com.chesterismay.x.y'), 'x.y');
    assert.equal(J.ago(Date.now() - 50 * 3600000), 'log changed 2 days ago');
    assert.deepEqual(J.state({ loaded: true, lastExit: undefined }), ['none', 'No run since the Mac started']);
  });
});
