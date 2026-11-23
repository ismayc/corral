// Token use, context use, and an estimated cost for a Claude Code conversation, from its transcript.
// Claude Code writes the API's `usage` object on every assistant line; a reply with several content blocks
// is several lines that share one message id and carry the same usage, so each id is counted once (its last
// line wins). Lines from subagents (isSidechain) count toward tokens and cost but not toward context, which
// is the main conversation's own: the input, cache reads, cache writes, and output of its latest reply.
//
// The dollar figure is an estimate at Anthropic's published API prices per million tokens (cached from the
// claude-api skill on November 23, 2026). A Claude plan does not bill each token, so the pages label it
// "at API prices". Cache writes cost 1.25x input for the 5-minute cache and 2x for the 1-hour cache.
const fs = require('fs');

// model id prefix -> [input, output, cache read] in dollars per million tokens, and the context window.
const PRICES = [
  ['claude-fable-5-2', 8, 40, 0.2, 1e6],
  ['claude-mythos-5-2', 8, 40, 0.2, 1e6],
  ['claude-fable-5-1', 10, 50, 0.25, 1e6],
  ['claude-mythos-5-1', 10, 50, 0.25, 1e6],
  ['claude-fable-5', 10, 50, 1, 1e6],
  ['claude-mythos-5', 10, 50, 1, 1e6],
  ['claude-opus-5-5', 4, 20, 0.2, 1e6],
  ['claude-opus-5', 5, 25, 0.5, 1e6],
  ['claude-opus-4-8', 5, 25, 0.5, 1e6],
  ['claude-opus-4-7', 5, 25, 0.5, 1e6],
  ['claude-opus-4-6', 5, 25, 0.5, 1e6],
  ['claude-sonnet-5-5', 2, 10, 0.1, 1e6],
  ['claude-sonnet-5', 2, 10, 0.2, 1e6],
  ['claude-sonnet-4-6', 3, 15, 0.3, 1e6],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01, 1e6],
  ['claude-haiku-4-5', 1, 5, 0.1, 2e5],
];

// The price row for a model id, longest prefix first so claude-opus-5-5 is not read as claude-opus-5.
function priceFor(model) {
  if (typeof model !== 'string') return null;
  const id = model.replace(/\[1m\]$/, '');
  let best = null;
  for (const row of PRICES) if ((id === row[0] || id.startsWith(`${row[0]}-`)) && (!best || row[0].length > best[0].length)) best = row;
  return best && { input: best[1], output: best[2], cacheRead: best[3], context: best[4] };
}

// The dollars one reply's usage costs at API prices, or null for a model not in the table.
function replyCost(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  const write1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const write5m = (Number(u.cache_creation_input_tokens) || 0) - write1h;
  return ((Number(u.input_tokens) || 0) * p.input + (Number(u.output_tokens) || 0) * p.output
    + (Number(u.cache_read_input_tokens) || 0) * p.cacheRead + write5m * p.input * 1.25 + write1h * p.input * 2) / 1e6;
}

// One transcript line's reply, or null: { id, model, usage, side }.
function replyLine(line) {
  if (!line.includes('"usage"') || !/"type":\s*"assistant"/.test(line)) return null;
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const m = d.message;
  if (d.type !== 'assistant' || !m?.usage || typeof m.model !== 'string' || m.model === '<synthetic>') return null;
  return { id: m.id || d.uuid, model: m.model, usage: m.usage, side: Boolean(d.isSidechain) };
}

// The totals for a set of replies (a Map of id -> reply) and the latest main-conversation reply.
function totals(replies, last) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: true, model: last?.model || null, context: null };
  for (const r of replies.values()) {
    const u = r.usage;
    t.input += Number(u.input_tokens) || 0;
    t.output += Number(u.output_tokens) || 0;
    t.cacheRead += Number(u.cache_read_input_tokens) || 0;
    t.cacheWrite += Number(u.cache_creation_input_tokens) || 0;
    const c = replyCost(r.model, u);
    if (c === null) t.priced = false; else t.cost += c;
  }
  if (!t.priced) t.cost = null;
  if (last) {
    const u = last.usage;
    const used = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.output_tokens) || 0);
    const size = priceFor(last.model)?.context || null;
    t.context = { used, size, pct: size ? Math.min(100, Math.round((used / size) * 100)) : null };
  }
  return t;
}

// Usage for a transcript file, read once in full and then only what was added since (the pages ask every
// few seconds). A file that shrank is read again from the start. A line still being written waits.
const cache = new Map();
function usageFor(file) {
  try {
    const { size } = fs.statSync(file);
    let hit = cache.get(file);
    if (!hit || size < hit.at) hit = { at: 0, replies: new Map(), last: null };
    if (size > hit.at) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - hit.at);
      fs.readSync(fd, buf, 0, buf.length, hit.at);
      fs.closeSync(fd);
      const end = buf.lastIndexOf(0x0a) + 1;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        const r = replyLine(line);
        if (!r) continue;
        hit.replies.set(r.id, r);
        if (!r.side) hit.last = r;
      }
      hit.at += end;
      cache.set(file, hit);
    }
    return hit.replies.size ? totals(hit.replies, hit.last) : null;
  } catch { return null; }
}

module.exports = { PRICES, priceFor, replyCost, replyLine, totals, usageFor, cache };
