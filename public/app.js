// A phone gets the phone page; ?desktop keeps this one.
if (matchMedia('(pointer: coarse) and (max-width: 760px)').matches && !new URLSearchParams(location.search).has('desktop')) location.replace('/m');
const $ = (s) => document.querySelector(s);
// The plan's usage limits strip (limits.js), looked up once: a poll that ends after the page is gone still paints.
const limitsStrip = window.CorralLimits;
const limitsEl = $('#limits');
const open = new Map(); // session id -> {term, fit, ws, el, info}
let focusedId = null;

const api = (url, opts = {}) => fetch(url, {
  ...opts, headers: { 'Content-Type': 'application/json' },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then((r) => r.json());

function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
// Reads the earlier 'webterm.' key when the 'corral.' one is not set yet, so settings survive the rename.
function load(k, d) {
  try {
    const v = localStorage.getItem(k) ?? localStorage.getItem(k.replace(/^corral\./, 'webterm.'));
    return v === null ? d : JSON.parse(v) ?? d;
  } catch { return d; }
}

// ---- Layouts. Like Sash, a layout is a list of zones, each [x, y, w, h] as fractions of the area. ----
// rowsOf([2,1]) = two zones on top, one across the bottom.
const rowsOf = (counts) => {
  const z = [], h = 1 / counts.length;
  counts.forEach((c, r) => { for (let i = 0; i < c; i++) z.push([i / c, r * h, 1 / c, h]); });
  return z;
};
const LAYOUTS = {
  full:      { name: 'Maximize',    zones: rowsOf([1]) },
  halves:    { name: 'Halves',      zones: rowsOf([2]) },
  stacked:   { name: 'Stacked',     zones: [[0, 0, 1, .5], [0, .5, 1, .5]] },
  thirds:    { name: 'Thirds',      zones: rowsOf([3]) },
  quarters:  { name: 'Quarters',    zones: rowsOf([2, 2]) },
  mainright: { name: 'Main + 2',    zones: [[0, 0, 2/3, 1], [2/3, 0, 1/3, .5], [2/3, .5, 1/3, .5]] },
  mainleft:  { name: '2 + Main',    zones: [[0, 0, 1/3, .5], [0, .5, 1/3, .5], [1/3, 0, 2/3, 1]] },
  maintop:   { name: 'Main over 2', zones: [[0, 0, 1, .6], [0, .6, .5, .4], [.5, .6, .5, .4]] },
  twoover1:  { name: '2 over 1',    zones: rowsOf([2, 1]) },
  oneover2:  { name: '1 over 2',    zones: rowsOf([1, 2]) },
  main3:     { name: 'Main + 3',    zones: [[0, 0, .6, 1], [.6, 0, .4, 1/3], [.6, 1/3, .4, 1/3], [.6, 2/3, .4, 1/3]] },
  six:       { name: '3 x 2',       zones: rowsOf([3, 3]) },
  nine:      { name: '3 x 3',       zones: rowsOf([3, 3, 3]) },
};
// Auto follows Sash's auto-arrange: shape comes from the window count and the area's aspect ratio.
const AUTO_ROWS = { 2: [2], 3: [2, 1], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [4, 3], 8: [4, 4], 9: [3, 3, 3] };
function autoZones(n, aspect) {
  if (n <= 1) return rowsOf([1]);
  if (n === 2) return aspect < 0.9 ? rowsOf([1, 1]) : rowsOf([2]);
  if (n === 3 && aspect >= 2.2) return rowsOf([3]);
  if (n === 4 && aspect >= 3) return rowsOf([4]);
  if (AUTO_ROWS[n]) return rowsOf(AUTO_ROWS[n]);
  const cols = Math.ceil(Math.sqrt(n)), counts = [];
  for (let left = n; left > 0; left -= cols) counts.push(Math.min(cols, left));
  return rowsOf(counts);
}

let layoutKind = load('corral.layout', 'auto'); // 'auto', 'grid', or a LAYOUTS key
if (layoutKind !== 'auto' && layoutKind !== 'grid' && !LAYOUTS[layoutKind]) layoutKind = 'auto';
let slots = [];   // slots[i] = id of the window in zone i, or null
let tray = [];    // windows that do not fit the layout; shown as chips under the grid
let suspend = false;
let ready = false; // layout() saves the arrangement only after startup has restored it
const savedArrangement = load('corral.slots', { slots: [], tray: [] }); // read before any layout() can overwrite it
// Minimized windows wait in the bottom bar, still running, until restored. They never take a zone.
const minimized = new Set(load('corral.minimized', []));
const visibleCount = () => [...open.keys()].filter((id) => !minimized.has(id)).length;

// Bottom bar height: drag the bar's top edge to change it, double-click the edge to reset. Saved per browser.
const TRAY_H = { def: 44, min: 30, max: 96 };
const trayGrip = document.createElement('div');
trayGrip.id = 'traygrip';
trayGrip.title = 'Drag to resize the bar. Double-click to reset.';
function setTrayH(h) {
  h = Math.round(Math.min(TRAY_H.max, Math.max(TRAY_H.min, Number(h) || TRAY_H.def)));
  $('#tray').style.setProperty('--th', `${h}px`);
  return h;
}
setTrayH(load('corral.trayH', TRAY_H.def));
trayGrip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  trayGrip.setPointerCapture(e.pointerId);
  trayGrip.classList.add('drag');
  const y0 = e.clientY, h0 = parseFloat($('#tray').style.getPropertyValue('--th'));
  const move = (ev) => setTrayH(h0 + y0 - ev.clientY); // dragging up makes the bar taller
  trayGrip.addEventListener('pointermove', move);
  trayGrip.addEventListener('pointerup', (ev) => {
    trayGrip.removeEventListener('pointermove', move);
    trayGrip.classList.remove('drag');
    store('corral.trayH', setTrayH(h0 + y0 - ev.clientY));
  }, { once: true });
});
trayGrip.addEventListener('dblclick', () => store('corral.trayH', setTrayH(TRAY_H.def)));

function currentZones() {
  const g = $('#grid');
  const n = visibleCount();
  if (layoutKind === 'auto') return autoZones(n, g.clientWidth / Math.max(1, g.clientHeight));
  if (layoutKind === 'grid') {
    const cols = Number($('#cols').value);
    const rows = $('#rows').value === 'auto' ? Math.max(1, Math.ceil(Math.max(n, 1) / cols)) : Number($('#rows').value);
    return rowsOf(Array(rows).fill(cols));
  }
  return LAYOUTS[layoutKind].zones;
}

// Keeps existing windows in slot order and refills the zones; used when the zone count changes.
// Minimized windows stay in the tray.
function repack(z) {
  const ids = [...slots.filter(Boolean), ...tray.filter((id) => !minimized.has(id))];
  slots = Array(z).fill(null);
  tray = tray.filter((id) => minimized.has(id));
  ids.forEach((id, i) => (i < z ? (slots[i] = id) : tray.push(id)));
}

function moveTo(id, to) {
  const from = slots.indexOf(id);
  if (from >= 0) [slots[from], slots[to]] = [slots[to], slots[from]];
  else {
    const t = tray.indexOf(id);
    if (t < 0) return;
    minimized.delete(id);
    const displaced = slots[to];
    slots[to] = id;
    if (displaced) tray[t] = displaced; else tray.splice(t, 1);
  }
  layout();
}

function minimize(id) {
  const i = slots.indexOf(id);
  if (i >= 0) slots[i] = null;
  if (!tray.includes(id)) tray.unshift(id);
  minimized.add(id);
  if (focusedId === id) focusedId = null;
  layout();
}

// Back into a free zone if there is one (Auto and Grid make room); otherwise swap with the focused window.
function restore(id) {
  minimized.delete(id);
  layout();
  if (tray.includes(id)) { const at = slots.indexOf(focusedId); moveTo(id, at >= 0 ? at : 0); }
  setFocus(id);
}

const dragOk = (e) => [...(e.dataTransfer?.types || [])].includes('text/x-corral');
function wireDrop(el, zoneOf) {
  el.addEventListener('dragover', (e) => { if (dragOk(e)) { e.preventDefault(); el.classList.add('over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('over');
    if (!dragOk(e)) return;
    e.preventDefault();
    moveTo(e.dataTransfer.getData('text/x-corral'), zoneOf());
  });
}

function layout() {
  if (suspend) return;
  const zones = currentZones();
  // Drop windows that closed, then place new ones in the first free zone (or the tray).
  if (ready) for (const id of [...minimized]) if (!open.has(id)) minimized.delete(id);
  slots = slots.map((id) => (id && open.has(id) && !minimized.has(id) ? id : null));
  tray = tray.filter((id) => open.has(id));
  for (const id of minimized) if (open.has(id) && !tray.includes(id)) tray.unshift(id);
  if (slots.length !== zones.length) repack(zones.length);
  for (const id of open.keys()) {
    if (slots.includes(id) || tray.includes(id)) continue;
    const free = slots.indexOf(null);
    if (free >= 0) slots[free] = id; else tray.push(id);
  }
  // Fill empty zones from the waiting (not minimized) windows.
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]) continue;
    const k = tray.findIndex((id) => !minimized.has(id));
    if (k < 0) break;
    slots[i] = tray.splice(k, 1)[0];
  }

  const grid = $('#grid');
  grid.querySelectorAll('.zone-empty').forEach((n) => n.remove());
  const place = (el, z) => {
    el.style.left = `${z[0] * 100}%`; el.style.top = `${z[1] * 100}%`;
    el.style.width = `${z[2] * 100}%`; el.style.height = `${z[3] * 100}%`;
  };
  let hinted = false;
  const back = []; // windows coming back into view, from the bottom bar or a pop-out
  zones.forEach((z, i) => {
    const id = slots[i];
    if (id) {
      const w = open.get(id);
      place(w.slot, z);
      if (w.slot.hidden) back.push(w);
      w.slot.hidden = false;
      w.slot.dataset.zone = i;
    } else {
      const e = document.createElement('div');
      e.className = 'zone-empty';
      const inner = document.createElement('div');
      inner.textContent = !hinted && !open.size ? 'Pick a space on the left to open it here.' : 'Empty zone';
      hinted = true;
      e.append(inner);
      place(e, z);
      wireDrop(e, () => i);
      grid.append(e);
    }
  });
  open.forEach((w, id) => { if (tray.includes(id)) w.slot.hidden = true; });

  // Bottom bar: minimized windows, then any that are waiting for a free zone. Click to restore,
  // or drag a chip onto a zone.
  const bar = $('#tray');
  bar.hidden = !tray.length;
  // Keep the resize grip in place: layout() runs while it is being dragged, and detaching it would end the drag.
  for (const n of [...bar.childNodes]) if (n !== trayGrip) n.remove();
  if (!trayGrip.parentNode) bar.prepend(trayGrip);
  const group = (label, ids, tip) => {
    if (!ids.length) return;
    const l = document.createElement('span');
    l.className = 'lbl';
    l.textContent = label;
    bar.append(l);
    for (const id of ids) {
      const c = document.createElement('button');
      c.className = `chip${minimized.has(id) ? ' min' : ''}${open.get(id).asking ? ' asking' : ''}`;
      c.dataset.id = id;
      const dot = document.createElement('span');
      dot.className = `dot ${stateOf(open.get(id))[0]}`;
      c.append(dot, open.get(id).info.label);
      c.title = tip;
      c.draggable = true;
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-corral', id); e.dataTransfer.effectAllowed = 'move'; });
      c.onclick = () => restore(id);
      bar.append(c);
    }
  };
  group('Minimized:', tray.filter((id) => minimized.has(id)), 'Restore this window');
  group('No free zone:', tray.filter((id) => !minimized.has(id)), 'Swap this window into the focused zone');
  if (ready) { store('corral.slots', { slots, tray }); store('corral.minimized', [...minimized]); }
  $('#laybtn').textContent = `Layout: ${layoutKind === 'auto' ? 'Auto' : layoutKind === 'grid' ? 'Grid' : LAYOUTS[layoutKind].name} ▾`;
  $('#colslab').hidden = $('#rowslab').hidden = layoutKind !== 'grid';
  const nMin = [...minimized].filter((id) => open.has(id)).length;
  $('#count').textContent = `${open.size} window${open.size === 1 ? '' : 's'}${nMin ? ` (${nMin} minimized)` : ''}`;
  // A window coming back also sends its size when the size did not change here: while it was out of view a
  // pop-out (which shares this page's tmux client) may have sized it, and tmux would keep that size.
  requestAnimationFrame(() => {
    open.forEach((w) => { if (!w.slot.hidden) w.fit.fit(); });
    for (const w of back) if (w.ws?.readyState === 1) w.ws.send(JSON.stringify({ t: 'resize', cols: w.term.cols, rows: w.term.rows }));
  });
}

