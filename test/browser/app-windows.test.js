const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, space, session, flush, fire } = require('../helpers/app');

test.afterEach(stop);

const herdr = (...ids) => ({ 'GET /api/herdr': { available: true, spaces: ids.map((id) => space(id)) } });

test('clicking a space opens a window for it with the chosen agent', async () => {
  const p = await start({ routes: { ...herdr('alpha'), 'POST /api/sessions': (req) => ({ __reply: true, status: 201, body: session('n1', { label: req.body.label, cwd: req.body.cwd, space: req.body.space }) }) } });
  p.$('#agent').value = 'claude-continue';
  p.$('#agent').onchange();
  assert.equal(p.store('corral.agent'), 'claude-continue');
  p.row('alpha').click();
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: '/Users/me/repos/alpha', label: 'alpha', space: 'alpha', agent: 'claude-continue' });
  assert.deepEqual(p.wins(), ['alpha']);
  assert.ok(p.slotOf('alpha').querySelector('.win').classList.contains('focus'));
  assert.ok(p.terms[0].focused);
  assert.deepEqual(p.store('corral.open'), ['n1']);
  // The space moves under Open windows.
  assert.deepEqual(p.secs(), ['Open windows (1)']);
  assert.ok(p.row('alpha').classList.contains('has-win'));
});

test('a space set to open a plain shell sends no agent', async () => {
  const p = await start({ routes: { ...herdr('alpha'), 'POST /api/sessions': session('n1', { space: 'alpha' }) } });
  p.$('#agent').value = '';
  p.row('alpha').click();
  await flush();
  assert.equal(p.api.called('POST', '/api/sessions')[0].body.agent, null);
});

test('a second click on a space brings its window forward instead of opening another', async () => {
  const p = await start({
    storage: { 'corral.layout': '"full"' },
    routes: { ...herdr('alpha', 'beta'), 'GET /api/sessions': { sessions: [session('a1', { label: 'alpha', space: 'alpha' }), session('b1', { label: 'beta', space: 'beta' })] } },
  });
  // alpha's window waits in the bottom bar behind beta.
  assert.deepEqual(p.visible(), ['alpha']);
  p.slotOf('alpha').querySelector('.min').click();
  assert.deepEqual(p.visible(), ['beta']);
  p.row('alpha').click();
  await flush();
  assert.equal(p.api.called('POST', '/api/sessions').length, 0);
  assert.deepEqual(p.visible(), ['alpha']);
  assert.equal(p.toast(), 'alpha is already open. Here it is.');
  // A window already in a zone just takes the focus.
  p.row('alpha').click();
  assert.ok(p.slotOf('alpha').querySelector('.win').classList.contains('focus'));
});

test('a window the server already has for the space, started elsewhere, is picked up and brought forward', async () => {
  const p = await start({
    routes: { ...herdr('alpha'), 'POST /api/sessions': { __reply: true, status: 409, body: { error: 'this space already has a window', existing: session('r1', { label: 'alpha', space: 'alpha' }) } } },
  });
  p.row('alpha').click();
  await flush();
  assert.deepEqual(p.visible(), ['alpha']);
  assert.equal(p.toast(), 'alpha is already open. Here it is.');
  assert.equal(p.sockets[0].url, 'ws://127.0.0.1:18777/ws?id=r1');
});

test('a refusal without a window shows the server error', async () => {
  const p = await start({ routes: { ...herdr('alpha'), 'POST /api/sessions': { __reply: true, status: 409, body: { error: 'busy' } } } });
  p.row('alpha').click();
  await flush();
  assert.equal(p.toast(), 'busy');
  assert.deepEqual(p.wins(), []);
});

test('a failure that is not JSON, or no answer at all, shows a plain message', async () => {
  const p = await start({ routes: { ...herdr('alpha'), 'POST /api/sessions': { __reply: true, status: 500, body: 'oops', type: 'text/plain' } } });
  p.row('alpha').click();
  await flush();
  assert.equal(p.toast(), 'Could not start the window.');
  p.api.routes['POST /api/sessions'] = new Error('offline');
  p.$('#toast').hidden = true;
  p.row('alpha').click();
  await flush();
  assert.equal(p.toast(), 'Could not start the window.');
  assert.deepEqual(p.wins(), []);
});

test('New shell opens a plain shell in the home folder', async () => {
  const p = await start({ routes: { 'POST /api/sessions': session('s1', { label: 'shell', cwd: '/Users/me' }) } });
  p.$('#newshell').click();
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: null, label: 'shell', agent: null });
  assert.deepEqual(p.wins(), ['shell']);
  assert.equal(p.slotOf('shell').querySelector('.cwd').textContent, '~');
});

test('the toast hides itself after a few seconds', async () => {
  const p = await start({ routes: { 'POST /api/sessions': { __reply: true, status: 500, body: { error: 'nope' } } } });
  p.$('#newshell').click();
  await flush();
  assert.equal(p.toast(), 'nope');
  p.tick(6000);
  assert.equal(p.toast(), null);
});

