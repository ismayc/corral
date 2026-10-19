const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('../helpers/claude');

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const text = (t) => ({ type: 'text', text: t });
const toolUse = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } };
const toolResult = user([{ type: 'tool_result', tool_use_id: 't1', content: 'a b c' }]);

function withClaude(opts) {
  const c = setup(opts);
  const s = c.open('chat');
  const sessionId = c.claude(s, { status: 'idle' });
  return { c, s, sessionId };
}

test('transcriptFile finds the conversation file in whichever project folder holds it', () => {
  const { srv, home } = setup();
  const sessionId = '11111111-2222-3333-4444-555555555555';
  assert.equal(srv.transcriptFile({ sessionId }), null); // no projects folder yet
  fs.mkdirSync(path.join(home, '.claude/projects/a-proj'), { recursive: true });
  assert.equal(srv.transcriptFile({ sessionId }), null); // folder without the file
  const dir = path.join(home, '.claude/projects/z-proj');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');
  assert.equal(srv.transcriptFile({ sessionId }), path.join(dir, `${sessionId}.jsonl`));
});

test('tailLines returns every line of a small file', () => {
  const { srv, home } = setup();
  const f = path.join(home, 'small.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  assert.deepEqual(srv.tailLines(f, 1000), ['one', 'two', 'three', '']);
});

test('tailLines drops the first line when the read starts mid-file', () => {
  const { srv, home } = setup();
  const f = path.join(home, 'big.txt');
  fs.writeFileSync(f, 'one\ntwo\nthree\n');
  assert.deepEqual(srv.tailLines(f, 8), ['three', '']);
});

test('lastReply says so when Claude is not running in the window', () => {
  const c = setup();
  const s = c.open('a');
  assert.deepEqual(c.srv.lastReply(s), { status: 409, error: 'Claude Code is not running in this window' });
});

test('lastReply says so when the conversation has no transcript yet', () => {
  const { c, s } = withClaude();
  assert.deepEqual(c.srv.lastReply(s), { status: 404, error: 'no transcript yet' });
});

test('lastReply joins every text block Claude wrote since your last message', () => {
  const { c, s, sessionId } = withClaude();
  const file = c.transcript(sessionId, [
    user('first question'),
    assistant([text('old answer')]),
    user('second question'),
    assistant([text('Let me check'), toolUse]),
    toolResult,
    assistant([text('  Done: all good  ')]),
  ]);
  assert.deepEqual(c.srv.lastReply(s), { status: 200, text: 'Let me check\n\nDone: all good', at: fs.statSync(file).mtimeMs });
});

test('lastReply keeps the blocks of one message in order', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [user('q'), assistant([text('one'), toolUse, text('two')])]);
  assert.equal(c.srv.lastReply(s).text, 'one\n\ntwo');
});

test('lastReply skips side chains, bookkeeping, blank blocks, and lines it cannot parse', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [
    user('question'),
    assistant([text('real answer')]),
    assistant([text('agent chatter')], { isSidechain: true }),
    user('<system-reminder>', { isMeta: true }),
    assistant([text('   '), toolUse]),
    assistant('not an array'),
    { type: 'attachment', attachment: { type: 'queued_command' } },
    '{this is not json',
    '',
    user([null, 7]),
  ]);
  assert.equal(c.srv.lastReply(s).text, 'real answer');
});

test('lastReply stops at a message you typed as text parts', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [
    assistant([text('earlier reply')]),
    user([text('typed in parts')]),
    assistant([text('the reply')]),
  ]);
  assert.equal(c.srv.lastReply(s).text, 'the reply');
});

test('lastReply gives null text when Claude has only used tools since your message', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [user('go'), assistant([toolUse]), toolResult]);
  assert.deepEqual(c.srv.lastReply(s), { status: 200, text: null });
  c.transcript(sessionId, []);
  assert.deepEqual(c.srv.lastReply(s), { status: 200, text: null });
});

