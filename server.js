#!/usr/bin/env node
// Corral: a local HTML terminal workspace that sits beside herdr.
// Owns real PTYs (node-pty), streams them to xterm.js over WebSocket, and reads
// herdr's workspace list from `herdr api snapshot` to populate the sidebar.
// Binds to 127.0.0.1 only. A shell is remote code execution, so every request
// is checked for a loopback Host header and every mutation or socket upgrade
// for a loopback Origin (blocks DNS rebinding and cross-site requests).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CORRAL_PORT || process.env.WEBTERM_PORT || 8777);
const SCROLLBACK_BYTES = 256 * 1024;
// herdr's installer puts it in ~/.local/bin, which is often not on PATH; otherwise rely on PATH.
const HERDR = process.env.HERDR_BIN
  || (fs.existsSync(path.join(os.homedir(), '.local/bin/herdr')) ? path.join(os.homedir(), '.local/bin/herdr') : 'herdr');
const PUBLIC = path.join(__dirname, 'public');
const VENDOR = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => fs.existsSync(p)) || null;
// Before the rename the tmux server used the socket name 'webterm'. If it still holds sessions,
// keep using it so those shells stay reachable; otherwise use 'corral'.
function legacyTmuxInUse() {
  if (!TMUX) return false;
  try {
    return execFileSync(TMUX, ['-L', 'webterm', 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n').some((n) => n.startsWith('wt-'));
  } catch { return false; }
}
const TMUX_SOCKET = process.env.CORRAL_TMUX_SOCKET || process.env.WEBTERM_TMUX_SOCKET || (legacyTmuxInUse() ? 'webterm' : 'corral');
const TMUX_CONF = path.join(__dirname, 'corral.tmux.conf');
const SESSION_PREFIX = 'wt-'; // internal tmux session name prefix; kept so existing sessions are adopted

/** @type {Map<string, {id:string,pty:any,buf:string,clients:Set<any>,cwd:string,label:string,exited:boolean,created:number,tmux:boolean}>} */
const sessions = new Map();
let counter = 0;

// This server may be started from inside a Claude Code session or a herdr pane. Their
// per-session variables (including a messaging token) must not leak into the shells it spawns:
// a Claude Code started there would think it is a child of that session, and a HERDR_PANE_ID
// would make herdr attribute its state to the wrong pane. TMUX would break nested attach.
const LEAKY_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|HERDR_.*|TMUX|TMUX_PANE)$/;
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!LEAKY_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
}

// Runs tmux on the dedicated socket, so the user's own tmux server is never touched.
function tmux(...args) {
  return execFileSync(TMUX, ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() });
}

// A tmux server started by an earlier run keeps the polluted variables in its global environment
// and hands them to new sessions, so remove them from it too.
function scrubTmuxEnv() {
  if (!TMUX) return;
  for (const k of Object.keys(process.env)) if (LEAKY_ENV.test(k)) { try { tmux('set-environment', '-gu', k); } catch { return; } }
}

// Optional program to start in a new window. A fixed list: the browser can only pick a name,
// never supply a command. The shell stays open after the program exits.
const AGENTS = { claude: 'claude', 'claude-continue': 'claude --continue' };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function startCommand(agent) {
  const shell = process.env.SHELL || '/bin/zsh';
  if (!AGENTS[agent]) return { shell, command: null };
  return { shell, command: `${shell} -lc ${shq(`${AGENTS[agent]}; exec ${shell} -l`)}` };
}

// Starts the process that feeds the browser: a plain login shell, or a tmux attach client.
function attachPty(id, dir, useTmux, agent) {
  const env = cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', CORRAL_SESSION: id });
  const [file, args] = useTmux
    ? [TMUX, ['-L', TMUX_SOCKET, 'attach-session', '-t', SESSION_PREFIX + id]]
    : agent && AGENTS[agent]
      ? [startCommand(agent).shell, ['-lc', `${AGENTS[agent]}; exec ${startCommand(agent).shell} -l`]]
      : [process.env.SHELL || '/bin/zsh', ['-l']];
  return pty.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: dir, env });
}

