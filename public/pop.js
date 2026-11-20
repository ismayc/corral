// The pop-out (/pop?id=<window>): one Corral window in a browser window of its own. Its project's files are
// on the left, and the panel can be hidden; the choice is kept per space. A file clicked there opens in a tab
// on the right while the terminal stays in view: markdown drawn (or as text), images, PDFs, and any other text
// file as text. A file Corral cannot show offers to open on the Mac. The open tabs are kept per window, and
// markdown and text tabs read their file again every 2 seconds while the page shows.
const $ = (s) => document.querySelector(s);
const { h } = corralMd;
const id = new URLSearchParams(location.search).get('id') || '';
const at = (p) => `window=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`;
const getJson = (url, opts = {}) => fetch(url, {
  ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then((r) => r.json());

function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }

const MD = /\.(md|markdown|qmd|rmd)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const kindOf = (rel) => (MD.test(rel) ? 'md' : IMAGE.test(rel) ? 'image' : /\.pdf$/i.test(rel) ? 'pdf' : 'text');
const nameOf = (rel) => rel.split('/').pop();

let toastTimer;
function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

// ---- Menus (a link in the terminal, a right-clicked file). One at a time; Escape or a click elsewhere closes it.
let menu = null;
function closeMenu() { menu?.remove(); menu = null; }
function showMenu(head, items, x, y) {
  closeMenu();
  menu = h('div', { class: 'menu' }, h('div', { class: 'mhead' }, head),
    ...items.map(([text, go]) => h('button', { type: 'button', onclick: () => { closeMenu(); go?.(); } }, text)));
  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 248))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector('button').focus();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); });

// ---- The file panel, shown or hidden per space (a window with no space: per folder).
let info = null;
const filesKey = () => `corral.pop.files.${info.space || info.cwd}`;
function showFiles(on) {
  $('#files').hidden = !on;
  $('#filesbtn').setAttribute('aria-pressed', String(on));
  $('#filesbtn').title = on ? 'Hide the file panel for this space' : 'Show the file panel for this space';
}
$('#filesbtn').onclick = () => {
  const on = $('#files').hidden;
  store(filesKey(), on);
  showFiles(on);
};
$('#hidden').onchange = () => fillTree($('#tree'), '');
$('#reload').onclick = () => fillTree($('#tree'), '');

// Lists one folder. Names go in as text, never HTML, since file names are untrusted.
async function fillTree(box, rel) {
  box.replaceChildren(h('div', { class: 'note' }, 'Loading...'));
  let r;
  try { r = await getJson(`/api/files?window=${encodeURIComponent(id)}&path=${encodeURIComponent(rel)}&hidden=${$('#hidden').checked ? 1 : 0}`); } catch { r = { error: 'Could not load files.' }; }
  if (r.error) return box.replaceChildren(h('div', { class: 'note' }, r.error));
  box.replaceChildren(...(r.entries.length ? [] : [h('div', { class: 'note' }, '(empty)')]));
  for (const e of r.entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    const ic = h('span', { class: 'ic' }, e.type === 'dir' ? '▸' : '');
    const row = h('div', { class: `node ${e.type}`, 'data-path': path }, ic, h('span', {}, e.name), e.link ? h('span', { class: 'lk' }, '↪') : null);
    box.append(row);
    if (e.type === 'dir') {
      const kids = h('div', { style: 'padding-left:14px' });
      box.append(kids);
      row.onclick = () => {
        const opening = !kids.childNodes.length;
        ic.textContent = opening ? '▾' : '▸';
        if (opening) fillTree(kids, path); else kids.replaceChildren();
      };
    } else {
      row.title = 'Click to open in a tab. Right-click for more.';
      row.onclick = () => openTab(path);
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        showMenu(e.name, [['Open in a tab', () => openTab(path)], ['Open on the Mac', () => openOnMac(path)],
          ['Show in Finder', () => openOnMac(path, 'finder')]], ev.clientX, ev.clientY);
      };
    }
  }
  if (r.truncated) box.append(h('div', { class: 'note' }, 'List cut off at 1000 entries.'));
  markOpen();
}

// On the Mac: the app saved for the file's type, else the macOS default. A markdown file saved to open in
// Corral opens in a tab here instead.
async function openOnMac(rel, app) {
  const post = (body) => getJson('/api/open', { method: 'POST', body: { window: id, path: rel, ...body } });
  let r;
  try {
    r = await post(app ? { app } : {});
    if (r.needsChoice) r = await post({ app: 'system' });
  } catch { r = { error: 'Could not reach Corral.' }; }
  if (r.view) return openTab(rel);
  toast(r.ok ? `Opened ${nameOf(rel)} in ${r.app}.` : `Could not open ${nameOf(rel)}: ${r.error}`);
}