test('lastReply keeps the last 6000 characters of a long reply, marked with an ellipsis', () => {
  const { c, s, sessionId } = withClaude();
  const long = `${'a'.repeat(3000)}${'b'.repeat(3000)}${'c'.repeat(3000)}`;
  c.transcript(sessionId, [user('q'), assistant([text(long)])]);
  const r = c.srv.lastReply(s);
  assert.equal(r.text, `…${'b'.repeat(3000)}${'c'.repeat(3000)}`);
  c.transcript(sessionId, [user('q'), assistant([text('a'.repeat(6000))])]);
  assert.equal(c.srv.lastReply(s).text, 'a'.repeat(6000));
});

test('lastReply reads only the last megabyte of a large transcript', () => {
  const { c, s, sessionId } = withClaude();
  const filler = user('x'.repeat(900)); // each line is about 1 KB
  const lines = [user('old question'), assistant([text('buried reply')]), ...Array(1300).fill(filler), user('new question'), assistant([text('fresh reply')])];
  c.transcript(sessionId, lines);
  assert.equal(c.srv.lastReply(s).text, 'fresh reply');
});

test('lastReply throws when the transcript path cannot be read', () => {
  const { c, s, sessionId } = withClaude();
  fs.mkdirSync(path.join(c.home, '.claude/projects/p', `${sessionId}.jsonl`), { recursive: true });
  assert.throws(() => c.srv.lastReply(s));
});

test('typedText returns plain text as typed', () => {
  const { srv } = setup();
  assert.equal(srv.typedText('  hello there  '), 'hello there');
  assert.equal(srv.typedText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), 'one\n\ntwo');
});

test('typedText shows a slash command as "/name args", with or without arguments', () => {
  const { srv } = setup();
  assert.equal(srv.typedText('<command-name>/model</command-name><command-args>opus</command-args>'), '/model opus');
  assert.equal(srv.typedText('<command-name>/clear</command-name><command-args></command-args>'), '/clear');
  assert.equal(srv.typedText('<command-message>x</command-message>\n<command-name>/help</command-name>'), '/help');
});

test('typedText ignores command output, reminders, image markers, and blank parts', () => {
  const { srv } = setup();
  assert.equal(srv.typedText('<local-command-stdout>done</local-command-stdout>'), '');
  assert.equal(srv.typedText('<system-reminder>be good</system-reminder>'), '');
  assert.equal(srv.typedText('[Image #1]'), '');
  assert.equal(srv.typedText([{ type: 'text', text: '   ' }, { type: 'tool_result', content: 'x' }, null]), '');
});

test('typedText turns images into a photo note after the text', () => {
  const { srv } = setup();
  const img = { type: 'image', source: {} };
  assert.equal(srv.typedText([img, text('look')]), 'look\n\n[a photo]');
  assert.equal(srv.typedText([img, img, img]), '[3 photos]');
});

test('typedText gives an empty string for content that is neither text nor a list', () => {
  const { srv } = setup();
  for (const v of [undefined, null, 5, { type: 'text', text: 'x' }]) assert.equal(srv.typedText(v), '');
});

test('conversation says so when Claude is not running or has no transcript', () => {
  const c = setup();
  const s = c.open('a');
  assert.deepEqual(c.srv.conversation(s), { status: 409, error: 'Claude Code is not running in this window' });
  c.claude(s);
  assert.deepEqual(c.srv.conversation(s), { status: 404, error: 'no transcript yet' });
});

test('conversation lists what you typed and what Claude wrote, oldest first, without tool calls', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [
    user('hello', { timestamp: 't1' }),
    assistant([text('Hi!')], { timestamp: 't2' }),
    assistant([toolUse], { timestamp: 't3' }),
    toolResult,
    assistant([text('Ran it.'), toolUse], { timestamp: 't4' }),
    user('<command-name>/model</command-name><command-args>opus</command-args>', { timestamp: 't5' }),
    assistant([text('Switched.')], { timestamp: 't6' }),
  ]);
  assert.deepEqual(c.srv.conversation(s), {
    status: 200, cut: false, claude: 'idle', statusLines: [],
    items: [
      { who: 'you', text: 'hello', at: 't1' },
      { who: 'claude', text: 'Hi!\n\nRan it.', at: 't2' },
      { who: 'you', text: '/model opus', at: 't5' },
      { who: 'claude', text: 'Switched.', at: 't6' },
    ],
  });
});