function register(id, dir, label, created, useTmux, space, agent) {
  const s = {
    id, pty: null, buf: '', clients: new Set(), cwd: dir, space: space || null,
    label: label || path.basename(dir) || dir, exited: false, created, tmux: useTmux,
  };
  s.pty = attachPty(id, dir, useTmux, agent);
  s.pty.onData((d) => {
    s.buf += d;
    if (s.buf.length > SCROLLBACK_BYTES) s.buf = s.buf.slice(-SCROLLBACK_BYTES);
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(d);
  });
  s.pty.onExit(({ exitCode }) => {
    s.exited = true;
    const msg = `\r\n\x1b[2m[${useTmux ? 'tmux session ended' : 'process exited'}, code ${exitCode}]\x1b[0m\r\n`;
    s.buf += msg;
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(msg);
  });
  sessions.set(id, s);
  return s;
}

function createSession(cwd, label, space, agent) {
  const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : os.homedir();
  const id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  const name = label || path.basename(dir) || dir;
  if (TMUX) {
    const { shell, command } = startCommand(agent);
    tmux('new-session', '-d', '-s', SESSION_PREFIX + id, '-c', dir, '-x', '100', '-y', '30', ...(command ? [command] : [shell, '-l']));
    tmux('source-file', TMUX_CONF);
    tmux('set-option', '-t', SESSION_PREFIX + id, '@corral_label', name);
    if (space) tmux('set-option', '-t', SESSION_PREFIX + id, '@corral_space', String(space));
  }
  return register(id, dir, name, Date.now(), Boolean(TMUX), space, agent);
}

// After a server restart, tmux sessions from the previous run are still alive. Reattach to them.
function adoptSessions() {
  if (!TMUX) return;
  let out = '';
  try {
    out = tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_path}\t#{?#{@corral_label},#{@corral_label},#{@webterm_label}}\t#{?#{@corral_space},#{@corral_space},#{@webterm_space}}');
  } catch { return; } // no tmux server running means nothing to adopt
  for (const line of out.split('\n')) {
    const [name, created, dir, label, space] = line.split('\t');
    if (!name || !name.startsWith(SESSION_PREFIX)) continue;
    const id = name.slice(SESSION_PREFIX.length);
    if (!/^[\w-]+$/.test(id) || sessions.has(id)) continue;
    try { register(id, dir && fs.existsSync(dir) ? dir : os.homedir(), label, Number(created) * 1000, true, space); } catch {}
  }
  if (sessions.size) console.log(`adopted ${sessions.size} tmux session(s)`);
}

function publicSession(s) {
  return { id: s.id, cwd: s.cwd, label: s.label, space: s.space, exited: s.exited, created: s.created, persistent: s.tmux };
}

// Project ledger: every project folder herdr has ever shown this server, so a closed space
// does not erase the project. Kept outside the repo because it holds local paths.
// "Open" is computed from the latest snapshot; the file stores only what was seen and when.
const DATA_DIR = path.join(os.homedir(), '.local/share/corral');
const LEGACY_DATA_DIR = path.join(os.homedir(), '.local/share/webterm'); // the data directory before the rename
const LEDGER_FILE = path.join(DATA_DIR, 'projects.json');
const SORT_BIN = process.env.CORRAL_SORT_BIN || path.join(__dirname, 'scripts', 'herdr-sort-spaces');
const SKIP_ROOT_PREFIXES = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
const ledger = new Map(); // root -> {root, label, firstSeen, lastSeen}
let openRoots = new Set();
let ledgerDirty = false;

const skippedRoot = (r) => SKIP_ROOT_PREFIXES.some((p) => r === p || r.startsWith(p + '/'));

function saveLedger() {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects: [...ledger.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, LEDGER_FILE);
    ledgerDirty = false;
  } catch (e) { console.error('ledger save failed:', e.message); }
}

// Copies the ledger from the pre-rename data directory the first time, leaving the old file in place.
function migrateLegacyData() {
  const old = path.join(LEGACY_DATA_DIR, 'projects.json');
  if (fs.existsSync(LEDGER_FILE) || !fs.existsSync(old)) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.copyFileSync(old, LEDGER_FILE);
    fs.chmodSync(LEDGER_FILE, 0o600);
    console.log('copied the project ledger from the earlier data directory');
  } catch (e) { console.error('ledger migration failed:', e.message); }
}

