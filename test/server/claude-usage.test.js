const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const usage = require('../../lib/usage');
const { setup } = require('../helpers/claude');

const reply = (id, model, u, extra = {}) => ({ type: 'assistant', message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u }, ...extra });
const u = (input, output, read = 0, write = 0, write1h = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write,
  cache_creation: { ephemeral_1h_input_tokens: write1h },
});
const tmpFile = (lines) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corral-usage-')), 't.jsonl');
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('priceFor matches the longest model prefix, a dated id, and a 1M tag, and nothing else', () => {
  assert.equal(usage.priceFor('claude-opus-5-5').input, 4);
  assert.equal(usage.priceFor('claude-opus-5').input, 5);
  assert.equal(usage.priceFor('claude-opus-5-20260101').input, 5);
  assert.equal(usage.priceFor('claude-sonnet-4-6[1m]').output, 15);
  assert.equal(usage.priceFor('claude-haiku-4-5').context, 2e5);
  assert.equal(usage.priceFor('claude-opus-5x'), null);
  assert.equal(usage.priceFor('gpt-5'), null);
  assert.equal(usage.priceFor(undefined), null);
});

test('replyCost prices input, output, cache reads, and both cache writes, and is null for an unknown model', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; 5-minute write 1.25x input, 1-hour write 2x input.
  near(usage.replyCost('claude-opus-5-5', u(1e6, 1e6, 1e6, 3e6, 1e6)), 4 + 20 + 0.2 + 2e6 * 5 / 1e6 + 8);
  near(usage.replyCost('claude-opus-5-5', { output_tokens: 1e6 }), 20); // missing fields count as 0
  assert.equal(usage.replyCost('mystery', u(1, 1)), null);
});

test('replyLine reads an assistant line with usage and skips everything else', () => {
  assert.equal(usage.replyLine('{"type":"user","message":{"content":"hi"}}'), null);
  assert.equal(usage.replyLine('"usage" "type":"assistant" not json'), null);
  assert.equal(usage.replyLine(JSON.stringify({ type: 'attachment', note: { type: 'assistant', usage: 1 } })), null);
  assert.equal(usage.replyLine(JSON.stringify(reply('m', '<synthetic>', u(0, 0)))), null);
  assert.equal(usage.replyLine(JSON.stringify({ type: 'assistant', message: { usage: u(1, 1) } })), null); // no model
  assert.deepEqual(usage.replyLine(JSON.stringify(reply('m1', 'claude-opus-5-5', u(1, 2), { isSidechain: true }))),
    { id: 'm1', model: 'claude-opus-5-5', usage: u(1, 2), side: true });
  // A line without a message id falls back to the line's own uuid.
  assert.equal(usage.replyLine(JSON.stringify({ ...reply(undefined, 'claude-opus-5-5', u(1, 1)), uuid: 'line-9' })).id, 'line-9');
});

test('usageFor counts each reply once, keeps subagents out of context, and reads only what was added', () => {
  const f = tmpFile([
    { type: 'user', message: { content: 'go' } },
    reply('a', 'claude-opus-5-5', u(10, 100, 1000, 500)),
    reply('a', 'claude-opus-5-5', u(10, 100, 1000, 500)), // the same reply's second content block
    reply('s', 'claude-haiku-5-5', u(5, 5), { isSidechain: true }),
  ]);
  const first = usage.usageFor(f);
  assert.equal(first.input, 15);
  assert.equal(first.output, 105);
  assert.equal(first.cacheRead, 1000);
  assert.equal(first.cacheWrite, 500);
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.context, { used: 1610, size: 1e6, pct: 0 });
  assert.equal(first.priced, true);
  near(first.cost, (10 * 4 + 100 * 20 + 1000 * 0.2 + 500 * 5) / 1e6 + (5 * 0.1 + 5 * 0.5) / 1e6);
  // A partly written line waits for its newline.
  fs.appendFileSync(f, JSON.stringify(reply('b', 'claude-opus-5-5', u(1, 1, 600000, 0))));
  assert.equal(usage.usageFor(f).context.used, 1610);
  fs.appendFileSync(f, '\n');
  const second = usage.usageFor(f);
  assert.deepEqual(second.context, { used: 600002, size: 1e6, pct: 60 });
  assert.deepEqual(usage.usageFor(f), second); // nothing new: the same answer from the cache
});

test('usageFor starts over when the file shrinks, and gives no cost for an unknown model', () => {
  const f = tmpFile([reply('a', 'claude-opus-5-5', u(1, 1))]);
  assert.ok(usage.usageFor(f).cost > 0);
  fs.writeFileSync(f, `${JSON.stringify(reply('z', 'mystery-model', u(2, 3)))}\n`);
  const r = usage.usageFor(f);
  assert.equal(r.input, 2);
  assert.equal(r.cost, null);
  assert.equal(r.priced, false);
  assert.deepEqual(r.context, { used: 5, size: null, pct: null });
});

test('usageFor is null for a transcript with no replies, a missing file, and caps context at 100%', () => {
  assert.equal(usage.usageFor(tmpFile([{ type: 'user', message: { content: 'hi' } }])), null);
  assert.equal(usage.usageFor('/no/such/file.jsonl'), null);
  const f = tmpFile([reply('a', 'claude-haiku-4-5', u(300000, 0))]);
  assert.equal(usage.usageFor(f).context.pct, 100);
  // A usage object with fields missing counts them as 0.
  const bare = usage.usageFor(tmpFile([reply('a', 'claude-opus-5-5', { output_tokens: 3 })]));
  assert.deepEqual([bare.input, bare.output, bare.cacheRead, bare.cacheWrite, bare.context.used], [0, 3, 0, 0, 3]);
  // Only subagent replies: tokens count, but there is no context.
  assert.equal(usage.usageFor(tmpFile([reply('s', 'claude-opus-5-5', u(1, 1), { isSidechain: true })])).context, null);
});

test('the overview gives each Claude window its usage, and null before there is a transcript', () => {
  const c = setup();
  const s = c.open('chat');
  const sessionId = c.claude(s, { status: 'idle' });
  assert.equal(c.srv.overview().find((w) => w.id === s.id).claude.usage, null);
  c.transcript(sessionId, [reply('a', 'claude-opus-5-5', u(1, 2))]);
  assert.equal(c.srv.overview().find((w) => w.id === s.id).claude.usage.output, 2);
  assert.equal(c.srv.overview({ screens: false }).find((w) => w.id === s.id).claude.usage, null);
});