function thumb(zones) {
  const t = document.createElement('div');
  t.className = 'thumb';
  for (const z of zones) {
    const i = document.createElement('i');
    i.style.cssText = `left:${z[0] * 100 + 2}%;top:${z[1] * 100 + 3}%;width:${z[2] * 100 - 4}%;height:${z[3] * 100 - 6}%`;
    t.append(i);
  }
  return t;
}

function buildLayoutMenu() {
  const menu = $('#laymenu');
  menu.textContent = '';
  const entries = [['auto', 'Auto', autoZones(3, 1.5)], ['grid', 'Grid', rowsOf([2, 2, 2])],
    ...Object.entries(LAYOUTS).map(([k, v]) => [k, v.name, v.zones])];
  for (const [key, name, zones] of entries) {
    const b = document.createElement('button');
    b.className = `lay${key === layoutKind ? ' on' : ''}`;
    b.title = key === 'auto' ? 'Picks a tiling from the window count and screen shape' : key === 'grid' ? 'Columns by rows, set in the bar' : name;
    b.append(thumb(zones), document.createTextNode(name));
    b.onclick = () => { layoutKind = key; store('corral.layout', key); menu.hidden = true; buildLayoutMenu(); layout(); };
    menu.append(b);
  }
  savedLayoutsMenu(menu);
}

function setFocus(id) {
  focusedId = id;
  open.forEach((w, k) => w.el.classList.toggle('focus', k === id));
  open.get(id)?.term.focus();
}