function loadLedger() {
  migrateLegacyData();
  try {
    const d = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    for (const p of d.projects || []) if (p.root) ledger.set(p.root, p);
    return true;
  } catch { return false; }
}

// First run only: herdr keeps its last few session snapshots, which already name spaces that
// were open earlier today. Add the ones that are not open now as inactive projects.
function seedFromSnapshots() {
  const dir = path.join(os.homedir(), '.config/herdr/session-snapshots');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  for (const f of files) {
    try {
      const at = fs.statSync(path.join(dir, f)).mtimeMs;
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const w of d.workspaces || []) {
        const root = w.identity_cwd;
        if (!root || skippedRoot(root)) continue;
        const label = w.custom_name || (root === os.homedir() ? '~' : path.basename(root));
        const e = ledger.get(root);
        if (!e) ledger.set(root, { root, label, firstSeen: at, lastSeen: at });
        else { e.lastSeen = Math.max(e.lastSeen, at); e.label = label; }
      }
    } catch {}
  }
}

function updateLedger(spaces) {
  const now = Date.now();
  const nowOpen = new Set();
  for (const s of spaces) {
    if (!s.root || skippedRoot(s.root)) continue;
    nowOpen.add(s.root);
    let e = ledger.get(s.root);
    if (!e) { e = { root: s.root, label: s.label, firstSeen: now, lastSeen: now }; ledger.set(s.root, e); ledgerDirty = true; }
    else {
      if (e.label !== s.label) { e.label = s.label; ledgerDirty = true; }
      if (!openRoots.has(s.root)) ledgerDirty = true; // came back, or first look after a restart
      e.lastSeen = now;
    }
  }
  for (const r of openRoots) if (!nowOpen.has(r)) ledgerDirty = true; // a space was closed
  openRoots = nowOpen;
  if (ledgerDirty) saveLedger();
}

