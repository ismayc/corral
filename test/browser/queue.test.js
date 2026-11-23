// Queued prompts: the Mac page's Queue button and menu, the palette command, and the phone's sheet and tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../helpers/app');
const m = require('../helpers/m');

test.afterEach(async () => { await m.settle(); app.stop(); });

const ITEMS = [{ id: 'q1', text: 'run the tests', added: 1 }, { id: 'q2', text: 'then commit', added: 2 }];
async function mac(routes = {}, queued = 2) {
  const p = await app.start({ routes: {
    'GET /api/sessions': { sessions: [app.session('a'), app.session('b')] },
    'GET /api/overview': { sessions: [app.status('a', { queued }), app.status('b', { claude: null })] },
    'GET /api/sessions/a/queue': { items: ITEMS },
    ...routes,
  } });
  p.tick(3000);
  await app.flush();
  return p;
}
const qbtn = (p, id) => p.slotOf(id).querySelector('.title .queue');

test('the Queue button shows on a Claude window with how many are waiting, and not on a shell', async () => {
  const p = await mac();
  assert.equal(qbtn(p, 'a').hidden, false);
  assert.equal(qbtn(p, 'a').textContent, 'Queue 2');
  assert.ok(qbtn(p, 'a').classList.contains('has'));
  assert.equal(qbtn(p, 'b').hidden, true);
  p.api.routes['GET /api/overview'] = { sessions: [app.status('a', { queued: 0 }), app.status('b', { claude: null, queued: 1 })] };
  p.tick(3000);
  await app.flush();
  assert.equal(qbtn(p, 'a').textContent, 'Queue');
  assert.equal(qbtn(p, 'b').hidden, false, 'a shell with prompts waiting still shows them');
});

test('the queue menu lists the prompts in order, adds one with Enter, removes one, and clears them', async () => {
  const p = await mac({
    'POST /api/sessions/a/queue': (req) => (req.body.text ? { items: [...ITEMS, { id: 'q3', text: req.body.text }] } : req.body.remove ? { items: [ITEMS[1]] } : { items: [] }),
  });
  qbtn(p, 'a').click();
  await app.flush();
  assert.equal(p.$('.queuemenu .mhead').textContent, 'Waiting to go to a, in order');
  assert.deepEqual(p.$$('.queuemenu .qtext').map((n) => n.textContent), ['run the tests', 'then commit']);
  const input = p.$('.queuemenu input');
  assert.equal(p.doc.activeElement, input);
  app.fire(input, 'keydown', { key: 'Enter' }); // empty: nothing sent
  app.fire(input, 'keydown', { key: 'a' });
  input.value = 'and push';
  app.fire(input, 'keydown', { key: 'Enter' });
  await app.flush();
  assert.deepEqual(p.api.called('POST', '/api/sessions/a/queue').map((c) => c.body), [{ text: 'and push' }]);
  assert.deepEqual(p.$$('.queuemenu .qtext').map((n) => n.textContent), ['run the tests', 'then commit', 'and push']);
  assert.equal(qbtn(p, 'a').textContent, 'Queue 3');
  p.$('.queuemenu .qdel').click();
  await app.flush();
  assert.deepEqual(p.$$('.queuemenu .qtext').map((n) => n.textContent), ['then commit']);
  p.$$('.queuemenu button').find((b) => b.textContent === 'Clear the queue').click();
  await app.flush();
  assert.equal(p.$('.queuemenu .mhead').textContent, 'Nothing is waiting for a');
  assert.equal(p.$$('.queuemenu button').some((b) => b.textContent === 'Clear the queue'), false);
  app.fire(p.$('.queuemenu input'), 'keydown', { key: 'Escape' });
  assert.equal(p.$('.queuemenu'), null);
});

test('a failed queue read, add, remove, or clear says so', async () => {
  const p = await mac({ 'POST /api/sessions/a/queue': { error: 'too many' } });
  qbtn(p, 'a').click();
  await app.flush();
  const input = p.$('.queuemenu input');
  input.value = 'x';
  app.fire(input, 'keydown', { key: 'Enter' });
  await app.flush();
  assert.equal(p.toast(), 'Could not queue it: too many.');
  p.$('.queuemenu .qdel').click();
  await app.flush();
  assert.equal(p.toast(), 'Could not take it out: too many.');
  p.api.routes['POST /api/sessions/a/queue'] = new Error('offline');
  p.$('.queuemenu .qdel').click();
  await app.flush();
  assert.equal(p.toast(), 'Could not take it out.');
  app.fire(input, 'keydown', { key: 'Enter' });
  await app.flush();
  assert.equal(p.toast(), 'Could not queue it.');
  p.$$('.queuemenu button').find((b) => b.textContent === 'Clear the queue').click();
  await app.flush();
  assert.equal(p.toast(), 'Could not clear the queue.');
  p.api.routes['GET /api/sessions/a/queue'] = new Error('offline');
  qbtn(p, 'a').click();
  await app.flush();
  assert.equal(p.toast(), 'Could not read the queue.');
});