test('a window still being created when the poll picks it up is not opened twice, and comes out of the bottom bar', async () => {
  let answer;
  const p = await start({ routes: { 'POST /api/sessions': () => new Promise((r) => { answer = r; }) } });
  p.$('#newshell').click();
  await flush();
  // The server already lists the new window while the page waits for its answer.
  p.api.routes['GET /api/sessions'] = { sessions: [session('s1', { label: 'shell' })] };
  p.tick(3000);
  await flush();
  p.tick(3000);
  await flush();
  assert.deepEqual(p.wins(), ['shell']);
  assert.deepEqual(p.chips(), ['shell']);
  answer({ __reply: true, status: 201, body: session('s1', { label: 'shell' }) });
  await flush();
  assert.deepEqual(p.wins(), ['shell']);
  assert.equal(p.sockets.length, 1);
  // The window you asked for is shown, not left in the bottom bar holding the keyboard.
  assert.deepEqual(p.visible(), ['shell']);
  assert.deepEqual(p.chips(), []);
  assert.ok(p.slotOf('shell').querySelector('.win').classList.contains('focus'));
});

const created = (o = {}) => ({ __reply: true, status: 201, body: { root: '/Users/me/repos/demo', label: 'demo', space: 'w9', ...o } });

test('New project makes a folder with a herdr space and opens a window there as "A space opens" says', async () => {
  const p = await start({ routes: {
    'GET /api/projects': { projects: [], newRepos: [], reposDir: '~/code' },
    'POST /api/projects/create': created(),
    'POST /api/sessions': session('s1', { label: 'demo', cwd: '/Users/me/repos/demo', space: 'w9' }),
  } });
  const box = p.$('#newprojname');
  assert.equal(box.hidden, true);
  p.$('#newproj').click();
  assert.equal(box.hidden, false);
  assert.equal(box.placeholder, 'Folder name in ~/code, then Enter');
  assert.equal(p.doc.activeElement, box);
  fire(box, 'keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/projects/create'), [], 'nothing typed yet');
  box.value = '  demo ';
  fire(box, 'keydown', { key: 'x' });
  fire(box, 'keydown', { key: 'Enter' });
  fire(box, 'keydown', { key: 'Enter' }); // a second Enter while the first is still working
  await flush();
  assert.deepEqual(p.api.called('POST', '/api/projects/create').map((c) => c.body), [{ name: 'demo' }]);
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: '/Users/me/repos/demo', label: 'demo', space: 'w9', agent: 'claude' });
  assert.deepEqual(p.wins(), ['demo']);
  assert.deepEqual([box.hidden, box.value, box.disabled], [true, '', false]);
});

test('New project says why a name is refused, and keeps the box to fix it', async () => {
  const p = await start({ routes: { 'POST /api/projects/create': { __reply: true, status: 409, body: { error: '~/repos/demo already exists.' } } } });
  p.$('#newproj').click();
  const box = p.$('#newprojname');
  assert.equal(box.placeholder, 'Folder name in ~/repos, then Enter', 'before the projects list loads');
  box.value = 'demo';
  fire(box, 'keydown', { key: 'Enter' });
  await flush();
  assert.equal(p.toast(), '~/repos/demo already exists.');
  assert.deepEqual([box.hidden, box.value, p.doc.activeElement === box], [false, 'demo', true]);
  p.api.routes['POST /api/projects/create'] = { __reply: true, status: 500, body: 'oops' };
  fire(box, 'keydown', { key: 'Enter' });
  await flush();
  assert.equal(p.toast(), 'Could not make the folder.');
  p.api.routes['POST /api/projects/create'] = new Error('offline');
  fire(box, 'keydown', { key: 'Enter' });
  await flush();
  assert.equal(p.toast(), 'Could not reach Corral.');
  assert.deepEqual(p.api.called('POST', '/api/sessions'), []);
});

test('New project still opens a window when herdr could not make the space or answer', async () => {
  const p = await start({ routes: {
    'POST /api/projects/create': created({ space: null, warning: 'herdr not reachable' }),
    'POST /api/sessions': session('s1', { label: 'demo', cwd: '/Users/me/repos/demo' }),
  } });
  p.$('#newproj').click();
  p.$('#newprojname').value = 'demo';
  p.api.routes['GET /api/herdr'] = new Error('offline'); // the sidebar refresh fails quietly
  fire(p.$('#newprojname'), 'keydown', { key: 'Enter' });
  await flush();
  assert.equal(p.toast(), 'Made ~/repos/demo, but herdr has no space for it: herdr not reachable');
  assert.deepEqual(p.api.called('POST', '/api/sessions')[0].body, { cwd: '/Users/me/repos/demo', label: 'demo', space: null, agent: 'claude' });
});

test('the New project box closes on Esc, on a second click, or when left empty', async () => {
  const p = await start({});
  const box = p.$('#newprojname');
  p.$('#newproj').click();
  box.value = 'half';
  fire(box, 'keydown', { key: 'Escape' });
  assert.deepEqual([box.hidden, box.value], [true, '']);
  p.$('#newproj').click();
  p.$('#newproj').click();
  assert.equal(box.hidden, true);
  p.$('#newproj').click();
  box.value = 'kept';
  fire(box, 'blur');
  assert.equal(box.hidden, false, 'a name in it keeps it open');
  box.value = '';
  fire(box, 'blur');
  assert.equal(box.hidden, true);
});