// quiet: a window started elsewhere goes straight to the bottom bar and does not take the keyboard.
// ---- Files and folders dropped on a window: the browser never sees a dropped file's path on the Mac, only
// its name, size, and modified time. The server finds it from those (see locateFile) and its path is pasted,
// escaped the way Terminal.app pastes a dropped file, so Claude Code reads it, and attaches an image as
// [Image #n]. An image the server cannot find (dragged from a screenshot's thumbnail, say) is uploaded to
// Corral's data folder instead, as the phone's photos are, and that copy's path pasted.
const filesIn = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/heic', 'image/webp', 'image/gif'];
const dropPath = (p) => p.replace(/[^\w@%+=:,./-]/g, '\\$&');
const base64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});
async function addFiles(w, files) {
  setFocus(w.info.id);
  for (const f of files) {
    let found = null;
    try { found = (await api(`/api/locate?${new URLSearchParams({ name: f.name, size: f.size, modified: f.lastModified })}`)).path; } catch {}
    if (found) { w.term.paste(`${dropPath(found)} `); continue; }
    if (!IMAGE_TYPES.includes(f.type)) { toast(`Could not find ${f.name} on this Mac. Paste its path instead.`); continue; }
    try {
      const j = await api(`/api/sessions/${encodeURIComponent(w.info.id)}/upload`, { method: 'POST', body: { type: f.type, data: await base64(f) } });
      if (!j.path) { toast(j.error || `Could not add ${f.name}.`); continue; }
      w.term.paste(`${j.path} `);
    } catch { toast(`Could not add ${f.name}.`); }
  }
}
// A file dropped anywhere else would make the browser open it in place of Corral.
document.addEventListener('dragover', (e) => { if (filesIn(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (filesIn(e)) e.preventDefault(); });

function attach(info, quiet) {
  // Already open: the status poll can pick up a window before its own POST answers, and puts it in the bottom
  // bar. The window you asked for comes out of it.
  if (open.has(info.id)) return minimized.has(info.id) || tray.includes(info.id) ? restore(info.id) : setFocus(info.id);
  const el = document.createElement('div');
  el.className = 'win';
  el.innerHTML = `<div class="title"><span class="dot"></span><span class="t"></span><span class="use" hidden></span><span class="cwd"></span><button class="queue" hidden title="Prompts to send when Claude finishes">Queue</button><button class="pop" title="Pop out into a browser window of its own, with this space's files and tabs">&#10697;</button><button class="min" title="Minimize to the bottom bar (keeps running)">&#8211;</button><button class="close" title="Close and kill shell">&times;</button></div><div class="term"></div>`;
  el.querySelector('.t').textContent = info.label;
  el.querySelector('.cwd').textContent = info.cwd.replace(/^\/Users\/[^/]+/, '~');
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.append(el);
  $('#grid').appendChild(slot);
  // Drag the title bar onto another zone to move this window there (or swap with its occupant).
  const title = el.querySelector('.title');
  title.draggable = true;
  title.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-corral', info.id); e.dataTransfer.effectAllowed = 'move'; });
  wireDrop(slot, () => Number(slot.dataset.zone));

  // Option-drag makes a browser selection even while tmux has the mouse (Cmd-C then copies it).
  const term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: fontOf(info.id), cursorBlink: true,
    scrollback: 5000, macOptionClickForcesSelection: true, linkHandler: { activate: linkMenu },
    theme: corralTheme.term() });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon(linkMenu));
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(search);
  term.open(el.querySelector('.term'));

  const w = { term, fit, search, el, slot, info, ws: null, muted: false };
  // Drop a file or folder from Finder or the Desktop on the window to give its path to Claude Code (see addFiles).
  el.addEventListener('dragover', (e) => { if (filesIn(e)) { e.preventDefault(); el.classList.add('filedrop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('filedrop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('filedrop');
    if (!filesIn(e)) return;
    e.preventDefault();
    addFiles(w, [...e.dataTransfer.files]);
  });
  // With tmux's mouse on, a plain drag selects inside tmux, and on release tmux sends the text as an
  // OSC 52 escape. Put it on the clipboard. Writes only: a request to read the clipboard is ignored,
  // and so is any copy replayed from saved output while reconnecting. tmux clears the highlight on
  // release, so a toast says what was copied.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (w.muted || !b64 || b64 === '?') return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      navigator.clipboard.writeText(text).then(() => toast(copiedNote(text)),
        () => toast('Could not copy. Option-drag to select it, then press Cmd-C.'));
    } catch {}
    return true;
  });
  // Press and hold a line with a `! command` on it for half a second to copy the command, ready to paste into
  // Claude Code's prompt. A drag is a tmux selection instead.
  const termEl = el.querySelector('.term');
  let hold = null;
  termEl.addEventListener('pointerdown', (e) => { hold = e.button === 0 ? { x: e.clientX, y: e.clientY, at: Date.now() } : null; });
  termEl.addEventListener('pointermove', (e) => {
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 5) hold = null;
  });
  termEl.addEventListener('pointerup', (e) => {
    const held = hold && Date.now() - hold.at >= 500;
    hold = null;
    const cmd = held && bangAt(term, e.clientY);
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => toast(`Copied: ${cmd}`), () => toast('Could not copy. Option-drag to select it.'));
  });
  open.set(info.id, w);
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?id=${info.id}`);
    w.ws = ws;
    let first = true;
    ws.onopen = () => { w.down = false; paint(w); term.reset(); fit.fit(); ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
    // The first message replays saved output, which can hold old terminal queries (device attributes and
    // the like). xterm answers those as it draws them; the answers must not reach the shell as typed text.
    ws.onmessage = (e) => {
      if (!first) return term.write(e.data);
      first = false;
      w.muted = true;
      term.write(e.data, () => { w.muted = false; });
    };
    ws.onclose = () => { if (open.has(info.id)) { w.down = true; paint(w); setTimeout(connect, 1500); } };
  };
  paint(w);
  connect();
  term.onData((d) => !w.muted && w.ws?.readyState === 1 && w.ws.send(JSON.stringify({ t: 'in', d })));
  // Cmd-Backspace erases back to the start of the line (Ctrl-U), as in Positron and VS Code. xterm would send
  // a single Backspace. Option-Backspace already erases a word: xterm sends ESC DEL.
  term.attachCustomKeyEventHandler((e) => {
    if (e.key !== 'Backspace' || !e.metaKey || e.altKey || e.ctrlKey) return true;
    if (e.type === 'keydown') term.input('\x15');
    e.preventDefault();
    return false;
  });
  term.onResize(({ cols, rows }) => w.ws?.readyState === 1 && w.ws.send(JSON.stringify({ t: 'resize', cols, rows })));
  new ResizeObserver(() => fit.fit()).observe(el.querySelector('.term'));
  el.addEventListener('mousedown', () => setFocus(info.id));
  el.querySelector('.min').onclick = (e) => { e.stopPropagation(); minimize(info.id); };
  el.querySelector('.pop').onclick = (e) => { e.stopPropagation(); popOut(info.id); };
  el.querySelector('.queue').onclick = (e) => { e.stopPropagation(); queueMenu(w, e.currentTarget); };
  el.querySelector('.use').onclick = (e) => { e.stopPropagation(); setCost(!costOn); };
  el.querySelector('.close').onclick = async () => {
    dropWindow(info.id);
    await api(`/api/sessions/${info.id}`, { method: 'DELETE' });
    persist(); layout(); arrange();
  };
  if (quiet) { persist(); minimize(info.id); arrange(); return; }
  persist(); layout(); arrange(); setFocus(info.id);
}

// Pop-outs: a window in a browser window of its own (/pop), with its space's files and a tab for each file
// opened from them. Here it waits minimized, so only the pop-out sizes it, and it comes back into a zone when
// the pop-out closes (unless it was brought back already). The browser window is named for the window, so a
// second click goes to the pop-out it already has.
const popped = new Map(); // window id -> the pop-out's browser window
function popOut(id) {
  const pw = window.open(`/pop?id=${encodeURIComponent(id)}`, `corral-pop:${id}`, 'popup,width=1500,height=950');
  if (!pw) return toast('The browser blocked the new window. Allow pop-ups for Corral, then try again.');
  pw.focus();
  popped.set(id, pw);
  popTimer ||= setInterval(checkPopped, 1500);
  minimize(id);
  toast(`Popped out ${open.get(id).info.label}. It comes back here when you close the pop-out.`);
}
let popTimer = null; // runs only while a pop-out is open
function checkPopped() {
  for (const [id, pw] of popped) {
    if (!pw.closed) continue;
    popped.delete(id);
    if (open.has(id) && minimized.has(id)) restore(id);
  }
  if (!popped.size) { clearInterval(popTimer); popTimer = null; }
}
// A pop-out's Send back button says so on this channel. That reaches this page even when it was reloaded
// after the window popped out and so lost track of the pop-out's browser window.
// Its × says on it that the window was closed: it goes from this page at once, so the closed-check cannot
// bring it back into a zone first.
const popChannel = new BroadcastChannel('corral-pop');
popChannel.onmessage = (e) => {
  const gone = e.data?.closed;
  if (gone) {
    popped.delete(gone);
    if (!open.has(gone)) return;
    dropWindow(gone);
    persist(); layout(); arrange();
    return;
  }
  const id = e.data?.sendBack;
  popped.delete(id);
  if (open.has(id) && minimized.has(id)) restore(id);
};
// Takes a closed window off this page: its terminal, connection, zone, and saved font size.
function dropWindow(id) {
  const w = open.get(id);
  open.delete(id);
  forgetFont(id);
  w.ws?.close(); w.term.dispose(); w.slot.remove();
}

// The toast for a drag copy: a short single line is shown whole, anything longer by its size.
function copiedNote(text) {
  const lines = text.replace(/\n$/, '').split('\n').length;
  if (lines > 1) return `Copied ${lines} lines.`;
  return text.length <= 60 ? `Copied: ${text}` : `Copied ${text.length} characters.`;
}

// The `! command` on the terminal row at height y: from a ! that starts a word to the end of the row.
function bangAt(term, y) {
  const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const b = term.buffer.active;
  const line = b.getLine(b.viewportY + Math.floor((y - r.top) / (r.height / term.rows)))?.translateToString(true);
  return line?.match(/(?:^|\s)(! +\S.*)$/)?.[1];
}

const persist = () => store('corral.open', [...open.keys()]);

// Light or dark (theme.js): the bar's button picks Auto, Light, or Dark, and open terminals change colors too.
corralTheme.button($('#theme'));
corralTheme.onChange(() => open.forEach((w) => { w.term.options.theme = corralTheme.term(); }));

// Restore: after the tmux server or the Mac restarts, Corral offers the windows that were open before,
// each resuming its Claude Code conversation. The server keeps the list; this page only asks for it.
async function checkRestore() {
  const r = await api('/api/restore').catch(() => null);
  const n = r?.windows?.length || 0;
  $('#restorewrap').hidden = !n;
  if (!n) return;
  const when = r.savedAt ? new Date(r.savedAt).toLocaleString() : 'before the restart';
  $('#restore').textContent = `Restore ${n} window${n === 1 ? '' : 's'}`;
  $('#restore').title = `Open again, as of ${when}:\n${r.windows.map((w) => `${w.label}${w.claude ? ' (resumes its Claude conversation)' : ''}`).join('\n')}`;
}
$('#restore').onclick = async () => {
  $('#restorewrap').hidden = true;
  const r = await api('/api/restore', { method: 'POST' });
  for (const s of r.sessions || []) attach(s);
  const miss = r.notResumed?.length ? ` (${r.notResumed.join(', ')}: conversation not found, opened as a shell)` : '';
  toast(`Restored ${r.sessions?.length || 0} window${r.sessions?.length === 1 ? '' : 's'}${miss}`);
};
$('#restorex').onclick = async () => {
  $('#restorewrap').hidden = true;
  await api('/api/restore/dismiss', { method: 'POST' });
  toast('Forgot the windows from before the restart');
};

// Opens a window. A space keeps one window: if it already has one, that window comes forward instead
// (out of the bottom bar if need be). The server enforces the same rule, which also stops a double-click.
async function spawn(cwd, label, space, agent) {
  const mine = space && [...open.values()].find((w) => w.info.space === space);
  if (mine) return bringForward(mine.info);
  const r = await fetch('/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, label, space, agent: agent || null }),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (r?.status === 409 && j.existing) return bringForward(j.existing);
  if (!r?.ok) return toast(j.error || 'Could not start the window.');
  attach(j);
  // Says so when a space opens without Claude Code, so a bumped "A space opens" shows on the first click.
  if (space && agent === '') toast('Opened a plain shell: "A space opens" is set to A plain shell.');
}
// Into a zone with the keyboard: opened if this page does not have it yet, out of the bottom bar if it is there.
function showSummoned(info) {
  if (!open.has(info.id)) return attach(info);
  if (minimized.has(info.id) || tray.includes(info.id)) restore(info.id); else setFocus(info.id);
}
function bringForward(info) {
  if (!open.has(info.id)) attach(info); // started on another device and not picked up yet
  if (minimized.has(info.id) || tray.includes(info.id)) restore(info.id);
  setFocus(info.id);
  toast(`${info.label} is already open. Here it is.`);
}

let spaces = [];
const rows = new Map(); // space id -> wrapper element, built once per load and only reordered after

// A space counts as open when a terminal window in this page belongs to it. Windows made from
// a space row carry its id; older adopted shells fall back to a matching folder.
function windowOf(s) {
  for (const w of open.values()) {
    const i = w.info;
    if (i.space === s.id || (!i.space && i.cwd && (i.cwd === s.cwd || i.cwd === s.root))) return w;
  }
  return null;
}
const hasWindow = (s) => Boolean(windowOf(s));
// When a space's window last did something: its Claude's latest status change (finished, asking, or started
// working), or for a plain shell tmux's last output. An idle Claude still redraws its screen, so tmux's time
// would put every Claude window near the top.
const lastChange = (s) => { const w = windowOf(s); return w.claude?.since || w.activity || 0; };
// The spaces a filter lets through, and those of them with a window, latest change first.
const shownSpaces = (q) => spaces.filter((s) => s.label.toLowerCase().includes(q));
const openFirst = (shown) => shown.filter(hasWindow).sort((a, b) => lastChange(b) - lastChange(a));
// A window whose last typed command was /clear, listed under Parked windows instead of Open windows, and one
// Claude Code compacted on its own and that has since finished with nothing typed, listed under
// Auto-compacted windows above it. One still working after its compaction stays under Open windows.
const isCleared = (s) => Boolean(windowOf(s).claude?.cleared);
const isCompacted = (s) => windowOf(s).claude?.compacted === true && windowOf(s).claude.status === 'idle';
const orderKey = (open) => open.map((s) => (isCleared(s) ? `c${s.id}` : isCompacted(s) ? `a${s.id}` : s.id)).join();
// The filter and Open windows order last drawn, so the status check redraws only when the order changes.
let drawn = { q: '', order: '' };
// A space's dot: its open window's color (stateOf) when it has one, since Claude runs in Corral's windows
// and herdr reports "unknown" for them; otherwise herdr's own status for the space.
const spaceDot = (s) => (windowOf(s) && stateOf(windowOf(s))[0]) || s.status;
function paintDots() { for (const s of spaces) rows.get(s.id).querySelector('.dot').className = `dot ${spaceDot(s)}`; }

function renderSpaces() { buildRows(); arrange(); }

// Puts spaces with an open window first, latest change on top (those last cleared with /clear in their own
// section after), then the rest alphabetical (herdr's own order). Moves the existing elements, so expanded file trees survive.
// ---- Categories: the user's own groups. Saved on the server, keyed by project folder. ----
let cats = { categories: [], uncatCollapsed: false, assign: {}, todo: [], later: [] };
let saveTimer = null;
function saveCats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/api/categories', { method: 'POST', body: cats }).catch(() => {}), 250);
}
async function loadCats() {
  try { const c = await api('/api/categories'); if (c.categories) cats = { ...c, todo: c.todo || [], later: c.later || [] }; } catch {}
  arrange();
}
const catOf = (s) => (s.root && Object.hasOwn(cats.assign, s.root) ? cats.assign[s.root] : null);
// Files spaces in a category (null = Uncategorized), then offers an undo for a few seconds.
function assignTo(list, name) {
  const moved = list.filter((s) => s.root);
  const before = moved.map((s) => [s.root, catOf(s)]);
  for (const s of moved) { if (name) cats.assign[s.root] = name; else delete cats.assign[s.root]; }
  selected.clear();
  saveCats(); arrange();
  if (!moved.length) return;
  const what = moved.length === 1 ? moved[0].label : `${moved.length} spaces`;
  toast(`Moved ${what} to ${name || 'Uncategorized'}`, () => {
    for (const [root, c] of before) { if (c) cats.assign[root] = c; else delete cats.assign[root]; }
    saveCats(); arrange();
  });
}

// TO-DO: spaces still to work on, listed above Open windows. Later: spaces to look at another time, listed
// under Parked windows. Both are kept by project folder, like categories, and a space is in one at most.
// A space whose window was cleared with /clear is done: it leaves either list and sits under Parked windows.
const MARKS = { todo: 'TO-DO', later: 'Later' };
const isTodo = (s) => Boolean(s.root) && cats.todo.includes(s.root);
const isLater = (s) => Boolean(s.root) && cats.later.includes(s.root);
function setMark(list, key, on) {
  const has = key === 'todo' ? isTodo : isLater;
  const moved = list.filter((s) => s.root && has(s) !== on);
  if (!moved.length) return;
  const before = { todo: cats.todo, later: cats.later };
  const roots = new Set(moved.map((s) => s.root));
  for (const k of Object.keys(MARKS)) cats[k] = cats[k].filter((r) => !roots.has(r));
  if (on) cats[key] = [...cats[key], ...roots];
  selected.clear();
  saveCats(); arrange();
  const what = moved.length === 1 ? moved[0].label : `${moved.length} spaces`;
  toast(`${on ? 'Added' : 'Removed'} ${what} ${on ? 'to' : 'from'} ${MARKS[key]}`, () => {
    Object.assign(cats, before);
    saveCats(); arrange();
  });
}
const setTodo = (list, on) => setMark(list, 'todo', on);

// Selection: Cmd/Ctrl-click toggles a space, Shift-click selects a run; moves then apply to all of them.
const selected = new Set();
let lastPick = null;
const pickList = (s) => (selected.has(s.id) ? spaces.filter((x) => selected.has(x.id)) : [s]);
function syncSel() {
  rows.forEach((wrap, id) => wrap.querySelector('.space').classList.toggle('sel', selected.has(id)));
  renderBulk();
}

let toastTimer = null;
function toast(msg, undo) {
  const t = $('#toast');
  t.textContent = '';
  const m = document.createElement('span'); m.textContent = msg; t.append(m);
  if (undo) {
    const b = document.createElement('button'); b.textContent = 'Undo';
    b.onclick = () => { t.hidden = true; undo(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

// Any space row or group header accepts dragged spaces; getName gives the category they land in.
const spaceDrag = (e) => [...(e.dataTransfer?.types || [])].includes('text/x-corral-space');
function wireCatDrop(el, getName, onList) {
  el.addEventListener('dragover', (e) => { if (spaceDrag(e)) { e.preventDefault(); el.classList.add('over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('over');
    if (!spaceDrag(e)) return;
    e.preventDefault();
    const ids = e.dataTransfer.getData('text/x-corral-space').split('\n');
    const list = spaces.filter((x) => ids.includes(x.id));
    if (list.length) (onList || ((l) => assignTo(l, getName())))(list);
  });
}
function addCategory(name) {
  name = name.trim().slice(0, 40);
  if (!name) return null;
  if (!cats.categories.some((c) => c.name === name)) { cats.categories.push({ name, collapsed: false }); saveCats(); }
  return name;
}

// Small popup for filing one or more spaces: pick a category, none, or type a new name.
let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
function catMenu(list, anchor) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'catmenu';
  const cur = list.length === 1 ? catOf(list[0]) : null;
  if (list.length > 1) { const h = document.createElement('div'); h.className = 'mhead'; h.textContent = `Move ${list.length} spaces to`; m.append(h); }
  const item = (text, name, on) => {
    const b = document.createElement('button');
    b.textContent = `${on ? '✓ ' : ''}${text}`;
    b.onclick = () => { closeMenu(); assignTo(list, name); };
    m.append(b);
  };
  for (const c of cats.categories) item(c.name, c.name, c.name === cur);
  item('Uncategorized', null, list.length === 1 && !cur);
  m.append(Object.assign(document.createElement('div'), { className: 'msep' }));
  for (const [key, label] of Object.entries(MARKS)) {
    const b = document.createElement('button');
    const all = list.every(key === 'todo' ? isTodo : isLater);
    b.textContent = `${all ? '✓ ' : ''}${label}`;
    b.onclick = () => { closeMenu(); setMark(list, key, !all); };
    m.append(b);
  }
  if (list.length === 1) {
    m.append(Object.assign(document.createElement('div'), { className: 'msep' }));
    const past = document.createElement('button');
    past.textContent = 'Past conversations…';
    past.onclick = (e) => { e.stopPropagation(); historyPanel(m, list[0]); };
    m.append(past);
    const b = document.createElement('button');
    b.className = 'danger';
    b.textContent = 'Close space…';
    b.onclick = (e) => { e.stopPropagation(); closeSpaceAsk(m, list[0]); };
    m.append(b);
  }
  const inp = document.createElement('input');
  inp.placeholder = 'New category, then Enter';
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { const n = addCategory(inp.value); if (n) { closeMenu(); assignTo(list, n); } }
    if (e.key === 'Escape') closeMenu();
  };
  m.append(inp);
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y };
  m.style.left = `${Math.min(r.left, innerWidth - 220)}px`;
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)}px`;
  openMenu = m;
  inp.focus();
}
document.addEventListener('click', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });

// The space menu turns into a question before a space closes: herdr ends its panes, and Corral ends any
// window opened for it, Claude Code included. The folder stays, under Inactive projects.
function closeSpaceAsk(m, s) {
  m.replaceChildren();
  const add = (cls, text) => m.appendChild(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
  add('mhead', `Close ${s.label}?`);
  add('murl', 'This ends the space and everything running in it, Claude Code included. The folder stays, under Inactive projects.');
  const yes = m.appendChild(Object.assign(document.createElement('button'), { className: 'danger', textContent: 'Close it' }));
  yes.onclick = async () => {
    closeMenu();
    const r = await api('/api/spaces/close', { method: 'POST', body: { space: s.id } }).catch(() => ({ error: 'Could not reach Corral.' }));
    toast(r.ok ? `Closed ${s.label}.` : `Could not close ${s.label}: ${r.error}`);
    loadSpaces();
  };
  m.appendChild(Object.assign(document.createElement('button'), { textContent: 'Keep it', onclick: closeMenu }));
  yes.focus();
}

// The space menu turns into the list of the project's past Claude Code conversations, newest first. Each can
// be resumed in a new window (when the space has none) or saved as Markdown or HTML.
async function historyPanel(m, s) {
  m.replaceChildren();
  m.classList.add('histmenu');
  const add = (cls, text) => m.appendChild(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
  add('mhead', `Past conversations in ${s.label}`);
  const wait = add('murl', 'Loading…');
  const q = `space=${encodeURIComponent(s.id)}`;
  const r = await api(`/api/history?${q}`).catch(() => null);
  wait.remove();
  if (!r?.conversations) return add('murl', `Could not list them${r?.error ? `: ${r.error}` : ''}.`);
  if (!r.conversations.length) return add('murl', 'No Claude Code conversations were started in this folder.');
  const hasWindow = [...open.values()].some((w) => w.info.space === s.id && !w.exited);
  for (const c of r.conversations) {
    const row = m.appendChild(Object.assign(document.createElement('div'), { className: 'hrow' }));
    row.append(Object.assign(document.createElement('div'), { className: 'htitle', textContent: c.title, title: c.first || '' }),
      Object.assign(document.createElement('div'), { className: 'hwhen', textContent: `${sentAt(c.updated)} · ${Math.max(1, Math.round(c.size / 1024)).toLocaleString()} KB` }));
    const btns = row.appendChild(Object.assign(document.createElement('div'), { className: 'hbtns' }));
    const resume = btns.appendChild(Object.assign(document.createElement('button'), { textContent: 'Resume' }));
    if (hasWindow) { resume.disabled = true; resume.title = 'This space has a window open. Close it first.'; }
    resume.onclick = async () => {
      closeMenu();
      const x = await api('/api/history/resume', { method: 'POST', body: { space: s.id, id: c.id } }).catch(() => ({ error: 'Could not reach Corral.' }));
      if (!x.id) return toast(`Could not resume it: ${x.error}`);
      attach(x);
      toast(`Resumed "${c.title}" in ${s.label}.`);
    };
    for (const f of ['md', 'html']) {
      btns.append(Object.assign(document.createElement('a'), {
        className: 'hsave', textContent: f === 'md' ? 'Markdown' : 'HTML', title: `Save this conversation as ${f === 'md' ? 'a Markdown file' : 'an HTML page'}`,
        href: `/api/history/export?${q}&id=${encodeURIComponent(c.id)}&format=${f}`, download: '',
      }));
    }
  }
  if (r.more) add('murl', 'Only the 200 most recent are listed.');
  const b = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(b.left, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(b.top, innerHeight - m.offsetHeight - 8))}px`;
}

// A link clicked in a terminal: one Claude Code marks as a link (OSC 8, which tmux passes on because of
// corral.tmux.conf) or plain http(s) text. It opens in a new tab of this computer's browser once confirmed.
// The menu waits for the click that follows the mouse-up, which would otherwise close it at once.
function linkMenu(e, uri) {
  setTimeout(() => {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'catmenu linkmenu';
    const add = (cls, text) => m.appendChild(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
    add('mhead', 'Open this link?');
    add('murl', uri);
    const item = (text, go) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => { closeMenu(); if (go) window.open(uri, '_blank', 'noopener'); };
      return m.appendChild(b);
    };
    const open = item('Open in browser', true);
    item('Cancel', false);
    document.body.append(m);
    m.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - 328))}px`;
    m.style.top = `${Math.max(8, Math.min(e.clientY + 4, innerHeight - m.offsetHeight - 8))}px`;
    openMenu = m;
    open.focus();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeMenu();
  if (selected.size) { selected.clear(); syncSel(); }
});

// Opening files from the tree. A click uses the app saved for that file type; until there is one, it asks.
// Right-click always asks. The apps listed are the ones macOS offers for the file.
async function openTreeFile(space, rel, anchor) {
  const r = await api('/api/open', { method: 'POST', body: { space, path: rel } }).catch(() => null);
  if (!r) return toast('Could not reach Corral.');
  if (r.needsChoice) return openWithMenu(space, rel, anchor, r.error);
  if (r.view && !viewFile(space, rel)) return;
  toast(r.ok ? `Opened ${rel.split('/').pop()} in ${r.app}.` : r.error || 'Could not open it.');
}

// The viewer: a markdown file in a browser window of its own (/view), which shows it drawn or as text.
// The window is named for the file, so a second click on the file goes to the window it already has.
function viewFile(space, rel) {
  const w = window.open(`/view?space=${encodeURIComponent(space)}&path=${encodeURIComponent(rel)}`, `corral-view:${space}:${rel}`, 'popup,width=900,height=1000');
  if (!w) toast('The browser blocked the new window. Allow pop-ups for Corral, then click the file again.');
  else w.focus();
  return Boolean(w);
}

async function openWithMenu(space, rel, anchor, problem) {
  closeMenu();
  const q = `space=${encodeURIComponent(space)}&path=${encodeURIComponent(rel)}`;
  const info = await api(`/api/open-with?${q}`).catch(() => null);
  if (!info || info.error) return toast(info?.error || 'Could not reach Corral.');
  const m = document.createElement('div');
  m.className = 'catmenu openwith';
  const add = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; m.append(d); return d; };
  add('mhead', `Open ${info.name} with`);
  if (problem) add('mnote', `The saved app could not open it (${problem}).`);
  if (info.asText) add('mnote', 'macOS has no app for this type of file. These open plain text.');
  const always = document.createElement('input');
  always.type = 'checkbox';
  const choose = async (app) => {
    closeMenu();
    const r = await api('/api/open', { method: 'POST', body: { space, path: rel, app, remember: always.checked } }).catch(() => null);
    if (!r?.ok) return toast(r?.error || 'Could not open it.');
    if (r.view && !viewFile(space, rel)) return;
    toast(`Opened ${info.name} in ${r.app}.${r.remembered && always.checked ? ` ${info.kind} files will open there from now on.` : ''}`);
  };
  const item = (label, app) => {
    const b = document.createElement('button');
    b.textContent = `${info.saved === app ? '✓ ' : ''}${label}`;
    b.onclick = () => choose(app);
    m.append(b);
  };
  // The checkbox goes above the list, which can be long, so it is seen before an app is picked.
  const lab = document.createElement('label');
  lab.className = 'always';
  lab.append(always, document.createTextNode(`Always open ${info.kind} files this way`));
  m.append(lab, Object.assign(document.createElement('div'), { className: 'msep' }));
  if (info.viewable) item('View in Corral', 'corral');
  const label = (a) => `${a.name}${a.path === info.def ? ' (macOS default)' : ''}`;
  const first = [info.saved, info.def].filter((p, i, l) => p && l.indexOf(p) === i);
  for (const p of first) { const a = info.apps.find((x) => x.path === p); if (a) item(label(a), a.path); }
  for (const a of info.apps) if (!first.includes(a.path)) item(label(a), a.path);
  if (!info.apps.length) add('mnote', 'No app on this Mac offers to open it.');
  m.append(Object.assign(document.createElement('div'), { className: 'msep' }));
  item('Show in Finder', 'finder');
  if (info.saved) {
    const saved = info.saved === 'system' ? 'the macOS default' : info.saved === 'corral' ? 'Corral' : info.apps.find((a) => a.path === info.saved)?.name || info.saved.split('/').pop();
    const f = document.createElement('button');
    f.className = 'forget';
    f.textContent = `Forget ${saved} for ${info.kind} files`;
    f.onclick = async () => { closeMenu(); await api('/api/open-with/forget', { method: 'POST', body: { kind: info.kind } }); toast(`Corral will ask again for ${info.kind} files.`); };
    m.append(f);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y };
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 288))}px`;
  m.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8))}px`;
  openMenu = m;
  m.querySelector('button')?.focus();
}

function renameCategory(c, h) {
  const inp = document.createElement('input');
  inp.value = c.name;
  inp.className = 'catname';
  const nm = h.querySelector('.cn');
  nm.replaceWith(inp);
  inp.focus(); inp.select();
  const done = (commit) => {
    const n = inp.value.trim().slice(0, 40);
    if (commit && n && n !== c.name && !cats.categories.some((x) => x.name === n)) {
      for (const k of Object.keys(cats.assign)) if (cats.assign[k] === c.name) cats.assign[k] = n;
      c.name = n; saveCats();
    }
    arrange();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
  inp.onclick = (e) => e.stopPropagation();
}

// One collapsible group header. c is a category, or null for Uncategorized.
function groupHeader(c, count, forceOpen) {
  const h = document.createElement('div');
  h.className = 'sec cat';
  const collapsed = c ? c.collapsed : cats.uncatCollapsed;
  const chev = document.createElement('span'); chev.className = 'cc'; chev.textContent = forceOpen || !collapsed ? '▾' : '▸';
  const nm = document.createElement('span'); nm.className = 'cn'; nm.textContent = c ? c.name : 'Uncategorized';
  const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = count;
  h.append(chev, nm, ct);
  h.onclick = () => { if (c) c.collapsed = !c.collapsed; else cats.uncatCollapsed = !cats.uncatCollapsed; saveCats(); arrange(); };
  if (c) {
    const acts = document.createElement('span'); acts.className = 'acts';
    const btn = (t, tip, fn) => { const b = document.createElement('button'); b.textContent = t; b.title = tip; b.onclick = (e) => { e.stopPropagation(); fn(b); }; acts.append(b); return b; };
    const i = cats.categories.indexOf(c);
    if (i > 0) btn('↑', 'Move up', () => { cats.categories.splice(i, 1); cats.categories.splice(i - 1, 0, c); saveCats(); arrange(); });
    if (i < cats.categories.length - 1) btn('↓', 'Move down', () => { cats.categories.splice(i, 1); cats.categories.splice(i + 1, 0, c); saveCats(); arrange(); });
    btn('✎', 'Rename', () => renameCategory(c, h));
    btn('×', 'Delete this category (its spaces become Uncategorized)', (b) => {
      if (b.dataset.sure) { cats.categories.splice(i, 1); saveCats(); arrange(); return; }
      b.dataset.sure = '1'; b.textContent = 'Delete?';
      setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = '×'; } }, 3000);
    });
    h.append(acts);
  }
  wireCatDrop(h, () => (c ? c.name : null)); // drop dragged spaces here to file them in this group
  return h;
}

// The sidebar lists folded by a click on their heading, on this browser (category groups are kept on the server).
const folded = new Set(load('corral.folded', []));
function arrange() {
  const box = $('#spaces');
  const q = $('#filter').value.trim().toLowerCase();
  const shown = shownSpaces(q);
  const openSpaces = openFirst(shown);
  // A cleared window finishes its TO-DO or Later item.
  const done = spaces.filter((s) => (isTodo(s) || isLater(s)) && hasWindow(s) && isCleared(s));
  if (done.length) {
    const gone = new Set(done.map((s) => s.root));
    cats.todo = cats.todo.filter((r) => !gone.has(r)); cats.later = cats.later.filter((r) => !gone.has(r));
    saveCats();
  }
  const newest = (a, b) => (hasWindow(b) ? lastChange(b) : 0) - (hasWindow(a) ? lastChange(a) : 0);
  const todo = shown.filter(isTodo).sort(newest), later = shown.filter(isLater).sort(newest);
  drawn = { q, order: orderKey(openSpaces) };
  const rest = shown.filter((s) => !openSpaces.includes(s) && !todo.includes(s) && !later.includes(s));
  rows.forEach((wrap) => wrap.remove());
  box.querySelectorAll('.sec, .note').forEach((n) => n.remove());
  // A heading over a list folds it: a click hides or shows the spaces under it. A search shows every list.
  const sec = (key, t, list) => {
    const h = document.createElement('div');
    const shut = !q && folded.has(key);
    h.className = `sec fold${shut ? ' shut' : ''}`;
    h.textContent = t;
    h.title = shut ? 'Show these spaces' : 'Hide these spaces';
    h.onclick = () => { if (!folded.delete(key)) folded.add(key); store('corral.folded', [...folded]); arrange(); };
    box.append(h);
    if (!shut) put(list);
  };
  const put = (list) => { for (const s of list) box.append(rows.get(s.id)); };

  if (todo.length) {
    sec('todo', `TO-DO (${todo.length})`, []);
    const h = box.lastChild;
    h.classList.add('todo');
    wireCatDrop(h, null, (l) => setTodo(l, true));
    if (!h.classList.contains('shut')) put(todo);
  }
  const marked = (s) => todo.includes(s) || later.includes(s);
  const working = openSpaces.filter((s) => !marked(s) && !isCleared(s) && !isCompacted(s));
  const compacted = openSpaces.filter((s) => !marked(s) && isCompacted(s)), cleared = openSpaces.filter(isCleared);
  if (working.length) sec('open', `Open windows (${working.length})`, working);
  if (compacted.length) sec('compacted', `Auto-compacted windows (${compacted.length})`, compacted);
  if (cleared.length) sec('parked', `Parked windows (${cleared.length})`, cleared);
  if (later.length) {
    sec('later', `Later (${later.length})`, []);
    const h = box.lastChild;
    h.classList.add('later');
    wireCatDrop(h, null, (l) => setMark(l, 'later', true));
    if (!h.classList.contains('shut')) put(later);
  }
  if (!cats.categories.length) {
    if (openSpaces.length && rest.length) sec('all', `All spaces (${rest.length})`, rest); else put(rest);
  } else {
    // A search opens every group that has a match, so a name is easy to find.
    const buckets = new Map(cats.categories.map((c) => [c.name, []]));
    const none = [];
    for (const s of rest) (buckets.get(catOf(s)) || none).push(s);
    for (const c of cats.categories) {
      const list = buckets.get(c.name);
      if (q && !list.length) continue;
      box.append(groupHeader(c, list.length, Boolean(q)));
      if (q || !c.collapsed) put(list);
    }
    if (none.length || !q) {
      box.append(groupHeader(null, none.length, Boolean(q)));
      if (q || !cats.uncatCollapsed) put(none);
    }
  }
  rows.forEach((wrap, id) => wrap.querySelector('.space').classList.toggle('has-win', openSpaces.some((s) => s.id === id)));
  paintDots();
  for (const s of spaces) if (catOf(s) !== null) fresh.delete(s.id);
  rows.forEach((wrap, id) => wrap.querySelector('.space').classList.toggle('fresh', fresh.has(id)));
  if (!shown.length) { const n = document.createElement('div'); n.className = 'note'; n.textContent = 'No spaces.'; box.append(n); }

  lastShown = q ? shown : [];
  syncSel();
}

