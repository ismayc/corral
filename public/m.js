const $ = (s) => document.querySelector(s);
const api = (url, opts = {}) => fetch(url, {
  ...opts, headers: { 'Content-Type': 'application/json' },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
function load(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
// Builds an element; strings become text nodes, never HTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el[k] = v; else if (v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
$('#toast').onclick = () => { $('#toast').hidden = true; };

// iOS shrinks the visual viewport, not the layout one, when the keyboard opens; follow it.
const vv = window.visualViewport;
function setVh() {
  if (!vv) return;
  document.documentElement.style.setProperty('--vh', `${vv.height}px`);
  window.scrollTo(0, 0);
  if (current) requestAnimationFrame(() => current.fit.fit());
}
vv?.addEventListener('resize', setVh);

const home = (p) => p?.replace(/^\/Users\/[^/]+/, '~') || '';
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
// Claude Code's own status: busy while it works, idle when it is waiting for you.
// "Waiting" is a prompt Claude cannot get past without you: a permission prompt, or another dialog.
function statusOf(w) {
  if (!w.claude) return { cls: '', text: 'Shell', rank: 2 };
  if (w.claude.status === 'waiting') return { cls: 'need', text: w.claude.waitingFor === 'permission prompt' ? 'Needs permission' : 'Waiting on a prompt', rank: 0, first: true };
  if (w.claude.status === 'busy') return { cls: 'busy', text: 'Working', rank: 1 };
  if (w.claude.status === 'idle') return { cls: 'idle', text: 'Your turn', rank: 0 };
  return { cls: '', text: 'Claude', rank: 1 };
}
const needsYou = (w) => w.claude?.status === 'idle' || w.claude?.status === 'waiting';

// What a permission prompt asks, with a button per answer. Esc denies; Claude Code's own "No" answer is
// left out because Deny does the same and is always there.
function askBlock(w, showText = true) {
  const p = w.prompt;
  const answer = async (choice, btn) => {
    for (const b of btn.parentNode.children) b.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(w.id)}/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice, key: p.key }),
      });
      const j = await r.json().catch(() => ({}));
      toast(r.ok ? (choice === 'deny' ? `Denied. ${w.label} will ask what to do instead.` : `Answered: ${btn.textContent}`) : j.error || 'Could not answer.');
    } catch { toast('Could not reach the Mac.'); }
    setTimeout(refresh, 600);
  };
  const stop = (e) => e.stopPropagation();
  return h('div', { class: 'ask', onclick: stop },
    showText ? h('pre', {}, p.text) : null,
    h('div', { class: 'answers' },
      ...p.options.filter((o) => !/^No\b/.test(o.label) || o.n === '1').map((o, i) => h('button', {
        class: i === 0 ? 'primary' : '', onclick: (e) => answer(o.n, e.currentTarget),
      }, o.label)),
      h('button', { class: 'deny', onclick: (e) => answer('deny', e.currentTarget) }, 'Deny')));
}
// The same prompt, under the terminal of the window that asks.
let askShown = '';
function renderAskbar(w) {
  const bar = $('#askbar');
  const key = w?.prompt ? JSON.stringify(w.prompt) : '';
  if (key === askShown) return;
  askShown = key;
  bar.hidden = !key;
  // The terminal above already shows what Claude asks, so the bar has only the answers.
  if (key) bar.replaceChildren(h('div', { class: 'head' }, 'Claude is asking for permission. Answer:'), askBlock(w, false));
  requestAnimationFrame(() => current?.fit.fit());
}

// How long Claude has been working, from the session file's statusUpdatedAt.
function took(since) {
  const m = Math.max(0, Math.round((Date.now() - since) / 60000));
  return m < 1 ? 'just started' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
// The terminal's subtitle: status, mode, and folder.
const termSub = (w) => [statusOf(w).text, w.claude?.mode ? modeName(w.claude.mode) : null, home(w.cwd)].filter(Boolean).join(' · ');
const modeName = (m) => (/mode$|edits$/.test(m) ? m : `${m} mode`).replace(/^./, (c) => c.toUpperCase());

// Stop (Esc) and next mode (Shift-Tab), sent without opening the window.
async function cardKey(w, key) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(w.id)}/key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
    });
    const j = await r.json().catch(() => ({}));
    toast(r.ok ? (key === 'stop' ? `Stopped ${w.label}. It will ask what to do instead.` : `Switched ${w.label} to the next mode.`) : j.error || 'Could not do that.');
  } catch { toast('Could not reach the Mac.'); }
  setTimeout(refresh, 700);
}

// A general sheet for the window menu, the last reply, renaming, and the quick reply editor.
function sheet(title, ...body) {
  $('#gentitle').textContent = title;
  $('#genbody').replaceChildren(...body);
  $('#gen').hidden = false;
}
const closeSheet = () => { $('#gen').hidden = true; };
$('#genx').onclick = closeSheet;
$('#gen').onclick = (e) => { if (e.target.id === 'gen') closeSheet(); };

