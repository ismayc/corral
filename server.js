#!/usr/bin/env node
// Corral: a local HTML terminal workspace that sits beside herdr.
// Owns real PTYs (node-pty), streams them to xterm.js over WebSocket, and reads
// herdr's workspace list from `herdr api snapshot` to populate the sidebar.
// Binds to 127.0.0.1 only. A shell is remote code execution, so every request
// is checked for a loopback Host header and every mutation or socket upgrade
// for a loopback Origin (blocks DNS rebinding and cross-site requests).
// Other devices can reach it only through `tailscale serve`, which forwards
// to loopback; those requests must name this Mac's tailnet host and carry an
// allowed Tailscale login (see tailnetAccess below).

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
  '.webmanifest': 'application/manifest+json',
};

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// Tailnet access. `tailscale serve --bg --https=8443 http://127.0.0.1:8777` makes Corral reachable from
// the user's own devices at https://<this Mac>.<tailnet>.ts.net:8443, still over loopback here.
// Tailscale serve adds Tailscale-User-Login to every request it forwards and replaces any value the
// client sent; a Funnel (public) request has none. So a request is accepted through the tailnet name
// only when that login is allowed: by default, the login that owns this Mac in Tailscale.
const TS_PORT = Number(process.env.CORRAL_TAILSCALE_PORT || 8443);
const TS_BIN = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
  .find((p) => fs.existsSync(p)) || null;
let tailnet = null; // {host, origin, url, logins:Set, machine}

function detectTailnet() {
  if (process.env.CORRAL_TAILSCALE === '0' || !TS_BIN) return;
  execFile(TS_BIN, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    if (err) return;
    try {
      const d = JSON.parse(out);
      const name = String(d.Self?.DNSName || '').replace(/\.$/, '');
      const owner = d.User?.[d.Self?.UserID]?.LoginName;
      const extra = (process.env.CORRAL_TAILSCALE_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const logins = new Set(extra.length ? extra : owner ? [owner] : []);
      if (!/^[a-z0-9.-]+\.ts\.net$/i.test(name) || !logins.size) return;
      const host = `${name}:${TS_PORT}`.toLowerCase();
      const next = { host, origin: `https://${host}`, url: `https://${host}/`, logins, machine: d.Self?.HostName || name, served: false };
      // Whether `tailscale serve` actually forwards that address here; only then is the link offered.
      execFile(TS_BIN, ['serve', 'status', '--json'], { timeout: 5000 }, (err2, out2) => {
        try {
          const proxy = JSON.parse(out2).Web?.[host]?.Handlers?.['/']?.Proxy || '';
          next.served = !err2 && /^(http:\/\/)?(127\.0\.0\.1|localhost):(\d+)\/?$/.test(proxy) && Number(proxy.match(/:(\d+)\/?$/)[1]) === PORT;
        } catch {}
        if (!tailnet || tailnet.host !== next.host || tailnet.served !== next.served) {
          console.log(`tailnet access: ${next.url} for ${[...logins].join(', ')}${next.served ? '' : ` (not served yet: tailscale serve --bg --https=${TS_PORT} http://127.0.0.1:${PORT})`}`);
        }
        tailnet = next;
      });
    } catch {}
  });
}

// Classifies a request: {local:true} from this Mac, {remote:true, login} through the tailnet, or null.
function requestAccess(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (allowedHosts.has(host)) return { local: true, origins: allowedOrigins };
  const login = String(req.headers['tailscale-user-login'] || '');
  if (tailnet && host === tailnet.host && tailnet.logins.has(login)) return { remote: true, login, origins: new Set([tailnet.origin]) };
  return null;
}

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

// Runs tmux on the dedicated socket, so the user's own tmux server is never touched. The first call
// starts the tmux server, which keeps that call's working folder for its whole life; home is used so
// it never holds a folder that may later be moved or deleted (such as this repo).
function tmux(...args) {
  return execFileSync(TMUX, ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv(), cwd: os.homedir() });
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
// `resume` comes only from Corral's own restore file, after resumableId() has checked it.
function programFor(agent, resume) {
  return resume ? `claude --resume ${resume}` : AGENTS[agent] || null;
}
function startCommand(agent, resume) {
  const shell = process.env.SHELL || '/bin/zsh';
  const program = programFor(agent, resume);
  if (!program) return { shell, command: null };
  return { shell, command: `${shell} -lc ${shq(`${program}; exec ${shell} -l`)}` };
}

// Starts the process that feeds the browser: a plain login shell, or a tmux attach client.
function attachPty(id, dir, useTmux, agent, resume) {
  const env = cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', CORRAL_SESSION: id });
  const shell = process.env.SHELL || '/bin/zsh';
  const program = programFor(agent, resume);
  const [file, args] = useTmux
    ? [TMUX, ['-L', TMUX_SOCKET, 'attach-session', '-t', SESSION_PREFIX + id]]
    : program ? [shell, ['-lc', `${program}; exec ${shell} -l`]] : [shell, ['-l']];
  return pty.spawn(file, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: dir, env });
}

function register(id, dir, label, created, useTmux, space, agent, resume) {
  const s = {
    id, pty: null, buf: '', clients: new Set(), cwd: dir, space: space || null,
    label: label || path.basename(dir) || dir, exited: false, created, tmux: useTmux,
  };
  s.pty = attachPty(id, dir, useTmux, agent, resume);
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
    saveBackupSoon();
  });
  sessions.set(id, s);
  return s;
}

