// Finding a file dropped on a Mac window from its name, size, and modified time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadServer, listen } = require('../helpers/server');

function put(file, text, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return { size: Buffer.byteLength(text), modified: mtime };
}
const T = 1791390000000;

test('locateFile finds a file in the usual folders when its size and time match', async () => {
  const h = loadServer({ exec: { mdfind: () => { throw new Error('should not run'); } } });
  const dl = path.join(h.home, 'Downloads', 'key.json');
  const f = put(dl, '{"a":1}', T);
  assert.equal(await h.srv.locateFile('key.json', f.size, f.modified + 900), dl); // times within 2 s count
  const top = path.join(h.home, 'top.txt');
  const g = put(top, 'x', T);
  assert.equal(await h.srv.locateFile('top.txt', g.size, g.modified), top);
});

test('locateFile asks Spotlight for a file elsewhere, and takes only an exact name with the same size and time', async () => {
  let asked;
  const deep = (h) => path.join(h.home, 'repos', 'p', 'data.csv');
  const h = loadServer({ exec: { mdfind: (args) => { asked = args; return [`${deep(h)}.bak`, path.join(h.home, 'old', 'data.csv'), deep(h), ''].join('\n'); } } });
  put(path.join(h.home, 'Downloads', 'data.csv'), 'a different file', T); // same name, wrong size
  put(path.join(h.home, 'old', 'data.csv'), '1,2', T - 60000); // same size, wrong time
  const f = put(deep(h), '1,2', T);
  assert.equal(await h.srv.locateFile('data.csv', f.size, f.modified), deep(h));
  assert.deepEqual(asked, ['-onlyin', h.home, '-name', 'data.csv']);
});

test('locateFile answers null for a bad question, a failed or empty search, or a folder', async () => {
  let reply = new Error('mdfind failed');
  const h = loadServer({ exec: { mdfind: () => { if (reply instanceof Error) throw reply; return reply; } } });
  assert.equal(await h.srv.locateFile(null, 1, T), null);
  assert.equal(await h.srv.locateFile('a/b', 1, T), null);
  assert.equal(await h.srv.locateFile('x', NaN, T), null);
  assert.equal(await h.srv.locateFile('x', 1, NaN), null);
  assert.equal(await h.srv.locateFile('x', 1, T), null);
  reply = '';
  assert.equal(await h.srv.locateFile('x', 1, T), null);
  fs.mkdirSync(path.join(h.home, 'Desktop', 'folder'), { recursive: true });
  assert.equal(await h.srv.locateFile('folder', 64, T), null);
});

test('GET /api/locate answers the Mac\'s own page with a path or 404, and refuses the tailnet', async (t) => {
  const h = loadServer({ exec: { mdfind: () => '' } });
  const http = await listen(h.srv);
  t.after(() => http.close());
  const f = put(path.join(h.home, 'Desktop', 'a b.txt'), 'hi', T);
  const q = (name) => `/api/locate?${new URLSearchParams({ name, size: f.size, modified: f.modified })}`;
  const ok = await http.request('GET', q('a b.txt'));
  assert.deepEqual([ok.status, ok.json], [200, { path: path.join(h.home, 'Desktop', 'a b.txt') }]);
  const missing = await http.request('GET', q('nope.txt'));
  assert.deepEqual([missing.status, missing.json], [404, { error: 'not found on this Mac' }]);
  h.srv.state.tailnet = { host: 'mac.tail1234.ts.net:8443', origin: 'https://mac.tail1234.ts.net:8443', logins: new Set(['me@example.com']) };
  const remote = await http.request('GET', q('a b.txt'), { headers: { host: 'mac.tail1234.ts.net:8443', 'tailscale-user-login': 'me@example.com' } });
  assert.deepEqual([remote.status, remote.json], [403, { error: 'only from this Mac' }]);
});