test('conversation keeps two messages from you separate', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [user('one', { timestamp: 'a' }), user('two', { timestamp: 'b' })]);
  assert.deepEqual(c.srv.conversation(s).items.map((i) => i.text), ['one', 'two']);
});

test('conversation notes a summarized history and skips bookkeeping and side chains', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [
    user('summary text', { isCompactSummary: true, timestamp: 'n' }),
    user('<system-reminder>x</system-reminder>', { isMeta: true }),
    user('<local-command-stdout>out</local-command-stdout>'),
    user('side question', { isSidechain: true }),
    assistant([text('side answer')], { isSidechain: true }),
    '{"type":"user" broken json',
    user('real', { timestamp: 'r' }),
  ]);
  assert.deepEqual(c.srv.conversation(s).items, [
    { who: 'note', text: 'Earlier messages were summarized to save space.', at: 'n' },
    { who: 'you', text: 'real', at: 'r' },
  ]);
});

test('conversation shows a message sent while Claude was working, only when a person typed it', () => {
  const { c, s, sessionId } = withClaude();
  const queued = (prompt, kind) => ({ type: 'attachment', timestamp: 'q', attachment: { type: 'queued_command', prompt, origin: { kind } } });
  c.transcript(sessionId, [
    queued('while you work', 'human'),
    queued('task notification', 'system'),
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'no origin' } },
    queued('<system-reminder>x</system-reminder>', 'human'),
    { type: 'attachment', attachment: { type: 'other', prompt: 'x' } },
  ]);
  assert.deepEqual(c.srv.conversation(s).items, [{ who: 'you', text: 'while you work', at: 'q' }]);
});

test('conversation counts photos in a message', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [user([{ type: 'image', source: {} }, text('what is this')], { timestamp: 'p' })]);
  assert.equal(c.srv.conversation(s).items[0].text, 'what is this\n\n[a photo]');
});

test('conversation returns the last 300 items and flags the cut', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, Array.from({ length: 305 }, (_, i) => user(`m${i}`)));
  const r = c.srv.conversation(s);
  assert.equal(r.items.length, 300);
  assert.equal(r.items[0].text, 'm5');
  assert.equal(r.cut, true);
  c.transcript(sessionId, Array.from({ length: 300 }, (_, i) => user(`m${i}`)));
  assert.equal(c.srv.conversation(s).cut, false);
});

test('conversation flags the cut when the transcript is bigger than the 64 MB it reads', () => {
  const { c, s, sessionId } = withClaude();
  const file = c.transcript(sessionId, [user('lost')]);
  fs.truncateSync(file, 65 * 1024 * 1024); // a sparse file: the earlier part is never read
  fs.appendFileSync(file, `\n${JSON.stringify(user('kept', { timestamp: 'k' }))}\n`);
  const r = c.srv.conversation(s);
  assert.equal(r.cut, true);
  assert.deepEqual(r.items, [{ who: 'you', text: 'kept', at: 'k' }]);
  fs.rmSync(file);
});

test('conversation throws when the transcript path cannot be read', () => {
  const { c, s, sessionId } = withClaude();
  fs.mkdirSync(path.join(c.home, '.claude/projects/p', `${sessionId}.jsonl`), { recursive: true });
  assert.throws(() => c.srv.conversation(s));
});

test('screenStatus returns the lines under the input box, or none without one', () => {
  const { srv } = setup();
  const rule = '─'.repeat(40);
  const screen = ['● Done.', '', rule, '❯ ', rule, '  📁 notes · main', '', '  ⏵⏵ auto mode on (shift+tab to cycle)', '', ''];
  assert.deepEqual(srv.screenStatus(screen), ['  📁 notes · main', '  ⏵⏵ auto mode on (shift+tab to cycle)']);
  assert.deepEqual(srv.screenStatus(['no rule here', 'at all']), []);
  assert.deepEqual(srv.screenStatus([rule, ...Array.from({ length: 12 }, (_, i) => `line ${i}`)]).length, 8);
});

test('conversation carries Claude\'s status and the status lines from the screen', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [user('hi')]);
  const rule = '─'.repeat(40);
  c.screen(s, ['● Hello.', rule, '❯ ', rule, '  📁 chat · main', '  ⏵⏵ auto mode on'].join('\n'));
  const r = c.srv.conversation(s);
  assert.equal(r.claude, 'idle');
  assert.deepEqual(r.statusLines, ['  📁 chat · main', '  ⏵⏵ auto mode on']);
});

