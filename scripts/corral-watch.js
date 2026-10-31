#!/usr/bin/env node
// Corral watch: runs on another Mac on the same tailnet and home network (a Mac mini that stays on, say) and
// finds out why the Mac that runs Corral cannot be reached from the phone. It asks Tailscale here whether that
// Mac is online, pings it on the home network, and, over SSH, reads its Tailscale state and whether Corral
// answers. Its page offers the fix: wake the Mac, reconnect its Tailscale, or restart Corral (which also
// reopens the windows a restart took away).
//   WATCH_TARGET=<the Mac's Tailscale machine name> node scripts/corral-watch.js
//   tailscale serve --bg --https=8444 http://127.0.0.1:8778     (once, on this Mac)
// Like Corral, it listens on loopback only and accepts tailnet requests only with an allowed Tailscale login.
// See "When the phone cannot reach the Mac" in README.md.
const http = require('http');
const cp = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TS_BINS = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function config(env = process.env) {
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    port: Number(env.WATCH_PORT || 8778),
    tsPort: Number(env.WATCH_TAILSCALE_PORT || 8444),
    target: String(env.WATCH_TARGET || '').trim().toLowerCase(),
    lanHost: env.WATCH_LAN_HOST || '',
    ssh: env.WATCH_SSH || '',
    mac: env.WATCH_MAC || '',
    broadcast: env.WATCH_BROADCAST || '255.255.255.255',
    corralPort: Number(env.WATCH_CORRAL_PORT || 8777),
    // Expanded by the shell on that Mac, so $HOME is its home folder.
    repo: env.WATCH_CORRAL_REPO || '$HOME/repos/corral',
    users: list(env.WATCH_USERS),
    stateFile: env.WATCH_STATE || path.join(os.homedir(), '.local', 'share', 'corral', 'watch.json'),
    tsBin: env.WATCH_TAILSCALE_BIN || TS_BINS.find((p) => fs.existsSync(p)) || 'tailscale',
  };
}

// Runs a program and always resolves, with {ok, out, err}.
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ ok: !err, out: String(out || ''), err: String(errOut || '') || (err ? err.message : '') });
    });
  });
}

// Wake-on-LAN: six 0xFF bytes, then the MAC address sixteen times, broadcast to UDP port 9.
function magicPacket(mac) {
  const bytes = Buffer.from(mac.replace(/[^0-9a-f]/gi, ''), 'hex');
  if (bytes.length !== 6) throw new Error(`not a MAC address: ${mac}`);
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}
function sendUdp(buf, host, port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => { s.close(); reject(e); });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(buf, port, host, (e) => { s.close(); if (e) reject(e); else resolve(); });
    });
  });
}

// arp on macOS drops leading zeros ("a:b:c:..."); write each byte as two digits.
function normMac(m) {
  const parts = String(m || '').split(':');
  return parts.length === 6 && parts.every((p) => /^[0-9a-f]{1,2}$/i.test(p)) ? parts.map((p) => p.padStart(2, '0').toLowerCase()).join(':') : null;
}

const dnsName = (n) => String(n?.DNSName || '').replace(/\.$/, '').toLowerCase();
// Tailscale reports year 1 for "never" and for a peer that is online now.
const seen = (t) => (t && Date.parse(t) > Date.parse('2000-01-01') ? t : null);

// How Tailscale on a Mac stands, from its `status --json` text, as Corral's server reads it.
function tsState(text) {
  let d;
  try { d = JSON.parse(text); } catch { return 'off'; }
  if (d.BackendState === 'Stopped') return 'stopped';
  if (d.BackendState === 'NeedsLogin' || !d.User?.[d.Self?.UserID]?.LoginName) return 'logged-out';
  return 'running';
}

// The prelude every script run on the Mac starts with: find its tailscale command.
const FIND_TS = `TS=tailscale; for p in ${TS_BINS.join(' ')}; do [ -x "$p" ] && { TS="$p"; break; }; done`;

function sshProbeScript(cfg) {
  return [FIND_TS,
    'if pgrep -x Tailscale >/dev/null || pgrep -x tailscaled >/dev/null; then echo app=yes; else echo app=no; fi',
    `echo corral=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:${cfg.corralPort}/api/hub)`,
    'echo ---', '"$TS" status --json 2>/dev/null'].join('\n');
}
function parseProbe(out) {
  const [head, ...rest] = out.split('\n---\n');
  const kv = Object.fromEntries(head.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2));
  return { app: kv.app === 'yes', corral: kv.corral === '200', tailscale: tsState(rest.join('\n---\n')) };
}