// The ⋯ menu on a card.
function windowMenu(w) {
  const item = (label, fn, cls) => h('button', { class: cls || '', onclick: fn }, label);
  const claude = Boolean(w.claude);
  sheet(w.label, h('div', { class: 'menu' },
    item('Open the window', () => { closeSheet(); openTerm(w); }),
    claude ? item('Last reply', () => showLastReply(w)) : null,
    claude && w.claude.status !== 'waiting' ? item(`Next mode${w.claude.mode ? ` (now ${modeName(w.claude.mode)})` : ''}`, () => { closeSheet(); cardKey(w, 'mode'); }) : null,
    item(w.muted ? 'Notify me about this window again' : 'Mute notifications for this window', () => setMuted(w, !w.muted)),
    item('Rename', () => renameSheet(w)),
    item('Close the window', () => closeSheetFor(w), 'danger')));
}

async function setMuted(w, muted) {
  closeSheet();
  try {
    await api(`/api/sessions/${encodeURIComponent(w.id)}/mute`, { method: 'POST', body: { muted } });
    toast(muted ? `No notifications for ${w.label} until you turn them back on.` : `Notifications for ${w.label} are back on.`);
  } catch { toast('Could not change that.'); }
  refresh();
}

function renameSheet(w) {
  const input = h('input', { value: w.label, maxlength: '60', autocapitalize: 'off', enterkeyhint: 'done' });
  const save = async () => {
    try {
      const r = await api(`/api/sessions/${encodeURIComponent(w.id)}/rename`, { method: 'POST', body: { label: input.value } });
      closeSheet();
      toast(`Renamed to ${r.label}.`);
      if (current?.info.id === w.id) { current.info.label = r.label; $('#ttitle').textContent = r.label; }
    } catch { toast('Use a name of 1 to 60 characters.'); }
    refresh();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  sheet('Rename the window', input, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: save }, 'Save')));
  input.focus();
  input.select();
}

function closeSheetFor(w) {
  sheet(`Close ${w.label}?`,
    h('p', {}, w.claude ? 'This ends the window and the Claude Code session running in it, on the Mac too. The conversation stays on disk.' : 'This ends the window and its shell, on the Mac too.'),
    h('div', { class: 'btns' },
      h('button', { class: 'primary', style: 'background:var(--blocked);border-color:var(--blocked)', onclick: async () => {
        closeSheet();
        try { await api(`/api/sessions/${encodeURIComponent(w.id)}`, { method: 'DELETE' }); toast(`Closed ${w.label}.`); } catch { toast('Could not close it.'); }
        if (current?.info.id === w.id) history.back();
        refresh();
      } }, 'Close it'),
      h('button', { onclick: closeSheet }, 'Keep it')));
}

// Claude's last reply, read from its transcript on the Mac.
async function showLastReply(w) {
  sheet(`${w.label}: last reply`, h('p', {}, 'Loading…'));
  let r;
  try { r = await api(`/api/sessions/${encodeURIComponent(w.id)}/last`); } catch { return sheet(`${w.label}: last reply`, h('p', {}, 'Could not read it.')); }
  sheet(`${w.label}: last reply`,
    r.text ? h('div', { class: 'reply' }, r.text) : h('p', {}, 'Claude has not replied since your last message.'),
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { closeSheet(); openTerm(w); } }, 'Open the window')));
}

// Press and hold a card to read Claude's last reply without opening the window.
let pressTimer = null, pressStart = null, pressedAt = 0;
const longPressed = () => Date.now() - pressedAt < 700;
$('#list').addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.target.closest('button')) return;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    const w = windows.find((x) => x.id === card.dataset.id);
    if (!w?.claude) return;
    pressedAt = Date.now();
    showLastReply(w);
  }, 550);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('#list').addEventListener(ev, () => clearTimeout(pressTimer));
$('#list').addEventListener('pointermove', (e) => {
  if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) clearTimeout(pressTimer);
});
$('#list').addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });

// ---- Home: the list of windows ----
let windows = [];
let restore = null;
let lastStatus = new Map();

async function refresh() {
  let o;
  try { o = await api('/api/overview'); } catch { return; }
  $('#machine').textContent = `on ${o.machine}`;
  windows = o.sessions.filter((s) => !s.exited);
  // A window whose Claude finishes while you look elsewhere gets a notice.
  for (const w of windows) {
    const now = w.claude?.status;
    const was = lastStatus.get(w.id);
    if (was && was !== now && current?.info.id !== w.id) {
      if (now === 'waiting') toast(`${w.label} needs you to answer a prompt`);
      else if (was === 'busy' && now === 'idle') toast(`${w.label} is waiting for you`);
    }
    lastStatus.set(w.id, now);
  }
  const waiting = windows.filter(needsYou).length;
  document.title = waiting ? `(${waiting}) Corral` : 'Corral';
  if (current) {
    const w = windows.find((x) => x.id === current.info.id);
    if (w) $('#tsub').textContent = termSub(w);
    renderAskbar(w);
    renderView();
  }
  if (!$('#home').hidden) renderList();
}