// The bar under the search box: moves the selected spaces, or else every search match.
let lastShown = [];
function renderBulk() {
  const bulk = $('#bulk');
  const list = selected.size ? spaces.filter((s) => selected.has(s.id)) : lastShown;
  bulk.hidden = !(list.length && cats.categories.length);
  if (bulk.hidden) return;
  bulk.textContent = '';
  const sel = document.createElement('select');
  const noun = selected.size ? `${list.length} selected` : `${list.length} match${list.length === 1 ? '' : 'es'}`;
  sel.append(new Option(`Move ${noun} to...`, ''));
  for (const c of cats.categories) sel.append(new Option(c.name, `c:${c.name}`));
  sel.append(new Option('Uncategorized', 'none'));
  sel.onchange = () => { if (sel.value) assignTo(list, sel.value === 'none' ? null : sel.value.slice(2)); };
  bulk.append(sel);
  if (selected.size) {
    const clr = document.createElement('button');
    clr.textContent = 'Clear';
    clr.title = 'Clear the selection (Esc)';
    clr.onclick = () => { selected.clear(); syncSel(); };
    bulk.append(clr);
  }
}

function buildRows() {
  rows.clear();
  $('#spaces').textContent = '';
  for (const s of spaces) {
    const wrap = document.createElement('div');
    rows.set(s.id, wrap);
    const d = document.createElement('div');
    d.className = 'space';
    d.dataset.id = s.id;
    d.title = `${s.root || s.cwd || ''}\nClick to open. Cmd-click or Shift-click to select several.\nRight-click, or drag onto a group, to move.`;
    d.innerHTML = `<span class="chev" title="Show files"></span><span class="dot ${spaceDot(s)}"></span><span class="name"></span><span class="more" title="Move to a category">⋯</span>`;
    d.querySelector('.name').textContent = s.label;
    d.onclick = (e) => {
      if (e.metaKey || e.ctrlKey) {
        selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id);
        lastPick = s.id;
        return syncSel();
      }
      if (e.shiftKey) {
        const ids = [...document.querySelectorAll('#spaces .space')].map((x) => x.dataset.id);
        const a = ids.indexOf(lastPick ?? s.id), b = ids.indexOf(s.id);
        for (const id of ids.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1)) selected.add(id);
        lastPick = s.id;
        return syncSel();
      }
      if (selected.size) { selected.clear(); return syncSel(); } // a plain click first ends a selection
      if ($('#filter').value) clearFilter(false); // a pick from a search shows the full list again
      spawn(s.cwd, s.label, s.id, $('#agent').value);
    };
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); catMenu(pickList(s), { x: e.clientX, y: e.clientY }); });
    d.draggable = true; // drag onto a group header or any row in a group to file it there
    d.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-corral-space', pickList(s).map((x) => x.id).join('\n'));
      e.dataTransfer.effectAllowed = 'move';
    });
    wireCatDrop(d, () => catOf(s));
    d.querySelector('.more').onclick = (e) => { e.stopPropagation(); catMenu(pickList(s), e.currentTarget); };
    const tree = document.createElement('div');
    tree.className = 'tree';
    const chev = d.querySelector('.chev');
    const sync = () => {
      const open = expanded.has(s.id);
      chev.textContent = open ? '▾' : '▸';
      tree.hidden = !open;
      if (open) fillTree(tree, s.id, '');
    };
    chev.onclick = (e) => {
      e.stopPropagation();
      expanded.has(s.id) ? expanded.delete(s.id) : expanded.add(s.id);
      store('corral.expanded', [...expanded]);
      sync();
    };
    sync();
    wrap.append(d, tree);
  }
}

const expanded = new Set(load('corral.expanded', []));

// Lists one folder of a space's project. Names go in with textContent, never innerHTML,
// because file names are untrusted text.
async function fillTree(box, spaceId, rel) {
  box.textContent = '';
  const note = (t) => { const n = document.createElement('div'); n.className = 'note'; n.textContent = t; box.append(n); };
  note('Loading...');
  let r;
  try {
    const q = `space=${encodeURIComponent(spaceId)}&path=${encodeURIComponent(rel)}&hidden=${$('#hidden').checked ? 1 : 0}`;
    r = await (await fetch(`/api/files?${q}`)).json();
  } catch { box.textContent = ''; return note('Could not load files.'); }
  box.textContent = '';
  if (r.error) return note(r.error);
  if (!r.entries.length) return note('(empty)');
  for (const e of r.entries) {
    const row = document.createElement('div');
    row.className = `node ${e.type}`;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = e.type === 'dir' ? '▸' : '';
    const nm = document.createElement('span');
    nm.textContent = e.name;
    row.append(ic, nm);
    if (e.link) { const l = document.createElement('span'); l.className = 'lk'; l.textContent = '↪'; row.append(l); }
    box.append(row);
    if (e.type === 'file') {
      const fileRel = rel ? `${rel}/${e.name}` : e.name;
      row.title = 'Click to open. Right-click to choose the app.';
      row.onclick = () => openTreeFile(spaceId, fileRel, row);
      row.oncontextmenu = (ev) => { ev.preventDefault(); openWithMenu(spaceId, fileRel, { x: ev.clientX, y: ev.clientY }); };
    }
    if (e.type === 'dir') {
      const kids = document.createElement('div');
      kids.style.paddingLeft = '14px';
      box.append(kids);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      row.onclick = () => {
        const open = kids.childNodes.length > 0;
        kids.textContent = '';
        ic.textContent = open ? '▸' : '▾';
        if (!open) fillTree(kids, spaceId, childRel);
      };
    }
  }
  if (r.truncated) note('List cut off at 1000 entries.');
}
// Spaces made in herdr after the page loaded show up on ↻ and on a check every 10 seconds while the page
// is showing. One that lands in Uncategorized while there are groups is announced and marked "new" until
// it is filed. The automatic check rebuilds the rows only when a space came, went, or changed its name or
// folder (a rebuild refetches open file trees); otherwise it just updates the status dots, and it leaves
// the list alone when herdr does not answer.
let known = null; // space ids from herdr's last answer; null until it first answers
const fresh = new Set();
const shape = (list) => JSON.stringify(list.map((s) => [s.id, s.label, s.root, s.cwd]));
const andList = (a) => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')}, and ${a.at(-1)}`);
async function loadSpaces(auto) {
  const r = await api('/api/herdr');
  if (auto && (!r.available || shape(r.spaces) === shape(spaces))) {
    if (r.available) { spaces = r.spaces; paintDots(); }
    return loadProjects(); // picks up a repo made since the last check
  }
  spaces = r.spaces;
  if (!r.available) { $('#spaces').textContent = `herdr not reachable: ${r.error}`; return loadProjects(); }
  const added = known && cats.categories.length ? spaces.filter((s) => !known.has(s.id) && catOf(s) === null) : [];
  known = new Set(spaces.map((s) => s.id));
  for (const s of added) fresh.add(s.id);
  renderSpaces();
  loadProjects();
  if (added.length === 1) toast(`New herdr space ${added[0].label} is in Uncategorized. Drag it onto a group to file it.`);
  else if (added.length) toast(`${added.length} new herdr spaces are in Uncategorized: ${andList(added.map((s) => s.label))}. Drag them onto a group to file them.`);
}

// Ledger of every project herdr has shown the server. "Inactive" means no space is open for it.
// New repos are git folders made in the repos folder lately that herdr has never had a space for.
let projects = [];
let newRepos = [];
let reposDir = '';
let inactiveOpen = load('corral.inactiveOpen', true);
async function loadProjects() {
  try { ({ projects, newRepos = [], reposDir } = await api('/api/projects')); } catch { projects = []; newRepos = []; }
  renderInactive();
}

// A row for a repo with no space. Add makes the space, which then arrives in the sidebar like any new
// space (announced, marked new).
function repoRow(p, name, cls) {
  const r = document.createElement('div');
  r.className = `proj ${cls}`;
  r.title = p.root;
  const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = name;
  const add = document.createElement('button'); add.textContent = 'Add to herdr';
  add.title = 'Create a herdr space for this folder';
  add.onclick = async () => {
    add.disabled = true; add.textContent = '...';
    const res = await api('/api/projects/reopen', { method: 'POST', body: { root: p.root } });
    if (res.error) { add.textContent = 'Failed'; add.title = res.error; return; }
    otherRepos = null; otherLoad = null; // the folder now has a space
    loadSpaces();
  };
  r.append(nm, add);
  return r;
}

function renderNewRepos(box) {
  if (!newRepos.length) return;
  const h = document.createElement('div');
  h.className = 'sec';
  h.textContent = `New in ${reposDir} (${newRepos.length})`;
  box.append(h);
  for (const p of newRepos) {
    const r = repoRow(p, p.label, 'newrepo');
    const when = document.createElement('span'); when.className = 'ago'; when.textContent = ago(p.born);
    r.querySelector('.name').after(when);
    const hide = document.createElement('button'); hide.textContent = '×'; hide.title = 'Do not list this folder here again';
    hide.onclick = async () => { await api('/api/projects/hide', { method: 'POST', body: { root: p.root } }); loadProjects(); };
    r.append(hide);
    box.append(r);
  }
}

// Other repos: every git repo in the repos folder (two folders deep) with no space that is not listed
// above, such as a project that was closed and then forgotten. Only a search shows them, so they are
// fetched on the first search and dropped when the search box is emptied.
let otherRepos = null;
let otherLoad = null; // the timer that starts the fetch; it stays set until the search is emptied
async function loadOtherRepos() {
  try { ({ repos: otherRepos } = await api('/api/projects/other')); } catch { otherRepos = []; }
  renderInactive();
}
const OTHER_MAX = 30;
const OTHER_WAIT = 250;
function renderOtherRepos(box, list) {
  if (!list.length) return;
  const h = document.createElement('div');
  h.className = 'sec';
  h.textContent = `Other repos in ${reposDir} (${list.length})`;
  box.append(h);
  for (const p of list.slice(0, OTHER_MAX)) box.append(repoRow(p, p.rel, 'otherrepo'));
  if (list.length > OTHER_MAX) { const n = document.createElement('div'); n.className = 'note'; n.textContent = `${list.length - OTHER_MAX} more. Type more of the name.`; box.append(n); }
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

function renderInactive() {
  const box = $('#inactive');
  box.textContent = '';
  renderNewRepos(box);
  const q = $('#filter').value.toLowerCase();
  const others = q && otherRepos ? otherRepos.filter((p) => p.rel.toLowerCase().includes(q)) : [];
  renderInactiveList(box, q, others);
  renderOtherRepos(box, others);
}

function renderInactiveList(box, q, others) {
  const list = projects.filter((p) => !p.open && (p.label.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)));
  const all = projects.filter((p) => !p.open).length;
  if (!all) return;
  const h = document.createElement('div');
  h.className = 'sec tog';
  h.textContent = `${inactiveOpen ? '▾' : '▸'} Inactive projects (${all})`;
  h.onclick = () => { inactiveOpen = !inactiveOpen; store('corral.inactiveOpen', inactiveOpen); renderInactive(); };
  box.append(h);
  if (!inactiveOpen) return;
  for (const p of list) {
    const r = document.createElement('div');
    r.className = `proj${p.exists ? '' : ' gone'}`;
    r.title = p.exists ? p.root : `${p.root} (folder no longer exists)`;
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = p.label;
    const when = document.createElement('span'); when.className = 'ago'; when.textContent = ago(p.lastSeen);
    const re = document.createElement('button'); re.textContent = 'Reopen'; re.disabled = !p.exists;
    re.title = 'Create a herdr space for this folder';
    re.onclick = async () => {
      re.disabled = true; re.textContent = '...';
      const res = await api('/api/projects/reopen', { method: 'POST', body: { root: p.root } });
      if (res.error) { re.textContent = 'Failed'; re.title = res.error; nm.title = res.error; return; }
      loadSpaces();
    };
    const fg = document.createElement('button'); fg.textContent = '×'; fg.title = 'Forget this project (removes it from the ledger only)';
    fg.onclick = async () => { await api('/api/projects/forget', { method: 'POST', body: { root: p.root } }); loadProjects(); };
    r.append(nm, when, re, fg);
    box.append(r);
  }
  if (!list.length && !others.length) { const n = document.createElement('div'); n.className = 'note'; n.textContent = 'No match.'; box.append(n); }
}

