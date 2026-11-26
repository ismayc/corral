// The plan's usage limits (lib/limits.js) from the status line helper's cache, and their place in /api/overview.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const limits = require('../../lib/limits');
const { setup } = require('../helpers/claude');
const { listen } = require('../helpers/server');

const NOW = Date.parse('2026-11-26T13:00:00Z');
const AT = NOW / 1000 - 60;
const WEEK = '2026-12-01T10:00:00+00:00';
// The cache as the helper writes it (from a real file, November 26, 2026), with the money fields left out.
const CACHE = {
  attempted_at: AT, fetched_at: AT,
  windows: { five_hour: { utilization: 2.0, resets_at: '2026-11-26T17:19:59+00:00' }, seven_day: { utilization: 32.0, resets_at: WEEK } },
  limits: [
    { kind: 'session', percent: 3, resets_at: '2026-11-26T17:19:59+00:00', scope: null },
    { kind: 'weekly_all', percent: 32, resets_at: WEEK, scope: null },
    { kind: 'weekly_scoped', percent: 0, resets_at: WEEK, scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
};

test('parse reads the limits array: 5h, Week, and Fable, with reset times in milliseconds', () => {
  assert.deepEqual(limits.parse(CACHE, NOW), {
    at: AT * 1000,
    items: [
      { key: 'five', label: '5h', pct: 3, resetsAt: Date.parse('2026-11-26T17:19:59Z') },
      { key: 'week', label: 'Week', pct: 32, resetsAt: Date.parse(WEEK) },
      { key: 'fable', label: 'Fable', pct: 0, resetsAt: Date.parse(WEEK), unreliable: false },
    ],
  });
});

test('parse falls back to the flat windows, takes a lone unnamed scoped limit, and marks one with no reset', () => {
  const d = {
    fetched_at: AT,
    windows: { five_hour: { utilization: 7.4, resets_at: 'not a time' }, seven_day: { utilization: 'x' } },
    limits: [null, { kind: 'weekly_scoped', percent: 12 }, { kind: 'other', percent: 1 }, { kind: 'session' }, { percent: 5 }],
  };
  assert.deepEqual(limits.parse(d, NOW).items, [
    { key: 'five', label: '5h', pct: 7, resetsAt: null },
    { key: 'fable', label: 'Fable', pct: 12, resetsAt: null, unreliable: true },
  ]);
  const two = { fetched_at: AT, limits: [{ kind: 'weekly_scoped', percent: 1 }, { kind: 'seven_scoped', utilization: 2 }, { kind: 'seven', percent: 40 }] };
  assert.deepEqual(limits.parse(two, NOW).items, [{ key: 'week', label: 'Week', pct: 40, resetsAt: null }], 'two unnamed scoped limits: no Fable');
  const named = { fetched_at: AT, limits: [{ kind: 'weekly_scoped', percent: 1 }, { kind: 'weekly_scoped', percent: 9, scope: ['Opus'] }] };
  assert.equal(limits.parse(named, NOW).items[0].pct, 9, 'the scoped limit that names the model wins');
});

test('parse gives null for an old, undated, or empty cache', () => {
  assert.equal(limits.parse({ ...CACHE, fetched_at: NOW / 1000 - 3 * 3600 }, NOW), null);
  assert.equal(limits.parse({ ...CACHE, fetched_at: 0 }, NOW), null);
  assert.equal(limits.parse({ ...CACHE, fetched_at: 'x' }, NOW), null);
  assert.equal(limits.parse(null, NOW), null);
  assert.equal(limits.parse({ fetched_at: AT, windows: null, limits: {} }, NOW), null);
  // The default clock: a cache fetched a minute ago by the real time (CACHE's own date goes stale 2 hours after NOW).
  assert.ok(limits.parse({ ...CACHE, fetched_at: Date.now() / 1000 - 60 }));
});

test('read gives null for a missing or broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corral-limits-'));
  assert.equal(limits.read(path.join(dir, 'none.json'), NOW), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  assert.equal(limits.read(path.join(dir, 'bad.json'), NOW), null);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(CACHE));
  assert.equal(limits.read(path.join(dir, 'ok.json'), NOW).items.length, 3);
});

test('GET /api/overview carries the limits from ~/.claude, or null without the cache', async () => {
  const c = setup({});
  const h = await listen(c.srv);
  try {
    assert.equal((await h.request('GET', '/api/overview')).json.limits, null);
    const file = path.join(c.home, '.claude/cache/statusline-usage/official.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...CACHE, fetched_at: Date.now() / 1000 }));
    assert.deepEqual((await h.request('GET', '/api/overview')).json.limits.items.map((i) => `${i.label} ${i.pct}`), ['5h 3', 'Week 32', 'Fable 0']);
  } finally { await h.close(); }
});