test('the palette offers Queue a prompt for the window that had the keyboard', async () => {
  const p = await mac();
  const t = p.terms.find((x) => x.element === p.slotOf('a').querySelector('.term'));
  t.textarea.focus();
  app.fire(t.textarea, 'keydown', { key: 'k', metaKey: true, bubbles: true });
  const input = p.$('#palette input');
  input.value = 'queue a prompt';
  app.fire(input, 'input');
  assert.equal(p.$('#palette .phint').textContent, '2 waiting');
  app.fire(input, 'keydown', { key: 'Enter' });
  await app.flush();
  assert.ok(p.$('.queuemenu'));
  const q = await mac({}, 0);
  const t2 = q.terms.find((x) => x.element === q.slotOf('a').querySelector('.term'));
  t2.textarea.focus();
  app.fire(t2.textarea, 'keydown', { key: 'k', metaKey: true, bubbles: true });
  q.$('#palette input').value = 'queue a prompt';
  app.fire(q.$('#palette input'), 'input');
  assert.equal(q.$('#palette .phint').textContent, 'queue');
});

// ---- Phone

test('a phone card shows how many prompts wait, and its sheet adds, removes, and clears them', async () => {
  let items = [...ITEMS];
  const p = await m.phone([m.win('a', { claude: m.claude('idle'), queued: 2 })], { routes: {
    'GET /api/sessions/a/queue': () => ({ items }),
    'POST /api/sessions/a/queue': (req) => {
      if (req.body.text) items = [...items, { id: 'q3', text: req.body.text }];
      else if (req.body.remove) items = items.filter((x) => x.id !== req.body.remove);
      else items = [];
      return { items };
    },
  } });
  const tag = [...p.card('a').querySelectorAll('button.tag')].find((b) => b.textContent === '2 queued');
  tag.click();
  await m.settle();
  assert.equal(p.sheetTitle(), 'a: queued prompts');
  assert.deepEqual([...p.$('#gen').querySelectorAll('.qtext')].map((n) => n.textContent), ['run the tests', 'then commit']);
  p.button('Add to the queue').click(); // empty box: nothing sent
  await m.settle();
  assert.equal(p.api.called('POST', '/api/sessions/a/queue').length, 0);
  p.$('#gen textarea').value = 'and push';
  p.button('Add to the queue').click();
  await m.settle();
  assert.deepEqual([...p.$('#gen').querySelectorAll('.qtext')].map((n) => n.textContent), ['run the tests', 'then commit', 'and push']);
  p.$('#gen [aria-label="Remove prompt 1"]').click();
  await m.settle();
  assert.deepEqual([...p.$('#gen').querySelectorAll('.qtext')].map((n) => n.textContent), ['then commit', 'and push']);
  p.button('Clear').click();
  await m.settle();
  assert.match(p.$('#gen').textContent, /Nothing is waiting\./);
  assert.ok(![...p.$('#gen').querySelectorAll('button')].some((b) => b.textContent === 'Clear'));
});

test('the phone menu offers the queue on a Claude window or one with prompts waiting, and failures say so', async () => {
  const p = await m.phone([m.win('a', { claude: m.claude('idle'), queued: 1 }), m.win('sh')], { routes: {
    'GET /api/sessions/a/queue': new Error('offline'),
  } });
  p.card('a').querySelector('.more').click();
  p.button('Queued prompts (1)').click();
  await m.settle();
  assert.match(p.$('#gen').textContent, /Could not read the queue\./);
  p.card('sh').querySelector('.more').click();
  assert.ok(![...p.$('#gen').querySelectorAll('button')].some((b) => /queue/i.test(b.textContent)));
  p.api.routes['GET /api/sessions/a/queue'] = { items: [] };
  p.api.routes['POST /api/sessions/a/queue'] = new Error('offline');
  p.card('a').querySelector('.more').click();
  p.button('Queued prompts (1)').click();
  await m.settle();
  p.$('#gen textarea').value = 'x';
  p.button('Add to the queue').click();
  await m.settle();
  assert.match(p.$('#toast').textContent, /^Could not queue it/);
});
