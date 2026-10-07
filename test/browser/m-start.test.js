// The start sheet: pick what to run, pick a project, and never a second window for the same project.
const test = require('node:test');
const assert = require('node:assert/strict');
const { phone, win, claude, settle, unloadPage, fire, deferred } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); });

const HERDR = { available: true, spaces: [
  { id: 'sp1', label: 'Corral', root: '/Users/chester/repos/corral', cwd: '/Users/chester/repos/corral/public', status: 'working' },
  { id: 'sp2', label: 'Corral again', root: '/Users/chester/repos/corral', cwd: '/x', status: 'idle' },
  { id: 'sp3', label: 'No root', cwd: '/Users/chester/notes', status: 'done' },
  { id: 'sp4', label: 'Nowhere' },
] };
const PROJECTS = { projects: [
  { label: 'corral dup', root: '/Users/chester/repos/corral', exists: true },
  { label: 'Website', root: '/Users/chester/site', exists: true },
  { label: 'Gone', root: '/Users/chester/gone', exists: false },
] };

const rows = (p) => p.$$('#projects > *').map((r) => (r.classList.contains('proj')
  ? [r.querySelector('.n div').textContent, r.querySelector('.p').textContent, r.querySelector('.dot').className, r.querySelector('.tag')?.textContent || '']
  : r.textContent));

test('the start sheet lists herdr spaces, then other projects, then the home folder, once each', async () => {
  const d = deferred();
  const p = await phone([], { routes: {
    'GET /api/herdr': () => d.promise, 'GET /api/projects': PROJECTS,
    'GET /api/sessions': { sessions: [win('w1', { space: 'sp1', cwd: '/elsewhere' }), win('w2', { cwd: '/Users/chester/site' }), win('w3', { cwd: '/Users/chester/notes', exited: true })] },
  } });
  p.$('#q').value = 'old search';
  p.$('#fab').click();
  assert.equal(p.$('#sheet').hidden, false);
  assert.equal(p.$('#q').value, '');
  assert.equal(p.text('#projects'), 'Loading projects…');
  d.resolve(HERDR);
  await settle();
  assert.deepEqual(rows(p), [
    'herdr spaces',
    ['Corral', '~/repos/corral', 'dot working', 'Open'],
    ['No root', '~/notes', 'dot done', ''],
    'Other projects',
    ['Website', '~/site', 'dot ', 'Open'],
    ['Home folder', '~', 'dot ', ''],
  ]);
});

test('a space whose window sits in its working folder counts as open', async () => {
  const p = await phone([], { routes: {
    'GET /api/herdr': { spaces: [{ id: 'sp1', label: 'Corral', root: '/r', cwd: '/r/sub' }] },
    'GET /api/sessions': { sessions: [win('w', { cwd: '/r/sub' }), win('nocwd', { cwd: null })] },
  } });
  p.$('#fab').click();
  await settle();
  assert.deepEqual(rows(p)[1], ['Corral', '/r', 'dot ', 'Open']);
});

test('the sheet still opens when the Mac cannot list spaces, projects, or windows', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': new Error('x'), 'GET /api/projects': new Error('x'), 'GET /api/sessions': new Error('x') } });
  p.$('#fab').click();
  await settle();
  assert.deepEqual(rows(p), ['Other projects', ['Home folder', '~', 'dot ', '']]);
});

test('answers without their lists are treated as empty', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': {}, 'GET /api/projects': {}, 'GET /api/sessions': {} } });
  p.$('#fab').click();
  await settle();
  assert.deepEqual(rows(p), ['Other projects', ['Home folder', '~', 'dot ', '']]);
});

test('search matches a project by name or folder, and says when nothing matches', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': HERDR, 'GET /api/projects': PROJECTS } });
  p.$('#fab').click();
  await settle();
  const q = p.$('#q');
  q.value = 'WEB';
  fire(q, 'input');
  assert.deepEqual(rows(p).map((r) => (Array.isArray(r) ? r[0] : r)), ['Other projects', 'Website']);
  q.value = 'notes';
  fire(q, 'input');
  assert.deepEqual(rows(p).map((r) => (Array.isArray(r) ? r[0] : r)), ['herdr spaces', 'No root']);
  q.value = 'zzz';
  fire(q, 'input');
  assert.deepEqual(rows(p), ['No project matches.']);
});

test('the sheet closes with its × or a tap outside it', async () => {
  const p = await phone([]);
  p.$('#fab').click();
  await settle();
  p.$('#projects').click();
  assert.equal(p.$('#sheet').hidden, false);
  p.$('#sheet').click();
  assert.equal(p.$('#sheet').hidden, true);
  p.$('#fab').click();
  await settle();
  p.$('#sheetx').click();
  assert.equal(p.$('#sheet').hidden, true);
});