// Opens the Tailscale app, then connects it if it is off or starts a login if it is logged out.
const TS_FIX = [FIND_TS, 'open -a Tailscale 2>&1', 'sleep 3',
  `st=$("$TS" status --json 2>/dev/null | grep -o '"BackendState": *"[A-Za-z]*"' | head -1 | sed 's/.*"\\([A-Za-z]*\\)"$/\\1/')`,
  'echo "Tailscale: ${st:-not answering}"',
  'case "$st" in Stopped) "$TS" up --timeout=20s 2>&1 ;; NeedsLogin) "$TS" login --timeout=20s 2>&1 ;; esac'].join('\n');

const LOGIN_URL = /https:\/\/login\.tailscale\.com\/\S+/;

// What the probes add up to: {level: ok|warn|down, title, detail, fix?}. `fix` names the button to offer.
function verdict(name, ts, lan, ssh, canWake) {
  const peer = ts.peer;
  if (ssh?.ok) {
    const s = ssh.tailscale;
    if (s === 'off') return { level: 'down', title: `Tailscale is not running on ${name}`, detail: 'The Mac is awake on the home network.', fix: 'tailscale' };
    if (s === 'stopped') return { level: 'down', title: `Tailscale is turned off on ${name}`, detail: 'The Mac is awake on the home network.', fix: 'tailscale' };
    if (s === 'logged-out') return { level: 'down', title: `Tailscale on ${name} is logged out`, detail: 'Reconnect starts a login and shows its link here; open it to sign the Mac back in.', fix: 'tailscale' };
    if (!ssh.corral) return { level: 'down', title: `Corral is not running on ${name}`, detail: 'Tailscale is connected, but Corral does not answer on the Mac.', fix: 'corral' };
    if (!peer?.online) return { level: 'warn', title: `Tailscale on ${name} says it is connected, but the tailnet does not see it`, detail: 'It may be reconnecting. Reconnect asks it to again.', fix: 'tailscale' };
    return { level: 'ok', title: `${name} and Corral both answer`, detail: 'If the phone still cannot open Corral, check that Tailscale is connected on the phone.' };
  }
  if (lan.up) return { level: 'warn', title: `${name} is awake on the home network, but SSH did not get in`, detail: `${ssh?.err ? `SSH said: ${ssh.err} ` : ''}Check Remote Login on the Mac and this Mac's key there.` };
  const when = peer?.lastSeen ? ` Tailscale last saw it at ${new Date(peer.lastSeen).toLocaleString()}.` : '';
  if (peer?.online) return { level: 'warn', title: `Tailscale sees ${name} online, but it does not answer on the home network`, detail: 'It may be away from home. This Mac can only look over the home network.' };
  return { level: 'down', title: `${name} is asleep, off, or away from home`, detail: `It does not answer on the home network.${when} After a power loss, a Mac with FileVault waits at its startup password screen, off the network, until someone types the password.`, ...(canWake ? { fix: 'wake' } : {}) };
}

