// Past Claude Code conversations for a project folder, and a conversation written out as Markdown or HTML.
//
// Claude Code keeps each conversation as ~/.claude/projects/<folder>/<id>.jsonl, where <folder> is the
// project path with every character other than a letter or digit turned into "-". Some folders also carry a
// ".<16 hex digits>" suffix (seen November 23, 2026 on 4 of 322 folders), so both forms are read.
// A conversation's title is the newest "ai-title" line Claude Code wrote for it; without one, the first
// prompt you typed stands in.
const fs = require('fs');
const path = require('path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encode = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

// The folders under `projects` that hold conversations started in `dir`.
function projectDirs(projects, dir) {
  const name = encode(dir);
  try {
    return fs.readdirSync(projects).filter((d) => d === name || new RegExp(`^${name}\\.[0-9a-f]{16}$`).test(d)).map((d) => path.join(projects, d));
  } catch { return []; }
}

// `max` bytes from the start (head) or the end of a file, as whole lines.
function readLines(file, max, head) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(size, max));
  fs.readSync(fd, buf, 0, buf.length, head ? 0 : size - buf.length);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (buf.length < size) { if (head) lines.pop(); else lines.shift(); } // a line cut by the read
  return lines;
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const cut = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);

// One conversation's row: its title, first prompt, start and last-change times, and size. Cached by the
// file's size and time, since a folder's list is asked for each time it is opened.
const rowCache = new Map();
function summary(file, typedText) {
  const { size, mtimeMs } = fs.statSync(file);
  const hit = rowCache.get(file);
  if (hit?.size === size && hit.mtimeMs === mtimeMs) return hit.row;
  let first = null, started = null;
  for (const line of readLines(file, 256 * 1024, true)) {
    if (!line.includes('"user"')) continue;
    const d = parse(line);
    if (d?.type !== 'user' || d.isMeta || d.isSidechain) continue;
    started = started || d.timestamp || null;
    const t = typedText(d.message?.content);
    if (t && t !== '/clear') { first = t; break; } // a conversation /clear started begins with the command
  }
  let title = null;
  const tail = readLines(file, 256 * 1024, false);
  for (let i = tail.length - 1; i >= 0 && !title; i--) {
    if (tail[i].includes('"ai-title"')) title = parse(tail[i])?.aiTitle || null;
  }
  const row = {
    id: path.basename(file, '.jsonl'), title: cut(title || first || 'Untitled conversation', 160),
    first: first ? cut(first, 400) : null, started, updated: mtimeMs, size,
  };
  rowCache.set(file, { size, mtimeMs, row });
  return row;
}

// Every conversation started in `dir`, newest first, the most recent `limit` of them.
function list(projects, dir, typedText, limit = 200) {
  const files = [];
  for (const d of projectDirs(projects, dir)) {
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.jsonl') || !UUID.test(name.slice(0, -6))) continue;
      const f = path.join(d, name);
      try { files.push({ f, at: fs.statSync(f).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.at - a.at);
  const rows = [];
  for (const { f } of files.slice(0, limit)) { try { rows.push(summary(f, typedText)); } catch {} }
  return { conversations: rows, more: files.length > limit };
}

// The file of conversation `id` started in `dir`, or null. The id must look like one Claude Code makes.
function fileFor(projects, dir, id) {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  for (const d of projectDirs(projects, dir)) {
    const f = path.join(d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// A message's time on the Mac's clock, as 2026-11-23 09:47.
const when = (at) => {
  const d = new Date(at ?? NaN);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const WHO = { you: 'You', claude: 'Claude', note: 'Note' };

// The conversation as Markdown: a heading, a line naming where and when, then each message under a heading.
function markdown(meta, items) {
  const out = [`# ${meta.title}`, '', `Claude Code conversation \`${meta.id}\` in \`${meta.dir}\`, exported by Corral${meta.cut ? ' (the most recent part only)' : ''}.`, ''];
  for (const it of items) { const t = when(it.at); out.push(`## ${WHO[it.who]}${t ? ` (${t})` : ''}`, '', it.text, ''); }
  return out.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The conversation as one HTML page with no scripts or outside files. Messages keep their line breaks.
function html(meta, items) {
  const rows = items.map((it) => `<section class="${it.who}"><h2>${WHO[it.who]}${when(it.at) ? ` <time>${esc(when(it.at))}</time>` : ''}</h2><div class="text">${esc(it.text)}</div></section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(meta.title)}</title>
<style>
:root { color-scheme: light dark; --bg:#fdfcff; --text:#24202d; --muted:#665e7a; --you:#efeaff; --rule:#ddd6f0; }
@media (prefers-color-scheme: dark) { :root { --bg:#100e15; --text:#e8e4f2; --muted:#a59cbc; --you:#221d33; --rule:#332c47; } }
body { margin:0 auto; max-width:820px; padding:24px 16px 48px; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system, system-ui, sans-serif; }
h1 { font-size:22px; margin:0 0 4px; } .sub { color:var(--muted); margin:0 0 24px; font-size:13px; }
section { border-top:1px solid var(--rule); padding:12px 0; } section.you { background:var(--you); padding:12px; border-radius:8px; border:0; margin:8px 0; }
h2 { font-size:13px; margin:0 0 6px; text-transform:uppercase; letter-spacing:.04em; } time { color:var(--muted); font-weight:400; text-transform:none; letter-spacing:0; }
.text { white-space:pre-wrap; overflow-wrap:anywhere; } section.note .text { color:var(--muted); font-style:italic; }
</style></head><body>
<h1>${esc(meta.title)}</h1>
<p class="sub">Claude Code conversation <code>${esc(meta.id)}</code> in <code>${esc(meta.dir)}</code>, exported by Corral${meta.cut ? ' (the most recent part only)' : ''}.</p>
${rows}
</body></html>
`;
}

// A safe file name for a download: the title's letters, digits, and dashes, then the format.
const fileName = (title, format) => `${(title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation')}.${format}`;

module.exports = { UUID, when, encode, projectDirs, readLines, summary, list, fileFor, markdown, html, fileName, rowCache };