function createSession(cwd, label, space, agent, resume) {
  const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : os.homedir();
  const id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  const name = label || path.basename(dir) || dir;
  if (TMUX) {
    const { shell, command } = startCommand(agent, resume);
    // tmux 3.7c ignores -c when its server's own working folder has been deleted: the pane starts in the
    // deleted folder and every command there fails. So the pane also changes into the folder itself,
    // falling back to home, before starting the shell. zsh -f (no startup files) is used where it exists
    // because sh prints a "shell-init: getcwd" warning when it starts in a deleted folder.
    const wrap = fs.existsSync('/bin/zsh') ? ['/bin/zsh', '-fc'] : ['/bin/sh', '-c'];
    const inDir = [...wrap, 'cd -- "$1" 2>/dev/null || cd; shift; exec "$@"', 'corral', dir];
    tmux('new-session', '-d', '-s', SESSION_PREFIX + id, '-c', dir, '-x', '100', '-y', '30',
      ...inDir, ...(command ? ['/bin/sh', '-c', command] : [shell, '-l']));
    tmux('source-file', TMUX_CONF);
    tmux('set-option', '-t', SESSION_PREFIX + id, '@corral_label', name);
    if (space) tmux('set-option', '-t', SESSION_PREFIX + id, '@corral_space', String(space));
  }
  const s = register(id, dir, name, Date.now(), Boolean(TMUX), space, agent, resume);
  saveBackupSoon();
  setTimeout(saveBackupSoon, 8000).unref(); // by then Claude Code has written its session file
  return s;
}

// After a server restart, tmux sessions from the previous run are still alive. Reattach to them.
function adoptSessions() {
  if (!TMUX) return;
  let out = '';
  try {
    out = tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_path}\t#{?#{@corral_label},#{@corral_label},#{@webterm_label}}\t#{?#{@corral_space},#{@corral_space},#{@webterm_space}}\t#{@corral_remote}');
  } catch { return; } // no tmux server running means nothing to adopt
  for (const line of out.split('\n')) {
    const [name, created, dir, label, space, remote] = line.split('\t');
    if (!name || !name.startsWith(SESSION_PREFIX)) continue;
    const id = name.slice(SESSION_PREFIX.length);
    if (!/^[\w-]+$/.test(id) || sessions.has(id)) continue;
    try { register(id, dir && fs.existsSync(dir) ? dir : os.homedir(), label, Number(created) * 1000, true, space).remote = remote === '1'; } catch {}
  }
  if (sessions.size) console.log(`adopted ${sessions.size} tmux session(s)`);
}