function createWatch(cfg, deps = {}) {
  const exec = deps.run || run;
  const udp = deps.udp || sendUdp;
  let me = null; // {host, owner} for this Mac in Tailscale
  let peerName = null; // the watched Mac's name in Tailscale, from the last look
  let state = {};
  try { state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')); } catch {}
  const saveState = () => {
    try { fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true }); fs.writeFileSync(cfg.stateFile, JSON.stringify(state)); } catch {}
  };

  async function tailscaleView() {
    const r = await exec(cfg.tsBin, ['status', '--json'], 8000);
    let d;
    try { d = JSON.parse(r.out); } catch { return { error: 'Tailscale on this Mac did not answer.', peer: null }; }
    me = { host: dnsName(d.Self), owner: d.User?.[d.Self?.UserID]?.LoginName || null };
    const p = Object.values(d.Peer || {}).find((x) => String(x.HostName || '').toLowerCase() === cfg.target || dnsName(x).split('.')[0] === cfg.target);
    if (p) peerName = p.HostName;
    return { peer: p ? { name: p.HostName, online: Boolean(p.Online), lastSeen: seen(p.LastSeen), ip: p.TailscaleIPs?.[0] || null } : null };
  }

  async function lanView(host) {
    const r = await exec('ping', ['-c', '1', '-t', '2', host], 5000);
    const ip = r.out.match(/\((\d+\.\d+\.\d+\.\d+)\)/)?.[1] || null;
    if (!r.ok || !ip) return { host, up: false, ip };
    const a = await exec('arp', ['-n', ip], 3000);
    return { host, up: true, ip, mac: normMac(a.out.match(/ at (\S+) /)?.[1]) };
  }

  // Its Bonjour name on the home network: macOS uses the same name as Tailscale does, plus .local.
  const lanHost = () => cfg.lanHost || `${peerName || cfg.target}.local`;
  const sshDest = (lan) => cfg.ssh || lan.host;
  const ssh = (lan, script, timeout) => exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', sshDest(lan), script], timeout);

  let inFlight = null;
  async function probe() {
    const ts = await tailscaleView();
    const name = ts.peer?.name || cfg.target;
    const lan = await lanView(lanHost());
    if (lan.mac && lan.mac !== state.mac) { state.mac = lan.mac; saveState(); }
    let sshView = null;
    if (lan.up) {
      const r = await ssh(lan, sshProbeScript(cfg), 15000);
      sshView = r.ok ? { ok: true, ...parseProbe(r.out) } : { ok: false, err: r.err.trim().split('\n').pop() };
    }
    const mac = cfg.mac || state.mac || null;
    return { name, checkedAt: new Date().toISOString(), tailscale: ts, lan, ssh: sshView, mac, verdict: verdict(name, ts, lan, sshView, Boolean(mac)) };
  }
  // Two pages polling at once share one probe.
  const status = () => (inFlight ||= probe().finally(() => { inFlight = null; }));

  const actions = {
    async wake() {
      const mac = cfg.mac || state.mac;
      if (!mac) return { ok: false, output: 'This Mac has not seen that Mac on the home network yet, so it does not know its address to wake. Set WATCH_MAC.' };
      await udp(magicPacket(mac), cfg.broadcast, 9);
      return { ok: true, output: `Sent a wake packet to ${mac}. A Mac wakes from it only when "Wake for network access" is on, usually only on power.` };
    },
    async tailscale() {
      const lan = await lanView(lanHost());
      const r = await ssh(lan, TS_FIX, 40000);
      const output = `${r.out}${r.err}`.trim();
      return { ok: r.ok, output, login: output.match(LOGIN_URL)?.[0] || null };
    },
    async corral() {
      const lan = await lanView(lanHost());
      const r = await ssh(lan, `CORRAL_NO_OPEN=1 CORRAL_AUTO_RESTORE=1 "${cfg.repo}/scripts/corral-launcher.sh" 2>&1`, 40000);
      return { ok: r.ok, output: `${r.out}${r.err}`.trim() || (r.ok ? 'Corral is running.' : 'The launcher failed.') };
    },
  };

  // {origins} for an allowed request, else null: from this Mac, or through tailscale serve with an allowed login.
  async function access(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (host === `127.0.0.1:${cfg.port}` || host === `localhost:${cfg.port}`) return { origins: [`http://${host}`] };
    if (!me) await tailscaleView();
    const logins = cfg.users.length ? cfg.users : [me?.owner].filter(Boolean);
    const login = String(req.headers['tailscale-user-login'] || '');
    if (me?.host && host === `${me.host}:${cfg.tsPort}` && logins.includes(login)) return { origins: [`https://${host}`] };
    return null;
  }

  async function handle(req, res) {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const ok = await access(req);
    if (!ok) return send(403, { error: 'not allowed' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, await status());
    const act = url.pathname.match(/^\/api\/(wake|tailscale|corral)$/)?.[1];
    if (req.method === 'POST' && act) {
      if (!ok.origins.includes(req.headers.origin || '')) return send(403, { error: 'bad origin' });
      try { return send(200, await actions[act]()); } catch (e) { return send(500, { ok: false, output: e.message }); }
    }
    return send(404, { error: 'not found' });
  }

  return { handle, status, actions, access };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corral watch</title>
<style>:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1d1d1b;--muted:#5d5d58;--card:#fff;--line:#e2e2dc;--ok:#2f7d4f;--warn:#a86b00;--down:#b3261e;--btn:#1d1d1b;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece6;--muted:#a3a39b;--card:#201f1d;--line:#34332f;--ok:#6fcf97;--warn:#f2c94c;--down:#ff8a80;--btn:#ecece6;--btnfg:#161615}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 -apple-system,system-ui,sans-serif}main{max-width:34rem;margin:0 auto;padding:2rem 16px}
h1{font-size:1.35rem;line-height:1.3;margin:.2rem 0}.sub{color:var(--muted);font-size:.9rem}.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.4rem;background:var(--muted)}
.ok .dot{background:var(--ok)}.warn .dot{background:var(--warn)}.down .dot{background:var(--down)}p{color:var(--muted)}
dl{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.6rem 1rem;margin:1.2rem 0}dt{font-size:.8rem;color:var(--muted);margin-top:.5rem}dd{margin:0}
.btns{display:flex;flex-wrap:wrap;gap:.5rem}button{font:inherit;font-size:.95rem;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:.55rem .9rem}
button.main{background:var(--btn);color:var(--btnfg);border-color:var(--btn)}button:disabled{opacity:.5}pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.6rem}a{color:inherit}</style>
</head><body><main><div class="sub">Corral watch</div><div id="v"><h1>Checking…</h1></div><dl id="d" hidden></dl>
<div class="btns"><button data-a="wake">Wake</button><button data-a="tailscale">Reconnect Tailscale</button><button data-a="corral">Restart Corral</button><button id="again">Check again</button></div>
<div id="out"></div></main><script>
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const when = (t) => t ? new Date(t).toLocaleString() : 'not known';
const TS = { running: 'connected', stopped: 'turned off', 'logged-out': 'logged out', off: 'not running' };
async function check() {
  let s;
  try { s = await (await fetch('/api/status')).json(); } catch { $('#v').innerHTML = '<h1>This page lost touch with the watching Mac</h1>'; return; }
  const v = s.verdict;
  $('#v').className = v.level;
  $('#v').innerHTML = '<h1><span class="dot"></span>' + esc(v.title) + '</h1><p>' + esc(v.detail) + '</p>';
  const ts = s.tailscale.peer;
  const rows = [['Tailscale', s.tailscale.error || (ts ? (ts.online ? 'online' : 'offline, last seen ' + when(ts.lastSeen)) : 'no machine named ' + s.name)],
    ['Home network', s.lan.up ? 'answers at ' + s.lan.ip : 'no answer from ' + s.lan.host]];
  if (s.ssh) rows.push(['Over SSH', s.ssh.ok ? 'Tailscale ' + TS[s.ssh.tailscale] + (s.ssh.app ? '' : ' (app not running)') + ', Corral ' + (s.ssh.corral ? 'answers' : 'not answering') : 'failed: ' + s.ssh.err]);
  rows.push(['Checked', when(s.checkedAt)]);
  $('#d').innerHTML = rows.map(([k, x]) => '<dt>' + esc(k) + '</dt><dd>' + esc(x) + '</dd>').join('');
  $('#d').hidden = false;
  for (const b of document.querySelectorAll('[data-a]')) b.className = b.dataset.a === v.fix ? 'main' : '';
}
for (const b of document.querySelectorAll('[data-a]')) b.onclick = async () => {
  b.disabled = true;
  $('#out').innerHTML = '<p>' + esc(b.textContent) + '…</p>';
  let r;
  try { r = await (await fetch('/api/' + b.dataset.a, { method: 'POST' })).json(); } catch { r = { output: 'The watching Mac did not answer.' }; }
  $('#out').innerHTML = (r.login ? '<p><a href="' + esc(r.login) + '">Open the Tailscale login for the Mac</a></p>' : '') + (r.output ? '<pre>' + esc(r.output) + '</pre>' : '');
  b.disabled = false;
  check();
};
$('#again').onclick = check;
check();
setInterval(() => { if (document.visibilityState === 'visible') check(); }, 20000);
</script></body></html>`;

function main(env = process.env) {
  const cfg = config(env);
  if (!cfg.target) { console.error('corral-watch: set WATCH_TARGET to the Tailscale machine name of the Mac that runs Corral.'); process.exitCode = 1; return null; }
  const w = createWatch(cfg);
  const server = http.createServer((req, res) => { w.handle(req, res); });
  server.listen(cfg.port, '127.0.0.1', () => console.log(`corral-watch: watching ${cfg.target} on http://127.0.0.1:${server.address().port}`));
  return server;
}

module.exports = { config, run, magicPacket, sendUdp, normMac, tsState, parseProbe, sshProbeScript, verdict, createWatch, main, PAGE, TS_FIX };
if (require.main === module) main();