function renderList() {
  const list = $('#list');
  const kids = [];
  if (restore?.windows?.length) {
    kids.push(h('div', { class: 'banner' },
      h('div', { class: 'grow' }, `${restore.windows.length} window${restore.windows.length === 1 ? '' : 's'} from before the restart can be reopened.`),
      h('button', { class: 'primary', onclick: doRestore }, 'Restore')));
  }
  if (!windows.length) kids.push(h('div', { class: 'empty' }, 'Nothing is running on the Mac. Start something below.'));
  const sorted = listOrder();
  const count = [0, 0, 0];
  for (const w of sorted) count[statusOf(w).rank]++;
  let lastRank = -1;
  for (const w of sorted) {
    const st = statusOf(w);
    if (st.rank !== lastRank) {
      kids.push(h('div', { class: 'section', id: `group-${st.rank}` }, GROUPS[st.rank].title, h('span', { class: 'n' }, String(count[st.rank]))));
      lastRank = st.rank;
    }
    const stop = (e) => e.stopPropagation();
    const busy = w.claude?.status === 'busy';
    const tags = [
      busy ? h('button', { class: 'stop', onclick: (e) => { stop(e); cardKey(w, 'stop'); } }, 'Stop') : null,
      w.claude?.mode ? h('span', { class: 'tag' }, modeName(w.claude.mode)) : null,
      w.muted ? h('span', { class: 'tag' }, 'Muted') : null,
    ].filter(Boolean);
    kids.push(h('div', { class: `card ${st.cls === 'need' ? 'need' : ''}`, role: 'button', tabindex: '0', 'data-id': w.id,
      onclick: (e) => { if (!longPressed(e)) openTerm(w); },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openTerm(w); } },
      h('div', { class: 'top' }, h('span', { class: 'name' }, w.label),
        h('span', { class: `pill ${st.cls}` }, busy && w.claude.since ? `${st.text} · ${took(w.claude.since)}` : st.text),
        h('button', { class: 'more', 'aria-label': `More for ${w.label}`, onclick: (e) => { stop(e); windowMenu(w); } }, '⋯')),
      h('div', { class: 'where' }, `${home(w.cwd)}${w.activity ? ` · ${ago(w.activity)}` : ''}`),
      tags.length ? h('div', { class: 'tags' }, ...tags) : null,
      w.prompt ? askBlock(w) : null));
  }
  const spacer = h('div', { 'aria-hidden': 'true' });
  const keep = list.scrollTop; // the list redraws every few seconds; stay where the reader is
  list.replaceChildren(...kids, spacer);
  // Room after the last group, so jumping to any group can bring its header to the top.
  const lastHead = [...list.querySelectorAll('.section[id^="group-"]')].pop();
  if (lastHead?.nextElementSibling) {
    const tail = list.scrollHeight - (groupTop(lastHead.nextElementSibling) - lastHead.offsetHeight - 8);
    spacer.style.height = `${Math.max(0, list.clientHeight - tail)}px`;
  }
  list.scrollTop = keep;
  const jump = $('#jump');
  const asking = windows.some((w) => statusOf(w).cls === 'need');
  jump.replaceChildren(...GROUPS.map((g, rank) => (count[rank] ? h('button', {
    class: rank === 0 && asking ? 'need' : g.cls, 'data-rank': rank, onclick: () => jumpTo(rank),
  }, g.chip, ' ', h('b', {}, String(count[rank]))) : null)).filter(Boolean));
  jump.hidden = !windows.length;
  markGroup();
}

// The order of the list, which swiping in a terminal also follows.
const listOrder = () => [...windows].sort((a, b) => statusOf(a).rank - statusOf(b).rank
  || Number(Boolean(statusOf(b).first)) - Number(Boolean(statusOf(a).first)) || (b.activity || 0) - (a.activity || 0));

// The three groups, in list order.
const GROUPS = [
  { title: 'Waiting for you', chip: 'Your turn', cls: 'idle' },
  { title: 'Working', chip: 'Working', cls: 'busy' },
  { title: 'Shells', chip: 'Shells', cls: '' },
];
// Where an element sits in the list's own scroll position. A stuck header reports where it is stuck,
// so jumping measures the first window under the header, which never sticks.
function groupTop(el) {
  const list = $('#list');
  return list.scrollTop + el.getBoundingClientRect().top - list.getBoundingClientRect().top;
}
function jumpTo(rank) {
  const el = document.getElementById(`group-${rank}`);
  const first = el?.nextElementSibling;
  if (first) $('#list').scrollTo({ top: Math.max(0, groupTop(first) - el.offsetHeight - 8), behavior: 'smooth' });
}
// Lights the chip of the group at the top of the list.
function markGroup() {
  const list = $('#list');
  let current = null;
  for (const el of list.querySelectorAll('.section[id^="group-"]')) if (groupTop(el) <= list.scrollTop + 4) current = el.id.slice(6);
  if (current === null) current = list.querySelector('.section[id^="group-"]')?.id.slice(6) ?? null;
  for (const b of $('#jump').children) b.classList.toggle('on', b.dataset.rank === current);
}
$('#list').addEventListener('scroll', markGroup, { passive: true });

async function checkRestore() {
  restore = await api('/api/restore').catch(() => null);
  renderList();
}
async function doRestore() {
  try {
    const r = await api('/api/restore', { method: 'POST' });
    restore = null;
    toast(`Reopened ${r.sessions.length} window${r.sessions.length === 1 ? '' : 's'}.`);
    refresh();
  } catch { toast('Could not restore the windows.'); }
}