function publicSession(s) {
  return { id: s.id, cwd: s.cwd, label: s.label, space: s.space, exited: s.exited, created: s.created, persistent: s.tmux, remote: Boolean(s.remote) };
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

// Backup of the open windows, so they can be brought back after the tmux server or the Mac restarts.
// open-sessions.json always mirrors what is open now, with the Claude Code conversation running in each
// window. At startup, windows in it that are no longer running move to restore.json, where they wait for
// the Restore button; opening new windows first cannot overwrite them.
const BACKUP_FILE = path.join(DATA_DIR, 'open-sessions.json');
const RESTORE_FILE = path.join(DATA_DIR, 'restore.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Claude Code writes ~/.claude/sessions/<pid>.json for each running instance, naming its conversation.
// The window's Claude is somewhere under the pane's shell, so walk the process tree down from it.
function claudeUnder(rootPid, children) {
  const queue = [rootPid];
  for (let i = 0; i < queue.length && i < 200; i++) {
    const d = readJsonFile(path.join(CLAUDE_DIR, 'sessions', `${queue[i]}.json`));
    if (d && UUID.test(d.sessionId || '') && typeof d.cwd === 'string') {
      return {
        sessionId: d.sessionId, cwd: d.cwd, status: typeof d.status === 'string' ? d.status : null,
        waitingFor: d.status === 'waiting' && typeof d.waitingFor === 'string' ? d.waitingFor : null,
      };
    }
    queue.push(...(children.get(queue[i]) || []));
  }
  return null;
}

function processChildren() {
  const children = new Map();
  try {
    for (const line of execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid) children.set(ppid, [...(children.get(ppid) || []), pid]);
    }
  } catch {}
  return children;
}

function openWindows() {
  const children = processChildren();
  return [...sessions.values()].filter((s) => !s.exited).sort((a, b) => a.created - b.created).map((s) => {
    let root = s.pty.pid;
    if (s.tmux) { try { root = Number(tmux('display-message', '-p', '-t', SESSION_PREFIX + s.id, '#{pane_pid}').trim()); } catch {} }
    const claude = claudeUnder(root, children);
    const w = { id: s.id, label: s.label, cwd: s.cwd, space: s.space };
    if (claude) {
      w.claudeSession = claude.sessionId;
      w.claudeCwd = claude.cwd;
      w.resumeCommand = `cd ${shq(claude.cwd)} && claude --resume ${claude.sessionId}`;
    }
    return w;
  });
}

// What the phone page lists: each open window with its last output time and Claude Code's own status
// (busy, idle, or shell, from its session file).
function overview() {
  const children = processChildren();
  const panes = new Map();
  if (TMUX) {
    try {
      for (const line of tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{window_activity}').split('\n')) {
        const [name, pid, activity] = line.split('\t');
        if (name?.startsWith(SESSION_PREFIX) && !panes.has(name)) panes.set(name, { pid: Number(pid), activity: Number(activity) * 1000 });
      }
    } catch {}
  }
  return [...sessions.values()].sort((a, b) => a.created - b.created).map((s) => {
    const p = panes.get(SESSION_PREFIX + s.id);
    const claude = s.exited ? null : claudeUnder(p ? p.pid : s.pty.pid, children);
    return {
      ...publicSession(s),
      activity: p ? p.activity : null,
      claude: claude ? { status: claude.status, waitingFor: claude.waitingFor } : null,
      prompt: claude?.waitingFor === 'permission prompt' ? permissionPrompt(s.id) : null,
    };
  });
}

// The window's scrollback as plain text, for reading and copying on a phone.
function windowHistory(id) {
  return tmux('capture-pane', '-p', '-J', '-S', '-3000', '-t', SESSION_PREFIX + id).replace(/\n+$/, '\n');
}

// Claude Code's permission prompt, read from the window's screen. Its session file says only that one is
// open ("waitingFor": "permission prompt"); the screen has what it asks and the numbered answers:
//   Bash command / <what it wants to run> / Do you want to proceed? / ❯ 1. Yes / 2. ... / 4. No / Esc to cancel
// Pressing an answer's number picks it, and Esc denies (both checked against Claude Code 2.1.292).
// Claude Code wraps at spaces, and splits a word only when it is too long for the line (such as a path).
const rejoin = (a, b) => (/\S{30,}$/.test(a) ? a + b : `${a} ${b}`);
function permissionPrompt(id) {
  let lines;
  try { lines = tmux('capture-pane', '-p', '-t', SESSION_PREFIX + id).split('\n').map((l) => l.trimEnd()); } catch { return null; }
  const end = lines.findLastIndex((l) => /^\s*Esc to cancel/.test(l));
  if (end < 0) return null;
  // The answers are the last run numbered 1, 2, 3... above "Esc to cancel". A line between two answers
  // continues the one above it, whether Claude Code indented the wrap or the terminal broke the line.
  const opt = (l) => l.match(/^\s*(?:❯\s*)?(\d)\.\s+(.*)$/);
  let first = -1;
  for (let j = end - 1; j >= 0 && end - j < 40; j--) if (opt(lines[j])?.[1] === '1') { first = j; break; }
  if (first < 0) return null;
  const options = [];
  for (let j = first; j < end; j++) {
    const m = opt(lines[j]);
    if (m && Number(m[1]) === options.length + 1) options.push({ n: m[1], label: m[2].trim() });
    else if (lines[j].trim()) options[options.length - 1].label = rejoin(options[options.length - 1].label, lines[j].trim());
  }
  const i = first - 1;
  // The prompt's own text runs from the full-width rule above it down to the answers.
  let top = i;
  while (top > 0 && !/^─{20,}$/.test(lines[top - 1].trim())) top--;
  const text = lines.slice(top, i + 1)
    .filter((l) => l.trim() && !/^[╌─]{20,}$/.test(l.trim()) && !/^\s*Tip:/.test(l))
    .map((l) => l.replace(/^\s?│ ?/, '').replace(/^ /, ''))
    .slice(-30);
  return { text: text.join('\n'), options: options.map((o) => ({ n: o.n, label: o.label.slice(0, 160) })) };
}

// The Claude Code status of one window, read fresh.
function windowClaude(s) {
  let root = s.pty.pid;
  if (s.tmux) { try { root = Number(tmux('display-message', '-p', '-t', SESSION_PREFIX + s.id, '#{pane_pid}').trim()); } catch {} }
  return claudeUnder(root, processChildren());
}

// Answers a permission prompt with one of its numbered answers, or denies it. The prompt is read again
// first, so an answer can only go to a prompt that is still open and offers that number.
function answerPrompt(s, choice) {
  if (windowClaude(s)?.waitingFor !== 'permission prompt') return { status: 409, error: 'no permission prompt is open in this window' };
  const p = permissionPrompt(s.id);
  if (!p) return { status: 409, error: 'could not read the prompt on the screen' };
  if (choice === 'deny') tmux('send-keys', '-t', SESSION_PREFIX + s.id, 'Escape');
  else if (p.options.some((o) => o.n === choice)) tmux('send-keys', '-t', SESSION_PREFIX + s.id, '-l', choice);
  else return { status: 400, error: 'that is not one of the answers' };
  return { status: 200, ok: true };
}

// A read-only look at what changed in a window's project: `git status` plus the diff against HEAD.
// GIT_OPTIONAL_LOCKS=0 keeps git from taking the index lock, so it never gets in the way of Claude's own git.
const DIFF_MAX = 600 * 1024;
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...cleanEnv(), GIT_OPTIONAL_LOCKS: '0' } },
      (err, out) => resolve(err ? null : out));
  });
}
async function windowChanges(s) {
  const cwd = windowClaude(s)?.cwd || s.cwd;
  const top = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return { status: 200, repo: null, cwd };
  const [branch, status, diff] = await Promise.all([
    git(top, ['branch', '--show-current']),
    git(top, ['status', '--porcelain=v1', '-uall']),
    git(top, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-M']),
  ]);
  const files = (status || '').split('\n').filter(Boolean).slice(0, 500).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  // New files are not in `git diff`; show the start of each small text one.
  let extra = '';
  for (const f of files.filter((x) => x.code === '??').slice(0, 20)) {
    try {
      const file = path.join(top, f.path);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const body = fs.readFileSync(file, 'utf8');
      if (body.includes('\0')) continue;
      const lines = body.replace(/\n$/, '').split('\n').slice(0, 200);
      extra += `diff --git a/${f.path} b/${f.path}\nnew file (not added to git yet)\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    } catch {}
  }
  let text = (diff || '') + extra;
  const truncated = text.length > DIFF_MAX;
  if (truncated) text = text.slice(0, DIFF_MAX);
  return { status: 200, repo: path.basename(top), root: top, branch: (branch || '').trim(), files, diff: text, truncated };
}

// Photos from the phone go to Corral's own data folder, not the project, so they never show up in git.
// The phone pastes the saved file's path into its message, which is how Claude Code is given an image.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const UPLOAD_MAX = 20 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/webp': '.webp', 'image/gif': '.gif' };
function saveUpload(body) {
  const ext = IMAGE_TYPES[body?.type];
  if (!ext || typeof body.data !== 'string') return { status: 400, error: 'send a photo (JPEG, PNG, HEIC, WebP, or GIF)' };
  const buf = Buffer.from(body.data, 'base64');
  if (!buf.length || buf.length > UPLOAD_MAX) return { status: 413, error: 'the photo is empty or too large' };
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(UPLOAD_DIR, `photo-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return { status: 201, path: file };
}

// Web Push: tells the phone when a window becomes your turn or asks for permission, even with the page
// closed. On an iPhone this works only for Corral added to the Home Screen (iOS 16.4 or later). The
// message is encrypted for the phone (RFC 8291) and signed with this server's own key (VAPID, RFC 8292),
// so Apple's push service carries it without being able to read it. Keys and subscriptions stay in push.json.
const crypto = require('crypto');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
let push = null; // {publicKey, privateKey (JWK), subs: [{endpoint, keys, ua, added}], prefs: {turn, permission, away}}
function loadPush() {
  push = readJsonFile(PUSH_FILE);
  if (!push?.privateKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    push = { publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)), privateKey: privateKey.export({ format: 'jwk' }), subs: [] };
  }
  push.subs = Array.isArray(push.subs) ? push.subs : [];
  push.prefs = { turn: true, permission: true, away: true, ...push.prefs };
  savePush();
}
function savePush() { try { writeJson(PUSH_FILE, push); } catch (e) { console.error('push save failed:', e.message); } }

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://github.com/ismayc/corral' }));
  const key = crypto.createPrivateKey({ key: push.privateKey, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${push.publicKey}`;
}

// aes128gcm content encoding for one subscription (RFC 8291 section 3 and RFC 8188).
function encryptPush(sub, payload) {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

async function sendPush(sub, message) {
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high' },
      body: encryptPush(sub, JSON.stringify(message)),
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404 || r.status === 410) return 'gone'; // the phone dropped this subscription
    if (!r.ok) console.error(`push to ${new URL(sub.endpoint).host} failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok ? 'ok' : 'failed';
  } catch (e) { console.error('push failed:', e.message); return 'failed'; }
}

async function pushAll(message) {
  if (!push.subs.length) return [];
  const results = await Promise.all(push.subs.map((s) => sendPush(s, message)));
  console.log(`push "${message.title}": ${results.join(', ')}`);
  const keep = push.subs.filter((_, i) => results[i] !== 'gone');
  if (keep.length !== push.subs.length) { push.subs = keep; savePush(); }
  return results;
}

// Seconds since the Mac last saw a key or the mouse, from IOKit's HIDIdleTime (nanoseconds).
function macIdleSeconds() {
  try {
    const m = execFileSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8', timeout: 3000 }).match(/"HIDIdleTime" = (\d+)/);
    return m ? Number(m[1]) / 1e9 : Infinity;
  } catch { return Infinity; }
}

// Watches every window's Claude status and sends a push on the moments worth one: a turn ending
// (busy to idle) and a permission prompt opening. With "away" on, nothing is sent while the Mac is in use.
const AWAY_SECONDS = 120;
const lastSeen = new Map(); // window id -> 'busy' | 'idle' | 'permission' | ...
let watchPrimed = false;
function watchForPush() {
  if (!push.subs.length) { lastSeen.clear(); watchPrimed = false; return; }
  let rows;
  try { rows = overview(); } catch { return; }
  const events = [];
  for (const w of rows) {
    if (w.exited) continue;
    const st = !w.claude ? 'shell' : w.claude.waitingFor === 'permission prompt' ? 'permission' : w.claude.status;
    // Before the first look, every window's state is old news; after it, a new window counts as just started.
    const was = lastSeen.has(w.id) ? lastSeen.get(w.id) : watchPrimed ? 'new' : st;
    lastSeen.set(w.id, st);
    if (was === st) continue;
    if (st === 'permission' && push.prefs.permission) {
      const first = (w.prompt?.text || '').split('\n').find((l) => l.trim()) || 'Claude is asking before it goes on';
      events.push({ title: `${w.label} needs permission`, body: first.trim().slice(0, 120), tag: w.id, url: `/m?w=${w.id}` });
    } else if (was === 'busy' && st === 'idle' && push.prefs.turn) {
      events.push({ title: `${w.label}: your turn`, body: 'Claude finished and is waiting for you.', tag: w.id, url: `/m?w=${w.id}` });
    }
  }
  for (const id of lastSeen.keys()) if (!rows.some((w) => w.id === id)) lastSeen.delete(id);
  watchPrimed = true;
  if (!events.length || (push.prefs.away && macIdleSeconds() < AWAY_SECONDS)) return;
  for (const e of events) pushAll(e);
}

const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
function cleanSubscription(b) {
  const s = b?.subscription;
  if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 2048) return null;
  // Only the browsers' own push services, so the server never posts to an address a page made up.
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
  } catch { return null; }
  if (typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return null;
  try { if (Buffer.from(s.keys.p256dh, 'base64url').length !== 65 || Buffer.from(s.keys.auth, 'base64url').length !== 16) return null; } catch { return null; }
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

let backupTimer = null;
function saveBackup() {
  clearTimeout(backupTimer);
  try { writeJson(BACKUP_FILE, { version: 1, savedAt: new Date().toISOString(), windows: openWindows() }); }
  catch (e) { console.error('backup save failed:', e.message); }
}
function saveBackupSoon() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(saveBackup, 1000);
  backupTimer.unref();
}