test('conversation has no status lines while a permission prompt or question replaces the input box, or without tmux', () => {
  const { c, s, sessionId } = withClaude();
  c.claude(s, { sessionId, status: 'waiting', waitingFor: 'permission prompt' });
  c.transcript(sessionId, [user('hi')]);
  c.screen(s, ['─'.repeat(40), ' Bash command', '   ls'].join('\n'));
  assert.deepEqual(c.srv.conversation(s).statusLines, []);
  // A question dialog puts "Chat about this" and its footer under the last rule, which are not status lines.
  c.claude(s, { sessionId, status: 'waiting', waitingFor: 'input needed' });
  c.screen(s, ['Pick one', ' ❯ 1. A', '─'.repeat(40), '  2. Chat about this', 'Enter to select · Esc to cancel'].join('\n'));
  assert.deepEqual(c.srv.conversation(s).statusLines, []);
  s.tmux = false;
  c.claude(s, { sessionId, status: 'busy', pid: s.pty.pid });
  assert.deepEqual(c.srv.conversation(s).statusLines, []);
});

test('conversation has no status lines when the screen cannot be read', () => {
  const { c, s, sessionId } = withClaude();
  c.transcript(sessionId, [user('hi')]);
  c.tmux.fail.add('capture-pane');
  assert.deepEqual(c.srv.conversation(s).statusLines, []);
});

const CLEAR = user('<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>');

test('restState is null for a conversation with no transcript yet', () => {
  const { c, sessionId } = withClaude();
  assert.equal(c.srv.restState({ sessionId }), null);
});

test('restState is cleared when /clear is the last thing typed, past Claude Code bookkeeping and stray lines', () => {
  const { c, sessionId } = withClaude();
  c.transcript(sessionId, [
    { type: 'mode', mode: 'normal' },
    user('<local-command-caveat>The command below was run directly</local-command-caveat>', { isMeta: true }),
    CLEAR,
    { type: 'system', subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>' },
    user('a side task', { isSidechain: true }),
    toolResult,
    '{"type":"user", not json',
    user('<system-reminder>noted</system-reminder>'),
  ]);
  assert.equal(c.srv.restState({ sessionId }), 'cleared');
});

test('restState is null once something is typed after /clear, or when nothing was typed at all', () => {
  const { c, sessionId } = withClaude();
  c.transcript(sessionId, [CLEAR, user('what next?')]);
  assert.equal(c.srv.restState({ sessionId }), null);
  c.transcript(sessionId, [assistant([text('hello')])]);
  assert.equal(c.srv.restState({ sessionId }), null);
});

test('restState reads a transcript again only when its size or time changes', () => {
  const { c, sessionId } = withClaude();
  const file = c.transcript(sessionId, [CLEAR, user('abc')]);
  fs.utimesSync(file, 1791390000, 1791390000); // whole seconds, so setting the time again gives the same time
  assert.equal(c.srv.restState({ sessionId }), null);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"abc"', '"   "'));
  fs.utimesSync(file, 1791390000, 1791390000);
  assert.equal(c.srv.restState({ sessionId }), null, 'same size and time: the cached answer');
  fs.utimesSync(file, 1791390000, 1791390005);
  assert.equal(c.srv.restState({ sessionId }), 'cleared');
});

const boundary = (trigger, o = {}) => ({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger }, ...o });
const summary = user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true });

test('restState is compacted after an automatic compaction, past its summary and Claude carrying on', () => {
  const { c, sessionId } = withClaude();
  c.transcript(sessionId, [user('build it'), boundary('auto'), summary, assistant([text('Picking up where I left off.')]), toolResult,
    boundary('auto', { isSidechain: true })]);
  assert.equal(c.srv.restState({ sessionId }), 'compacted');
});