function ledgerView() {
  return [...ledger.values()]
    .map((e) => ({ ...e, open: openRoots.has(e.root), exists: fs.existsSync(e.root) }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

// Categories: the user's own groups for the sidebar. A space belongs to at most one, keyed by its
// project folder so the grouping survives a space being closed and reopened.
const CATEGORIES_FILE = path.join(DATA_DIR, 'categories.json');
let categories = { version: 1, categories: [], uncatCollapsed: false, assign: {} };

// Accepts only a well-formed whole document; returns the cleaned copy or null.
function cleanCategories(body) {
  if (!body || !Array.isArray(body.categories) || !body.assign || typeof body.assign !== 'object') return null;
  if (body.categories.length > 60) return null;
  const names = new Set();
  const list = [];
  for (const c of body.categories) {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    if (!name || name.length > 40 || names.has(name)) return null;
    names.add(name);
    list.push({ name, collapsed: Boolean(c.collapsed) });
  }
  // fromEntries makes plain own properties, so a folder called "__proto__" cannot touch the prototype.
  const assign = Object.fromEntries(Object.entries(body.assign)
    .filter(([root, name]) => root.length < 1024 && typeof name === 'string' && names.has(name)));
  return { version: 1, categories: list, uncatCollapsed: Boolean(body.uncatCollapsed), assign };
}

function loadCategories() {
  try {
    const d = cleanCategories(JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8')));
    if (d) categories = d;
  } catch {}
}

function saveCategories() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${CATEGORIES_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(categories, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, CATEGORIES_FILE);
    return true;
  } catch (e) { console.error('categories save failed:', e.message); return false; }
}

// Creates a herdr space for a ledger project, then re-sorts the spaces alphabetically with the
// existing herdr-sort-spaces script (best effort; the new space is kept either way).
async function reopenProject(root) {
  const e = ledger.get(root);
  if (!e) return { status: 404, error: 'unknown project' };
  const snap = await herdrSnapshot();
  if (!snap.available) return { status: 502, error: 'herdr not reachable' };
  if (snap.spaces.some((s) => s.root === root)) return { status: 409, error: 'already open in herdr' };
  try { if (!fs.statSync(root).isDirectory()) throw new Error('not a folder'); } catch { return { status: 410, error: 'folder no longer exists' }; }
  let label = e.label;
  if (snap.spaces.some((s) => s.label === label)) label = `${path.basename(path.dirname(root))}/${path.basename(root)}`;
  const created = await new Promise((resolve) => {
    execFile(HERDR, ['workspace', 'create', '--cwd', root, '--label', label, '--no-focus'], { timeout: 10000 }, (err) => resolve(!err));
  });
  if (!created) return { status: 502, error: 'herdr could not create the space' };
  await new Promise((resolve) => execFile(SORT_BIN, ['--apply'], { timeout: 15000 }, () => resolve()));
  await herdrSnapshot(); // refreshes the ledger's open set
  return { status: 200, ok: true, label };
}

// herdr stores each space's project folder as identity_cwd in session.json. A pane's own cwd
// drifts when the user cd's, so the file tree roots at the identity folder when it is known.
function identityRoots() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/herdr/session.json'), 'utf8'));
    return new Map((d.workspaces || []).filter((w) => w.identity_cwd).map((w) => [w.id, w.identity_cwd]));
  } catch { return new Map(); }
}

function herdrSnapshot() {
  return new Promise((resolve) => {
    execFile(HERDR, ['api', 'snapshot'], { maxBuffer: 32 * 1024 * 1024, timeout: 5000 }, (err, out) => {
      if (err) return resolve({ available: false, error: String(err.message || err), spaces: [] });
      try {
        const snap = JSON.parse(out).result.snapshot;
        const cwdByWs = new Map();
        for (const p of snap.panes || []) if (!cwdByWs.has(p.workspace_id)) cwdByWs.set(p.workspace_id, p.foreground_cwd || p.cwd);
        const roots = identityRoots();
        const spaces = (snap.workspaces || []).map((w) => ({
          id: w.workspace_id, number: w.number, label: w.label, status: w.agent_status,
          panes: w.pane_count, focused: w.focused, cwd: cwdByWs.get(w.workspace_id) || null,
          root: roots.get(w.workspace_id) || cwdByWs.get(w.workspace_id) || null,
        }));
        // Only a real answer counts: an unreachable herdr or an empty list must never mark
        // every project closed.
        if (spaces.length) updateLedger(spaces);
        resolve({ available: true, spaces });
      } catch (e) {
        resolve({ available: false, error: 'could not parse herdr snapshot', spaces: [] });
      }
    });
  });
}

// Space id -> project root, refreshed from herdr when stale or when the id is unknown.
let rootCache = { at: 0, map: new Map() };
async function rootFor(spaceId) {
  if (Date.now() - rootCache.at > 10000 || !rootCache.map.has(spaceId)) {
    const r = await herdrSnapshot();
    rootCache = { at: Date.now(), map: new Map(r.spaces.map((s) => [s.id, s.root])) };
  }
  return rootCache.map.get(spaceId) || null;
}

const TREE_SKIP = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', '.Trash']);
const TREE_MAX = 1000;

// Lists one directory under a space's root. Read-only. The real path of the target (symlinks
// resolved) must stay inside the real root, so neither `..` nor a symlink can leave the project.
function listDir(root, rel, showHidden) {
  if (rel.includes('\0') || path.isAbsolute(rel)) return { status: 400, error: 'bad path' };
  let realRoot, target;
  try {
    realRoot = fs.realpathSync(root);
    target = fs.realpathSync(path.join(realRoot, rel));
  } catch { return { status: 404, error: 'not found' }; }
  const inside = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(target)) return { status: 403, error: 'outside the project folder' };
  let dirents;
  try { dirents = fs.readdirSync(target, { withFileTypes: true }); } catch { return { status: 404, error: 'not a readable folder' }; }
  const entries = [];
  for (const d of dirents) {
    if (TREE_SKIP.has(d.name) || (!showHidden && d.name.startsWith('.'))) continue;
    let type = d.isDirectory() ? 'dir' : 'file';
    const link = d.isSymbolicLink();
    if (link) {
      try {
        const rp = fs.realpathSync(path.join(target, d.name));
        type = inside(rp) && fs.statSync(rp).isDirectory() ? 'dir' : 'file';
      } catch { type = 'file'; }
    }
    entries.push({ name: d.name, type, link });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  return { status: 200, root: realRoot, path: path.relative(realRoot, target), entries: entries.slice(0, TREE_MAX), truncated: entries.length > TREE_MAX };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating) {
    if (!allowedOrigins.has(req.headers.origin || '')) return send(res, 403, { error: 'bad origin' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
  }

  if (url.pathname === '/api/herdr' && req.method === 'GET') return send(res, 200, await herdrSnapshot());
  if (url.pathname === '/api/categories' && req.method === 'GET') return send(res, 200, categories);
  if (url.pathname === '/api/categories' && req.method === 'POST') {
    const clean = cleanCategories(await readJson(req));
    if (!clean) return send(res, 400, { error: 'bad categories' });
    categories = clean;
    return saveCategories() ? send(res, 200, categories) : send(res, 500, { error: 'could not save' });
  }
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    await herdrSnapshot(); // keeps the open/inactive split current
    return send(res, 200, { projects: ledgerView() });
  }
  if (url.pathname === '/api/projects/reopen' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.root !== 'string') return send(res, 400, { error: 'bad json' });
    const r = await reopenProject(body.root);
    return send(res, r.status, r);
  }
  if (url.pathname === '/api/projects/forget' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.root !== 'string') return send(res, 400, { error: 'bad json' });
    await herdrSnapshot(); // the open set can be up to 30 seconds old
    if (openRoots.has(body.root)) return send(res, 409, { error: 'a space is open for this project' });
    if (!ledger.delete(body.root)) return send(res, 404, { error: 'unknown project' });
    saveLedger();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/files' && req.method === 'GET') {
    const root = await rootFor(url.searchParams.get('space') || '');
    if (!root) return send(res, 404, { error: 'unknown space' });
    const r = listDir(root, url.searchParams.get('path') || '', url.searchParams.get('hidden') === '1');
    return send(res, r.status, r);
  }
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return send(res, 200, { sessions: [...sessions.values()].map(publicSession) });
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'bad json' });
    try {
      return send(res, 201, publicSession(createSession(body.cwd, body.label, typeof body.space === 'string' && /^[\w-]+$/.test(body.space) ? body.space : null, typeof body.agent === 'string' ? body.agent : null)));
    } catch (e) {
      return send(res, 500, { error: `could not start shell: ${e.message}` });
    }
  }
  const del = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (del && req.method === 'DELETE') {
    const s = sessions.get(del[1]);
    if (!s) return send(res, 404, { error: 'no such session' });
    if (s.tmux) { try { tmux('kill-session', '-t', SESSION_PREFIX + s.id); } catch {} }
    try { s.pty.kill(); } catch {}
    for (const ws of s.clients) ws.close();
    sessions.delete(s.id);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET') {
    if (VENDOR[url.pathname]) return serveFile(res, path.join(__dirname, VENDOR[url.pathname]));
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
    return serveFile(res, file);
  }
  send(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const ok = allowedHosts.has(req.headers.host || '') && allowedOrigins.has(req.headers.origin || '');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const s = sessions.get(url.searchParams.get('id') || '');
  if (!ok || url.pathname !== '/ws' || !s) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    s.clients.add(ws);
    if (s.buf) ws.send(s.buf);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (s.exited) return;
      if (m.t === 'in' && typeof m.d === 'string') s.pty.write(m.d);
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
        try { s.pty.resize(Math.min(m.cols, 500), Math.min(m.rows, 200)); } catch {}
      }
    });
    ws.on('close', () => s.clients.delete(ws));
  });
});

scrubTmuxEnv();
adoptSessions();
loadCategories();
if (!loadLedger()) seedFromSnapshots();
herdrSnapshot(); // records the current spaces right away
setInterval(herdrSnapshot, 30000).unref(); // notices closed spaces even with no page open
server.listen(PORT, HOST, () => console.log(`Corral listening on http://${HOST}:${PORT} (${TMUX ? 'tmux ' + TMUX_SOCKET : 'no tmux, plain shells'})`));

// Killing a tmux attach client only detaches it; the tmux session keeps running.
function shutdown() {
  for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