// Runs once at startup, after adoptSessions(): whatever the backup lists that is not running now can be restored.
function prepareRestore() {
  const prev = readJsonFile(BACKUP_FILE);
  const gone = (prev?.windows || []).filter((w) => w && typeof w.id === 'string' && !sessions.has(w.id));
  if (gone.length) {
    try { writeJson(RESTORE_FILE, { version: 1, savedAt: prev.savedAt, windows: gone }); }
    catch (e) { console.error('restore list save failed:', e.message); }
    console.log(`${gone.length} window(s) from ${prev.savedAt} can be restored`);
  }
}

// A conversation ID is used only if it is well formed and Claude Code has that conversation on disk.
function resumableId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  const projects = path.join(CLAUDE_DIR, 'projects');
  try {
    return fs.readdirSync(projects).some((d) => fs.existsSync(path.join(projects, d, `${id}.jsonl`))) ? id : null;
  } catch { return null; }
}

function restoreList() {
  const r = readJsonFile(RESTORE_FILE);
  return r && Array.isArray(r.windows) ? r : { savedAt: null, windows: [] };
}

// Reopens every window in restore.json. The page sends no paths or IDs; everything comes from that file.
function restoreWindows() {
  const restored = [];
  const plain = [];
  for (const w of restoreList().windows) {
    if (!w || typeof w.label !== 'string') continue;
    const space = typeof w.space === 'string' && /^[\w-]+$/.test(w.space) ? w.space : null;
    const resume = resumableId(w.claudeSession);
    if (w.claudeSession && !resume) plain.push(w.label);
    const cwd = resume && typeof w.claudeCwd === 'string' ? w.claudeCwd : typeof w.cwd === 'string' ? w.cwd : null;
    try { restored.push(publicSession(createSession(cwd, w.label, space, null, resume))); } catch {}
  }
  try { fs.unlinkSync(RESTORE_FILE); } catch {}
  return { sessions: restored, notResumed: plain };
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

// Open with: a click on a file in a space's tree opens it in a Mac app. The apps offered are the ones
// macOS itself lists for that file; the user's choice per file type is kept in open-with.json.
// The page names a file (space plus relative path) and an app; the server checks both.
const OPEN_WITH_FILE = path.join(DATA_DIR, 'open-with.json');
const APPS_SCRIPT = path.join(__dirname, 'scripts', 'apps-for-file.js');
const openWith = new Map(); // file type -> app path, 'system', or nothing
function loadOpenWith() {
  const d = readJsonFile(OPEN_WITH_FILE);
  if (d && d.defaults && typeof d.defaults === 'object') for (const [k, v] of Object.entries(d.defaults)) if (typeof v === 'string') openWith.set(k, v);
}
function saveOpenWith() {
  try { writeJson(OPEN_WITH_FILE, { version: 1, defaults: Object.fromEntries(openWith) }); return true; } catch (e) { console.error('open-with save failed:', e.message); return false; }
}

// The type a default applies to: the extension (".md"), or the whole name for files without one ("Makefile").
const fileKind = (file) => path.extname(file).toLowerCase() || path.basename(file);

// The real path of a file inside a space's project folder, or null.
async function spaceFile(spaceId, rel) {
  const root = await rootFor(spaceId || '');
  if (!root || typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const file = fs.realpathSync(path.join(realRoot, rel));
    if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) return null;
    return file;
  } catch { return null; }
}

