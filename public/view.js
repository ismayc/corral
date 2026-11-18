// The markdown viewer (/view?space=...&path=...): one file from a space's project, drawn as a page or shown
// as its text. The Mac page opens it in a window of its own. It reads the file again every 2 seconds while
// the window shows, so a file that Claude Code is writing stays current.
const $ = (s) => document.querySelector(s);
const { h, markdown } = corralMd;
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

// ---- Images and links in the file ----
// A path written in the file, as a path in the project: relative to the file's folder, or to the project's
// folder when it starts with /. Null for one that leaves the project or names nothing.
function inProject(target) {
  let p;
  try { p = decodeURIComponent(target.replace(/[?#].*$/, '')); } catch { return null; }
  const parts = p.startsWith('/') ? [] : rel.split('/').slice(0, -1);
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') parts.push(seg);
    else if (!parts.pop()) return null;
  }
  return parts.join('/') || null;
}
const OTHER_PLACE = /^([a-z][a-z0-9+.-]*:|\/\/)/i; // an address with a scheme, or //host

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

corralMd.local = {
  // Web and mail addresses open in a new tab. #heading jumps on this page. Another markdown file of the
  // project opens here, and any other file of the project opens on the Mac.
  link(target) {
    if (/^(https?:\/\/|mailto:)/i.test(target)) return { href: target, target: '_blank', rel: 'noopener' };
    if (OTHER_PLACE.test(target)) return null;
    if (target.startsWith('#')) return { href: target.toLowerCase() };
    const to = inProject(target);
    if (!to) return null;
    if (/\.(md|markdown|qmd|rmd)$/i.test(to)) return { href: `/view?${at(to)}${(target.match(/#.*$/) || [''])[0].toLowerCase()}` };
    return { href: `#${to}`, title: `Open ${to} on the Mac`, onclick: (e) => { e.preventDefault(); openOnMac(to); } };
  },
  // An image of the project comes from Corral; one on the web loads only over https.
  image(target) {
    if (/^https:\/\//i.test(target)) return target;
    if (OTHER_PLACE.test(target)) return null;
    const to = inProject(target);
    return to && `/api/image?${at(to)}`;
  },
};

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
  // Each heading gets the id GitHub gives it, so a #heading link has a place to go.
  const used = new Map();
  for (const hd of $('#doc').querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const id = hd.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
    const n = used.get(id) || 0;
    used.set(id, n + 1);
    hd.id = n ? `${id}-${n}` : id;
  }
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
  draw();
  if (!first) return scrollTo(0, y);
  let id = location.hash.slice(1);
  try { id = decodeURIComponent(id); } catch {}
  if (id) document.getElementById(id)?.scrollIntoView();
}

draw();
refresh();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 2000);