$('#filter').oninput = () => {
  const q = $('#filter').value;
  $('#clearfilter').hidden = !q;
  // The fetch waits a moment, so a quick search that is emptied again asks for nothing.
  if (!q) { clearTimeout(otherLoad); otherRepos = null; otherLoad = null; } else if (!otherLoad) otherLoad = setTimeout(loadOtherRepos, OTHER_WAIT);
  arrange(); renderInactive();
};
// The x in the search box, or Escape while typing in it, empties the search and stays in the box. Opening
// a space from the results empties it too, but leaves the keyboard with the window that opens.
const clearFilter = (refocus = true) => { $('#filter').value = ''; $('#filter').oninput(); if (refocus) $('#filter').focus(); };
$('#clearfilter').onclick = () => clearFilter();
$('#filter').onkeydown = (e) => { if (e.key === 'Escape' && e.target.value) clearFilter(); };
$('#newcat').onclick = () => { $('#newcatrow').hidden = !$('#newcatrow').hidden; if (!$('#newcatrow').hidden) $('#newcatname').focus(); };
$('#newcatname').onkeydown = (e) => {
  if (e.key === 'Enter') { addCategory(e.target.value); e.target.value = ''; $('#newcatrow').hidden = true; arrange(); }
  if (e.key === 'Escape') { e.target.value = ''; $('#newcatrow').hidden = true; }
};
const setAll = (collapsed) => { cats.categories.forEach((c) => { c.collapsed = collapsed; }); cats.uncatCollapsed = collapsed; saveCats(); arrange(); };
$('#expall').onclick = () => setAll(false);
$('#colall').onclick = () => setAll(true);
$('#hidden').checked = load('corral.hidden', false);
$('#hidden').onchange = () => { store('corral.hidden', $('#hidden').checked); renderSpaces(); };
$('#refresh').onclick = () => loadSpaces();
$('#newshell').onclick = () => spawn(null, 'shell');

// New project, as the phone's Start sheet makes one: a folder in the repos folder with a git repo and a herdr
// space, then a window in it that opens as "A space opens" says. Enter makes it; Esc or leaving the box closes it.
$('#newproj').onclick = () => {
  const box = $('#newprojname');
  box.hidden = !box.hidden;
  box.placeholder = `Folder name in ${reposDir || '~/repos'}, then Enter`;
  if (!box.hidden) box.focus();
};
$('#newprojname').onblur = (e) => { if (!e.target.value) e.target.hidden = true; };
$('#newprojname').onkeydown = async (e) => {
  const box = e.target;
  if (e.key === 'Escape') { box.value = ''; box.hidden = true; return; }
  if (e.key !== 'Enter' || !box.value.trim() || box.disabled) return;
  box.disabled = true;
  const r = await fetch('/api/projects/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: box.value.trim() }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  box.disabled = false;
  if (!r?.ok) { box.focus(); return toast(r ? j.error || 'Could not make the folder.' : 'Could not reach Corral.'); }
  box.value = ''; box.hidden = true;
  if (!j.space) toast(`Made ${j.root.replace(/^\/Users\/[^/]+/, '~')}, but herdr has no space for it: ${j.warning}`);
  spawn(j.root, j.label, j.space, $('#agent').value);
  loadSpaces(true).catch(() => {});
};
$('#agent').value = load('corral.agent', 'claude');
$('#agent').onchange = () => store('corral.agent', $('#agent').value);
$('#cols').value = load('corral.cols', 2);
$('#cols').onchange = () => { store('corral.cols', $('#cols').value); layout(); };
$('#rows').value = load('corral.rows', 'auto');
$('#rows').onchange = () => { store('corral.rows', $('#rows').value); layout(); };
new ResizeObserver(() => layout()).observe($('#grid'));
$('#laybtn').onclick = (e) => { e.stopPropagation(); buildLayoutMenu(); $('#laymenu').hidden = !$('#laymenu').hidden; };
// Shortcuts: a reminder of the keys and clicks that work on this page, written out in index.html.
const showKeys = (on) => { $('#keysmenu').hidden = !on; $('#keysbtn').setAttribute('aria-expanded', String(on)); };
$('#keysbtn').onclick = () => showKeys($('#keysmenu').hidden);
document.addEventListener('click', (e) => {
  if (!e.target.closest('#laywrap')) $('#laymenu').hidden = true;
  if (!e.target.closest('#keyswrap')) showKeys(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#laymenu').hidden = true; showKeys(false); } });

// ---- Text size. Every window uses the size for all windows unless it has one of its own. Cmd-= and Cmd-- in a
// window change its own size (Cmd-0 puts it back), and the command palette changes it for all windows. Kept in
// this browser. Elsewhere on the page those keys still zoom the browser.
const FONT = { def: 13, min: 9, max: 24 };
const clampFont = (n) => Math.min(FONT.max, Math.max(FONT.min, Math.round(Number(n) || FONT.def)));
let fontAll = clampFont(load('corral.fontSize', FONT.def));
const fontOne = load('corral.fontSizes', {}); // window id -> its own size
function fontOf(id) { return fontOne[id] ? clampFont(fontOne[id]) : fontAll; }
function applyFont(w) {
  const n = fontOf(w.info.id);
  if (w.term.options.fontSize === n) return;
  w.term.options.fontSize = n;
  w.fit.fit();
}
// id names one window; null sets the size for all windows and drops each window's own size.
function setFont(id, n) {
  n = clampFont(n);
  if (id) {
    if (n === fontAll) delete fontOne[id]; else fontOne[id] = n;
  } else {
    fontAll = n;
    for (const k of Object.keys(fontOne)) delete fontOne[k];
    store('corral.fontSize', n);
  }
  store('corral.fontSizes', fontOne);
  open.forEach(applyFont);
  toast(id ? `Text size ${n} in ${open.get(id).info.label}.` : `Text size ${n} in every window.`);
}
function forgetFont(id) {
  if (!(id in fontOne)) return;
  delete fontOne[id];
  store('corral.fontSizes', fontOne);
}

// ---- Find in a window's scrollback (Cmd-F in a window): a bar under its title, with the previous and next match.
// What a window can search is what this page has received for it, up to 5,000 lines. A program on the
// alternate screen (a full-screen editor) has no scrollback there.
function openFind(w) {
  let bar = w.el.querySelector('.find');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'find';
    bar.innerHTML = '<input placeholder="Find in this window" aria-label="Find in this window" spellcheck="false" autocomplete="off"><span class="fnote"></span><button class="fprev" title="Previous match (Shift-Enter)">&#8593;</button><button class="fnext" title="Next match (Enter)">&#8595;</button><button class="fclose" title="Close (Esc)">&times;</button>';
    const input = bar.querySelector('input');
    const go = (back) => {
      const q = input.value;
      if (!q) { bar.querySelector('.fnote').textContent = ''; return; }
      const hit = back ? w.search.findPrevious(q) : w.search.findNext(q);
      bar.querySelector('.fnote').textContent = hit ? '' : 'No match';
    };
    input.oninput = () => go(false);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(w); }
    };
    bar.querySelector('.fprev').onclick = () => go(true);
    bar.querySelector('.fnext').onclick = () => go(false);
    bar.querySelector('.fclose').onclick = () => closeFind(w);
    (w.el.querySelector('.lastprompt') || w.el.querySelector('.title')).after(bar);
    requestAnimationFrame(() => w.fit.fit());
  }
  const input = bar.querySelector('input');
  input.focus();
  input.select();
}
function closeFind(w) {
  w.el.querySelector('.find')?.remove();
  w.term.clearSelection();
  requestAnimationFrame(() => w.fit.fit());
  w.term.focus();
}

// ---- Saved layouts: a name for the current layout and the spaces in its zones, kept in this browser. Using one
// opens a window for each of its spaces that has none (as a click on the space does), puts each in its zone,
// and minimizes the other windows. Nothing is closed.
let savedLayouts = load('corral.savedLayouts', []);
const windowForSpace = (sid) => [...open.values()].find((w) => w.info.space === sid && !w.exited);
function saveLayout(name) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) return false;
  const entry = { name, kind: layoutKind, cols: $('#cols').value, rows: $('#rows').value, spaces: slots.map((id) => open.get(id)?.info.space || null) };
  savedLayouts = [...savedLayouts.filter((l) => l.name !== name), entry];
  store('corral.savedLayouts', savedLayouts);
  const n = entry.spaces.filter(Boolean).length;
  toast(`Saved "${name}": ${layoutName(entry.kind)} with ${n} space${n === 1 ? '' : 's'}.`);
  return true;
}
function deleteLayout(name) {
  const gone = savedLayouts.find((l) => l.name === name);
  savedLayouts = savedLayouts.filter((l) => l.name !== name);
  store('corral.savedLayouts', savedLayouts);
  toast(`Deleted the layout "${name}".`, () => { savedLayouts = [...savedLayouts, gone]; store('corral.savedLayouts', savedLayouts); });
}
const layoutName = (kind) => (kind === 'auto' ? 'Auto' : kind === 'grid' ? 'Grid' : LAYOUTS[kind]?.name || 'Auto');
async function applyLayout(l) {
  layoutKind = l.kind === 'grid' || LAYOUTS[l.kind] ? l.kind : 'auto';
  store('corral.layout', layoutKind);
  if (layoutKind === 'grid') {
    $('#cols').value = l.cols; $('#rows').value = l.rows;
    store('corral.cols', $('#cols').value); store('corral.rows', $('#rows').value);
  }
  const missing = [];
  for (const sid of l.spaces) {
    if (!sid || windowForSpace(sid)) continue;
    const s = spaces.find((x) => x.id === sid);
    if (s) await spawn(s.cwd, s.label, s.id, $('#agent').value); else missing.push(sid);
  }
  const want = l.spaces.map((sid) => (sid && windowForSpace(sid)?.info.id) || null);
  for (const id of open.keys()) { if (want.includes(id)) minimized.delete(id); else minimized.add(id); }
  tray = tray.filter((id) => !want.includes(id));
  slots = want;
  layout();
  const first = want.find(Boolean);
  if (first) setFocus(first);
  toast(`Using "${l.name}".${missing.length ? ` ${missing.length} of its spaces no longer exist${missing.length === 1 ? 's' : ''}.` : ''}`);
}
// The saved layouts at the foot of the Layout menu, each with an ×, then a box to save the current one.
function savedLayoutsMenu(menu) {
  const head = document.createElement('div');
  head.className = 'savedhead';
  head.textContent = 'Saved layouts';
  menu.append(head);
  for (const l of savedLayouts) {
    const row = document.createElement('div');
    row.className = 'savedrow';
    const use = Object.assign(document.createElement('button'), { className: 'saveduse', textContent: l.name, title: `${layoutName(l.kind)}: ${l.spaces.filter(Boolean).map((sid) => spaces.find((x) => x.id === sid)?.label || 'a closed space').join(', ') || 'no spaces'}` });
    use.onclick = () => { menu.hidden = true; applyLayout(l); };
    const del = Object.assign(document.createElement('button'), { className: 'saveddel', textContent: '×', title: `Delete "${l.name}"` });
    del.onclick = (e) => { e.stopPropagation(); deleteLayout(l.name); buildLayoutMenu(); };
    row.append(use, del);
    menu.append(row);
  }
  const input = Object.assign(document.createElement('input'), { className: 'savedname', placeholder: 'Save this layout as…', maxLength: 40 });
  input.onkeydown = (e) => { if (e.key === 'Enter' && saveLayout(input.value)) { menu.hidden = true; } };
  menu.append(input);
}