// ---- Tabs. A tab is {rel, kind, shown, error, v}; `shown` is the file as last read, `v` makes an image load again.
const TABS_KEY = `corral.pop.tabs.${id}`;
const MODE_KEY = 'corral.view.mode'; // shared with the markdown viewer
let mode = load(MODE_KEY, 'rendered') === 'raw' ? 'raw' : 'rendered';
const tabs = [];
let active = null;
const saveTabs = () => store(TABS_KEY, { open: tabs.map((t) => t.rel), active: active?.rel || null });
const markOpen = () => document.querySelectorAll('#tree .node.file').forEach((n) => n.classList.toggle('on', n.dataset.path === active?.rel));

function openTab(rel, heading) {
  let t = tabs.find((x) => x.rel === rel);
  if (!t) {
    t = { rel, kind: kindOf(rel), shown: null, error: null, v: 0 };
    tabs.push(t);
  }
  t.heading = heading;
  activate(t);
}

function activate(t) {
  active = t;
  saveTabs();
  drawTabs();
  drawPane(true);
  if (t.kind === 'md' || t.kind === 'text') refresh(t);
}

function closeTab(t) {
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (active === t) {
    active = tabs[Math.min(i, tabs.length - 1)] || null;
    if (active) return activate(active);
  }
  saveTabs();
  drawTabs();
  drawPane(true);
}

function drawTabs() {
  const any = tabs.length > 0;
  $('#tabpane').hidden = $('#split').hidden = !any;
  $('#tabs').replaceChildren(...tabs.map((t) => {
    const x = h('button', { class: 'tx', type: 'button', title: 'Close this tab', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, '×');
    return h('div', { class: 'tab', role: 'tab', title: t.rel, 'aria-selected': String(t === active), onclick: () => activate(t),
      onauxclick: (e) => { if (e.button === 1) closeTab(t); } }, h('span', { class: 'tn' }, nameOf(t.rel)), x);
  }));
  markOpen();
  document.title = `${active ? `${nameOf(active.rel)} · ` : ''}${info.label}`;
}

// Draws the active tab. top: start at the top of the file (a new tab) rather than keep the place (a new version).
function drawPane(top) {
  const pane = $('#pane');
  const y = pane.scrollTop;
  const t = active;
  if (!t) return pane.replaceChildren();
  $('#tabpath').textContent = t.rel;
  $('#mdmode').hidden = t.kind !== 'md';
  $('#tabreload').hidden = t.kind === 'pdf';
  $('#rendered').setAttribute('aria-pressed', String(mode === 'rendered'));
  $('#raw').setAttribute('aria-pressed', String(mode === 'raw'));
  pane.replaceChildren(body(t));
  pane.scrollTop = top ? 0 : y;
  if (top && t.heading && t.shown) corralMd.jump(pane, t.heading);
}

function body(t) {
  if (t.kind === 'image') return h('div', { class: 'imgbox' }, h('img', { src: `/api/image?${at(t.rel)}${t.v ? `&v=${t.v}` : ''}`, alt: t.rel }));
  if (t.kind === 'pdf') return h('iframe', { src: `/api/pdf?${at(t.rel)}`, title: t.rel });
  if (!t.shown) {
    if (!t.error) return h('p', { class: 'note' }, 'Loading...');
    return h('p', { class: 'note' }, t.error, h('button', { type: 'button', onclick: () => openOnMac(t.rel) }, 'Open on the Mac'));
  }
  if (t.kind === 'text' || mode === 'raw') return h('pre', { class: 'raw' }, t.shown.text);
  return h('div', { class: 'doc' }, corralMd.fileDoc(t.shown.text, {
    base: `window=${encodeURIComponent(id)}`, rel: t.rel,
    openMd: (to, heading) => openTab(to, heading), openFile: (to) => openTab(to), fileTitle: (to) => `Open ${to} in a tab`,
  }));
}

// Reads a markdown or text tab. After the first read it asks only for a newer version. A read that fails
// leaves the last version up and says so in the bar.
async function refresh(t) {
  let r;
  const route = t.kind === 'md' ? '/api/view' : '/api/text';
  try { r = await getJson(`${route}?${at(t.rel)}${t.shown ? `&since=${t.shown.modified}` : ''}`); } catch { r = { error: 'Could not reach Corral.' }; }
  if (r.error) {
    if (t.shown) { if (t === active) $('#state').textContent = `Could not read ${nameOf(t.rel)} again: ${r.error}`; return; }
    t.error = r.error;
  } else {
    if (t === active) $('#state').textContent = '';
    if (r.unchanged) return;
    const first = !t.shown;
    t.shown = r;
    if (t !== active) return;
    return drawPane(first);
  }
  if (t === active) drawPane(true);
}

$('#rendered').onclick = () => { mode = 'rendered'; store(MODE_KEY, mode); drawPane(true); };
$('#raw').onclick = () => { mode = 'raw'; store(MODE_KEY, mode); drawPane(true); };
$('#tabreload').onclick = () => {
  if (active.kind === 'image') { active.v = Date.now(); return drawPane(false); }
  active.shown = null;
  active.error = null;
  drawPane(true);
  refresh(active);
};
$('#tabmac').onclick = () => openOnMac(active.rel);
setInterval(() => {
  if (document.visibilityState === 'visible' && active && (active.kind === 'md' || active.kind === 'text')) refresh(active);
}, 2000);

// ---- The split between the terminal and the tabs: drag it, double-click to reset. Kept for every pop-out.
const SPLIT = { def: 0.5, min: 0.2, max: 0.8 };
function setSplit(f) {
  f = Math.min(SPLIT.max, Math.max(SPLIT.min, Number(f) || SPLIT.def));
  document.documentElement.style.setProperty('--tw', `${(f * 100).toFixed(1)}%`);
  return f;
}
setSplit(load('corral.pop.split', SPLIT.def));
$('#split').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const split = $('#split');
  split.setPointerCapture(e.pointerId);
  split.classList.add('drag');
  const box = $('#main').getBoundingClientRect();
  const at = (ev) => (box.right - ev.clientX) / Math.max(1, box.width - ($('#files').hidden ? 0 : $('#files').offsetWidth));
  const move = (ev) => setSplit(at(ev));
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', (ev) => {
    split.removeEventListener('pointermove', move);
    split.classList.remove('drag');
    store('corral.pop.split', setSplit(at(ev)));
  }, { once: true });
});
$('#split').addEventListener('dblclick', () => store('corral.pop.split', setSplit(SPLIT.def)));