function appsFor(file) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', APPS_SCRIPT, file], { timeout: 10000 }, (err, out) => {
      try { resolve(err ? { def: null, apps: [] } : JSON.parse(out)); } catch { resolve({ def: null, apps: [] }); }
    });
  });
}

// The apps for a file. A type macOS knows nothing about gets the apps that open plain text.
async function openChoices(file) {
  const r = await appsFor(file);
  if (r.apps.length) return { ...r, asText: false };
  const sample = path.join(DATA_DIR, 'plain-text-sample.txt');
  try { if (!fs.existsSync(sample)) { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(sample, '', { mode: 0o600 }); } } catch {}
  const t = await appsFor(sample);
  return { def: null, apps: t.apps, asText: true };
}

// app is 'system' (the macOS default), 'finder' (show it in Finder), or the path of one of the offered apps.
async function openFile(file, app) {
  let args;
  if (app === 'finder') args = ['-R', file];
  else if (app === 'system') {
    if (!(await appsFor(file)).def) return { status: 409, error: 'macOS has no default app for this file' };
    args = [file];
  } else {
    const { apps } = await openChoices(file);
    if (!apps.some((a) => a.path === app)) return { status: 400, error: 'that app does not open this file' };
    args = ['-a', app, file];
  }
  const ok = await new Promise((resolve) => execFile('open', args, { timeout: 10000 }, (err) => resolve(!err)));
  return ok ? { status: 200, ok: true } : { status: 502, error: 'macOS could not open it' };
}