test('the kind of start is chosen once and remembered', async () => {
  const p = await phone([]);
  const seg = (a) => p.$(`#agentseg [data-a="${a}"]`);
  assert.ok(seg('claude').classList.contains('on'));
  seg('claude-continue').click();
  assert.ok(seg('claude-continue').classList.contains('on'));
  assert.ok(!seg('claude').classList.contains('on'));
  assert.equal(p.window.localStorage.getItem('corral.m.agent'), '"claude-continue"');
  const q = await phone([], { storage: { 'corral.m.agent': '""' } });
  assert.ok(q.$('#agentseg [data-a=""]').classList.contains('on'));
});

test('tapping a project starts the chosen kind there and opens its terminal', async () => {
  const p = await phone([], { routes: {
    'GET /api/herdr': HERDR, 'GET /api/projects': PROJECTS,
    'POST /api/sessions': (r) => ({ __reply: true, status: 201, body: win('new1', { label: r.body.label, cwd: r.body.cwd }) }),
  } });
  p.$('#agentseg [data-a="claude-continue"]').click();
  p.$('#fab').click();
  await settle();
  p.$$('#projects .proj')[0].click();
  assert.equal(p.$('#sheet').hidden, true);
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: '/Users/chester/repos/corral', label: 'Corral', space: 'sp1', agent: 'claude-continue' });
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.text('#ttitle'), 'Corral');
  assert.equal(p.sockets[0].url.includes('id=new1'), true);
});

test('the home folder starts a plain shell', async () => {
  const p = await phone([], { routes: { 'POST /api/sessions': (r) => ({ __reply: true, status: 201, body: win('sh1', { label: 'shell' }) }) } });
  p.$('#fab').click();
  await settle();
  p.button('Home folder~').click();
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: null, label: 'shell', space: null, agent: '' });
});

test('a project already open on the Mac is not started twice', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': HERDR, 'GET /api/sessions': { sessions: [] } } });
  p.$('#fab').click();
  await settle();
  // It opened on the Mac after the sheet loaded.
  p.api.routes['GET /api/sessions'] = { sessions: [win('w1', { space: 'sp1' })] };
  p.$$('#projects .proj')[0].click();
  await settle();
  assert.equal(p.toast(), 'Corral is already open on the Mac. Tap it in the list to continue there.');
  assert.equal(p.api.called('POST', '/api/sessions').length, 0);
});

test('when the fresh check fails, the windows the sheet saw still prevent a second one', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': HERDR, 'GET /api/sessions': { sessions: [win('w1', { space: 'sp1' })] } } });
  p.$('#fab').click();
  await settle();
  p.api.routes['GET /api/sessions'] = new Error('offline');
  p.$$('#projects .proj')[0].click();
  await settle();
  assert.equal(p.toast(), 'Corral is already open on the Mac. Tap it in the list to continue there.');
});

test('when the Mac answers that the space already has a window, that window opens', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': HERDR,
    'POST /api/sessions': { __reply: true, status: 409, body: { error: 'this space already has a window', existing: win('w9', { label: 'Corral' }) } } } });
  p.$('#fab').click();
  await settle();
  p.$$('#projects .proj')[0].click();
  await settle();
  assert.equal(p.toast(), 'Corral is already open. Here it is.');
  assert.equal(p.$('#termview').hidden, false);
  assert.equal(p.sockets[0].url.includes('id=w9'), true);
});

test('a start the Mac refuses, cannot parse, or cannot get says it could not start', async () => {
  for (const reply of [
    { __reply: true, status: 409, body: { error: 'conflict' } },
    { __reply: true, status: 500, body: 'oops', type: 'text/plain' },
    new Error('offline'),
  ]) {
    const p = await phone([], { routes: { 'POST /api/sessions': reply } });
    p.$('#fab').click();
    await settle();
    p.button('Home folder~').click();
    await settle();
    assert.equal(p.toast(), 'Could not start it on the Mac.');
    assert.equal(p.$('#termview').hidden, true);
    unloadPage();
  }
});

test('a window in the list after a start shows its status in the terminal', async () => {
  const p = await phone([win('w1', { claude: claude('busy') })], { routes: { 'POST /api/sessions': { __reply: true, status: 201, body: win('w1') } } });
  p.$('#fab').click();
  await settle();
  p.button('Home folder~').click();
  await settle();
  assert.equal(p.text('#tsub'), 'Working · ~/repos/w1');
});
