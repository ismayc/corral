// The markdown viewer (/view?space=...&path=...): one file from a space's project, drawn as a page or shown
// as its text. The Mac page opens it in a window of its own. It reads the file again every 2 seconds while
// the window shows, so a file that Claude Code is writing stays current.
const $ = (s) => document.querySelector(s);
const { h, markdown } = corralMd;
const query = new URLSearchParams(location.search);
const where = `space=${encodeURIComponent(query.get('space') || '')}&path=${encodeURIComponent(query.get('path') || '')}`;
const MODE_KEY = 'corral.view.mode';

let mode = 'rendered';
try { if (localStorage.getItem(MODE_KEY) === 'raw') mode = 'raw'; } catch {}
let shown = null; // the file as last read: {name, text, modified}

const name = (query.get('path') || '').split('/').pop();
$('#name').textContent = name;
$('#path').textContent = query.get('path') || '';
if (name) document.title = `${name} · Corral`;

// Front matter (a YAML block between --- lines at the top) is shown as it is written, above the page.
function parts(text) {
  const m = text.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: null, body: text };
}

function draw() {
  $('#rendered').setAttribute('aria-pressed', String(mode === 'rendered'));
  $('#raw').setAttribute('aria-pressed', String(mode === 'raw'));
  if (!shown) return;
  if (mode === 'raw') return $('#doc').replaceChildren(h('pre', { class: 'raw' }, shown.text));
  const { front, body } = parts(shown.text.replace(/\r\n/g, '\n'));
  $('#doc').replaceChildren(h('div', { class: 'md' }, front === null ? null : h('pre', { class: 'front' }, front), markdown(body)));
}

function setMode(next) {
  mode = next;
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  draw();
  scrollTo(0, 0);
}
$('#rendered').onclick = () => setMode('rendered');
$('#raw').onclick = () => setMode('raw');

// Reads the file. After the first read it asks only for a file changed since then, and keeps the place on
// the page when it draws a new version. A read that fails leaves the last version up and says so.
async function refresh() {
  let r;
  try { r = await (await fetch(`/api/view?${where}${shown ? `&since=${shown.modified}` : ''}`)).json(); } catch { r = { error: 'Could not reach Corral.' }; }
  if (r.error) {
    if (shown) $('#state').textContent = `Could not read it again: ${r.error}`;
    else $('#doc').replaceChildren(h('p', { class: 'note' }, r.error));
    return;
  }
  $('#state').textContent = '';
  if (r.unchanged) return;
  const y = window.scrollY;
  shown = r;
  draw();
  scrollTo(0, y);
}

draw();
refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 2000);