$('#todesk').onclick = () => { location.href = '/?desktop'; };

// ---- Start something: pick a project and what to run there ----
let agent = load('corral.m.agent', 'claude');
let projects = [];
function setAgent(a) {
  agent = a; store('corral.m.agent', a);
  for (const b of $('#agentseg').children) b.classList.toggle('on', b.dataset.a === a);
}
for (const b of $('#agentseg').children) b.onclick = () => setAgent(b.dataset.a);
setAgent(agent);

async function openSheet() {
  $('#sheet').hidden = false;
  $('#q').value = '';
  $('#projects').replaceChildren(h('div', { class: 'empty' }, 'Loading projects…'));
  const [hd, pj, ss] = await Promise.all([api('/api/herdr').catch(() => ({ spaces: [] })),
    api('/api/projects').catch(() => ({ projects: [] })), api('/api/sessions').catch(() => ({ sessions: [] }))]);
  liveSessions = ss.sessions || [];
  const seen = new Set();
  projects = [];
  for (const s of hd.spaces || []) {
    const root = s.root || s.cwd;
    if (!root || seen.has(root)) continue;
    seen.add(root);
    projects.push({ label: s.label, root, cwd: s.cwd, space: s.id, status: s.status, open: true });
  }
  for (const p of pj.projects || []) {
    if (seen.has(p.root) || !p.exists) continue;
    seen.add(p.root);
    projects.push({ label: p.label, root: p.root, space: null, status: null, open: false });
  }
  projects.push({ label: 'Home folder', root: null, space: null, status: null, open: false, home: true });
  renderProjects();
}
// A project that already has a window on the Mac (made from its space, or in its folder). The home
// folder is exempt, since several plain shells there are normal.
let liveSessions = [];
function windowFor(p, list) {
  if (p.home) return null;
  return list.find((s) => !s.exited && ((p.space && s.space === p.space) || (s.cwd && (s.cwd === p.root || s.cwd === p.cwd)))) || null;
}

function renderProjects() {
  const q = $('#q').value.trim().toLowerCase();
  const match = projects.filter((p) => !q || p.label.toLowerCase().includes(q) || (p.root || '').toLowerCase().includes(q));
  const row = (p) => h('button', { class: 'proj', onclick: () => start(p) },
    h('span', { class: `dot ${p.status || ''}` }),
    h('span', { class: 'n' }, h('div', {}, p.label), h('div', { class: 'p' }, p.home ? '~' : home(p.root))),
    windowFor(p, liveSessions) ? h('span', { class: 'tag' }, 'Open') : null);
  const open = match.filter((p) => p.open), other = match.filter((p) => !p.open);
  $('#projects').replaceChildren(
    ...(open.length ? [h('div', { class: 'section' }, 'herdr spaces'), ...open.map(row)] : []),
    ...(other.length ? [h('div', { class: 'section' }, 'Other projects'), ...other.map(row)] : []),
    ...(!match.length ? [h('div', { class: 'empty' }, 'No project matches.')] : []));
}
$('#q').oninput = renderProjects;
$('#fab').onclick = openSheet;
$('#sheetx').onclick = () => { $('#sheet').hidden = true; };
$('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };

async function start(p) {
  $('#sheet').hidden = true;
  // Never a second window for the same space: check what is running now, not what the sheet saw.
  const now = await api('/api/sessions').catch(() => null);
  const existing = windowFor(p, now?.sessions || liveSessions);
  if (existing) {
    toast(`${p.label} is already open on the Mac. Tap it in the list to continue there.`);
    refresh();
    return;
  }
  try {
    const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: p.root, label: p.home ? 'shell' : p.label, space: p.space, agent: p.home ? '' : agent }) });
    const j = await r.json().catch(() => ({}));
    // The Mac allows one window per space; if one opened meanwhile, go to it.
    if (r.status === 409 && j.existing) { toast(`${p.label} is already open. Here it is.`); openTerm(j.existing); refresh(); return; }
    if (!r.ok) throw new Error(j.error);
    openTerm(j);
    refresh();
  } catch { toast('Could not start it on the Mac.'); }
}

// ---- Terminal view ----
let current = null; // {info, term, fit, ws}
let fontSize = load('corral.m.font', 12);
let ctrlArmed = false;

function sendRaw(d) { if (current?.ws?.readyState === 1) current.ws.send(JSON.stringify({ t: 'in', d })); }

