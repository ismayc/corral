const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FILE = path.join(__dirname, '..', '..', 'scripts', 'sessions-page.js');
const P = require(FILE);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corral-sessions-page-'));
const BACKUP = {
  version: 1,
  savedAt: '2026-11-01T16:17:55.817Z',
  windows: [
    { id: 'a', label: 'corral', cwd: '/r/corral', claudeCwd: '/r/corral/sub', claudeSession: 'x', resumeCommand: "cd '/r/corral/sub' && claude --resume x" },
    { id: 'b', label: 'w9 <b>', cwd: '/r/w9' },
    { id: 'c', cwd: 5 },
    null,
  ],
};

test('esc escapes the five HTML characters', () => {
  assert.equal(P.esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('when formats a date and names a bad one', () => {
  assert.match(P.when('2026-11-01T16:17:55.817Z'), /November 1, 2026/);
  assert.equal(P.when('nope'), 'an unknown time');
});

test('render lists each window with its folder and its resume command', () => {
  const html = P.render(BACKUP);
  assert.match(html, /3 windows, saved November 1, 2026/);
  assert.match(html, /<div class="name">corral<\/div>/);
  assert.match(html, /<div class="folder">\/r\/corral\/sub<\/div>/);
  assert.match(html, /<code>cd &#39;\/r\/corral\/sub&#39; &amp;&amp; claude --resume x<\/code>/);
  assert.match(html, /data-cmd="cd &#39;\/r\/corral\/sub&#39; &amp;&amp; claude --resume x"/);
  assert.match(html, /w9 &lt;b&gt;/);
  assert.match(html, /<div class="folder">\/r\/w9<\/div>/);
  assert.match(html, /\(no name\)/);
  assert.match(html, /<div class="folder"><\/div>/);
  assert.equal((html.match(/No Claude conversation/g) || []).length, 2);
});

test('render says "1 window" and copes with a missing list', () => {
  assert.match(P.render({ savedAt: 'x', windows: [{ label: 'one' }] }), /1 window, saved an unknown time/);
  assert.match(P.render(null), /0 windows, saved an unknown time/);
});

test('main writes the page only for a readable backup with windows', () => {
  const dir = tmp();
  const src = path.join(dir, 'open-sessions.json');
  const out = path.join(dir, 'page.html');
  assert.equal(P.main([]), false);
  assert.equal(P.main([src, out]), false);
  fs.writeFileSync(src, '{bad');
  assert.equal(P.main([src, out]), false);
  fs.writeFileSync(src, 'null');
  assert.equal(P.main([src, out]), false);
  fs.writeFileSync(src, JSON.stringify({ windows: [] }));
  assert.equal(P.main([src, out]), false);
  assert.equal(fs.existsSync(out), false);
  fs.writeFileSync(src, JSON.stringify(BACKUP));
  assert.equal(P.main([src, out]), true);
  assert.match(fs.readFileSync(out, 'utf8'), /claude --resume x/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('run as a command, it exits 0 after writing the page and 1 when there is nothing to write', () => {
  const dir = tmp();
  const src = path.join(dir, 'open-sessions.json');
  const out = path.join(dir, 'page.html');
  assert.equal(spawnSync(process.execPath, [FILE, src, out]).status, 1);
  fs.writeFileSync(src, JSON.stringify(BACKUP));
  assert.equal(spawnSync(process.execPath, [FILE, src, out]).status, 0);
  assert.ok(fs.existsSync(out));
});
