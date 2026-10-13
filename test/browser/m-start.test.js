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

test("a project with an open window takes the window's color for its dot, not herdr's", async () => {
  const p = await phone([win('w1', { space: 'sp1', claude: claude('busy') }), win('w2', { cwd: '/Users/chester/site', claude: claude('waiting') }),
    win('w3', { space: 'sp3' })], { routes: {
    'GET /api/herdr': { available: true, spaces: [
      { id: 'sp1', label: 'Corral', root: '/Users/chester/repos/corral', status: 'unknown' },
      { id: 'sp3', label: 'Notes', root: '/Users/chester/notes', status: 'unknown' }] },
    'GET /api/projects': PROJECTS,
  } });
  p.$('#fab').click();
  await settle();
  const dots = Object.fromEntries(rows(p).filter(Array.isArray).map((r) => [r[0], r[2]]));
  assert.equal(dots.Corral, 'dot working');
  assert.equal(dots.Website, 'dot idle');
  assert.equal(dots.Notes, 'dot unknown', 'a plain shell keeps herdr\'s status');
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
  assert.deepEqual(rows(p).map((r) => (Array.isArray(r) ? r[0] : r)), ['Other projects', 'Website', 'New project', 'New folder WEB']);
  q.value = 'notes';
  fire(q, 'input');
  assert.deepEqual(rows(p).map((r) => (Array.isArray(r) ? r[0] : r)), ['herdr spaces', 'No root', 'New project', 'New folder notes']);
  q.value = 'zzz';
  fire(q, 'input');
  assert.deepEqual(rows(p).slice(0, 1), ['No project matches.']);
});

// ---- A new folder in the repos folder, named in the search box ----
const typeName = (p, v) => { p.$('#q').value = v; fire(p.$('#q'), 'input'); };
const CREATED = { root: '/Users/chester/repos/fresh-idea', label: 'fresh-idea', space: 'sp9' };

test('a name that is not a project yet offers a new folder in the repos folder; a project name or a bad name does not', async () => {
  const p = await phone([], { routes: { 'GET /api/herdr': HERDR, 'GET /api/projects': { ...PROJECTS, reposDir: '~/code' } } });
  p.$('#fab').click();
  await settle();
  assert.equal(p.$('#q').placeholder, 'Search projects, or name a new one');
  typeName(p, '  fresh  idea ');
  assert.deepEqual(rows(p), ['No project matches.', 'New project', ['New folder fresh-idea', '~/code/fresh-idea', 'dot plus', '']]);
  typeName(p, 'website');
  assert.deepEqual(rows(p), ['Other projects', ['Website', '~/site', 'dot ', '']]);
  typeName(p, 'a/b');
  assert.deepEqual(rows(p), ['No project matches.', 'A new folder name can use letters, digits, dots, dashes, and underscores.']);
});

test('the repos folder defaults to ~/repos when the Mac does not say', async () => {
  const p = await phone([], { routes: { 'GET /api/projects': new Error('x') } });
  p.$('#fab').click();
  await settle();
  typeName(p, 'x');
  assert.equal(rows(p)[2][1], '~/repos/x');
});

test('a new folder is made on the Mac, then the chosen kind starts in its space', async () => {
  const p = await phone([], { routes: {
    'POST /api/projects/create': { __reply: true, status: 201, body: CREATED },
    'POST /api/sessions': (r) => ({ __reply: true, status: 201, body: win('new1', { label: r.body.label, cwd: r.body.cwd }) }),
  } });
  p.$('#fab').click();
  await settle();
  typeName(p, 'fresh-idea');
  p.button('+New folder fresh-idea~/repos/fresh-idea').click();
  assert.equal(p.$('#sheet').hidden, true);
  await settle();
  assert.deepEqual(p.api.called('POST', '/api/projects/create')[0].body, { name: 'fresh-idea' });
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: CREATED.root, label: 'fresh-idea', space: 'sp9', agent: 'claude' });
  assert.equal(p.text('#ttitle'), 'fresh-idea');
});

test('a new folder herdr made no space for still starts there, and says why', async () => {
  const p = await phone([], { routes: {
    'POST /api/projects/create': { __reply: true, status: 201, body: { ...CREATED, space: null, warning: 'herdr not reachable' } },
    'POST /api/sessions': (r) => ({ __reply: true, status: 201, body: win('new1', { label: r.body.label }) }),
  } });
  p.$('#fab').click();
  await settle();
  typeName(p, 'fresh-idea');
  p.button('+New folder fresh-idea~/repos/fresh-idea').click();
  await settle();
  assert.equal(p.toast(), 'Made ~/repos/fresh-idea, but herdr has no space for it: herdr not reachable');
  assert.equal(p.api.called('POST', '/api/sessions')[0].body.space, null);
});

test('a new folder the Mac refuses, cannot parse, or cannot get is reported and starts nothing', async () => {
  for (const [reply, said] of [
    [{ __reply: true, status: 409, body: { error: '~/repos/x already exists.' } }, '~/repos/x already exists.'],
    [{ __reply: true, status: 500, body: 'oops', type: 'text/plain' }, 'Could not make the folder.'],
    [new Error('offline'), 'Could not reach the Mac.'],
  ]) {
    const p = await phone([], { routes: { 'POST /api/projects/create': reply } });
    p.$('#fab').click();
    await settle();
    typeName(p, 'x');
    p.button('+New folder x~/repos/x').click();
    await settle();
    assert.equal(p.toast(), said);
    assert.equal(p.api.called('POST', '/api/sessions').length, 0);
    unloadPage();
  }
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