function openTerm(info, swiped) {
  closeTerm();
  $('#home').hidden = true; $('#histview').hidden = true; $('#diffview').hidden = true; $('#termview').hidden = false;
  $('#ttitle').textContent = info.label;
  const w = windows.find((x) => x.id === info.id) || info;
  $('#tsub').textContent = termSub(w);
  askShown = null;
  renderAskbar(w);
  const term = new Terminal({ fontFamily: 'Menlo, Monaco, ui-monospace, monospace', fontSize, cursorBlink: false,
    scrollback: 1000, theme: { background: '#100e15', cursor: '#c9c1ff', selectionBackground: '#4d4366' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  // Tapping the terminal should not pop up the keyboard; typing goes through the box below, or the Type key.
  term.textarea.setAttribute('inputmode', 'none');
  current = { info, term, fit, ws: null, alive: true };
  if (swiped) history.replaceState({ term: info.id }, ''); else history.pushState({ term: info.id }, '');
  fit.fit();
  term.onData((d) => {
    if (ctrlArmed && d.length === 1) { d = String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31); setCtrl(false); }
    sendRaw(d);
  });
  term.onResize(({ cols, rows }) => current?.ws?.readyState === 1 && current.ws.send(JSON.stringify({ t: 'resize', cols, rows })));
  connect();
  renderView();
}

function connect() {
  const c = current;
  const { term } = c;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?id=${encodeURIComponent(c.info.id)}&own=1&cols=${term.cols}&rows=${term.rows}`);
  c.ws = ws;
  ws.onopen = () => {
    $('#conn').hidden = true;
    term.reset();
    c.fit.fit();
    ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => {
    if (current !== c || !c.alive) return;
    $('#conn').hidden = false;
    setTimeout(() => { if (current === c && c.ws === ws) connect(); }, 1500);
  };
}

function closeTerm() {
  if (!current) return;
  current.alive = false;
  current.ws?.close();
  current.term.dispose();
  $('#term').replaceChildren();
  current = null;
  stopConvo();
  $('#convo').hidden = true;
  setCtrl(false);
  $('#askbar').hidden = true; askShown = '';
}

function backHome() {
  closeTerm();
  $('#termview').hidden = true; $('#histview').hidden = true; $('#diffview').hidden = true; $('#home').hidden = false;
  refresh();
}
$('#back').onclick = () => history.back();
window.addEventListener('popstate', () => {
  if ((!$('#histview').hidden || !$('#diffview').hidden) && current) {
    $('#histview').hidden = true; $('#diffview').hidden = true; $('#termview').hidden = false; return;
  }
  if (current) backHome();
});

// iOS drops the socket while the page is in the background; reconnect when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refresh();
  if (current && current.ws?.readyState !== 1) connect();
});

function setFont(n) {
  fontSize = Math.min(20, Math.max(8, n)); store('corral.m.font', fontSize);
  if (current) { current.term.options.fontSize = fontSize; current.fit.fit(); }
}
new ResizeObserver(() => current?.fit.fit()).observe($('#termwrap'));

// The keys a phone keyboard lacks. Claude Code uses Esc to interrupt, Shift-Tab to change mode,
// and numbers to answer its menus.
// "Use suggestion" takes Claude Code's dimmed suggested prompt (Tab, in an empty input box) and sends it (Enter).
const KEYS = [
  ['Use suggestion', 'suggest'], ['Type', 'kbd'], ['Esc', '\x1b'], ['⇧Tab', '\x1b[Z'], ['Tab', '\t'], ['Ctrl', 'ctrl'], ['^C', '\x03'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['⏎', '\r'],
  ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['/', '/'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
  ['A−', 'smaller'], ['A+', 'bigger'],
];
const LOCAL_KEYS = new Set(['kbd', 'ctrl', 'suggest', 'smaller', 'bigger']);
function setCtrl(on) { ctrlArmed = on; $('#keys [data-k="ctrl"]')?.classList.toggle('on', on); }
$('#keys').replaceChildren(...KEYS.map(([label, k]) => h('button', {
  'data-k': LOCAL_KEYS.has(k) ? k : null,
  'aria-label': { Type: 'Type straight into the terminal', '⏎': 'Enter', '⇧Tab': 'Shift Tab', 'A−': 'Smaller text', 'A+': 'Larger text' }[label] || null,
  // Keep focus where it is, so the keyboard does not close on every key.
  onpointerdown: (e) => e.preventDefault(),
  onclick: () => {
    if (k === 'kbd') {
      const ta = current?.term.textarea;
      if (!ta) return;
      const typing = ta.getAttribute('inputmode') !== 'none' && document.activeElement === ta;
      ta.setAttribute('inputmode', typing ? 'none' : 'text');
      if (typing) ta.blur(); else { ta.blur(); ta.focus(); }
      $('#keys [data-k="kbd"]').classList.toggle('on', !typing);
      return;
    }
    if (k === 'ctrl') return setCtrl(!ctrlArmed);
    if (k === 'smaller' || k === 'bigger') return setFont(fontSize + (k === 'bigger' ? 1 : -1));
    if (k === 'suggest') { sendRaw('\t'); setTimeout(() => sendRaw('\r'), 150); return; }
    sendRaw(k);
  },
}, label)));

// The message box: text goes in as a paste (so a multi-line message stays one message), then Enter.
const msg = $('#msg');
function grow() { msg.style.height = 'auto'; msg.style.height = `${Math.min(msg.scrollHeight, innerHeight * 0.3)}px`; }
msg.addEventListener('input', grow);
function sendMsg() {
  if (!current) return;
  const text = msg.value;
  if (text) current.term.paste(text);
  setTimeout(() => sendRaw('\r'), text ? 80 : 0);
  msg.value = ''; grow();
}
$('#send').onpointerdown = (e) => e.preventDefault();
$('#send').onclick = sendMsg;
msg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
});

// ---- Conversation: the view a window running Claude opens in ----
// Your prompts and Claude's replies, read from Claude Code's transcript every few seconds, with its status lines
// under them. The terminal stays connected beneath it, so the keys and the message box work in both views.
// Terminal and Chat switch between them; the choice is kept on this device.
let viewPref = load('corral.m.view', 'chat');
let convo = null; // {id, timer, sig, drawn}
function renderView() {
  if (!current) return;
  const claude = Boolean(windows.find((x) => x.id === current.info.id)?.claude);
  const chat = claude && viewPref === 'chat';
  $('#viewbtn').hidden = !claude;
  $('#viewbtn').textContent = chat ? 'Terminal' : 'Chat';
  $('#convo').hidden = !chat;
  if (chat && !convo) {
    convo = { id: current.info.id, timer: setInterval(loadConvo, 3000), sig: '', drawn: false };
    $('#chat').replaceChildren(h('div', { class: 'note' }, 'Loading…'));
    $('#statusline').hidden = true;
    loadConvo();
  } else if (!chat) stopConvo();
}
function stopConvo() {
  if (convo) clearInterval(convo.timer);
  convo = null;
}
$('#viewbtn').onclick = () => { viewPref = viewPref === 'chat' ? 'term' : 'chat'; store('corral.m.view', viewPref); renderView(); };

async function loadConvo() {
  const c = convo;
  if (document.visibilityState !== 'visible') return;
  let r;
  try { r = await api(`/api/sessions/${encodeURIComponent(c.id)}/conversation`); } catch { r = { failed: true }; }
  if (convo !== c) return;
  const sig = JSON.stringify(r);
  if (sig === c.sig) return; // nothing new: leave the reader where they are
  c.sig = sig;
  const chat = $('#chat');
  // Follow new messages only for a reader at the bottom; someone scrolled up stays put.
  const atEnd = !c.drawn || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  // The status lines go in first, since they change how much of the conversation fits.
  const lines = r.statusLines || [];
  const indent = Math.min(...lines.map((l) => l.match(/^ */)[0].length));
  $('#statusline').textContent = lines.map((l) => l.slice(indent)).join('\n');
  $('#statusline').hidden = !lines.length;
  chat.replaceChildren(...chatItems(r));
  if (atEnd) chat.scrollTop = chat.scrollHeight;
  c.drawn = true;
}

// The ⋯ menu: the project's uncommitted changes, and the window's scrollback as text.
$('#morebtn').onclick = () => {
  if (!current) return;
  const item = (label, fn) => h('button', { onclick: () => { closeSheet(); fn(); } }, label);
  sheet(current.info.label, h('div', { class: 'menu' }, item('Changes not yet committed', showChanges), item('Scrollback as text', showHistory)));
};

function chatItems(r) {
  const note = (t) => h('div', { class: 'note' }, t);
  if (r.failed) return [note('Could not read the conversation. Tap Terminal to see the window.')];
  const els = r.cut ? [note('Older messages are not shown.')] : [];
  if (!r.items.length) els.push(note('Nothing typed in this conversation yet.'));
  let lastDay = '';
  for (const it of r.items) {
    if (it.at && it.who === 'you') {
      const at = new Date(it.at);
      const day = at.toDateString();
      const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      els.push(h('div', { class: 'when' }, day === lastDay ? time : `${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`));
      lastDay = day;
    }
    els.push(h('div', { class: `msg ${it.who}` }, it.text));
  }
  if (r.claude === 'busy') els.push(h('div', { class: 'working' }, 'Claude is working…'));
  return els;
}

// ---- History: the window's scrollback as plain text ----
async function showHistory() {
  if (!current) return;
  const id = current.info.id;
  $('#htitle').textContent = current.info.label;
  $('#termview').hidden = true; $('#histview').hidden = false;
  history.pushState({ hist: true }, '');
  const pre = $('#histtext');
  pre.textContent = 'Loading…';
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/history`);
    pre.textContent = r.ok ? await r.text() : 'This window has no saved scrollback.';
  } catch { pre.textContent = 'Could not load the scrollback.'; }
  pre.scrollTop = pre.scrollHeight;
}
$('#histback').onclick = () => history.back();
$('#histcopy').onclick = () => navigator.clipboard.writeText($('#histtext').textContent)
  .then(() => toast('Copied the scrollback.')).catch(() => toast('Could not copy. Select the text instead.'));

// ---- Photos: upload to the Mac, then paste the file's path, which Claude Code attaches as [Image #n] ----
// A photo is scaled to at most 2048 pixels on its long side and sent as JPEG, so a 12-megapixel shot
// uploads quickly over a phone connection. A file the browser cannot draw is sent as it is.
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    if (blob) return blob;
  } catch {}
  return file;
}
const base64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = reject;
  r.readAsDataURL(blob);
});
$('#photo').onpointerdown = (e) => e.preventDefault();
$('#photo').onclick = () => $('#photofile').click();
$('#photofile').onchange = async () => {
  const files = [...$('#photofile').files];
  $('#photofile').value = '';
  if (!current || !files.length) return;
  const c = current;
  toast(`Sending ${files.length === 1 ? 'the photo' : `${files.length} photos`} to the Mac…`);
  let sent = 0;
  for (const f of files) {
    try {
      const blob = await shrink(f);
      const r = await fetch(`/api/sessions/${encodeURIComponent(c.info.id)}/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: blob.type || f.type, data: await base64(blob) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast(j.error || 'Could not send the photo.'); continue; }
      if (current !== c) return;
      c.term.paste(`${j.path} `);
      sent++;
    } catch { toast('Could not send the photo.'); }
  }
  if (sent) toast(`${sent === 1 ? 'Photo' : `${sent} photos`} added to Claude's message. Type what you want and Send.`);
};

// ---- Changes: what is not yet committed in the window's project ----
async function showChanges() {
  if (!current) return;
  $('#dtitle').textContent = current.info.label;
  if ($('#diffview').hidden) history.pushState({ diff: true }, '');
  $('#termview').hidden = true; $('#diffview').hidden = false;
  const list = $('#difflist');
  list.replaceChildren(h('div', { class: 'note' }, 'Reading git…'));
  let r;
  try { r = await api(`/api/sessions/${encodeURIComponent(current.info.id)}/changes`); } catch { return list.replaceChildren(h('div', { class: 'note' }, 'Could not read the changes.')); }
  if (!r.repo) { $('#dsub').textContent = home(r.cwd); return list.replaceChildren(h('div', { class: 'note' }, 'This folder is not in a git repository.')); }
  $('#dsub').textContent = `${r.repo}${r.branch ? ` · ${r.branch}` : ''} · ${r.files.length} file${r.files.length === 1 ? '' : 's'} changed`;
  if (!r.files.length) return list.replaceChildren(h('div', { class: 'note' }, 'Nothing has changed since the last commit.'));
  const anchors = new Map();
  const lines = [];
  for (const line of r.diff.split('\n')) {
    let cls = 'd';
    if (line.startsWith('diff --git ')) {
      const name = line.replace(/^diff --git a\/.* b\//, '');
      const el = h('div', { class: 'd file' }, name);
      anchors.set(name, el);
      lines.push(el);
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary )/.test(line)) cls += ' meta';
    else if (line.startsWith('@@')) cls += ' hunk';
    else if (line.startsWith('+')) cls += ' add';
    else if (line.startsWith('-')) cls += ' del';
    lines.push(h('div', { class: cls }, line || ' '));
  }
  const CODES = { M: 'M', A: 'A', D: 'D', R: 'R', '??': 'new', C: 'C', U: 'U' };
  const files = h('div', { class: 'files' }, ...r.files.map((f) => {
    const code = f.code === '??' ? 'new' : CODES[f.code.trim()[0]] || f.code.trim();
    const name = f.path.includes(' -> ') ? f.path.split(' -> ')[1] : f.path;
    return h('button', { onclick: () => anchors.get(name)?.scrollIntoView({ block: 'start' }) }, h('b', {}, code), h('span', {}, name));
  }));
  // After reading the diff, hand the commit to Claude in this window.
  const win = windows.find((x) => x.id === current?.info.id);
  if (win?.claude) {
    files.append(h('button', { class: 'primary commit', onclick: () => {
      if (!current) return;
      current.term.paste('Commit these changes.');
      setTimeout(() => sendRaw('\r'), 80);
      history.back();
      toast(`Asked ${current.info.label} to commit.`);
    } }, 'Ask Claude to commit these'));
  }
  list.replaceChildren(files, ...lines, ...(r.truncated ? [h('div', { class: 'note' }, 'The diff is long, so the rest is cut off here.')] : []));
  list.scrollTop = 0;
}
$('#diffback').onclick = () => history.back();
$('#diffreload').onclick = showChanges;

// ---- Notifications: Web Push from the Mac, for a window's turn or a permission prompt ----
// iOS allows them only in Corral opened from the Home Screen (iOS 16.4 or later), and asks only after a tap.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.open) openById(e.data.open); });
}
const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function renderNotify() {
  const body = $('#notifybody');
  const p = (text, cls) => h('p', { class: cls || '' }, text);
  const info = await api('/api/push').catch(() => null);
  if (!info) return body.replaceChildren(p('Could not reach the Mac.', 'state'));
  const pref = (key, label, help) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = Boolean(info.prefs[key]);
    box.onchange = () => api('/api/push/prefs', { method: 'POST', body: { [key]: box.checked } }).catch(() => toast('Could not save that.'));
    return h('label', { class: 'row' }, h('span', {}, label, h('small', {}, help)), box);
  };
  // Not a notification setting, but it decides whether the Mac is there to send one.
  const mac = [h('div', { class: 'section', style: 'margin:18px -16px 0' }, 'On the Mac'),
    pref('awake', 'Keep the Mac awake while Claude works', 'Stops idle sleep while any window is working or waiting on a prompt. Closing the lid still sleeps.')];
  if (!pushable || !isSecureContext) {
    const iphone = /iPhone|iPad/.test(navigator.userAgent);
    return body.replaceChildren(
      p(iphone && !standalone ? 'On an iPhone, notifications work only for Corral opened from the Home Screen.' : 'This browser cannot get notifications from Corral.', 'state'),
      ...(iphone && !standalone ? [h('ol', {}, h('li', {}, 'Tap the Share button in Safari.'), h('li', {}, 'Choose Add to Home Screen, then Add.'),
        h('li', {}, 'Open Corral from its new Home Screen icon and come back here.'))] : []), ...mac);
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  const on = Boolean(sub) && Notification.permission === 'granted';
  const kids = [];
  if (Notification.permission === 'denied') {
    kids.push(p('Notifications are blocked for Corral. Allow them for Corral in the phone\'s Settings app, under Notifications, then come back.', 'state'));
  } else if (!on) {
    kids.push(p('Get a notification on this phone when a window needs you, even when Corral is closed.', 'state'),
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: enablePush }, 'Turn on notifications')));
  } else {
    kids.push(p(`Notifications are on for this ${/iPhone/.test(navigator.userAgent) ? 'iPhone' : 'device'}.`, 'state'),
      pref('permission', 'A permission prompt opens', 'Claude is asking before it runs something.'),
      pref('turn', 'Claude finishes its turn', 'A window goes from Working to Your turn.'),
      pref('away', 'Only when I am away from the Mac', 'Nothing is sent while the Mac has been used in the last 2 minutes.'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => api('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } })
          .then(() => toast('Sent. It should arrive in a few seconds.')).catch(() => toast('The test did not go through.')) }, 'Send a test'),
        h('button', { onclick: disablePush }, 'Turn off on this device')));
  }
  kids.push(p('A notification names the window and what it is waiting for. It travels encrypted, so the push service cannot read it. To silence one window, use its ⋯ menu.'), ...mac);
  body.replaceChildren(...kids);
}
async function enablePush() {
  try {
    if (await Notification.requestPermission() !== 'granted') return renderNotify();
    const { key } = await api('/api/push');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    toast('Notifications are on.');
  } catch (e) { toast(`Could not turn on notifications (${e.message}).`); }
  renderNotify();
}
async function disablePush() {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  toast('Notifications are off on this device.');
  renderNotify();
}
$('#bell').onclick = () => { $('#notify').hidden = false; $('#notifybody').replaceChildren(h('p', {}, 'Checking…')); renderNotify(); };
$('#notifyx').onclick = () => { $('#notify').hidden = true; };
$('#notify').onclick = (e) => { if (e.target.id === 'notify') $('#notify').hidden = true; };