// ---- Command palette (Cmd-K): type to find a window, a space, a layout, or a page action, then Enter.
function focusedWindow() {
  const el = document.activeElement?.closest?.('.win');
  return [...open.values()].find((w) => (el ? w.el === el : w.info.id === focusedId));
}
// `w` is the window that had the keyboard when the palette opened.
function commands(w) {
  const out = [];
  const add = (label, hint, run) => out.push({ label, hint, run });
  for (const x of open.values()) add(`Go to ${x.info.label}`, minimized.has(x.info.id) || tray.includes(x.info.id) ? 'window, in the bottom bar' : 'window', () => (minimized.has(x.info.id) || tray.includes(x.info.id) ? restore(x.info.id) : setFocus(x.info.id)));
  for (const s of spaces) if (!windowForSpace(s.id)) add(`Open ${s.label}`, 'space', () => spawn(s.cwd, s.label, s.id, $('#agent').value));
  if (w) {
    add(`Find in ${w.info.label}`, 'Cmd-F', () => openFind(w));
    add(`Queue a prompt for ${w.info.label}`, w.queued ? `${w.queued} waiting` : 'queue', () => queueMenu(w, w.el.querySelector('.title .queue')));
    add(`Larger text in ${w.info.label}`, 'Cmd-=', () => setFont(w.info.id, fontOf(w.info.id) + 1));
    add(`Smaller text in ${w.info.label}`, 'Cmd--', () => setFont(w.info.id, fontOf(w.info.id) - 1));
    if (fontOne[w.info.id]) add(`Usual text size in ${w.info.label}`, 'Cmd-0', () => setFont(w.info.id, fontAll));
    const s = spaces.find((x) => x.id === w.info.space);
    if (s) add(`Past conversations in ${s.label}`, 'space', () => pastConversationsOf(s));
  }
  add('Larger text in every window', `now ${fontAll}`, () => setFont(null, fontAll + 1));
  add('Smaller text in every window', `now ${fontAll}`, () => setFont(null, fontAll - 1));
  if (fontAll !== FONT.def || Object.keys(fontOne).length) add('Usual text size in every window', String(FONT.def), () => setFont(null, FONT.def));
  for (const l of savedLayouts) add(`Use layout: ${l.name}`, 'saved layout', () => applyLayout(l));
  add('Save this layout…', 'saved layout', () => paletteAsk('Name for this layout, then Enter', saveLayout));
  for (const [k, v] of [['auto', { name: 'Auto' }], ['grid', { name: 'Grid' }], ...Object.entries(LAYOUTS)]) {
    add(`Layout: ${v.name}`, k === layoutKind ? 'in use' : 'layout', () => { layoutKind = k; store('corral.layout', k); buildLayoutMenu(); layout(); });
  }
  add('New shell', 'page', () => $('#newshell').click());
  add('New project', 'page', () => $('#newproj').click());
  add(`Theme: ${$('#theme').textContent.replace(/^Theme:\s*/, '')}, change it`, 'page', () => $('#theme').click());
  add(promptsOn ? 'Hide last prompts' : 'Show last prompts', 'page', () => setPrompts(!promptsOn));
  add(costOn ? 'Hide dollar amounts' : 'Show dollar amounts', 'page', () => setCost(!costOn));
  add('Shortcuts', 'page', () => showKeys(true));
  add('Scheduled Claude jobs', 'page', openJobs);
  return out;
}
// The words typed must each appear in the label; labels that start with what was typed come first.
function matches(list, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = list.filter((c) => words.every((t) => c.label.toLowerCase().includes(t)));
  const lead = q.trim().toLowerCase();
  return lead ? [...hits.filter((c) => c.label.toLowerCase().startsWith(lead)), ...hits.filter((c) => !c.label.toLowerCase().startsWith(lead))] : hits;
}
let palette = null; // { el, input, list, items, at, ask }
function closePalette() {
  palette.el.remove();
  const back = palette.back;
  palette = null;
  back?.focus?.();
}
function drawPalette() {
  const { list, input } = palette;
  palette.items = palette.ask ? [] : matches(commands(palette.win), input.value).slice(0, 50);
  palette.at = Math.min(palette.at, Math.max(0, palette.items.length - 1));
  list.replaceChildren(...palette.items.map((c, i) => {
    const row = document.createElement('div');
    row.className = `pitem${i === palette.at ? ' on' : ''}`;
    row.append(Object.assign(document.createElement('span'), { className: 'plabel', textContent: c.label }),
      Object.assign(document.createElement('span'), { className: 'phint', textContent: c.hint }));
    row.onmousedown = (e) => { e.preventDefault(); runPalette(i); };
    return row;
  }));
  if (!palette.ask && !palette.items.length) list.append(Object.assign(document.createElement('div'), { className: 'pnone', textContent: 'Nothing matches.' }));
  list.querySelector('.on')?.scrollIntoView?.({ block: 'nearest' });
}
function runPalette(i) {
  const c = palette.items[i];
  if (!c) return;
  const back = palette.back;
  palette.el.remove();
  palette = null;
  if (back) back.focus?.();
  c.run();
}
// The palette as a one-line question: Enter hands the text to `done`, which answers true to close it.
function paletteAsk(placeholder, done) {
  openPalette();
  palette.ask = done;
  palette.input.placeholder = placeholder;
  drawPalette();
}
function openPalette() {
  if (palette) return closePalette();
  const win = focusedWindow(); // before the palette takes the keyboard
  const el = document.createElement('div');
  el.id = 'palette';
  el.innerHTML = '<div class="pbox"><input aria-label="Command" placeholder="Type a window, a space, or a command" spellcheck="false" autocomplete="off"><div class="plist"></div></div>';
  el.onmousedown = (e) => { if (e.target === el) closePalette(); };
  document.body.append(el);
  palette = { el, input: el.querySelector('input'), list: el.querySelector('.plist'), items: [], at: 0, ask: null, win, back: document.activeElement };
  const { input } = palette;
  input.oninput = () => { palette.at = 0; drawPalette(); };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closePalette(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = palette.items.length;
      if (n) { palette.at = (palette.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; drawPalette(); }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (palette.ask) { if (palette.ask(input.value)) closePalette(); } else runPalette(palette.at);
    }
  };
  drawPalette();
  input.focus();
}
// Scheduled Claude jobs on each Mac (public/jobs.js), in a panel over the page. Esc or a click outside closes it.
function openJobs() {
  $('#jobspanel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'jobspanel';
  panel.innerHTML = '<div class="jbox"><div class="jhead"><b>Scheduled Claude jobs</b><button class="jclose" title="Close (Esc)">&times;</button></div><div class="jbody"></div></div>';
  const close = () => panel.remove();
  panel.onmousedown = (e) => { if (e.target === panel) close(); };
  panel.querySelector('.jclose').onclick = close;
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(panel);
  panel.querySelector('.jclose').focus();
  window.CorralJobs.show(panel.querySelector('.jbody'), { toast });
}
$('#jobsbtn').onclick = openJobs;

// Past conversations from the palette: the same panel the space menu shows, near the top of the page.
function pastConversationsOf(s) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'catmenu';
  m.style.left = `${Math.max(8, (innerWidth - 440) / 2)}px`;
  m.style.top = '64px';
  document.body.append(m);
  openMenu = m;
  historyPanel(m, s);
}

// Cmd-K anywhere; Cmd-F, Cmd-=, Cmd--, and Cmd-0 while a window has the keyboard. Taken before the terminal
// sees them, so none reaches the program in the window.
document.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const w = document.activeElement?.closest?.('.win') ? focusedWindow() : null;
  if (k === 'k' && !e.shiftKey) openPalette();
  else if (k === 'f' && w && !e.shiftKey) openFind(w);
  else if (w && (k === '=' || k === '+')) setFont(w.info.id, fontOf(w.info.id) + 1);
  else if (w && k === '-') setFont(w.info.id, fontOf(w.info.id) - 1);
  else if (w && k === '0') setFont(w.info.id, fontAll);
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

(async () => {
  layout();
  loadCats();
  loadSpaces();
  const { sessions } = await api('/api/sessions');
  const live = new Map(sessions.map((s) => [s.id, s]));
  const wanted = load('corral.open', []);
  suspend = true; // attach every window first, then restore where each one sat
  // Every running terminal gets a window, in the remembered order first. Closing a window ends its
  // shell, so a live one that this browser does not remember (its storage was cleared, or this is
  // another browser) would otherwise keep running with no way to reach it.
  for (const id of wanted) if (live.has(id) && !live.get(id).exited) attach(live.get(id));
  for (const s of sessions) if (!open.has(s.id) && !s.exited) attach(s);
  slots = (savedArrangement.slots || []).map((id) => (id && open.has(id) ? id : null));
  tray = (savedArrangement.tray || []).filter((id) => open.has(id));
  for (const id of [...minimized]) if (!open.has(id)) minimized.delete(id);
  suspend = false;
  ready = true;
  layout();
  // Started on another device while this page was closed: into the bottom bar, like the ones that start while it is open.
  for (const s of sessions) if (s.remote && !s.exited && !wanted.includes(s.id) && open.has(s.id)) minimize(s.id);
  // Handed a task just before this page opened (mail-triager opens Corral after sending one): in view.
  // Older ones are already dealt with.
  for (const s of sessions) {
    if (!s.summoned || s.exited) continue;
    summonSeen.set(s.id, s.summoned);
    if (Date.now() - s.summoned < SUMMON_FRESH_MS) showSummoned(s);
  }
  checkRestore();
  showPhoneLink();
  showHubLink();
  setInterval(pickUpNewWindows, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pickUpNewWindows(); });
  watchStatus();
  setInterval(watchStatus, 3000);
  setInterval(() => { if (!document.hidden) loadSpaces(true).catch(() => {}); }, 10000);
})();

// Each window's Claude status, every few seconds: the Allow and Deny bar for a permission prompt, names
// changed on another device, windows closed on another device, and desktop notifications.
const lastStatus = new Map();
let alertsOn = load('corral.alerts', false) && 'Notification' in window && Notification.permission === 'granted';
function showAlerts() { $('#alerts').textContent = `Alerts: ${alertsOn ? 'on' : 'off'}`; }
$('#alerts').onclick = async () => {
  if (!('Notification' in window)) return toast('This browser cannot show notifications.');
  if (!alertsOn && Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') {
    return toast('Notifications are blocked for this page in the browser settings.');
  }
  alertsOn = !alertsOn;
  store('corral.alerts', alertsOn);
  showAlerts();
  toast(alertsOn ? 'A notification will appear when a window needs you while Corral is in the background or the window is minimized.' : 'Desktop alerts are off.');
};
showAlerts();

// The last prompt you typed in each window, in a line under its title bar that stays in place while the
// terminal scrolls. A click lists every prompt in the conversation. Its × or the toolbar's Prompts button hides
// them, on this browser.
let promptsOn = load('corral.prompts', true);
function showPrompts() {
  $('#prompts').textContent = `Prompts: ${promptsOn ? 'on' : 'off'}`;
  for (const w of open.values()) paintPrompt(w);
}
function setPrompts(on) {
  promptsOn = on;
  store('corral.prompts', on);
  showPrompts();
  if (!on) toast('Last prompts are hidden. Prompts in the toolbar shows them again.');
}
$('#prompts').onclick = () => setPrompts(!promptsOn);
function paintPrompt(w) {
  const text = (promptsOn && w.claude?.lastPrompt) || null;
  if (text === (w.promptText || null)) return;
  w.promptText = text;
  let bar = w.el.querySelector('.lastprompt');
  if (!text) return bar?.remove();
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'lastprompt';
    bar.innerHTML = '<span class="pt"></span><button title="Hide the last prompt in every window">&times;</button>';
    bar.onclick = () => promptsMenu(w, bar);
    bar.querySelector('button').onclick = (e) => { e.stopPropagation(); setPrompts(false); };
    w.el.querySelector('.title').after(bar);
  }
  bar.querySelector('.pt').textContent = text;
  bar.title = 'Your last prompt (click for every prompt in this conversation)';
}

// Context use and an estimated cost in the title bar, with the details on hover (public/usage.js). A click on
// it, or the palette, hides or shows the dollar amount in every window, on this browser.
let costOn = load('corral.cost', true);
function paintUsage(w) {
  const el = w.el.querySelector('.title .use');
  const u = w.claude?.usage;
  el.hidden = !u;
  el.textContent = window.CorralUsage.text(u, { cost: costOn });
  el.title = u ? `${window.CorralUsage.title(u, { cost: costOn })}\nClick to ${costOn ? 'hide' : 'show'} the dollar amount.` : '';
}
function setCost(on) {
  costOn = on;
  store('corral.cost', on);
  for (const w of open.values()) paintUsage(w);
  toast(on ? 'Dollar amounts are shown.' : 'Dollar amounts are hidden. Click a usage tag to show them again.');
}