test('restState is null after a manual /compact, or once something is typed after a compaction', () => {
  const { c, sessionId } = withClaude();
  c.transcript(sessionId, [boundary('manual'), summary]);
  assert.equal(c.srv.restState({ sessionId }), null);
  c.transcript(sessionId, [boundary('auto'), summary, user('and now the tests')]);
  assert.equal(c.srv.restState({ sessionId }), null);
  c.transcript(sessionId, [CLEAR, boundary('auto')]);
  assert.equal(c.srv.restState({ sessionId }), 'compacted', 'the later of the two decides');
  c.transcript(sessionId, [{ type: 'system', subtype: 'compact_boundary' }]);
  assert.equal(c.srv.restState({ sessionId }), null, 'no metadata: not known to be automatic');
});

test('restState is null when the transcript cannot be read', () => {
  const { c, sessionId } = withClaude();
  fs.mkdirSync(path.join(c.home, '.claude', 'projects', 'proj', `${sessionId}.jsonl`), { recursive: true });
  assert.equal(c.srv.restState({ sessionId }), null);
});

const queued = (prompt, kind = 'human') => ({ type: 'attachment', attachment: { type: 'queued_command', prompt, origin: { kind } } });

test('lastPrompt is null for a conversation with no transcript yet, or one that cannot be read', () => {
  const { c, sessionId } = withClaude();
  assert.equal(c.srv.lastPrompt({ sessionId }), null);
  fs.mkdirSync(path.join(c.home, '.claude', 'projects', 'proj', `${sessionId}.jsonl`), { recursive: true });
  assert.equal(c.srv.lastPrompt({ sessionId }), null);
});

test('lastPrompt is the last thing you typed, past slash commands, bookkeeping, side tasks, and queued messages from Claude', () => {
  const { c, sessionId } = withClaude();
  c.transcript(sessionId, [
    user('first'),
    user([text('fix the scrolling')]),
    assistant([text('On it.')]),
    toolResult,
    '{"type":"user", not json',
    user('<system-reminder>noted</system-reminder>'),
    user('a side task', { isSidechain: true }),
    user('caveat', { isMeta: true }),
    user('summary', { isCompactSummary: true }),
    CLEAR,
    queued('from a hook', 'system'),
    { type: 'attachment', attachment: { type: 'other' }, note: 'queued_command' },
  ]);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'fix the scrolling');
});

test('lastPrompt counts a message sent while Claude was working, and cuts a long one', () => {
  const { c, sessionId } = withClaude();
  c.transcript(sessionId, [user('build it'), queued('and add tests')]);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'and add tests');
  const { c: c2, sessionId: id2 } = withClaude();
  c2.transcript(id2, [user('x'.repeat(700))]);
  assert.equal(c2.srv.lastPrompt({ sessionId: id2 }), `${'x'.repeat(600)}…`);
});

test('lastPrompt reads only what was added since the last read, waiting for a line still being written', () => {
  const { c, sessionId } = withClaude();
  const file = c.transcript(sessionId, [user('one')]);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'one');
  assert.equal(c.srv.lastPrompt({ sessionId }), 'one', 'nothing added');
  const line = JSON.stringify(user('two'));
  fs.appendFileSync(file, line.slice(0, 10));
  assert.equal(c.srv.lastPrompt({ sessionId }), 'one', 'half a line');
  fs.appendFileSync(file, `${line.slice(10)}\n${JSON.stringify(assistant([text('ok')]))}\n`);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'two');
  // Earlier bytes are not read again: a prompt written over them is not seen.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"one"', '"uno"'));
  fs.appendFileSync(file, `${JSON.stringify(toolResult)}\n`);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'two');
  // A shorter file is a new one: read from the start.
  fs.writeFileSync(file, `${JSON.stringify(user('three'))}\n`);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'three');
});

test('lastPrompt reads only the last 8 MB of a long transcript, and of a long stretch added at once', () => {
  const { c, sessionId } = withClaude();
  const pad = `${JSON.stringify(toolResult).replace('a b c', 'z'.repeat(1024 * 1024))}\n`;
  const file = c.transcript(sessionId, [user('too early')]);
  fs.appendFileSync(file, pad.repeat(9));
  fs.appendFileSync(file, `${JSON.stringify(user('in reach'))}\n`);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'in reach');
  fs.appendFileSync(file, `${JSON.stringify(user('lost'))}\n${pad.repeat(9)}`);
  assert.equal(c.srv.lastPrompt({ sessionId }), 'in reach', 'kept when nothing newer is in reach');
});
