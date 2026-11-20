// The markdown viewer (/view?space=...&path=...): one file from a space's project, drawn as a page or shown
// as its text. The Mac page opens it in a window of its own. It reads the file again every 2 seconds while
// the window shows, so a file that Claude Code is writing stays current.
const $ = (s) => document.querySelector(s);
const { h } = corralMd;
const query = new URLSearchParams(location.search);
const space = query.get('space') || '';
const rel = query.get('path') || '';
const at = (p) => `space=${encodeURIComponent(space)}&path=${encodeURIComponent(p)}`;
const MODE_KEY = 'corral.view.mode';

let mode = 'rendered';
try { if (localStorage.getItem(MODE_KEY) === 'raw') mode = 'raw'; } catch {}
let shown = null; // the file as last read: {name, text, modified}

const name = rel.split('/').pop();
$('#name').textContent = name;
$('#path').textContent = rel;
if (name) document.title = `${name} · Corral`;

// A note in the bar that goes away after 4 seconds.
let noteTimer;
function note(text) {
  $('#state').textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { $('#state').textContent = ''; }, 4000);
}

// A link to a file that is not markdown opens it on the Mac: in the app saved for its type, or the macOS default.
async function openOnMac(to) {
  const post = (body) => fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space, path: to, ...body }) }).then((r) => r.json());
  let r;
  try {
    r = await post({});
    if (r.needsChoice) r = await post({ app: 'system' });
  } catch { r = { error: 'Could not reach Corral.' }; }
  const file = to.split('/').pop();
  note(r.ok ? `Opened ${file} in ${r.app}.` : `Could not open ${file}: ${r.error}`);
}

// Edit mode (editor.js). Leaving it keeps unsaved edits for the next visit; with none, the editor goes.
let editing = false;
let ed = null;
const markDirty = () => {
  $('#edit').textContent = ed?.dirty() ? 'Edit •' : 'Edit';
  document.title = `${ed?.dirty() ? '• ' : ''}${name} · Corral`;
};
function editorFor() {
  return corralEdit.editor({
    file: shown,
    save: (body) => fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ space, path: rel, ...body }) }).then((r) => r.json()),
    onSaved: (file) => { shown = { ...shown, ...file }; },
    onDirty: markDirty,
  });
}
// Unsaved edits: the browser asks before the window closes or reloads.
window.addEventListener('beforeunload', (e) => { if (ed?.dirty()) e.preventDefault(); });

function draw() {
  $('#rendered').setAttribute('aria-pressed', String(!editing && mode === 'rendered'));
  $('#raw').setAttribute('aria-pressed', String(!editing && mode === 'raw'));
  $('#edit').setAttribute('aria-pressed', String(editing));
  if (!shown) return;
  if (editing) return $('#doc').replaceChildren(ed.el);
  // Rendered: corralMd.fileDoc draws the file with its images and links (markdown.js says where each goes).
  $('#doc').replaceChildren(mode === 'raw' ? h('pre', { class: 'raw' }, shown.text)
    : corralMd.fileDoc(shown.text, { base: `space=${encodeURIComponent(space)}`, rel, openFile: openOnMac, fileTitle: (to) => `Open ${to} on the Mac` }));
}

function setMode(next) {
  mode = next;
  editing = false;
  if (!ed?.dirty()) ed = null;
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  draw();
  scrollTo(0, 0);
}
$('#rendered').onclick = () => setMode('rendered');
$('#raw').onclick = () => setMode('raw');
$('#edit').onclick = () => {
  if (!shown) return;
  editing = true;
  ed ||= editorFor();
  draw();
  ed.focus();
};

// Reads the file. After the first read it asks only for a file changed since then, and keeps the place on
// the page when it draws a new version. A read that fails leaves the last version up and says so. The first
// version drawn goes to the heading the address names, if it names one.
let failing = false;
async function refresh() {
  let r;
  try { r = await (await fetch(`/api/view?${at(rel)}${shown ? `&since=${shown.modified}` : ''}`)).json(); } catch { r = { error: 'Could not reach Corral.' }; }
  if (r.error) {
    if (shown) { failing = true; clearTimeout(noteTimer); $('#state').textContent = `Could not read it again: ${r.error}`; }
    else $('#doc').replaceChildren(h('p', { class: 'note' }, r.error));
    return;
  }
  if (failing) { failing = false; $('#state').textContent = ''; }
  if (r.unchanged) return;
  const first = !shown;
  const y = window.scrollY;
  shown = r;
  ed?.diskChanged(r);
  if (editing) return; // the editor keeps its text; diskChanged has told it
  draw();
  if (!first) return scrollTo(0, y);
  corralMd.jump($('#doc'), location.hash.slice(1));
}

corralTheme.button($('#theme')); // Auto, Light, or Dark, shared with the Mac page (theme.js)
draw();
refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 2000);