const appName = (p) => (p === 'system' ? 'its macOS default app' : p === 'finder' ? 'Finder' : path.basename(p, '.app'));

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

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
    req.on('close', () => resolve(null)); // a body over the limit destroys the request, and 'end' never comes
  });
}

const server = http.createServer(async (req, res) => {
  const access = requestAccess(req);
  if (!access) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating) {
    if (!access.origins.has(req.headers.origin || '')) return send(res, 403, { error: 'bad origin' });
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
  if (url.pathname === '/api/open-with' && req.method === 'GET') {
    const file = await spaceFile(url.searchParams.get('space'), url.searchParams.get('path'));
    if (!file) return send(res, 404, { error: 'no such file in this space' });
    const kind = fileKind(file);
    const c = await openChoices(file);
    return send(res, 200, { name: path.basename(file), kind, saved: openWith.get(kind) || null, ...c });
  }
  // Opens a file. With no app, uses the saved default for its type, or answers needsChoice.
  if (url.pathname === '/api/open' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'bad json' });
    const file = await spaceFile(body.space, body.path);
    if (!file) return send(res, 404, { error: 'no such file in this space' });
    const kind = fileKind(file);
    const app = typeof body.app === 'string' && body.app ? body.app : openWith.get(kind);
    if (!app) return send(res, 200, { needsChoice: true });
    const r = await openFile(file, app);
    if (r.ok && body.remember && app !== 'finder') { openWith.set(kind, app); saveOpenWith(); }
    if (!r.ok && !body.app && openWith.has(kind)) return send(res, 200, { needsChoice: true, error: r.error }); // a saved app that is gone
    const { status, ...result } = r;
    return send(res, status, { ...result, kind, app: appName(app), remembered: openWith.get(kind) === app });
  }
  if (url.pathname === '/api/open-with/forget' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.kind !== 'string') return send(res, 400, { error: 'bad json' });
    openWith.delete(body.kind);
    return saveOpenWith() ? send(res, 200, { ok: true }) : send(res, 500, { error: 'could not save' });
  }
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return send(res, 200, { sessions: [...sessions.values()].map(publicSession) });
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'bad json' });
    try {
      const s = createSession(body.cwd, body.label, typeof body.space === 'string' && /^[\w-]+$/.test(body.space) ? body.space : null, typeof body.agent === 'string' ? body.agent : null);
      // Started from another device: the Mac's page puts it in the bottom bar rather than in a zone.
      if (access.remote) {
        s.remote = true;
        if (s.tmux) { try { tmux('set-option', '-t', SESSION_PREFIX + s.id, '@corral_remote', '1'); } catch {} }
      }
      return send(res, 201, publicSession(s));
    } catch (e) {
      return send(res, 500, { error: `could not start shell: ${e.message}` });
    }
  }
  if (url.pathname === '/api/overview' && req.method === 'GET') {
    return send(res, 200, { machine: tailnet?.machine || os.hostname().replace(/\.local$/, ''), sessions: overview() });
  }
  if (url.pathname === '/api/remote' && req.method === 'GET') {
    return send(res, 200, { url: tailnet?.served ? tailnet.url : null, machine: tailnet?.machine || null, remote: Boolean(access.remote) });
  }
  const hist = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/history$/);
  if (hist && req.method === 'GET') {
    const s = sessions.get(hist[1]);
    if (!s || !s.tmux || s.exited) return send(res, 404, { error: 'no such window' });
    try { return send(res, 200, windowHistory(s.id), 'text/plain; charset=utf-8'); } catch { return send(res, 500, { error: 'could not read the window' }); }
  }
  const act = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/(prompt|answer|changes|upload)$/);
  if (act) {
    const s = sessions.get(act[1]);
    if (!s || s.exited) return send(res, 404, { error: 'no such window' });
    if (act[2] === 'prompt' && req.method === 'GET') {
      return send(res, 200, { prompt: windowClaude(s)?.waitingFor === 'permission prompt' ? permissionPrompt(s.id) : null });
    }
    if (act[2] === 'answer' && req.method === 'POST') {
      if (!s.tmux) return send(res, 409, { error: 'this window has no tmux session' });
      const body = await readJson(req);
      if (!body || typeof body.choice !== 'string') return send(res, 400, { error: 'bad json' });
      const { status, ...r } = answerPrompt(s, body.choice);
      return send(res, status, r);
    }
    if (act[2] === 'changes' && req.method === 'GET') {
      const { status, ...r } = await windowChanges(s);
      return send(res, status, r);
    }
    if (act[2] === 'upload' && req.method === 'POST') {
      const body = await readJson(req, Math.ceil(UPLOAD_MAX * 1.4));
      if (!body) return send(res, 400, { error: 'bad json, or the photo is too large' });
      try { const { status, ...r } = saveUpload(body); return send(res, status, r); } catch (e) { return send(res, 500, { error: `could not save: ${e.message}` }); }
    }
  }
  if (url.pathname === '/api/push' && req.method === 'GET') {
    return send(res, 200, { key: push.publicKey, devices: push.subs.length, prefs: push.prefs });
  }
  if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
    const sub = cleanSubscription(await readJson(req));
    if (!sub) return send(res, 400, { error: 'not a push subscription from a known push service' });
    push.subs = [...push.subs.filter((x) => x.endpoint !== sub.endpoint), { ...sub, added: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 200) }].slice(-10);
    savePush();
    return send(res, 200, { ok: true, devices: push.subs.length });
  }
  if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || typeof body.endpoint !== 'string') return send(res, 400, { error: 'bad json' });
    push.subs = push.subs.filter((x) => x.endpoint !== body.endpoint);
    savePush();
    return send(res, 200, { ok: true, devices: push.subs.length });
  }
  if (url.pathname === '/api/push/prefs' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return send(res, 400, { error: 'bad json' });
    for (const k of ['turn', 'permission', 'away']) if (typeof body[k] === 'boolean') push.prefs[k] = body[k];
    savePush();
    return send(res, 200, { prefs: push.prefs });
  }
  // Sends a test notification to one device (the one asking), so the setup can be checked from the phone.
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    const body = await readJson(req);
    const sub = push.subs.find((x) => x.endpoint === body?.endpoint);
    if (!sub) return send(res, 404, { error: 'this device is not subscribed' });
    const r = await sendPush(sub, { title: 'Corral', body: 'Notifications work. You will hear from Corral when a window needs you.', tag: 'test', url: '/m' });
    return send(res, r === 'ok' ? 200 : 502, r === 'ok' ? { ok: true } : { error: `the push service answered: ${r}` });
  }
  const del = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (del && req.method === 'DELETE') {
    const s = sessions.get(del[1]);
    if (!s) return send(res, 404, { error: 'no such session' });
    if (s.tmux) { try { tmux('kill-session', '-t', SESSION_PREFIX + s.id); } catch {} }
    try { s.pty.kill(); } catch {}
    for (const ws of s.clients) ws.close();
    sessions.delete(s.id);
    saveBackupSoon();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/restore' && req.method === 'GET') {
    const r = restoreList();
    return send(res, 200, { savedAt: r.savedAt, windows: r.windows.map((w) => ({ label: w.label, claude: Boolean(w.claudeSession) })) });
  }
  if (url.pathname === '/api/restore' && req.method === 'POST') return send(res, 200, restoreWindows());
  if (url.pathname === '/api/restore/dismiss' && req.method === 'POST') {
    try { fs.unlinkSync(RESTORE_FILE); } catch {}
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET') {
    if (VENDOR[url.pathname]) return serveFile(res, path.join(__dirname, VENDOR[url.pathname]));
    const rel = url.pathname === '/' ? 'index.html' : url.pathname === '/m' ? 'm.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
    return serveFile(res, file);
  }
  send(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const access = requestAccess(req);
  const ok = access && access.origins.has(req.headers.origin || '');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const s = sessions.get(url.searchParams.get('id') || '');
  if (!ok || url.pathname !== '/ws' || !s) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  // Another device (or the phone page) gets its own tmux client for the window instead of sharing the
  // Mac's. tmux then sizes the window for whichever device typed last, rather than the two fighting.
  const own = s.tmux && !s.exited && (access.remote || url.searchParams.get('own') === '1');
  wss.handleUpgrade(req, socket, head, (ws) => {
    let target = s.pty;
    if (own) {
      const size = (v, max, d) => Math.min(Math.max(Number(v) || d, 10), max);
      try {
        target = pty.spawn(TMUX, ['-L', TMUX_SOCKET, 'attach-session', '-t', SESSION_PREFIX + s.id], {
          name: 'xterm-256color', cols: size(url.searchParams.get('cols'), 500, 80), rows: size(url.searchParams.get('rows'), 200, 24),
          cwd: os.homedir(), env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', CORRAL_SESSION: s.id }),
        });
      } catch { return ws.close(); }
      target.onData((d) => { if (ws.readyState === 1) ws.send(d); });
      target.onExit(() => {
        if (ws.readyState === 1) ws.send('\r\n\x1b[2m[window closed]\x1b[0m\r\n');
        ws.close();
      });
    } else {
      s.clients.add(ws);
      if (s.buf) ws.send(s.buf);
    }
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (s.exited) return;
      if (m.t === 'in' && typeof m.d === 'string') target.write(m.d);
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
        try { target.resize(Math.min(m.cols, 500), Math.min(m.rows, 200)); } catch {}
      }
    });
    // Killing a tmux attach client only detaches it; the window keeps running.
    ws.on('close', () => { if (own) { try { target.kill(); } catch {} } else s.clients.delete(ws); });
  });
});

scrubTmuxEnv();
adoptSessions();
prepareRestore(); // must read the previous backup before saveBackup() replaces it
saveBackup();
setInterval(saveBackup, 30000).unref(); // also catches a window switching to another Claude conversation
loadCategories();
loadOpenWith();
loadPush();
setInterval(watchForPush, 3000).unref();
if (!loadLedger()) seedFromSnapshots();
herdrSnapshot(); // records the current spaces right away
setInterval(herdrSnapshot, 30000).unref(); // notices closed spaces even with no page open
detectTailnet();
setInterval(detectTailnet, 60000).unref(); // picks up Tailscale starting, or a renamed Mac
server.listen(PORT, HOST, () => console.log(`Corral listening on http://${HOST}:${PORT} (${TMUX ? 'tmux ' + TMUX_SOCKET : 'no tmux, plain shells'})`));

// Killing a tmux attach client only detaches it; the tmux session keeps running.
function shutdown() {
  for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