// The Queue button: on a Claude window, or any window with prompts waiting, with how many are waiting.
function paintQueue(w, n) {
  const b = w.el.querySelector('.title .queue');
  w.queued = n;
  b.hidden = !w.claude && !n;
  b.textContent = n ? `Queue ${n}` : 'Queue';
  b.classList.toggle('has', n > 0);
}
// Prompts waiting their turn in a window, in a menu under its Queue button: each with an ×, a box to add one,
// and Clear. The server types the next one in when Claude finishes and nothing is typed in its input box.
async function queueMenu(w, anchor) {
  const base = `/api/sessions/${encodeURIComponent(w.info.id)}/queue`;
  const r = await api(base).catch(() => null);
  if (!r?.items) return toast('Could not read the queue.');
  closeMenu();
  const m = document.createElement('div');
  m.className = 'catmenu queuemenu';
  const draw = (items) => {
    m.replaceChildren();
    paintQueue(w, items.length);
    m.append(Object.assign(document.createElement('div'), { className: 'mhead', textContent: items.length ? `Waiting to go to ${w.info.label}, in order` : `Nothing is waiting for ${w.info.label}` }));
    for (const it of items) {
      const row = m.appendChild(Object.assign(document.createElement('div'), { className: 'qrow' }));
      const del = Object.assign(document.createElement('button'), { className: 'qdel', textContent: '×', title: 'Take it out of the queue' });
      del.onclick = async (e) => {
        e.stopPropagation();
        const x = await api(base, { method: 'POST', body: { remove: it.id } }).catch(() => null);
        if (x?.items) draw(x.items); else toast(`Could not take it out${x?.error ? `: ${x.error}` : ''}.`);
      };
      row.append(Object.assign(document.createElement('span'), { className: 'qtext', textContent: it.text }), del);
    }
    const input = Object.assign(document.createElement('input'), { placeholder: 'A prompt to send when Claude finishes, then Enter', maxLength: 4000 });
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') return closeMenu();
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const x = await api(base, { method: 'POST', body: { text: input.value } }).catch(() => null);
      if (!x?.items) return toast(`Could not queue it${x?.error ? `: ${x.error}` : ''}.`);
      draw(x.items);
      m.querySelector('input').focus();
    };
    m.append(input);
    if (items.length) {
      const clear = Object.assign(document.createElement('button'), { className: 'danger', textContent: 'Clear the queue' });
      clear.onclick = async () => {
        const x = await api(base, { method: 'POST', body: { clear: true } }).catch(() => null);
        if (x?.items) draw(x.items); else toast('Could not clear the queue.');
      };
      m.append(clear);
    }
    m.append(Object.assign(document.createElement('div'), { className: 'murl', textContent: 'Corral types the next one in when Claude has finished and nothing is typed in its prompt box.' }));
  };
  draw(r.items);
  document.body.append(m);
  const b = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(b.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${b.bottom + 4}px`;
  openMenu = m;
  m.querySelector('input').focus();
}

// When a prompt was sent: the time today, else the date and time.
function sentAt(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
// Every prompt you typed in the window's conversation, oldest first, in a menu under its line that opens on
// the newest. It waits a turn so the click that opened it does not close it.
async function promptsMenu(w, bar) {
  const r = await api(`/api/sessions/${encodeURIComponent(w.info.id)}/prompts`).catch(() => null);
  if (!r?.prompts) return toast(`Could not list the prompts${r?.error ? `: ${r.error}` : ''}.`);
  setTimeout(() => {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'catmenu promptmenu';
    const add = (cls, text) => m.appendChild(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
    const n = r.prompts.length;
    add('mhead', `${n} prompt${n === 1 ? '' : 's'} in ${w.info.label}${r.cut ? ' (the most recent)' : ''}`);
    for (const p of r.prompts) {
      const row = m.appendChild(Object.assign(document.createElement('div'), { className: 'prow' }));
      row.append(Object.assign(document.createElement('span'), { className: 'pwhen', textContent: sentAt(p.at) }),
        Object.assign(document.createElement('span'), { className: 'ptext', textContent: p.text }));
    }
    document.body.append(m);
    const b = bar.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(b.left, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${b.bottom + 2}px`;
    m.style.maxHeight = `${Math.max(160, innerHeight - b.bottom - 12)}px`;
    m.scrollTop = m.scrollHeight;
    openMenu = m;
  });
}
showPrompts();
// A pop-out (pop.js) changed one of these settings: show it here too.
window.addEventListener('storage', (e) => {
  if (e.key === 'corral.cost') { costOn = load('corral.cost', true); open.forEach(paintUsage); }
  if (e.key === 'corral.prompts') { promptsOn = load('corral.prompts', true); showPrompts(); }
});

async function watchStatus() {
  const r = await api('/api/overview').catch(() => null);
  if (!r?.sessions) return;
  limitsStrip.paint(limitsEl, r.limits);
  const byId = new Map(r.sessions.map((s) => [s.id, s]));
  let relayout = false;
  for (const [id, w] of [...open]) {
    const s = byId.get(id);
    if (!s) { open.delete(id); w.ws?.close(); w.term.dispose(); w.slot.remove(); persist(); relayout = true; continue; } // closed on another device
    w.exited = s.exited;
    w.claude = s.claude;
    w.activity = s.activity;
    paint(w);
    paintPrompt(w);
    paintUsage(w);
    paintQueue(w, s.queued || 0);
    if (s.exited) continue;
    if (s.label !== w.info.label) { w.info.label = s.label; w.el.querySelector('.t').textContent = s.label; relayout = true; }
    const key = s.prompt?.key || null;
    if (key !== (w.askKey || null)) {
      w.askKey = key;
      w.el.querySelector('.ask')?.remove();
      w.asking = Boolean(s.prompt);
      w.el.classList.toggle('asking', w.asking);
      if (s.prompt) (w.el.querySelector('.lastprompt') || w.el.querySelector('.title')).after(askBar(s));
      requestAnimationFrame(() => w.fit.fit());
      relayout = true;
    }
    const now = s.claude?.status;
    const was = lastStatus.get(id);
    lastStatus.set(id, now);
    const unseen = document.hidden || minimized.has(id) || tray.includes(id);
    if (alertsOn && was && was !== now && unseen && !s.muted) {
      if (now === 'waiting') notify(`${s.label} needs you`, s.prompt ? 'Claude is asking for permission.' : 'Claude is waiting on a prompt.', id);
      else if (was === 'busy' && now === 'idle') notify(`${s.label}: your turn`, 'Claude finished and is waiting for you.', id);
    }
  }
  if (relayout) { layout(); arrange(); } else if (orderKey(openFirst(shownSpaces(drawn.q))) !== drawn.order) arrange(); // a window moved up the list
}

// What a window is doing, as a color and a line to hover: yellow while Claude works, green when it is your
// turn (finished, or asking), blue when it finished a /wrap-up with nothing typed since, red when the window
// lost its connection or its shell ended. A plain shell has none.
function stateOf(w) {
  if (w.exited) return ['blocked', 'The shell ended. Close this window.'];
  if (w.down) return ['blocked', 'Disconnected from Corral. Reconnecting…'];
  const st = w.claude?.status;
  if (st === 'busy') return ['working', 'Claude is working.'];
  if (st === 'waiting') return ['idle', w.claude.waitingFor === 'permission prompt' ? 'Claude is asking for permission.' : 'Claude is waiting on a prompt.'];
  if (st === 'idle' && /^\/wrap-up\b/.test(w.claude.lastPrompt || '')) return ['wrapped', 'Wrapped up: /wrap-up finished.'];
  if (st === 'idle') return ['idle', 'Your turn: Claude finished.'];
  return ['', ''];
}
function paint(w) {
  const [state, says] = stateOf(w);
  if (state) w.el.dataset.state = state; else delete w.el.dataset.state;
  const dot = w.el.querySelector('.title .dot');
  dot.className = `dot ${state}`;
  dot.title = says;
  const chip = document.querySelector(`#tray .chip[data-id="${w.info.id}"] .dot`);
  if (chip) chip.className = `dot ${state}`;
  paintDots();
}

function notify(title, body, id) {
  const n = new Notification(title, { body, tag: id, icon: '/apple-touch-icon.png' });
  n.onclick = () => { window.focus(); if (minimized.has(id) || tray.includes(id)) restore(id); setFocus(id); n.close(); };
}

// The answers to a permission prompt, as buttons. The terminal shows what Claude asks; Deny is Esc.
function askBar(s) {
  const bar = document.createElement('div');
  bar.className = 'ask';
  const b = document.createElement('b');
  b.textContent = 'Claude is asking for permission:';
  bar.append(b);
  const answer = async (choice, label) => {
    for (const x of bar.querySelectorAll('button')) x.disabled = true;
    const r = await fetch(`/api/sessions/${s.id}/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice, key: s.prompt.key }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    toast(r?.ok ? (choice === 'deny' ? `Denied. ${s.label} will ask what to do instead.` : `Answered: ${label}`) : j.error || 'Could not reach Corral.');
    setTimeout(watchStatus, 600);
  };
  s.prompt.options.filter((o) => !/^No\b/.test(o.label)).forEach((o, i) => {
    const btn = document.createElement('button');
    btn.className = i === 0 ? 'allow' : '';
    btn.textContent = o.label;
    btn.title = `Answer ${o.n}`;
    btn.onclick = () => answer(o.n, o.label);
    bar.append(btn);
  });
  const deny = document.createElement('button');
  deny.className = 'deny';
  deny.textContent = 'Deny';
  deny.title = 'Esc';
  deny.onclick = () => answer('deny', 'Deny');
  bar.append(deny);
  return bar;
}

// Windows started somewhere else (the phone page, another browser) show up here in the bottom bar.
// A window counts only once it has been seen twice without this page attaching it, so one this page
// is in the middle of creating is never picked up a second time.
// A window handed a task by another app (mail-triager's Mail action) is the exception: the server marks it
// `summoned`, and it comes into view at once, in a zone with the keyboard, since the task was sent to be
// worked on now. This page never sends a task itself, so such a window cannot be one it is creating.
let unclaimed = new Set();
const SUMMON_FRESH_MS = 30000;
const summonSeen = new Map(); // window id -> the `summoned` time already acted on
async function pickUpNewWindows() {
  const r = await api('/api/sessions').catch(() => null);
  if (!r?.sessions) return;
  const fresh = r.sessions.filter((s) => !s.exited && !open.has(s.id));
  const summoned = r.sessions.filter((s) => !s.exited && s.summoned && s.summoned !== summonSeen.get(s.id));
  const added = fresh.filter((s) => unclaimed.has(s.id) && !summoned.includes(s));
  for (const s of added) attach(s, true);
  if (added.length === 1) toast(`${added[0].label} was started ${added[0].remote ? 'on another device' : 'elsewhere'}. It is in the bottom bar.`);
  else if (added.length > 1) toast(`${added.length} windows were started elsewhere. They are in the bottom bar.`);
  for (const s of summoned) {
    summonSeen.set(s.id, s.summoned);
    const isNew = !open.has(s.id);
    showSummoned(s);
    toast(`${s.label} ${isNew ? 'was started with' : 'was given'} a task from another app. Here it is.`);
  }
  unclaimed = new Set(fresh.filter((s) => !open.has(s.id)).map((s) => s.id));
}

// A link to the page that lists every page on the tailnet, when the server knows its address.
async function showHubLink() {
  const r = await api('/api/hub').catch(() => null);
  if (!/^https?:\/\//i.test(r?.url || '')) return;
  const a = $('#hub');
  a.href = r.url;
  a.hidden = false;
}

// When Tailscale serves Corral, offer the link that opens it on a phone or another of your devices.
async function showPhoneLink() {
  const r = await api('/api/remote').catch(() => null);
  if (!r?.url || r.remote) return;
  const b = $('#phone');
  b.hidden = false;
  b.title = `Copy ${r.url}m, the link that opens Corral on your phone or another Tailscale device`;
  b.onclick = () => navigator.clipboard.writeText(`${r.url}m`)
    .then(() => toast(`Copied ${r.url}m. Open it on any device signed in to your Tailscale.`))
    .catch(() => toast(`Open ${r.url}m on any device signed in to your Tailscale.`));
}
