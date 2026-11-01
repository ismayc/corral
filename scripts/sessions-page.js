// Usage: node scripts/sessions-page.js <open-sessions.json> <out.html>
// Turns Corral's backup of the open windows into a page that lists each window, its folder, and the command
// that resumes its Claude conversation. scripts/corral-launcher.sh runs it before it starts the server, so the
// page shows the windows from before a restart (the server rewrites the backup every 30 seconds once it runs).
const fs = require('fs');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function when(iso) {
  const d = new Date(typeof iso === 'string' ? iso : NaN);
  return Number.isNaN(d.getTime()) ? 'an unknown time' : d.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
}

function render(backup) {
  const windows = backup && Array.isArray(backup.windows) ? backup.windows.filter((w) => w && typeof w === 'object') : [];
  const rows = windows.map((w) => {
    const cmd = typeof w.resumeCommand === 'string' ? w.resumeCommand : '';
    const folder = typeof w.claudeCwd === 'string' ? w.claudeCwd : typeof w.cwd === 'string' ? w.cwd : '';
    return `<li>
  <div class="name">${esc(typeof w.label === 'string' ? w.label : '(no name)')}</div>
  <div class="folder">${esc(folder)}</div>
  ${cmd ? `<div class="cmd"><code>${esc(cmd)}</code><button type="button" data-cmd="${esc(cmd)}">Copy</button></div>` : '<div class="none">No Claude conversation in this window</div>'}
</li>`;
  }).join('\n');
  const n = windows.length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corral Windows Before Restart</title>
<style>
:root { --bg: #f7f7f5; --card: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --line: #deded9; --code: #f0efe9; --accent: #3a5ccc; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --card: #222226; --text: #ececf0; --muted: #a0a0a8; --line: #34343a; --code: #2c2c31; --accent: #8ea6ff; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
li { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.name { font-weight: 600; }
.folder, .none { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.cmd { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
code { flex: 1; background: var(--code); border-radius: 6px; padding: 6px 8px; font: 12px/1.4 ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
button { border: 1px solid var(--accent); color: var(--accent); background: none; border-radius: 6px; padding: 5px 10px; font: inherit; font-size: 13px; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Corral windows before the restart</h1>
<p class="sub">${n} window${n === 1 ? '' : 's'}, saved ${esc(when(backup && backup.savedAt))}. Run a command in a terminal to resume that conversation.</p>
<ul>
${rows}
</ul>
</main>
<script>
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.cmd).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); });
});
</script>
</body>
</html>
`;
}

// Writes the page. Returns false (and writes nothing) when the backup is missing, unreadable, or empty.
function main(argv) {
  const [src, out] = argv;
  if (!src || !out) return false;
  let backup;
  try { backup = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { return false; }
  if (!backup || !Array.isArray(backup.windows) || !backup.windows.length) return false;
  fs.writeFileSync(out, render(backup), { mode: 0o600 });
  return true;
}

module.exports = { render, main, esc, when };
if (require.main === module) process.exitCode = main(process.argv.slice(2)) ? 0 : 1;
