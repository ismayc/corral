// The plan's usage limits (the 5-hour window, the weekly limit, and the weekly Fable limit), for a strip on
// the Mac page and the phone that sits outside every window. Corral does not ask Anthropic for them: the
// Claude Code status line's helper (~/.claude/statusline-fetch-official.py) fetches them with the Keychain
// token, at most every 5 minutes while a Claude session draws its status line, and keeps the answer in a
// cache file that holds percentages and reset times only. Corral reads that file.
//
// The parse follows the helper's: the newer limits[] array first (kind session, weekly_all, weekly_scoped
// with the model named in scope), then the older flat windows (five_hour, seven_day) for any gap. A scoped
// limit with no reset time has under-reported before (July 22, 2026), so it is marked unreliable. A file
// older than 2 hours gives null, as the status line drops the numbers then too.
const fs = require('fs');

const STALE = 2 * 60 * 60 * 1000;

const pctOf = (e) => {
  for (const k of ['percent', 'utilization']) {
    const n = Number(e?.[k]);
    if (e?.[k] != null && Number.isFinite(n)) return Math.round(n);
  }
  return null;
};
const timeOf = (raw) => {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
};
const mentions = (node, re) => (typeof node === 'string' ? re.test(node)
  : node && typeof node === 'object' ? Object.values(node).some((v) => mentions(v, re)) : false);

// { at, items: [{ key, label, pct, resetsAt, unreliable? }] } from the cache file's parsed contents, or null.
function parse(d, now = Date.now()) {
  const at = Number(d?.fetched_at) * 1000;
  if (!Number.isFinite(at) || at <= 0 || now - at > STALE) return null;
  const found = {};
  const scoped = [];
  for (const e of Array.isArray(d.limits) ? d.limits : []) {
    const pct = pctOf(e);
    if (pct == null) continue;
    const kind = String(e.kind || '').toLowerCase();
    const item = { pct, resetsAt: timeOf(e.resets_at) };
    if (kind.includes('session')) found.five ??= item;
    else if (kind.includes('scoped')) scoped.push([e, item]);
    else if (kind.includes('week') || kind.includes('seven')) found.week ??= item;
  }
  const named = scoped.find(([e]) => mentions(e, /fable|mythos|opus/i)) || (scoped.length === 1 ? scoped[0] : null);
  if (named) found.fable = { ...named[1], unreliable: !named[0].resets_at };
  const w = d.windows && typeof d.windows === 'object' ? d.windows : {};
  for (const [key, name] of [['five', 'five_hour'], ['week', 'seven_day']]) {
    const pct = pctOf(w[name]);
    if (!found[key] && pct != null) found[key] = { pct, resetsAt: timeOf(w[name].resets_at) };
  }
  const items = [['five', '5h'], ['week', 'Week'], ['fable', 'Fable']]
    .filter(([key]) => found[key]).map(([key, label]) => ({ key, label, ...found[key] }));
  return items.length ? { at, items } : null;
}

// The limits from the cache file, or null when it is missing, unreadable, or too old.
function read(file, now = Date.now()) {
  try { return parse(JSON.parse(fs.readFileSync(file, 'utf8')), now); } catch { return null; }
}

module.exports = { STALE, parse, read };