// ---- The terminal: the Mac page's own connection to the window, so the window takes this page's size.
let term, fit, ws, muted = false;
function linkMenu(e, uri) {
  setTimeout(() => showMenu(`Open this link? ${uri}`, [['Open in browser', () => window.open(uri, '_blank', 'noopener')], ['Cancel']], e.clientX, e.clientY + 4), 0);
}
function openTerm() {
  term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: 13, cursorBlink: true,
    scrollback: 5000, macOptionClickForcesSelection: true, linkHandler: { activate: linkMenu },
    theme: { background: '#100e15', cursor: '#c9c1ff', selectionBackground: '#4d4366' } });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon(linkMenu));
  term.open($('#term'));
  // tmux sends a drag selection as OSC 52 on release: put it on the clipboard (writes only, never replays).
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (muted || !b64 || b64 === '?') return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      navigator.clipboard.writeText(text).then(() => toast(text.length <= 60 && !text.includes('\n') ? `Copied: ${text}` : `Copied ${text.length} characters.`),
        () => toast('Could not copy. Option-drag to select it, then press Cmd-C.'));
    } catch {}
    return true;
  });
  term.onData((d) => !muted && ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'in', d })));
  // Cmd-Backspace erases to the start of the line, as on the Mac page.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key !== 'Backspace' || !e.metaKey || e.altKey || e.ctrlKey) return true;
    if (e.type === 'keydown') term.input('\x15');
    e.preventDefault();
    return false;
  });
  term.onResize(({ cols, rows }) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', cols, rows })));
  new ResizeObserver(() => fit.fit()).observe($('#term'));
  connect();
  term.focus();
}

function connect() {
  ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?id=${encodeURIComponent(id)}`); // https gives wss
  let first = true;
  ws.onopen = () => { $('#state').textContent = ''; term.reset(); fit.fit(); ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
  // The first message replays saved output; answers xterm gives to old queries in it must not reach the shell.
  ws.onmessage = (e) => {
    if (!first) return term.write(e.data);
    first = false;
    muted = true;
    term.write(e.data, () => { muted = false; });
  };
  ws.onclose = async () => {
    const r = await getJson('/api/sessions').catch(() => null);
    if (r && !r.sessions.some((s) => s.id === id && !s.exited)) { $('#state').textContent = 'This window has closed.'; return; }
    $('#state').textContent = 'Reconnecting...';
    setTimeout(connect, 1500);
  };
}

async function start() {
  const r = await getJson('/api/sessions').catch(() => null);
  info = r?.sessions.find((s) => s.id === id && !s.exited) || null;
  if (!info) {
    $('#label').textContent = 'Corral';
    $('#files').hidden = true;
    $('#filesbtn').hidden = true;
    $('#term').append(h('p', { class: 'note' }, r ? 'This window is not open any more. Open it again from Corral.' : 'Could not reach Corral.'));
    return;
  }
  $('#label').textContent = info.label;
  $('#cwd').textContent = info.cwd.replace(/^\/Users\/[^/]+/, '~');
  showFiles(load(filesKey(), true));
  fillTree($('#tree'), '');
  openTerm();
  const saved = load(TABS_KEY, { open: [], active: null });
  for (const rel of saved.open || []) tabs.push({ rel, kind: kindOf(rel), shown: null, error: null, v: 0 });
  const back = tabs.find((t) => t.rel === saved.active) || tabs.at(-1);
  if (back) activate(back); else drawTabs();
  for (const t of tabs) if (t !== back && (t.kind === 'md' || t.kind === 'text')) refresh(t);
}
start();
