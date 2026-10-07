// Loads a fresh copy of server.js against a throwaway home folder, with tmux, ps, herdr, git, and the other
// programs it runs replaced by fakes, so a test never touches the real machine. Each test file runs in its
// own process (node --test), so the mocks installed here last for that file only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { mock } = require('node:test');
const pty = require('node-pty');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const PORT = 18777;
const TMUX_PATHS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
const TS_PATHS = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const realExistsSync = fs.existsSync;
const realExecFile = cp.execFile;

// A stand-in for node-pty's IPty.
class FakePty {
  constructor(file, args, opts) {
    Object.assign(this, { file, args, opts, pid: 50000 + FakePty.count++, written: [], sizes: [], killed: false });
    this.dataCbs = []; this.exitCbs = [];
  }
  onData(cb) { this.dataCbs.push(cb); }
  onExit(cb) { this.exitCbs.push(cb); }
  emitData(d) { for (const cb of this.dataCbs) cb(d); }
  emitExit(exitCode = 0) { for (const cb of this.exitCbs) cb({ exitCode }); }
  write(d) { this.written.push(d); }
  resize(c, r) { if (this.throwOnResize) throw new Error('resize failed'); this.sizes.push([c, r]); }
  kill() { if (this.throwOnKill) throw new Error('kill failed'); this.killed = true; }
}
FakePty.count = 0;

// A small model of the tmux server: sessions with options, a pane pid, a screen, and the keys sent.
class FakeTmux {
  constructor() {
    this.sessions = new Map(); // name -> {created, path, options:{}, panePid, activity, screen, history}
    this.calls = [];
    this.keys = [];
    this.fail = new Set(); // subcommands that throw, e.g. 'list-sessions'
    this.env = [];
  }
  add(name, extra = {}) {
    const s = { created: 1791390000, path: os.tmpdir(), options: {}, panePid: 40000 + this.sessions.size, activity: 1791390100, screen: '', history: '', ...extra };
    this.sessions.set(name, s);
    return s;
  }
  run(args) {
    if (args[0] === '-L') args = args.slice(2);
    const [cmd, ...rest] = args;
    this.calls.push(args);
    if (this.fail.has(cmd)) throw new Error(`tmux ${cmd} failed`);
    const target = () => rest[rest.indexOf('-t') + 1];
    switch (cmd) {
      case 'list-sessions': {
        if (rest.includes('#{session_name}')) return [...this.sessions.keys()].join('\n');
        if (!this.sessions.size) throw new Error('no server running');
        return [...this.sessions].map(([n, s]) => [n, s.created, s.path, s.options['@corral_label'] || '', s.options['@corral_space'] || '', s.options['@corral_remote'] || ''].join('\t')).join('\n');
      }
      case 'new-session': {
        const name = rest[rest.indexOf('-s') + 1];
        this.add(name, { path: rest[rest.indexOf('-c') + 1], command: rest.slice(rest.indexOf('-y') + 2) });
        return '';
      }
      case 'set-option': {
        const s = this.sessions.get(target());
        if (s) s.options[rest[rest.length - 2]] = rest[rest.length - 1];
        return '';
      }
      case 'list-panes':
        return [...this.sessions].map(([n, s]) => `${n}\t${s.panePid}\t${s.activity}`).join('\n');
      case 'display-message': {
        const s = this.sessions.get(target());
        if (!s) throw new Error("can't find session");
        return `${s.panePid}\n`;
      }
      case 'capture-pane': {
        const s = this.sessions.get(target());
        if (!s) throw new Error("can't find session");
        return rest.includes('-S') ? s.history : s.screen;
      }
      case 'send-keys':
        this.keys.push({ target: target(), keys: rest.slice(rest.indexOf('-t') + 2) });
        return '';
      case 'kill-session':
        this.sessions.delete(target());
        return '';
      case 'set-environment':
        this.env.push(rest);
        return '';
      case 'source-file':
        return '';
      default:
        throw new Error(`fake tmux: unhandled ${cmd}`);
    }
  }
}

// handlers: {program basename: (args, opts) => stdout string | Error}. 'git' defaults to the real git.
function installExec(handlers) {
  const route = (file, args, opts) => {
    const h = handlers[path.basename(file)];
    if (!h) { const e = new Error(`spawn ${file} ENOENT`); e.code = 'ENOENT'; return e; }
    try { return h(args || [], opts || {}); } catch (e) { return e; }
  };
  mock.method(cp, 'execFileSync', (file, args, opts) => {
    const r = route(file, args, opts);
    if (r instanceof Error) throw r;
    return r;
  });
  mock.method(cp, 'execFile', (file, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (path.basename(file) === 'git' && !handlers.git) return realExecFile(file, args, opts, cb);
    const r = route(file, args, opts);
    setImmediate(() => (r instanceof Error ? cb(r, '', '') : cb(null, r, '')));
    return { kill() {} };
  });
}

// Loads server.js fresh. Options:
//   tmux: false to make tmux look uninstalled; tailscale: true to make it look installed.
//   env: extra environment variables. exec: extra fake programs. legacy: 'webterm' sessions exist.
function loadServer(opts = {}) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'corral-test-'));
  for (const k of Object.keys(process.env)) if (/^(CORRAL_|WEBTERM_|HERDR_)/.test(k)) delete process.env[k];
  Object.assign(process.env, { HOME: home, CORRAL_PORT: String(PORT), HERDR_BIN: path.join(home, 'bin', 'herdr'), SHELL: '/bin/zsh' }, opts.env || {});
  const tmux = new FakeTmux();
  const ptys = [];
  mock.restoreAll();
  mock.method(fs, 'existsSync', (p) => {
    if (TMUX_PATHS.includes(p)) return opts.tmux === false ? false : p === TMUX_PATHS[0];
    if (TS_PATHS.includes(p)) return opts.tailscale ? p === TS_PATHS[0] : false;
    return realExistsSync(p);
  });
  const ps = { out: '' };
  installExec({
    tmux: (args) => {
      if (args[1] === 'webterm' && args[2] === 'list-sessions') {
        if (opts.legacy === 'throw') throw new Error('no server');
        return opts.legacy ? 'wt-old\nother' : 'other';
      }
      return tmux.run(args);
    },
    ps: () => ps.out,
    ...opts.exec,
  });
  mock.method(pty, 'spawn', (file, args, o) => {
    if (opts.ptyThrows?.()) throw new Error('pty spawn failed');
    const p = new FakePty(file, args, o);
    ptys.push(p);
    return p;
  });
  delete require.cache[SERVER];
  const srv = require(SERVER);
  return { srv, tmux, ptys, home, ps };
}

// Writes a Claude Code session file for a process, as Claude Code itself does.
function claudeSession(home, pid, fields) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, cwd: home, status: 'idle', statusUpdatedAt: 1791390000000, ...fields }));
}

// Starts the server's HTTP handler on a free port; requests carry the Host header the server expects.
async function listen(srv) {
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const request = (method, url, { body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const h = { host: `127.0.0.1:${PORT}`, ...(method !== 'GET' && method !== 'HEAD' ? { origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
  const close = () => new Promise((r) => { srv.server.closeAllConnections?.(); srv.server.close(() => r()); });
  return { port, request, close };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

module.exports = { loadServer, listen, claudeSession, FakePty, FakeTmux, installExec, tick, PORT, ROOT, TMUX_PATHS, TS_PATHS };