// A tapped notification opens the page at /m?w=<window>; go straight to that window.
async function openById(id) {
  if (!windows.length) await refresh();
  const w = windows.find((x) => x.id === id);
  if (w) openTerm(w); else toast('That window is no longer open.');
}

// ---- Quick replies: tap one to put it in the message box, then Send ----
// Kept on this device. Tapping fills the box rather than sending, so a slip of the finger sends nothing.
const QUICK_DEFAULT = ['Continue', 'Yes, go ahead', 'Run the tests', 'Commit and push', '/clear'];
let quick = load('corral.m.quick', QUICK_DEFAULT);
function renderQuick() {
  $('#quick').replaceChildren(...quick.map((q) => h('button', {
    onpointerdown: (e) => e.preventDefault(),
    onclick: () => { msg.value = msg.value ? `${msg.value} ${q}` : q; grow(); },
  }, q)), h('button', { class: 'edit', onclick: editQuick }, 'Edit'));
}
function editQuick() {
  const ta = h('textarea', { rows: '7' });
  ta.value = quick.join('\n');
  sheet('Quick replies', h('p', {}, 'One per line. Tapping one puts it in the message box; Send sends it.'), ta,
    h('div', { class: 'btns' },
      h('button', { class: 'primary', onclick: () => {
        quick = ta.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20);
        store('corral.m.quick', quick); renderQuick(); closeSheet();
      } }, 'Save'),
      h('button', { onclick: () => { ta.value = QUICK_DEFAULT.join('\n'); } }, 'Reset')));
}
renderQuick();

