// Token use on the Mac page's title bars and the phone's cards (public/usage.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../helpers/app');
const m = require('../helpers/m');

const U = {
  input: 42, output: 12736, cacheRead: 2007249, cacheWrite: 194449, cost: 2.21, priced: true, model: 'claude-opus-5-5',
  context: { used: 176358, size: 1000000, pct: 18 },
};

test.afterEach(async () => { await m.settle(); app.stop(); });

test('the Mac title bar shows context and cost, the details on hover, and hides for a window with none', async () => {
  const now = { sessions: [app.status('a', { claude: { status: 'idle', usage: U } }), app.status('b')] };
  const p = await app.start({ routes: { 'GET /api/sessions': { sessions: [app.session('a'), app.session('b')] }, 'GET /api/overview': () => now } });
  p.tick(3000);
  await app.flush();
  const use = (id) => p.window.document.querySelector(`.win[data-id="${id}"] .title .use`) || [...p.window.document.querySelectorAll('.win')].find((w) => w.querySelector('.t').textContent === id).querySelector('.use');
  assert.equal(use('a').hidden, false);
  assert.equal(use('a').textContent, '18% · $2.21');
  assert.deepEqual(use('a').title.split('\n'), [
    'Context: 176,358 of 1,000,000 tokens (18%)',
    'Tokens so far: 42 input, 13k output, 2.0M cache read, 194k cache write',
    'About $2.21 at API prices (claude-opus-5-5). A Claude plan does not bill each token.',
    'Click to hide the dollar amount.',
  ]);
  assert.equal(use('b').hidden, true);
  assert.equal(use('b').textContent, '');
});

test('the usage text covers a model with no context size, a tiny cost, and no price', () => {
  const p = m;
  return p.phone([]).then(({ window }) => {
    const { text, lines } = window.CorralUsage;
    assert.equal(text({ ...U, cost: 0.004, context: { used: 5000, size: null, pct: null } }), '5000 tokens · <$0.01');
    assert.equal(text({ ...U, cost: null, context: null }), '');
    assert.deepEqual(lines({ ...U, cost: null, model: null, context: { used: 9, size: null, pct: null } }), [
      'Context: 9 tokens',
      'Tokens so far: 42 input, 13k output, 2.0M cache read, 194k cache write',
      'No cost estimate: a model in this conversation is not in Corral\'s price table.',
    ]);
    assert.deepEqual(lines({ ...U, context: null, model: null }).slice(-1), ['About $2.21 at API prices. A Claude plan does not bill each token.']);
    assert.deepEqual(lines(null), []);
    assert.equal(text(null), '');
  });
});

test('a phone card shows the usage tag, and a tap on it opens the details without opening the window', async () => {
  const p = await m.phone([m.win('a', { claude: m.claude('idle', { usage: U }) }), m.win('b', { claude: m.claude('idle') })]);
  const tag = p.card('a').querySelector('button.tag.use');
  assert.equal(tag.textContent, '18% · $2.21');
  assert.equal(p.card('b').querySelector('.use'), null);
  tag.click();
  await m.settle();
  assert.equal(p.sheetTitle(), 'a: token use');
  assert.equal(p.$('#termview').hidden, true);
  assert.match(p.$('#gen').textContent, /at API prices/);
});

test('a click on the Mac usage tag hides the dollar amount in every window, and it stays hidden after a reload', async () => {
  const now = { sessions: [app.status('a', { claude: { status: 'idle', usage: U } }), app.status('b', { claude: { status: 'idle', usage: { ...U, cost: 0.5 } } })] };
  const routes = { 'GET /api/sessions': { sessions: [app.session('a'), app.session('b')] }, 'GET /api/overview': () => now };
  let p = await app.start({ routes });
  p.tick(3000);
  await app.flush();
  const use = (id) => [...p.window.document.querySelectorAll('.win')].find((w) => w.querySelector('.t').textContent === id).querySelector('.use');
  assert.match(use('a').title, /Click to hide the dollar amount\.$/);
  use('a').click();
  assert.equal(use('a').textContent, '18%');
  assert.equal(use('b').textContent, '18%');
  assert.doesNotMatch(use('a').title, /API prices/);
  assert.match(use('a').title, /Click to show the dollar amount\.$/);
  assert.equal(p.store('corral.cost'), false);
  assert.match(p.$('#toast').textContent, /Dollar amounts are hidden/);
  app.stop();
  p = await app.start({ routes, storage: { 'corral.cost': 'false' } });
  p.tick(3000);
  await app.flush();
  assert.equal(use('a').textContent, '18%');
  use('a').click();
  assert.equal(use('a').textContent, '18% · $2.21');
  assert.equal(p.store('corral.cost'), true);
  assert.match(p.$('#toast').textContent, /Dollar amounts are shown/);
});

test('the palette hides and shows dollar amounts', async () => {
  const now = { sessions: [app.status('a', { claude: { status: 'idle', usage: U } })] };
  const p = await app.start({ routes: { 'GET /api/sessions': { sessions: [app.session('a')] }, 'GET /api/overview': () => now } });
  p.tick(3000);
  await app.flush();
  const run = (q) => {
    app.fire(p.doc.body, 'keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    const input = p.$('#palette input');
    input.value = q;
    app.fire(input, 'input');
    app.fire(input, 'keydown', { key: 'Enter' });
  };
  run('hide dollar');
  assert.equal(p.$('.win .use').textContent, '18%');
  run('show dollar');
  assert.equal(p.$('.win .use').textContent, '18% · $2.21');
});

test('the phone usage sheet hides and shows dollar amounts on every card', async () => {
  const p = await m.phone([m.win('a', { claude: m.claude('idle', { usage: U }) }), m.win('b', { claude: m.claude('idle', { usage: U }) })]);
  p.card('a').querySelector('button.tag.use').click();
  await m.settle();
  p.button('Hide dollar amounts', p.$('#gen')).click();
  await m.settle();
  assert.equal(p.card('a').querySelector('button.tag.use').textContent, '18%');
  assert.equal(p.card('b').querySelector('button.tag.use').textContent, '18%');
  assert.doesNotMatch(p.$('#gen').textContent, /API prices/);
  assert.equal(JSON.parse(p.window.localStorage.getItem('corral.m.cost')), false);
  p.button('Show dollar amounts', p.$('#gen')).click();
  await m.settle();
  assert.equal(p.card('a').querySelector('button.tag.use').textContent, '18% · $2.21');
  assert.match(p.$('#gen').textContent, /at API prices/);
});
