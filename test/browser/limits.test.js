// The plan's usage limits strip on the Mac page's sidebar and the phone's home header (public/limits.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../helpers/app');
const m = require('../helpers/m');

const MIN = 60000;
const now = Date.now();
const L = {
  at: now - MIN,
  items: [
    { key: 'five', label: '5h', pct: 3, resetsAt: now + (4 * 60 + 19) * MIN + 30000 },
    { key: 'week', label: 'Week', pct: 62, resetsAt: now + (4 * 1440 + 21 * 60) * MIN + 30000 },
    { key: 'fable', label: 'Fable', pct: 85, resetsAt: now + 4 * 1440 * MIN + 30000, unreliable: false },
  ],
};
// Each meter as "class: label pct reset", read from its parts.
const strip = (doc) => [...doc.querySelectorAll('#limits .lim')].map((s) => `${s.className}: ${s.classList.contains('age') ? s.textContent
  : ['.lab', '.pct', '.rst'].map((c) => s.querySelector(c).textContent).filter(Boolean).join(' ')}`);
const bar = (doc, key) => {
  const b = doc.querySelector(`#limits [data-key="${key}"] .bar`);
  return { fill: b.querySelector('.fill').style.width, tick: b.querySelector('.tick')?.style.left ?? null };
};

test.afterEach(async () => { await m.settle(); app.stop(); });

test('the Mac sidebar shows each limit with its reset and color, and hides with no numbers', async () => {
  let limits = L;
  const p = await app.start({ routes: { 'GET /api/overview': () => ({ machine: 'Test Mac', sessions: [], limits }) } });
  p.tick(3000);
  await app.flush();
  const doc = p.window.document;
  assert.equal(doc.querySelector('#limits').hidden, false);
  assert.deepEqual(strip(doc), ['lim ok: 5h 3% 4h 19m', 'lim warn: Week 62% 4d 21h', 'lim alert: Fable 85% 4d 0h']);
  assert.match(doc.querySelector('#limits [data-key="five"]').title, /^5-hour limit: 3% used\nResets in 4h 19m \(.*\)\n14% of the window has passed/);
  // The bar fills to the percent used; the tick marks the share of the window gone (5 h with 4h 19m left).
  assert.deepEqual(bar(doc, 'five'), { fill: '3%', tick: '14%' });
  assert.deepEqual(bar(doc, 'fable'), { fill: '85%', tick: '43%' });
  assert.match(doc.querySelector('#limits').title, /^Plan usage, read 1 min ago/);
  limits = null;
  p.tick(3000);
  await app.flush();
  assert.equal(doc.querySelector('#limits').hidden, true);
  assert.equal(doc.querySelector('#limits').title, '');
});

test('the phone header shows the strip, "?%" for an unreliable Fable figure, and the age of old numbers', async () => {
  const old = {
    at: now - 75 * MIN,
    items: [
      { key: 'five', label: '5h', pct: 50, resetsAt: now + 19 * MIN + 30000 },
      { key: 'week', label: 'Week', pct: 10, resetsAt: now - MIN },
      { key: 'fable', label: 'Fable', pct: 0, resetsAt: null, unreliable: true },
      { key: 'odd', label: 'Odd', pct: 1, resetsAt: null },
    ],
  };
  const p = await m.phone([], { routes: { 'GET /api/overview': { ...m.overview(), limits: old } } });
  assert.deepEqual(strip(p.doc), ['lim warn: 5h 50% 19m', 'lim ok: Week 10% now', 'lim warn: Fable ?%', 'lim ok: Odd 1%', 'lim age: as of 1 h 15 min ago']);
  assert.equal(p.$('#limits [data-key="fable"]').title,
    'Weekly Fable limit: 0% used\nNo reset time given\nAnthropic sent this with no reset time, which has under-reported before.');
  assert.match(p.$('#limits [data-key="odd"]').title, /^Odd: 1% used/);
  // No reset or no known window length: no tick. A reset already past: the whole window is gone.
  assert.deepEqual(bar(p.doc, 'fable'), { fill: '0%', tick: null });
  assert.deepEqual(bar(p.doc, 'odd'), { fill: '1%', tick: null });
  assert.deepEqual(bar(p.doc, 'week'), { fill: '10%', tick: '100%' });
});

test('left() reads minutes, hours, and days', async () => {
  const { window } = await m.phone([]);
  const { left } = window.CorralLimits;
  assert.equal(left(0), 'now');
  assert.equal(left(5 * MIN), '5m');
  assert.equal(left(65 * MIN), '1h 5m');
  assert.equal(left(1440 * MIN), '1d 0h');
  assert.equal(window.CorralLimits.parts(null).length, 0);
});