// ---- Swipe left or right in a terminal to go to the next or previous window in the list ----
let swipe = null;
$('#termview').addEventListener('touchstart', (e) => {
  // The key rows and the message box scroll or select sideways themselves.
  if (e.touches.length !== 1 || e.target.closest('#keys, #quick, #compose, #askbar')) { swipe = null; return; }
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
$('#termview').addEventListener('touchend', (e) => {
  if (!swipe || !current) return;
  const dx = e.changedTouches[0].clientX - swipe.x, dy = e.changedTouches[0].clientY - swipe.y;
  const quickEnough = Date.now() - swipe.t < 700;
  swipe = null;
  if (!quickEnough || Math.abs(dx) < 80 || Math.abs(dy) > 50) return;
  const order = listOrder();
  const i = order.findIndex((w) => w.id === current.info.id);
  if (i < 0 || order.length < 2) return;
  const next = order[(i + (dx < 0 ? 1 : -1) + order.length) % order.length];
  openTerm(next, true);
  toast(`${next.label} (${order.indexOf(next) + 1} of ${order.length})`);
}, { passive: true });

// ---- Start ----
setVh();
refresh().then(() => {
  const w = new URLSearchParams(location.search).get('w');
  if (w) { history.replaceState(null, '', '/m'); openById(w); }
});
checkRestore();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 4000);
setInterval(() => { if (!$('#home').hidden) renderList(); }, 30000); // keeps "5m ago" current
